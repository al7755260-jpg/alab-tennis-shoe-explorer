import * as THREE from 'three';
import { installPrintReveal, printParticleFlow, PRINT_DURATION_MS } from './print-effect.js';

// Baked from the original shoe surface: no triangle walk or random sampling at startup.
const sampleCache = new Map();
export function loadPrintSamples(mobile) {
  const file = mobile ? 'print-samples-mobile.bin' : 'print-samples.bin';
  if (!sampleCache.has(file)) sampleCache.set(file, fetch(`${import.meta.env.BASE_URL}models/${file}`)
    .then(response => { if (!response.ok) throw new Error('Print samples unavailable'); return response.arrayBuffer(); })
    .then(buffer => {
      const header = new DataView(buffer);
      const count = header.getUint32(4, true);
      if (header.getUint32(0, true) !== 0x31545250 || buffer.byteLength !== 32 + count * 28) throw new Error('Invalid print samples');
      return {
        bounds: new Float32Array(buffer, 8, 6),
        targets: new Float32Array(buffer, 32, count * 3),
        normals: new Float32Array(buffer, 32 + count * 12, count * 3),
        seeds: new Float32Array(buffer, 32 + count * 24, count), count,
      };
    }).catch(error => { sampleCache.delete(file); throw error; }));
  return sampleCache.get(file);
}

// All motion runs in the vertex shaders. Only a few uniforms change per frame.
const motion = printParticleFlow + /* glsl */`
uniform float uTime;
uniform float uFront;
uniform float uFade;
attribute vec3 aTarget;
attribute vec3 aNormal;
attribute float aSeed;
varying float vAlpha;
varying vec3 vTint;
vec3 particlePosition(float tail) {
  return printParticle(aTarget, aNormal, aSeed, tail, uTime, uFront, uFade, 1.0, vAlpha, vTint);
}
`;

function mulberry32(seed) {
  return () => {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function createPrintIntro(scene, meshes, { mobile = false, samples, introGeometries } = {}) {
  const group = new THREE.Group();
  group.name = 'temporary-print-particles';
  const printLights = new THREE.Group();
  const key = new THREE.DirectionalLight('#edf3ff', 2.2);
  key.position.set(-4, 7, 4);
  const rim = new THREE.DirectionalLight('#d6e5ff', 1.35);
  rim.position.set(4, 4, -4);
  printLights.add(key, rim, new THREE.HemisphereLight('#cbd9ec', '#18222d', 0.35));
  scene.add(printLights);
  const box = new THREE.Box3(new THREE.Vector3().fromArray(samples.bounds), new THREE.Vector3().fromArray(samples.bounds, 3));
  const random = mulberry32(7162026);
  scene.updateMatrixWorld(true);
  const meshBounds = meshes.map(mesh => ({ mesh, minY: new THREE.Box3().setFromObject(mesh).min.y, visible: mesh.visible }));
  const uniforms = {
    uTime: { value: 0 },
    uFront: { value: box.min.y - 0.3 },
    uFade: { value: 0 },
    uPointScale: { value: 700 },
  };

  // Temporarily use sliced copies; the untouched PBR materials return at the end.
  const originals = new Map();
  const originalGeometries = new Map();
  for (const mesh of meshes) {
    originals.set(mesh, mesh.material);
    originalGeometries.set(mesh, mesh.geometry);
    if (introGeometries?.has(mesh.userData.part_id)) mesh.geometry = introGeometries.get(mesh.userData.part_id);
    // The transient formation uses cheap direct lighting; the original PBR returns intact.
    // Phong ignores the studio's costly RectAreaLights, retaining a soft silver highlight.
    const material = new THREE.MeshPhongMaterial({
      color: mesh.material.color, opacity: mesh.material.opacity,
      transparent: mesh.material.transparent, side: THREE.DoubleSide,
      specular: '#7e8e9e', shininess: 38,
      emissive: '#172331', emissiveIntensity: 0.12,
    });
    material.forceSinglePass = true;
    installPrintReveal(material, uniforms);
    mesh.material = material;
  }

  const { count, targets, normals, seeds } = samples;
  function lowerBound(y) {
    let lo = 0, hi = count;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (targets[mid * 3 + 1] < y) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function attributes(geometry, ids, instanced = false) {
    const target = new Float32Array(ids.length * 3), norm = new Float32Array(ids.length * 3), seed = new Float32Array(ids.length);
    ids.forEach((id, i) => { target.set(targets.subarray(id*3, id*3+3), i*3); norm.set(normals.subarray(id*3, id*3+3), i*3); seed[i] = seeds[id]; });
    const Attribute = instanced ? THREE.InstancedBufferAttribute : THREE.BufferAttribute;
    geometry.setAttribute('aTarget', new Attribute(target, 3));
    geometry.setAttribute('aNormal', new Attribute(norm, 3));
    geometry.setAttribute('aSeed', new Attribute(seed, 1));
    return geometry;
  }
  const pointsGeometry = new THREE.BufferGeometry();
  pointsGeometry.setAttribute('position', new THREE.BufferAttribute(targets, 3));
  pointsGeometry.setAttribute('aTarget', new THREE.BufferAttribute(targets, 3));
  pointsGeometry.setAttribute('aNormal', new THREE.BufferAttribute(normals, 3));
  pointsGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  const pointsMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: motion + /* glsl */`
      uniform float uPointScale;
      void main() {
        vec3 p = particlePosition(0.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = clamp((0.010 + aSeed * 0.014) * uPointScale / -mv.z, 1.0, 4.5);
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      varying vec3 vTint;
      void main() {
        float r = length(gl_PointCoord - 0.5);
        float alpha = (1.0 - smoothstep(0.14, 0.5, r)) * vAlpha;
        if (alpha < 0.01) discard;
        gl_FragColor = vec4(vTint * 1.4, alpha * 0.82);
      }`,
  });
  const points = new THREE.Points(pointsGeometry, pointsMaterial);
  points.frustumCulled = false;
  group.add(points);

  // Larger fragments give the grain a physical, voxel-like scale, as in the reference.
  const fragmentCount = mobile ? 100 : 200;
  const fragmentGeometry = new THREE.BoxGeometry(1, 1, 1);
  const ids = Array.from({ length: fragmentCount }, () => Math.floor(random() * count));
  attributes(fragmentGeometry, ids, true);
  const fragmentMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false,
    vertexShader: motion + /* glsl */`
      varying float vLight;
      void main() {
        vec3 p = particlePosition(0.0);
        float angle = aSeed * 6.283 + uTime * 0.45;
        mat2 rot = mat2(cos(angle), -sin(angle), sin(angle), cos(angle));
        vec3 cube = position * (0.012 + aSeed * aSeed * 0.042);
        cube.xz = rot * cube.xz;
        vLight = 0.55 + max(0.0, dot(normal, normalize(vec3(-1.0, 2.0, 3.0)))) * 0.65;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p + cube, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      varying vec3 vTint;
      varying float vLight;
      void main() { if(vAlpha < 0.01) discard; gl_FragColor = vec4(vTint * vLight, vAlpha * 0.86); }`,
  });
  const fragments = new THREE.InstancedMesh(fragmentGeometry, fragmentMaterial, fragmentCount);
  fragments.frustumCulled = false;
  group.add(fragments);

  const steps = 10, strandCount = mobile ? 50 : 90;
  const strandIds = [], tails = [];
  for (let i = 0; i < strandCount; i++) {
    const id = Math.floor(random() * count);
    for (let j = 0; j < steps; j++) { strandIds.push(id, id); tails.push(j / steps, (j+1) / steps); }
  }
  const strandGeometry = attributes(new THREE.BufferGeometry(), strandIds);
  strandGeometry.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(strandIds.length * 3), 3));
  strandGeometry.setAttribute('aTail', new THREE.Float32BufferAttribute(tails, 1));
  const strandMaterial = new THREE.ShaderMaterial({
    uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: motion + /* glsl */`
      attribute float aTail;
      void main() {
        vec3 p = particlePosition(aTail);
        vAlpha *= (1.0 - aTail) * 0.23;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }`,
    fragmentShader: /* glsl */`
      varying float vAlpha;
      varying vec3 vTint;
      void main() { gl_FragColor = vec4(vTint, vAlpha); }`,
  });
  const strands = new THREE.LineSegments(strandGeometry, strandMaterial);
  strands.frustumCulled = false;
  group.add(strands);
  scene.add(group);

  let elapsed = 0, disposed = false;
  const duration = PRINT_DURATION_MS;
  return {
    update(delta, viewportHeight, pixelRatio, fixedProgress = null) {
      elapsed += delta;
      const progress = fixedProgress ?? Math.min(1, elapsed / duration);
      uniforms.uTime.value = progress * duration / 1000;
      uniforms.uFront.value = THREE.MathUtils.lerp(box.min.y - 0.3, box.max.y + 0.25, progress);
      uniforms.uFade.value = THREE.MathUtils.smoothstep(progress, 0, 0.08) * (1 - THREE.MathUtils.smoothstep(progress, 0.91, 1));
      uniforms.uPointScale.value = viewportHeight * pixelRatio;
      const first = lowerBound(uniforms.uFront.value - 0.12);
      const last = lowerBound(uniforms.uFront.value + 1.85);
      pointsGeometry.setDrawRange(first, last - first);
      for (const item of meshBounds) item.mesh.visible = item.visible && item.minY <= uniforms.uFront.value;
      return progress;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const [mesh, material] of originals) { mesh.material.dispose(); mesh.material = material; }
      for (const [mesh, geometry] of originalGeometries) mesh.geometry = geometry;
      for (const item of meshBounds) item.mesh.visible = item.visible;
      scene.remove(group);
      scene.remove(printLights);
      group.traverse(object => { object.geometry?.dispose(); object.material?.dispose(); });
    },
  };
}

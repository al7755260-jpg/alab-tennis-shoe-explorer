import * as THREE from 'three';
import { installPrintReveal, printParticleFlow, PRINT_DURATION_MS, PART_PRINT_SPEED } from './print-effect.js';

// Surface sampling is offline. Focusing never walks triangles or allocates particles.
export async function loadFocusSamples(mobile) {
  const file = mobile ? 'focus-samples-mobile.bin' : 'focus-samples.bin';
  const response = await fetch(`${import.meta.env.BASE_URL}models/${file}`);
  if (!response.ok) throw new Error('Focus samples unavailable');
  const buffer = await response.arrayBuffer();
  const header = new DataView(buffer);
  if (header.getUint32(0, true) !== 0x31534e46) throw new Error('Invalid focus samples');
  const headerLength = header.getUint32(4, true);
  const parts = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerLength)));
  let offset = 8 + headerLength;
  const samples = new Map();
  for (const part of parts) {
    const { count } = part;
    samples.set(part.id, {
      ...part,
      positions: new Float32Array(buffer, offset, count * 3),
      normals: new Float32Array(buffer, offset + count * 12, count * 3),
      seeds: new Float32Array(buffer, offset + count * 24, count),
    });
    offset += count * 28;
  }
  if (offset !== buffer.byteLength) throw new Error('Incomplete focus samples');
  return samples;
}

// A low-contrast surface remains legible while a brighter wave grows upward.
// Only the wave's frontier drifts into curls, like the opening print animation.
const flow = printParticleFlow + /* glsl */`
  uniform float uTime;
  uniform float uAge;
  uniform float uPhase;
  uniform float uMinY;
  uniform float uHeight;
  uniform float uSpread;
  uniform float uPrintEnabled;
  uniform float uPrintTime;
  uniform float uPrintScale;
  uniform float uFront;
  attribute vec3 aNormal;
  attribute float aSeed;
  varying float vAlpha;
  varying vec3 vTint;
  vec3 noisePosition(float tail) {
    float height = clamp((position.y - uMinY) / uHeight, 0.0, 1.0);
    float phase = fract(uTime * 0.16 - height * 0.72 + uPhase);
    float distanceToWave = min(phase, 1.0 - phase);
    float band = 1.0 - smoothstep(0.01, 0.18, distanceToWave);
    float reveal = smoothstep(height * 0.78, height * 0.78 + 0.3, uAge);
    float field = position.x * 3.2 + position.z * 4.7 + uTime * 1.8;
    float curl = field + aSeed * 6.28318;
    vec3 drift = vec3(
      sin(field + tail * 1.7) * 0.72 + cos(curl) * 0.25,
      sin(field * 0.7 + position.z * 3.0) * 0.3,
      cos(field * 0.85 + tail * 2.0) * 0.62 + sin(curl) * 0.2
    );
    drift += aNormal * (0.25 + aSeed * 0.5);
    drift += vec3(-0.85, 0.28, 0.32) * tail;
    float spread = (0.05 + band * (0.3 + aSeed * 0.7)) * uSpread;
    vAlpha = reveal * (0.3 + band * 0.68) * (0.6 + aSeed * 0.4);
    if (tail > 0.0) vAlpha *= band * (1.0 - tail) * 0.4;
    vTint = mix(vec3(0.3, 0.65, 0.62), vec3(0.76, 0.87, 0.94), aSeed);
    vec3 p = position + drift * spread;
    if (uPrintEnabled > 0.5) {
      float printAlpha;
      vec3 printTint;
      vec3 printP = printParticle(position, aNormal, aSeed, tail, uPrintTime,
                                  uFront, 1.0, uPrintScale, printAlpha, printTint);
      float ahead = (position.y - uFront) / uPrintScale;
      float frontier = 1.0 - smoothstep(0.25, 1.85, abs(ahead));
      // The existing cloud survives above the print head. Grains settle into the
      // solid surface below it, rather than disappearing and respawning elsewhere.
      vAlpha = max(vAlpha * smoothstep(-0.12, 0.025, ahead), printAlpha * 0.85);
      if (tail > 0.0) vAlpha *= (1.0 - tail) * 0.4;
      vTint = mix(vTint, printTint, frontier);
      p = mix(p, printP, frontier);
    }
    return p;
  }
`;

export function createFocusNoise(scene, meshes, samples, { mobile = false, reduceMotion = false, materialsFor } = {}) {
  const root = new THREE.Group();
  root.name = 'focus-growth-noise';
  root.visible = false;
  scene.add(root);
  scene.updateMatrixWorld(true);
  let selected = null;
  let elapsed = 0;
  let forming = null;
  const duration = PRINT_DURATION_MS / PART_PRINT_SPEED;
  const entries = meshes.map((mesh, index) => {
    const sample = samples.get(mesh.userData.part_id);
    if (!sample) throw new Error(`Missing focus samples: ${mesh.userData.part_id}`);
    const { positions, normals, seeds, count, bounds } = sample;
    const uniforms = {
      uTime: { value: 0 }, uAge: { value: 2 },
      uPhase: { value: index * 0.071 },
      uMinY: { value: bounds[1] }, uHeight: { value: Math.max(0.08, bounds[4] - bounds[1]) },
      uSpread: { value: THREE.MathUtils.clamp(Math.hypot(bounds[3] - bounds[0], bounds[4] - bounds[1], bounds[5] - bounds[2]) * 0.085, 0.04, 0.26) },
      uPointScale: { value: 700 },
      uPrintEnabled: { value: 0 }, uPrintTime: { value: 0 },
      uFront: { value: bounds[1] },
      uPrintScale: { value: THREE.MathUtils.clamp((bounds[4] - bounds[1]) * 0.5, 0.015, 1) },
      uPrintSpace: { value: new THREE.Matrix4() },
    };
    // Patch both cached material paths once, before their startup prewarm.
    for (const material of materialsFor?.(mesh) || [mesh.material]) installPrintReveal(material, uniforms);
    const group = new THREE.Group();
    group.name = `noise-${mesh.userData.part_id}`;
    group.matrixAutoUpdate = false;
    root.add(group);
    const restInverse = mesh.matrixWorld.clone().invert();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aNormal', new THREE.BufferAttribute(normals, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
    const material = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: flow + /* glsl */`
        uniform float uPointScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(noisePosition(0.0), 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp((0.018 + aSeed * 0.024) * uPointScale / max(0.1, -mv.z), 1.0, 4.0);
        }
      `,
      fragmentShader: /* glsl */`
        varying float vAlpha;
        varying vec3 vTint;
        void main() {
          float radius = length(gl_PointCoord - 0.5);
          float alpha = (1.0 - smoothstep(0.12, 0.5, radius)) * vAlpha;
          if (alpha < 0.008) discard;
          gl_FragColor = vec4(vTint * 1.2, alpha);
          #include <colorspace_fragment>
        }
      `,
    });
    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    group.add(points);

    // Short filaments around the active growth band, with no per-frame buffer writes.
    const steps = 7;
    const strandCount = Math.max(3, Math.round(count / (mobile ? 230 : 180)));
    const vertexCount = strandCount * steps * 2;
    const targets = new Float32Array(vertexCount * 3);
    const normal = new Float32Array(vertexCount * 3);
    const seed = new Float32Array(vertexCount);
    const tail = new Float32Array(vertexCount);
    for (let strand = 0, vertex = 0; strand < strandCount; strand++) {
      const id = Math.floor((strand + 0.5) * count / strandCount);
      for (let step = 0; step < steps; step++) for (let end = 0; end < 2; end++, vertex++) {
        targets.set(positions.subarray(id * 3, id * 3 + 3), vertex * 3);
        normal.set(normals.subarray(id * 3, id * 3 + 3), vertex * 3);
        seed[vertex] = seeds[id];
        tail[vertex] = 0.001 + (step + end) / steps;
      }
    }
    const strandGeometry = new THREE.BufferGeometry();
    strandGeometry.setAttribute('position', new THREE.BufferAttribute(targets, 3));
    strandGeometry.setAttribute('aNormal', new THREE.BufferAttribute(normal, 3));
    strandGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    strandGeometry.setAttribute('aTail', new THREE.BufferAttribute(tail, 1));
    const strandMaterial = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, depthTest: true, blending: THREE.AdditiveBlending,
      vertexShader: flow + /* glsl */`
        attribute float aTail;
        void main() { gl_Position = projectionMatrix * modelViewMatrix * vec4(noisePosition(aTail), 1.0); }
      `,
      fragmentShader: /* glsl */`
        varying float vAlpha;
        varying vec3 vTint;
        void main() {
          gl_FragColor = vec4(vTint, vAlpha);
          #include <colorspace_fragment>
        }
      `,
    });
    const strands = new THREE.LineSegments(strandGeometry, strandMaterial);
    strands.frustumCulled = false;
    group.add(strands);
    return { mesh, group, restInverse, uniforms, bounds, born: 0, count };
  });

  function syncTransforms() {
    scene.updateMatrixWorld(true);
    for (const entry of entries) {
      entry.group.matrix.multiplyMatrices(entry.mesh.matrixWorld, entry.restInverse);
      entry.group.matrixWorldNeedsUpdate = true;
      entry.uniforms.uPrintSpace.value.copy(entry.group.matrix).invert();
    }
  }

  return {
    // Only used during loading, before the first interactive frame.
    prepare() { root.visible = true; syncTransforms(); },
    setFocus(next) {
      const previous = selected;
      const changed = next !== previous;
      if (changed) {
        forming = previous && next && !reduceMotion
          ? { entry: entries.find(entry => entry.mesh === next), elapsed: 0, progress: 0 } : null;
      }
      selected = next;
      root.visible = !!next;
      for (const entry of entries) {
        const noise = !!next && entry.mesh !== next;
        const materializing = forming?.entry === entry;
        // Hidden solids remain explicit raycast targets; no translucent shell is drawn.
        entry.mesh.visible = !noise;
        entry.group.visible = noise || materializing;
        entry.uniforms.uPrintEnabled.value = materializing ? 1 : 0;
        if (materializing && changed) {
          entry.uniforms.uFront.value = entry.bounds[1] - 0.3 * entry.uniforms.uPrintScale.value;
          entry.uniforms.uPrintTime.value = 0;
        }
        if (noise && (!previous || entry.mesh === previous)) entry.born = elapsed;
      }
      syncTransforms();
    },
    update(delta, height, pixelRatio) {
      if (!selected) return false;
      if (!reduceMotion) elapsed += Math.min(delta, 64) / 1000;
      for (const entry of entries) {
        entry.uniforms.uTime.value = reduceMotion ? 2.7 : elapsed;
        entry.uniforms.uAge.value = reduceMotion ? 2 : elapsed - entry.born;
        entry.uniforms.uPointScale.value = height * pixelRatio;
      }
      if (forming) {
        forming.elapsed += delta;
        forming.progress = Math.min(1, forming.elapsed / duration);
        const { entry, progress } = forming;
        const scale = entry.uniforms.uPrintScale.value;
        entry.uniforms.uFront.value = THREE.MathUtils.lerp(entry.bounds[1] - 0.3 * scale, entry.bounds[4] + 0.25 * scale, progress);
        entry.uniforms.uPrintTime.value = forming.elapsed / 1000 * PART_PRINT_SPEED;
        if (progress === 1) {
          entry.uniforms.uPrintEnabled.value = 0;
          entry.group.visible = false;
          forming = null;
        }
      }
      return !reduceMotion;
    },
    get count() { return selected ? entries.reduce((sum, entry) => sum + (entry.group.visible ? entry.count : 0), 0) : 0; },
    get forming() { return !!forming; },
    get progress() { return forming?.progress ?? 1; },
    get durationMs() { return duration; },
    get time() { return elapsed; },
    dispose() {
      for (const { mesh, group, uniforms } of entries) {
        uniforms.uPrintEnabled.value = 0;
        mesh.visible = true;
        for (const object of group.children) { object.geometry.dispose(); object.material.dispose(); }
      }
      scene.remove(root);
    },
  };
}

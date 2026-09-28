import * as THREE from 'three';
import { installPrintReveal, printParticleFlow, printWarpStrength, PRINT_WARP_BOUND, PRINT_DURATION_MS, PART_PRINT_SPEED, PART_DISSOLVE_MS } from './print-effect.js';

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
  uniform float uPrintWarp;
  uniform float uFront;
  uniform float uDissolveEnabled;
  uniform float uDissolveProgress;
  attribute vec3 aNormal;
  attribute float aSeed;
  varying float vAlpha;
  varying vec3 vTint;
  vec3 noisePosition(float tail) {
    float ahead = uPrintEnabled > 0.5
      ? printAhead(position, uFront, uPrintTime, uPrintScale, uPrintWarp) : 1.0;
    // Already-solid grains contribute nothing; skip their flow math entirely.
    if (uPrintEnabled > 0.5 && ahead <= -0.12) {
      vAlpha = 0.0; vTint = vec3(0.0); return position;
    }
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
                                  ahead, 1.0, uPrintScale, printAlpha, printTint);
      float settle = uDissolveEnabled > 0.5 ? 1.0 - smoothstep(0.78, 1.0, uDissolveProgress) : 1.0;
      float frontier = (1.0 - smoothstep(0.25, 1.85, abs(ahead))) * settle;
      // The existing cloud survives above the print head. Grains settle into the
      // solid surface below it, rather than disappearing and respawning elsewhere.
      vAlpha = max(vAlpha * smoothstep(-0.12, 0.025, ahead), printAlpha * 0.85 * settle);
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
  let assemblyProgress = null;
  const dissolving = new Map();
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
      uPrintWarp: { value: 0 },
      uDissolveEnabled: { value: 0 }, uDissolveProgress: { value: 0 },
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
    // Offline height order allows a binary-search draw range, preserving every
    // visible grain while skipping the fully materialized portion on the GPU.
    geometry.setDrawRange(0, count);
    geometry.boundingSphere = new THREE.Box3(
      new THREE.Vector3().fromArray(bounds), new THREE.Vector3().fromArray(bounds, 3),
    ).expandByScalar(Math.max(1.5 * uniforms.uPrintScale.value, 2 * uniforms.uSpread.value))
      .getBoundingSphere(new THREE.Sphere());
    const material = new THREE.ShaderMaterial({
      uniforms, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
      vertexShader: flow + /* glsl */`
        uniform float uPointScale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(noisePosition(0.0), 1.0);
          if (vAlpha < 0.008) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 1.0; return; }
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
    group.add(points);

    // Surface grains only: no line trails during focus, growth or dissolution.
    return { mesh, group, geometry, positions, sorted: sample.sortedByHeight, restInverse, uniforms, bounds, born: 0, count };
  });

  function syncTransforms() {
    for (const entry of entries) {
      entry.mesh.updateWorldMatrix(true, false);
      entry.group.matrix.multiplyMatrices(entry.mesh.matrixWorld, entry.restInverse);
      entry.group.matrixWorldNeedsUpdate = true;
      entry.uniforms.uPrintSpace.value.copy(entry.group.matrix).invert();
    }
  }

  function setPrintProgress(entry, progress) {
    const scale = entry.uniforms.uPrintScale.value;
    entry.uniforms.uFront.value = THREE.MathUtils.lerp(entry.bounds[1] - 0.3 * scale, entry.bounds[4] + 0.25 * scale, progress);
    entry.uniforms.uPrintTime.value = progress * PRINT_DURATION_MS / 1000;
    entry.uniforms.uPrintWarp.value = printWarpStrength(progress);
    if (entry.sorted) {
      const floor = entry.uniforms.uFront.value - scale * (PRINT_WARP_BOUND * entry.uniforms.uPrintWarp.value + 0.12);
      let lo = 0, hi = entry.count;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (entry.positions[mid * 3 + 1] < floor) lo = mid + 1; else hi = mid;
      }
      entry.geometry.setDrawRange(lo, entry.count - lo);
    }
  }

  return {
    // Only used during loading, before the first interactive frame.
    prepare() { root.visible = true; syncTransforms(); },
    beginAssembly() {
      selected = null;
      forming = null;
      dissolving.clear();
      assemblyProgress = reduceMotion ? null : 0;
      root.visible = !reduceMotion;
      for (const entry of entries) {
        entry.mesh.visible = true;
        entry.group.visible = !reduceMotion;
        entry.born = elapsed - 2;
        entry.uniforms.uAge.value = 2;
        entry.uniforms.uDissolveEnabled.value = 0;
        entry.uniforms.uPrintEnabled.value = reduceMotion ? 0 : 1;
        setPrintProgress(entry, reduceMotion ? 1 : 0);
      }
      syncTransforms();
    },
    setAssemblyProgress(progress) {
      if (assemblyProgress === null) return;
      assemblyProgress = THREE.MathUtils.clamp(progress, 0, 1);
      for (const entry of entries) {
        setPrintProgress(entry, assemblyProgress);
        if (assemblyProgress === 1) {
          entry.uniforms.uPrintEnabled.value = 0;
          entry.group.visible = false;
        }
      }
      // Keep each particle cloud and liquid cut attached to the moving solid.
      syncTransforms();
      if (assemblyProgress === 1) { assemblyProgress = null; root.visible = false; }
    },
    setFocus(next) {
      assemblyProgress = null;
      const previous = selected;
      const changed = next !== previous;
      if (changed) {
        if (!next || reduceMotion) dissolving.clear();
        else if (previous) {
          const outgoing = entries.find(entry => entry.mesh === previous);
          const fromProgress = forming?.entry === outgoing ? forming.progress : 1;
          dissolving.set(outgoing, { elapsed: 0, progress: 0, fromProgress });
          outgoing.uniforms.uPrintEnabled.value = 1;
          setPrintProgress(outgoing, fromProgress);
          outgoing.uniforms.uDissolveProgress.value = 0;
          outgoing.born = elapsed - 2;
          // Re-selecting a dissolving part immediately gives it back to printing.
          dissolving.delete(entries.find(entry => entry.mesh === next));
        }
        forming = previous && next && !reduceMotion
          ? { entry: entries.find(entry => entry.mesh === next), elapsed: 0, progress: 0 } : null;
      }
      selected = next;
      root.visible = !!next;
      for (const entry of entries) {
        const noise = !!next && entry.mesh !== next;
        const materializing = forming?.entry === entry;
        const disintegrating = dissolving.has(entry);
        // Hidden solids remain explicit raycast targets; no translucent shell is drawn.
        entry.mesh.visible = !noise || disintegrating;
        entry.group.visible = noise || materializing;
        entry.uniforms.uDissolveEnabled.value = disintegrating ? 1 : 0;
        if (!disintegrating) entry.uniforms.uPrintEnabled.value = materializing ? 1 : 0;
        if (!disintegrating && !materializing) entry.geometry.setDrawRange(0, entry.count);
        if (materializing && changed) {
          setPrintProgress(entry, 0);
        }
        if (noise && !disintegrating && (!previous || entry.mesh === previous)) entry.born = elapsed;
      }
      syncTransforms();
    },
    update(delta, height, pixelRatio) {
      if (!selected && assemblyProgress === null) return false;
      if (!reduceMotion) elapsed += Math.min(delta, 64) / 1000;
      for (const entry of entries) {
        entry.uniforms.uTime.value = reduceMotion ? 2.7 : elapsed;
        entry.uniforms.uAge.value = reduceMotion ? 2 : elapsed - entry.born;
        entry.uniforms.uPointScale.value = height * pixelRatio;
      }
      for (const [entry, sweep] of dissolving) {
        sweep.elapsed += delta;
        sweep.progress = Math.min(1, sweep.elapsed / PART_DISSOLVE_MS);
        entry.uniforms.uDissolveProgress.value = sweep.progress;
        setPrintProgress(entry, sweep.fromProgress * (1 - sweep.progress));
        if (sweep.progress === 1) {
          entry.mesh.visible = false;
          entry.uniforms.uDissolveEnabled.value = 0;
          entry.uniforms.uPrintEnabled.value = 0;
          entry.geometry.setDrawRange(0, entry.count);
          dissolving.delete(entry);
        }
      }
      if (forming) {
        forming.elapsed += delta;
        forming.progress = Math.min(1, forming.elapsed / duration);
        const { entry, progress } = forming;
        setPrintProgress(entry, progress);
        if (progress === 1) {
          entry.uniforms.uPrintEnabled.value = 0;
          entry.group.visible = false;
          forming = null;
        }
      }
      return !reduceMotion;
    },
    get count() { return selected || assemblyProgress !== null ? entries.reduce((sum, entry) => sum + (entry.group.visible ? entry.geometry.drawRange.count : 0), 0) : 0; },
    get assembling() { return assemblyProgress !== null; },
    get assemblyProgress() { return assemblyProgress ?? 1; },
    get forming() { return !!forming; },
    get dissolvingCount() { return dissolving.size; },
    get dissolveProgress() { return dissolving.size ? Math.min(...Array.from(dissolving.values(), sweep => sweep.progress)) : 1; },
    get dissolveDurationMs() { return PART_DISSOLVE_MS; },
    get progress() { return forming?.progress ?? 1; },
    get durationMs() { return duration; },
    get time() { return elapsed; },
    dispose() {
      for (const { mesh, group, uniforms } of entries) {
        uniforms.uPrintEnabled.value = 0;
        uniforms.uDissolveEnabled.value = 0;
        mesh.visible = true;
        for (const object of group.children) { object.geometry.dispose(); object.material.dispose(); }
      }
      scene.remove(root);
    },
  };
}

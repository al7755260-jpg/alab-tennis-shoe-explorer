import * as THREE from 'three';

export const PRINT_DURATION_MS = 10800;
export const PART_PRINT_SPEED = 2;
export const PART_DISSOLVE_MS = PRINT_DURATION_MS / PART_PRINT_SPEED / 2;
export const RESET_GROW_MS = PRINT_DURATION_MS / PART_PRINT_SPEED;
// Conservative normalized bound, also used by the intro's CPU visibility culling.
export const PRINT_WARP_BOUND = 0.86;

export function printWarpStrength(progress) {
  return THREE.MathUtils.smoothstep(progress, 0, 0.12) * (1 - THREE.MathUtils.smoothstep(progress, 0.86, 1));
}

// Smooth domain-warped noise creates rounded lobes and channels instead of a
// horizontal cut. The solid reveal and all its particles use this same field.
const liquidFront = /* glsl */`
float liquidHash(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
float liquidNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  vec2 blend = f * f * (3.0 - 2.0 * f);
  return mix(mix(liquidHash(cell), liquidHash(cell + vec2(1.0, 0.0)), blend.x),
             mix(liquidHash(cell + vec2(0.0, 1.0)), liquidHash(cell + vec2(1.0)), blend.x), blend.y);
}
float printAhead(vec3 p, float front, float time, float scale, float strength) {
  float ahead = (p.y - front) / scale;
  // Skip noise far away from the visible frontier.
  if (strength < 0.001 || ahead < -1.1 || ahead > 2.72) return ahead;
  vec2 uv = p.xz * (1.35 / sqrt(max(scale, 0.04)));
  vec2 drift = vec2(time * 0.16, -time * 0.12);
  vec2 warp = vec2(liquidNoise(uv * 0.65 + drift),
                   liquidNoise(uv * 0.65 - drift + vec2(7.3, 11.8))) - 0.5;
  float lobes = liquidNoise(uv + warp * 1.4 + drift);
  float detail = liquidNoise(uv * 2.35 - drift * 1.3 + vec2(13.1, 2.6));
  float offset = (smoothstep(0.18, 0.82, lobes) - 0.5) * 1.4 + (detail - 0.5) * 0.32;
  return ahead - offset * strength;
}
`;

// Shared by the opening assembly and the selected part's materialization.
export const printParticleFlow = liquidFront + /* glsl */`
vec3 printParticle(vec3 target, vec3 normal, float seed, float tail,
                   float time, float ahead, float fade, float scale,
                   out float alpha, out vec3 tint) {
  float spread = smoothstep(-0.015, 0.7, ahead);
  float phase = target.x * 3.2 + target.z * 4.7 + time * 1.8;
  float curl = phase + seed * 6.28318;
  vec3 flow = vec3(
    sin(phase + tail * 1.7) * 0.42 + cos(curl) * 0.13,
    sin(phase * 0.7 + target.z * 3.0) * 0.14,
    cos(phase * 0.85 + tail * 2.0) * 0.38 + sin(curl) * 0.12
  );
  flow += normal * (0.09 + seed * 0.24);
  flow += vec3(-0.5, 0.1, 0.16) * tail;
  alpha = smoothstep(-0.12, 0.025, ahead)
    * (1.0 - smoothstep(0.9, 1.85, ahead)) * fade;
  tint = mix(vec3(0.38, 0.78, 0.69), vec3(0.85, 0.94, 1.0), seed);
  return target + flow * spread * scale;
}
`;

export function installPrintReveal(material, uniforms) {
  const printUniforms = {
    uPrintEnabled: { value: 1 },
    uPrintSpace: { value: new THREE.Matrix4() },
    uPrintScale: { value: 1 },
    uPrintTime: uniforms.uTime || { value: 0 },
    uPrintWarp: { value: 0 },
    ...uniforms,
  };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, printUniforms);
    shader.vertexShader = `uniform mat4 uPrintSpace;\nvarying vec3 vPrintPosition;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvPrintPosition = (uPrintSpace * modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
    shader.fragmentShader = liquidFront + /* glsl */`
      uniform float uFront;
      uniform float uPrintEnabled;
      uniform float uPrintScale;
      uniform float uPrintTime;
      uniform float uPrintWarp;
      varying vec3 vPrintPosition;
      float printNoise(vec3 p) { return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', /* glsl */`
      #include <clipping_planes_fragment>
      float printEdge = (uFront - vPrintPosition.y) / uPrintScale;
      float printGrain = 0.0;
      if (uPrintEnabled > 0.5) {
        if (printEdge < -0.86 * uPrintWarp) discard;
        if (printEdge < 0.86 * uPrintWarp + 0.23) {
          printEdge = -printAhead(vPrintPosition, uFront, uPrintTime, uPrintScale, uPrintWarp);
        }
        if (printEdge < 0.0) discard;
        printGrain = printEdge < 0.065 ? printNoise(floor(vPrintPosition * 150.0 / uPrintScale)) : 0.0;
        if (printEdge < printGrain * 0.035) discard;
      }
    `).replace('#include <emissivemap_fragment>', /* glsl */`
      #include <emissivemap_fragment>
      if (uPrintEnabled > 0.5 && printEdge < 0.22) {
        float printBand = 1.0 - smoothstep(0.01, 0.065, printEdge);
        float layer = pow(0.5 + 0.5 * cos(printEdge * 680.0), 12.0);
        totalEmissiveRadiance += vec3(0.52, 0.82, 0.87) * printBand * (0.3 + printGrain * 1.2);
        totalEmissiveRadiance += vec3(0.08, 0.12, 0.14) * layer * (1.0 - smoothstep(0.03, 0.22, printEdge));
      }
    `);
  };
  material.customProgramCacheKey = () => 'liquid-front-print-v7';
  material.needsUpdate = true;
}

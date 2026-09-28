import * as THREE from 'three';

export const PRINT_DURATION_MS = 10800;
export const PART_PRINT_SPEED = 2;

// Shared by the opening assembly and the selected part's materialization.
export const printParticleFlow = /* glsl */`
vec3 printParticle(vec3 target, vec3 normal, float seed, float tail,
                   float time, float front, float fade, float scale,
                   out float alpha, out vec3 tint) {
  float ahead = (target.y - front) / scale;
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
    ...uniforms,
  };
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, printUniforms);
    shader.vertexShader = `uniform mat4 uPrintSpace;\nvarying vec3 vPrintPosition;\n${shader.vertexShader}`.replace(
      '#include <project_vertex>',
      '#include <project_vertex>\nvPrintPosition = (uPrintSpace * modelMatrix * vec4(transformed, 1.0)).xyz;',
    );
    shader.fragmentShader = /* glsl */`
      uniform float uFront;
      uniform float uPrintEnabled;
      uniform float uPrintScale;
      varying vec3 vPrintPosition;
      float printNoise(vec3 p) { return fract(sin(dot(p, vec3(127.1,311.7,74.7))) * 43758.5453); }
    ` + shader.fragmentShader;
    shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>', /* glsl */`
      #include <clipping_planes_fragment>
      float printEdge = (uFront - vPrintPosition.y) / uPrintScale;
      float printGrain = 0.0;
      if (uPrintEnabled > 0.5) {
        if (printEdge < 0.0) discard;
        printGrain = printEdge < 0.065 ? printNoise(floor(vPrintPosition * 150.0 / uPrintScale)) : 0.0;
        if (printEdge < printGrain * 0.035) discard;
      }
    `).replace('#include <emissivemap_fragment>', /* glsl */`
      #include <emissivemap_fragment>
      if (uPrintEnabled > 0.5 && printEdge < 0.22) {
        float printBand = 1.0 - smoothstep(0.01, 0.065, printEdge);
        float layer = pow(0.5 + 0.5 * cos(vPrintPosition.y * 680.0 / uPrintScale), 12.0);
        totalEmissiveRadiance += vec3(0.52, 0.82, 0.87) * printBand * (0.3 + printGrain * 1.2);
        totalEmissiveRadiance += vec3(0.08, 0.12, 0.14) * layer * (1.0 - smoothstep(0.03, 0.22, printEdge));
      }
    `);
  };
  material.customProgramCacheKey = () => 'bottom-up-print-v4';
  material.needsUpdate = true;
}

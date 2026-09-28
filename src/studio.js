import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';

// A dark photographic studio: restrained front fill and broad cool rim softboxes.
// The light panels exist only in the reflection environment, never as UI scenery.
export function createStudio(scene, renderer) {
  // A static studio backdrop: a soft charcoal halo, not a physical ground plane.
  const backdrop = document.createElement('canvas');
  backdrop.width = backdrop.height = 512;
  const ctx = backdrop.getContext('2d');
  ctx.fillStyle = '#030407'; ctx.fillRect(0, 0, 512, 512);
  const halo = ctx.createRadialGradient(296, 240, 12, 278, 246, 325);
  halo.addColorStop(0, '#171c23');
  halo.addColorStop(0.36, '#10151c');
  halo.addColorStop(0.72, '#080b10');
  halo.addColorStop(1, '#030407');
  ctx.fillStyle = halo; ctx.fillRect(0, 0, 512, 512);
  const background = new THREE.CanvasTexture(backdrop);
  background.colorSpace = THREE.SRGBColorSpace;
  background.generateMipmaps = false;
  background.minFilter = THREE.LinearFilter;
  scene.background = background;

  RectAreaLightUniformsLib.init();
  const environment = new THREE.Scene();
  environment.background = new THREE.Color('#010203');
  function panel(position, width, height, strength, color) {
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(strength), side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
    mesh.position.set(...position); mesh.lookAt(0,0,0); environment.add(mesh);
  }
  panel([-4,7,3], 6, 4, 6, '#eef3ff');
  panel([4,3,-4], 1.2, 7, 9, '#d9e6ff');
  panel([-5,1,-2], 2, 5, 4, '#eaf0ff');
  panel([0,2,7], 5, 3, 0.6, '#ffffff');
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(environment, 0.035).texture;
  scene.environmentIntensity = 0.55;
  pmrem.dispose();
  environment.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });

  function softbox(position, width, height, intensity, color) {
    const light = new THREE.RectAreaLight(color, intensity, width, height);
    light.position.set(...position); light.lookAt(0,0.4,0); scene.add(light);
  }
  softbox([-4,7,4], 6, 4, 4.0, '#edf3ff');
  softbox([4,4,-4], 2, 7, 6.5, '#d6e5ff');
  softbox([1,0,7], 5, 3, 0.45, '#e8edf7');
  scene.add(new THREE.HemisphereLight('#b9cdeb', '#020304', 0.07));

  // No floor or shadow plane: every viewing angle stays clear of the components.
}

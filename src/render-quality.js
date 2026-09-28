import * as THREE from 'three';

// Cache both paths before interaction: a drag must not allocate materials or decode a model.
export function createRenderQuality(scene, meshes, motionGeometries) {
  const lights = new THREE.Group();
  const key = new THREE.DirectionalLight('#eef3ff', 2.2);
  key.position.set(-4, 7, 4);
  const rim = new THREE.DirectionalLight('#d9e9ff', 1.35);
  rim.position.set(4, 4, -4);
  lights.add(key, rim, new THREE.HemisphereLight('#dbe7f5', '#131923', 0.35));
  lights.visible = false;
  scene.add(lights);
  const materials = new Map(meshes.map(mesh => [mesh, {
    detail: mesh.material,
    motion: new THREE.MeshPhongMaterial({
      color: mesh.material.color,
      specular: '#7e8e9e', shininess: 38,
      emissive: '#172331', emissiveIntensity: 0.12,
      opacity: mesh.material.opacity, transparent: mesh.material.transparent,
      side: THREE.DoubleSide, forceSinglePass: true,
    }),
  }]));
  let moving = false;

  function refresh(selected, highDetail) {
    for (const mesh of meshes) {
      const pair = materials.get(mesh);
      const material = moving ? pair.motion : pair.detail;
      mesh.material = material;
      material.opacity = mesh.userData.originalOpacity;
      material.transparent = mesh.userData.originalTransparent;
      material.depthWrite = true;
      mesh.geometry = moving ? motionGeometries?.get(mesh.userData.part_id) || mesh.userData.previewGeometry
        : selected === mesh && highDetail?.has(mesh.userData.part_id) ? highDetail.get(mesh.userData.part_id) : mesh.userData.previewGeometry;
      if ('transmission' in material) {
        // The green insert has only 9.5% transmission. Its extra scene/back-face
        // passes are too costly now that the surrounding noise animates continuously.
        // Keep original color, roughness, IOR and full geometry; use studio reflections.
        material.transmission = 0;
      }
      material.needsUpdate = true;
    }
  }

  return {
    refresh,
    materialsFor(mesh) { return Object.values(materials.get(mesh)); },
    setMoving(next, selected, highDetail) {
      if (moving === next) return false;
      moving = next;
      lights.visible = moving;
      refresh(selected, highDetail);
      return true;
    },
    get moving() { return moving; },
    dispose() {
      scene.remove(lights);
      for (const { motion } of materials.values()) motion.dispose();
    },
  };
}

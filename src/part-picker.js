import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

// Stable picking surfaces are independent of render LOD and particle visibility.
// Build once while loading, never inside a pointer event or focus transition.
export async function createPartPicker(meshes, yieldTask = () => new Promise(resolve => setTimeout(resolve, 0))) {
  const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const entries = [];
  for (const mesh of meshes) {
    const geometry = mesh.userData.previewGeometry || mesh.geometry;
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    if (!geometry.boundsTree) geometry.boundsTree = new MeshBVH(geometry, { indirect: true, targetLeafSize: 8 });
    const proxy = new THREE.Mesh(geometry, material);
    proxy.matrixAutoUpdate = false;
    proxy.raycast = acceleratedRaycast;
    proxy.userData.source = mesh;
    entries.push(proxy);
    await yieldTask();
  }
  const hits = [];
  return {
    pick(raycaster) {
      for (const proxy of entries) {
        const mesh = proxy.userData.source;
        mesh.updateWorldMatrix(true, false);
        proxy.matrixWorld.copy(mesh.matrixWorld);
      }
      const firstHitOnly = raycaster.firstHitOnly;
      raycaster.firstHitOnly = true;
      hits.length = 0;
      try {
        raycaster.intersectObjects(entries, false, hits);
        const hit = hits[0];
        if (hit) hit.object = hit.object.userData.source;
        return hit;
      } finally { raycaster.firstHitOnly = firstHitOnly; }
    },
    dispose() {
      material.dispose();
      for (const proxy of entries) proxy.geometry.boundsTree = null;
      entries.length = 0;
    },
  };
}

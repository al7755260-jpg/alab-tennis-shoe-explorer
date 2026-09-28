import * as THREE from 'three';

const turn = new THREE.Quaternion();
const identity = new THREE.Quaternion();
const shifted = new THREE.Vector3();
const axisY = new THREE.Vector3(0, 1, 0);
const orbitTurn = new THREE.Quaternion();
const spinTurn = new THREE.Quaternion();
const orbitCenter = new THREE.Vector3();
const wrapAngle = angle => THREE.MathUtils.euclideanModulo(angle + Math.PI, Math.PI * 2) - Math.PI;

export function prepareExplodeLayout(mesh, part) {
  const base = mesh.matrix.clone();
  mesh.geometry.computeBoundingBox();
  const pivot = mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(base);
  const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(...part.tilt.map(THREE.MathUtils.degToRad)));
  mesh.userData.explodeLayout = {
    position: mesh.position.clone(), quaternion: mesh.quaternion.clone(), pivot, tilt,
    offset: new THREE.Vector3(...part.offset), scatter: new THREE.Vector3(...part.scatter),
    spinRate: 0.038 + Number(mesh.userData.part_id.slice(-2)) * 0.0025,
  };
}

export function configureExplodeOrbit(meshes) {
  const center = meshes.find(mesh => mesh.userData.part_id === 'part_05').userData.explodeLayout;
  orbitCenter.copy(center.pivot).add(center.offset).add(center.scatter);
}

export function captureAssemblyLayout(meshes) {
  return meshes.map(mesh => ({ mesh, position: mesh.position.clone(), quaternion: mesh.quaternion.clone() }));
}

export function applyAssemblyLayout(poses, progress) {
  const travel = THREE.MathUtils.smoothstep(progress, 0, 1);
  for (const { mesh, position, quaternion } of poses) {
    const rest = mesh.userData.explodeLayout;
    mesh.position.lerpVectors(position, rest.position, travel);
    mesh.quaternion.slerpQuaternions(quaternion, rest.quaternion, travel);
  }
}

export function applyExplodeLayout(mesh, amount, orbitTime = 0) {
  const layout = mesh.userData.explodeLayout;
  // A single uninterrupted curve: clear the assembled contacts early and ease
  // into the final pose, with tilt gradually increasing throughout the move.
  const separation = 1 - Math.pow(1 - THREE.MathUtils.clamp(amount, 0, 1), 4);
  const flourish = separation * separation * separation;
  turn.slerpQuaternions(identity, layout.tilt, flourish);
  const orbitWeight = THREE.MathUtils.smoothstep(amount, 0.65, 1);
  orbitTurn.setFromAxisAngle(axisY, wrapAngle(orbitTime * 0.055) * orbitWeight);
  spinTurn.setFromAxisAngle(axisY, wrapAngle(orbitTime * layout.spinRate) * orbitWeight);
  turn.premultiply(spinTurn);
  // Rotate about each part's own center in its parent's space, preserving its
  // original scale and Blender transform. Returning to zero is exact.
  shifted.copy(layout.position).sub(layout.pivot).applyQuaternion(turn).add(layout.pivot);
  mesh.position.copy(shifted).addScaledVector(layout.offset, separation).addScaledVector(layout.scatter, separation);
  mesh.quaternion.copy(turn).multiply(layout.quaternion);
  mesh.position.sub(orbitCenter).applyQuaternion(orbitTurn).add(orbitCenter);
  mesh.quaternion.premultiply(orbitTurn);
}

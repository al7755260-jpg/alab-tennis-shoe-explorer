// Offsets are expressed in the normalized shoe's world space (Y is up).
// Continuous paths end in a composed constellation with space for self rotation.
// Scatter is intentionally composed, not re-randomized on every click.
export const PARTS = {
  part_01: { label: '中底网格', offset: [0, -2.0, 0], phase: [0, 0.28], scatter: [-0.8, -0.55, 0.45], tilt: [6, -12, 9] },
  part_02: { label: '鞋面组件 · 02', offset: [0, 3.35, 0], phase: [0, 0.22], scatter: [0.55, 0.6, -0.3], tilt: [-8, 17, -11] },
  part_03: { label: '鞋面组件 · 03', offset: [0, 2.3, 0], phase: [0.14, 0.38], scatter: [-0.65, 0.35, 0.55], tilt: [7, -18, 13] },
  part_04: { label: '侧面支撑片 · 04', offset: [0, 0, 2.0], phase: [0, 0.25], scatter: [-0.8, 0.45, 1.1], tilt: [18, -15, -14] },
  part_05: { label: '外层鞋面 · 05', offset: [0, 0, 0], phase: [0, 1], scatter: [0.12, 0, 0], tilt: [-3, -7, 3] },
  part_06: { label: '底部承托层 · 06', offset: [0, -0.95, 0], phase: [0.28, 0.6], scatter: [0.65, -0.15, -0.35], tilt: [-4, 14, -6] },
  part_07: { label: '内层鞋面 · 07', offset: [0, 1.36, 0], phase: [0.3, 0.65], scatter: [0.55, 0.3, -0.35], tilt: [6, 12, -8] },
  part_08: { label: '足弓嵌件 · 08', offset: [0, -0.45, -2.35], phase: [0.6, 0.95], scatter: [-0.35, -0.25, -1.5], tilt: [-18, 18, 13] },
  part_10: { label: '侧面标识 · 10', offset: [0, 0, -1.4], phase: [0, 0.2], scatter: [0.55, 0.35, -0.3], tilt: [10, -20, 15] },
  part_11: { label: '鞋底标识 · 11', offset: [1.4, -2.0, 1.6], phase: [0, 0.2], scatter: [0.3, 0.7, 1.0], tilt: [-15, 10, -18] },
};

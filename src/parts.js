// Offsets are expressed in the normalized shoe's world space (Y is up).
// Geometry and source names are retained from the supplied Blender assembly.
export const PARTS = {
  part_01: { label: '中底网格', offset: [0, -2.0, 0], phase: [0, 0.28] },
  part_02: { label: '鞋面组件 · 02', offset: [0, 3.35, 0], phase: [0, 0.22] },
  part_03: { label: '鞋面组件 · 03', offset: [0, 2.3, 0], phase: [0.14, 0.38] },
  part_04: { label: '侧面支撑片 · 04', offset: [0, 0, 2.0], phase: [0, 0.25] },
  part_05: { label: '外层鞋面 · 05', offset: [0, 0, 0], phase: [0, 1] },
  part_06: { label: '底部承托层 · 06', offset: [0, -0.95, 0], phase: [0.28, 0.6] },
  part_07: { label: '内层鞋面 · 07', offset: [0, 1.36, 0], phase: [0.3, 0.65] },
  part_08: { label: '足弓嵌件 · 08', offset: [0, -0.45, -2.35], phase: [0.6, 0.95] },
  part_10: { label: '侧面标识 · 10', offset: [0, 0, -1.4], phase: [0, 0.2] },
  part_11: { label: '鞋底标识 · 11', offset: [1.4, -2.0, 1.6], phase: [0, 0.2] },
};

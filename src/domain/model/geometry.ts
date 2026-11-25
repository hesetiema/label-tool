/**
 * ============================================================
 * 几何基础类型 —— domain 层的最底砖
 * ============================================================
 *
 * 这里刻意不 import `core/types`：
 *   `Box3D` 是"框 + 身份 + 任务"的混合体，而关键帧只需要纯几何。
 *   把几何单独定义出来，才能让 `Keyframe` 不携带 id/label，
 *   避免同一份几何在不同层被写两遍（方案 4.1 的设计理由）。
 *
 * 与 `core/types.ts` 的同构关系是硬约束：
 *   { position, scale, yaw } 三个字段名、坐标系、单位完全一致，
 *   因此 `toGeometry(box)` / `applyGeometry(box, geo)` 是零成本转换。
 */

export interface Vec3 {
  x: number
  y: number
  z: number
}

/** 与 Box3D 的 position/scale/yaw 完全同构 */
export interface BoxGeometry {
  position: Vec3
  scale: Vec3
  yaw: number
}

/** 自车位姿：位置 + 欧拉角（弧度）。旋转顺序固定 Z→Y→X，写进约定 */
export interface Pose {
  position: Vec3
  rotation: { x: number; y: number; z: number }
}

/** 只要求几何三字段，便于直接接收 Box3D / Box3DView 而不产生类型依赖 */
export interface BoxGeometryLike {
  position: Vec3
  scale: Vec3
  yaw: number
}

export function cloneVec3(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z }
}

export function cloneGeometry(g: BoxGeometry): BoxGeometry {
  return {
    position: cloneVec3(g.position),
    scale: cloneVec3(g.scale),
    yaw: g.yaw,
  }
}

/** Box3D → 纯几何（拷贝，不共享引用） */
export function toGeometry(box: BoxGeometryLike): BoxGeometry {
  return {
    position: cloneVec3(box.position),
    scale: cloneVec3(box.scale),
    yaw: box.yaw,
  }
}

/** 把几何写回一个已有对象，保持对象引用不变（渲染层缓存依赖这一点） */
export function applyGeometry<T extends BoxGeometryLike>(target: T, g: BoxGeometryLike): T {
  target.position.x = g.position.x
  target.position.y = g.position.y
  target.position.z = g.position.z
  target.scale.x = g.scale.x
  target.scale.y = g.scale.y
  target.scale.z = g.scale.z
  target.yaw = g.yaw
  return target
}

/**
 * 几何是否真的变了。
 *
 * 用 1e-6 的绝对容差而不是严格相等：滑杆/拖拽产生的浮点尾数差异
 * 不该被当成一次编辑记进历史，否则"点一下没动"也会产生撤销步。
 */
export function geometryEquals(a: BoxGeometryLike, b: BoxGeometryLike, eps = 1e-6): boolean {
  return (
    Math.abs(a.position.x - b.position.x) < eps &&
    Math.abs(a.position.y - b.position.y) < eps &&
    Math.abs(a.position.z - b.position.z) < eps &&
    Math.abs(a.scale.x - b.scale.x) < eps &&
    Math.abs(a.scale.y - b.scale.y) < eps &&
    Math.abs(a.scale.z - b.scale.z) < eps &&
    Math.abs(angleDelta(a.yaw, b.yaw)) < eps
  )
}

/** 规范到 (-π, π]。与 `core/sequence/sequence.ts` 的 lerpAngle 同一套绕圈逻辑 */
export function normalizeAngle(a: number): number {
  let x = a
  while (x > Math.PI) x -= 2 * Math.PI
  while (x <= -Math.PI) x += 2 * Math.PI
  return x
}

/** 从 from 到 to 的最短有向角差，落在 (-π, π] */
export function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from)
}

/** 走最短弧的角度插值 */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDelta(a, b) * t
}

/** 两关键帧尺寸的逐轴中位数 —— 刚体目标的"尺寸恒定"策略 */
export function medianScale(a: BoxGeometryLike, b: BoxGeometryLike): Vec3 {
  return {
    x: (a.scale.x + b.scale.x) / 2,
    y: (a.scale.y + b.scale.y) / 2,
    z: (a.scale.z + b.scale.z) / 2,
  }
}

/** 点乘/欧氏距离只在这里出现一次，避免各算法文件各写一份 */
export function distance(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/**
 * 三次 Hermite 基函数。
 * m0/m1 是"整段跨度内的位移量"，不是速度——调用方必须把 v(米/帧) 乘以 span。
 */
export function hermite(p0: number, p1: number, m0: number, m1: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
}

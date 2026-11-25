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

/* ------------------------------------------------------------------
 * BEV 重叠度（IoU）
 *
 * 【为什么自己写而不是复用跟踪器的距离度量】
 *   跟踪器用的是"中心距 + 尺寸差"的代价，没有面积重叠。预标注合并要回答的是
 *   "模型框和人工框是不是同一个物体"，IoU 是这一行的通用语言，
 *   也是方案 5.2.2 里 `iouThreshold` 的单位。两套度量混用会让阈值失去意义。
 *
 * 【为什么在 BEV 上算】3D IoU 需要判断高度重叠，而点云里目标的 z 常常只有
 *   一两层点，高度估计比水平位置不可靠得多。BEV IoU 对"车头压线"这种
 *   常见情形更稳定，也正是模型评测（KITTI BEV AP）的口径。
 * ------------------------------------------------------------------ */

/** 车体在 BEV 上的四个角，逆时针（与 `core/geometry/box.ts` 的 yaw 约定一致） */
export function bevCorners(g: BoxGeometryLike): Array<{ x: number; y: number }> {
  const c = Math.cos(g.yaw)
  const s = Math.sin(g.yaw)
  const hx = g.scale.x / 2
  const hy = g.scale.y / 2
  const local: Array<[number, number]> = [[hx, -hy], [hx, hy], [-hx, hy], [-hx, -hy]]
  return local.map(([lx, ly]) => ({
    x: g.position.x + lx * c - ly * s,
    y: g.position.y + lx * s + ly * c,
  }))
}

function polygonArea(poly: Array<{ x: number; y: number }>): number {
  let sum = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

/**
 * 用凸多边形 `clip` 裁 `subject`（Sutherland–Hodgman）。
 *
 * 两个矩形都是凸的，所以裁剪结果仍是凸多边形。不做通用多边形布尔运算：
 * 那需要处理自交、洞、退化边，代码量是这里的十倍，而输入永远是矩形。
 *
 * 用"内侧"判定而不是"左右手"判定：即使调用方给的顶点顺序突然变成顺时针，
 * 结果依然正确 —— 输入顺序由 `bevCorners` 保证，但裁剪函数不该依赖它。
 */
function clipConvex(
  subject: Array<{ x: number; y: number }>,
  clip: Array<{ x: number; y: number }>,
): Array<{ x: number; y: number }> {
  let out = subject
  // 顶点是逆时针时"内侧"在边的左侧；`bevCorners` 给的就是逆时针，
  // 这里仍然现算一次，避免有人改了角点顺序后裁剪静默出错
  const ccw = signedArea(clip) > 0
  for (let i = 0; i < clip.length && out.length; i++) {
    const a = clip[i]
    const b = clip[(i + 1) % clip.length]
    const input = out
    out = []
    const inside = (p: { x: number; y: number }) => {
      const cross = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
      return ccw ? cross >= -1e-9 : cross <= 1e-9
    }
    for (let j = 0; j < input.length; j++) {
      const cur = input[j]
      const prev = input[(j + input.length - 1) % input.length]
      const curIn = inside(cur)
      const prevIn = inside(prev)
      if (curIn) {
        if (!prevIn) out.push(intersect(prev, cur, a, b))
        out.push(cur)
      } else if (prevIn) {
        out.push(intersect(prev, cur, a, b))
      }
    }
  }
  return out
}

function signedArea(poly: Array<{ x: number; y: number }>): number {
  let sum = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    sum += a.x * b.y - b.x * a.y
  }
  return sum / 2
}

/** 线段 p→q 与直线 a→b 的交点（裁剪时两条边一定相交，退化时返回 q） */
function intersect(
  p: { x: number; y: number },
  q: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  const r = { x: q.x - p.x, y: q.y - p.y }
  const s = { x: b.x - a.x, y: b.y - a.y }
  const denom = r.x * s.y - r.y * s.x
  if (Math.abs(denom) < 1e-12) return { x: q.x, y: q.y }
  const t = ((a.x - p.x) * s.y - (a.y - p.y) * s.x) / denom
  return { x: p.x + r.x * t, y: p.y + r.y * t }
}

/**
 * BEV IoU，落在 [0, 1]。
 *
 * 退化输入（尺寸为 0 或 NaN）返回 0 而不是抛错：合并时遇到的脏框应当
 * "不参与匹配"，而不是让整批预标注失败。
 */
export function bevIoU(a: BoxGeometryLike, b: BoxGeometryLike): number {
  const areaA = a.scale.x * a.scale.y
  const areaB = b.scale.x * b.scale.y
  if (!(areaA > 0) || !(areaB > 0)) return 0
  if (!Number.isFinite(a.position.x) || !Number.isFinite(b.position.x)) return 0
  const polyA = bevCorners(a)
  const polyB = bevCorners(b)
  const inter = polygonArea(clipConvex(polyA, polyB))
  const union = areaA + areaB - inter
  if (!(union > 0)) return 0
  const iou = inter / union
  return Number.isFinite(iou) ? Math.min(1, Math.max(0, iou)) : 0
}

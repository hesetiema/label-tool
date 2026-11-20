/**
 * ============================================================
 * 多帧时序 —— 跟踪关联与轨迹插值
 * ============================================================
 *
 * 【为什么这一层是自动驾驶标注区别于普通图像标注的关键】
 *   单帧标注只需回答"这一帧有什么"；时序标注要回答"同一目标在连续帧里在哪"。
 *    obj_id 跨帧一致性是感知模型训练时序模块（跟踪、预测）的前提。
 *
 * 【本模块实现三个核心能力】
 *   1. lerpAngle / lerpBox：带角度跨界处理的插值（yaw 从 +3.1 到 -3.1 实际只转了 0.08 弧度，
 *      直接线性插值会绕远路 6.2 弧度 —— 这是新手必踩的坑）
 *   2. associateNearest：最近邻数据关联，给新帧的框匹配上一帧的 obj_id
 *   3. interpolateTracks：标首末帧、自动补全中间帧（原仓库 batch 模式的原理）
 *
 * 【生产环境 vs 本实现】
 *   生产系统用 Hungarian 匹配 + Kalman 滤波预测位置，处理遮挡与密集目标；
 *   这里用贪心最近邻 + 线性插值，算法简单但能讲清楚问题的本质。
 */
import type { Box3D, PointCloud } from './types'
import { addBoxSurface, makeRng } from './sample'

/** 一帧数据：点云 + 这一帧的标注框 */
export interface FrameData {
  index: number
  cloud: PointCloud
  boxes: Box3D[]
}

/**
 * 角度线性插值：走最短弧。
 * 常规 lerp 在 ±π 边界会突然绕一大圈，这里先把角度差规范到 [-π, π]。
 */
export function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

/** 两个框之间线性插值，生成中间帧的框（保留首尾框的 id 与类别） */
export function lerpBox(a: Box3D, b: Box3D, t: number): Box3D {
  const mix = (p: number, q: number) => p + (q - p) * t
  return {
    id: a.id,
    label: a.label,
    position: {
      x: mix(a.position.x, b.position.x),
      y: mix(a.position.y, b.position.y),
      z: mix(a.position.z, b.position.z),
    },
    scale: {
      x: mix(a.scale.x, b.scale.x),
      y: mix(a.scale.y, b.scale.y),
      z: mix(a.scale.z, b.scale.z),
    },
    yaw: lerpAngle(a.yaw, b.yaw, t),
  }
}

/**
 * 最近邻关联：把当前帧的框与上一帧的框按中心距离配对，继承 obj_id。
 * 贪心实现：算出所有配对的距离，从小到大依次确认，每个框只用一次。
 * 直接修改传入的 curr 数组（给框赋 id）。返回成功关联的数量。
 */
export function associateNearest(prev: Box3D[], curr: Box3D[], maxDist = 6): number {
  const candidates: { pi: number; ci: number; d: number }[] = []
  for (let ci = 0; ci < curr.length; ci++) {
    for (let pi = 0; pi < prev.length; pi++) {
      const dx = curr[ci].position.x - prev[pi].position.x
      const dy = curr[ci].position.y - prev[pi].position.y
      const dz = curr[ci].position.z - prev[pi].position.z
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (d <= maxDist) candidates.push({ pi, ci, d })
    }
  }
  candidates.sort((a, b) => a.d - b.d)
  const usedPrev = new Set<number>()
  const usedCurr = new Set<number>()
  let count = 0
  for (const c of candidates) {
    if (usedPrev.has(c.pi) || usedCurr.has(c.ci)) continue
    // 只给尚未分配 id（或 id 为空）的框关联
    if (curr[c.ci].id && curr[c.ci].id !== '?') continue
    curr[c.ci].id = prev[c.pi].id
    usedPrev.add(c.pi)
    usedCurr.add(c.ci)
    count++
  }
  return count
}

/** 轨迹上的一个采样点：某帧里某个目标的中心位置 */
export interface TrackPoint {
  frame: number
  x: number
  y: number
  z: number
  /** 该帧的可见性，predicted/occluded 的点不参与位移精度检测 */
  visibility?: Box3D['visibility']
}

/** 一条轨迹：同一 obj_id 跨帧出现的有序点列 */
export interface Trajectory {
  id: string
  label: string
  points: TrackPoint[]
}

/**
 * 跨帧编辑传播范围
 * - all:     传播到所有帧（含当前帧外的每一帧）
 * - forward: 只传播到当前帧之后（把当前框的修正带到后续轨迹）
 * - backward:只传播到当前帧之前
 */
export type PropagateScope = 'all' | 'forward' | 'backward'

/**
 * 跨帧编辑：把"当前帧某个框"的修改传播到其他帧里同一个 obj_id 的框。
 *
 * 两种策略（面试常问的"改一帧怎么同步到其他帧"）：
 * - 'replace'：整框替换 —— 用当前框原样覆盖其他帧的同 id 框。
 *   适合"这个目标从头到尾尺寸/朝向就该是这样"的修正，但会抹掉各帧的位置差异。
 * - 'offset' ：增量平移 —— 计算当前框相对"当前帧原始框"的位移/朝向变化量，
 *   把这个增量叠加到其他帧的同 id 框上，保留它们各自的位置。
 *   适合"这个目标整体标注偏了 2 米"的整体修正，轨迹形状不变。
 *
 * @param frames 帧序列（会被原地修改）
 * @param currentFrame 当前帧号
 * @param boxId 要传播的 obj_id
 * @param referenceBox 当前帧编辑前的原始框（用于算 offset 增量）
 * @param editedBox 当前帧编辑后的框
 * @param scope 传播范围
 * @param strategy 传播策略
 * @returns 被修改的帧数
 */
export function propagateBox(
  frames: FrameData[],
  currentFrame: number,
  boxId: string,
  referenceBox: Box3D,
  editedBox: Box3D,
  scope: PropagateScope = 'all',
  strategy: 'replace' | 'offset' = 'replace',
): number {
  if (currentFrame < 0 || currentFrame >= frames.length) return 0

  // 增量：编辑后 - 编辑前（朝向走最短弧，避免 ±π 绕圈）
  let dx = 0, dy = 0, dz = 0, dyaw = 0
  if (strategy === 'offset') {
    dx = editedBox.position.x - referenceBox.position.x
    dy = editedBox.position.y - referenceBox.position.y
    dz = editedBox.position.z - referenceBox.position.z
    dyaw = lerpAngle(referenceBox.yaw, editedBox.yaw, 1) - referenceBox.yaw
  }

  let changed = 0
  frames.forEach((frame, fi) => {
    if (fi === currentFrame) return // 当前帧已经是编辑后的，跳过
    if (scope === 'forward' && fi < currentFrame) return
    if (scope === 'backward' && fi > currentFrame) return
    const box = frame.boxes.find((b) => b.id === boxId)
    if (!box) return

    if (strategy === 'replace') {
      const idx = frame.boxes.indexOf(box)
      frame.boxes[idx] = { ...editedBox } // 保留 id，整框替换
    } else {
      box.position.x += dx
      box.position.y += dy
      box.position.z += dz
      box.yaw += dyaw
    }
    changed++
  })
  return changed
}

/**
 * 轨迹提取：把帧序列里同一 obj_id 的框按帧号串成轨迹线数据。
 * 这是"轨迹叠加可视化"的数据源 —— 渲染层拿它把同目标的多帧中心点连成线。
 * 只保留出现 >= 2 帧的目标（单点连不成线）。
 */
export function extractTrajectories(frames: FrameData[]): Trajectory[] {
  const byId = new Map<string, Trajectory>()
  frames.forEach((frame, fi) => {
    for (const box of frame.boxes) {
      let tr = byId.get(box.id)
      if (!tr) {
        tr = { id: box.id, label: box.label, points: [] }
        byId.set(box.id, tr)
      }
      tr.points.push({
        frame: fi, x: box.position.x, y: box.position.y, z: box.position.z,
        visibility: box.visibility ?? 'visible',
      })
    }
  })
  return Array.from(byId.values())
    .filter((t) => t.points.length >= 2)
    .map((t) => ({ ...t, points: t.points.sort((a, b) => a.frame - b.frame) }))
}

/**
 * 轨迹插值：对每个 obj_id，找到它在哪些帧出现过，用相邻两次观测线性插值补全中间缺失帧。
 * 这就是"标首末帧、自动补齐"的核心 —— 标注员工作量从 N 帧降到 2 帧。
 * 返回新补出的框数量。
 */
export function interpolateTracks(frames: FrameData[], trackIds?: string[]): number {
  if (frames.length < 2) return 0
  const ids = trackIds ?? Array.from(new Set(frames.flatMap((f) => f.boxes.map((b) => b.id))))
  let added = 0

  for (const id of ids) {
    // 收集该轨迹的所有观测：{帧号, 框}
    const obs: { fi: number; box: Box3D }[] = []
    frames.forEach((frame, fi) => {
      const box = frame.boxes.find((b) => b.id === id)
      if (box) obs.push({ fi, box })
    })
    if (obs.length < 2) continue

    // 每对相邻观测之间，补出所有缺失帧
    for (let k = 0; k < obs.length - 1; k++) {
      const a = obs[k], b = obs[k + 1]
      for (let fi = a.fi + 1; fi < b.fi; fi++) {
        if (frames[fi].boxes.some((box) => box.id === id)) continue
        const t = (fi - a.fi) / (b.fi - a.fi)
        frames[fi].boxes.push(lerpBox(a.box, b.box, t))
        added++
      }
    }
  }
  return added
}

/** 演示帧序列的运动目标定义（速度单位 m/s） */
interface MovingSpec {
  id: string
  label: string
  cx: number; cy: number
  L: number; W: number; H: number
  yaw: number
  vx: number; vy: number
}

const DEMO_SPECS: MovingSpec[] = [
  { id: '1', label: 'Car',        cx: 18,  cy:  2.5, L: 4.5, W: 1.8, H: 1.5,  yaw: 0.05,          vx:  6.0, vy:  0.0 },
  { id: '2', label: 'Car',        cx:  6,  cy: -2.5, L: 4.6, W: 1.85,H: 1.55, yaw: Math.PI - 0.08,vx:  5.0, vy:  0.0 },
  { id: '3', label: 'Truck',      cx: 28,  cy:  2.5, L: 8.5, W: 2.5, H: 3.2,  yaw: 0.02,          vx:  4.0, vy:  0.0 },
  { id: '4', label: 'Pedestrian', cx:  2,  cy:  6.0, L: 0.6, W: 0.6, H: 1.75, yaw: 0,             vx:  0.0, vy: -1.2 },
  { id: '5', label: 'Rider',      cx: -8,  cy: -3.0, L: 2.0, W: 0.8, H: 1.7,  yaw: 0.3,           vx: -5.0, vy:  0.0 },
  { id: '6', label: 'Cyclist',    cx:-14,  cy:  2.0, L: 1.7, W: 0.6, H: 1.7,  yaw: Math.PI / 2,   vx: -4.0, vy:  0.0 },
]

/**
 * 生成演示帧序列：5 帧、每帧间隔 0.5 秒，目标按各自速度移动。
 *
 * 故意做成"稀疏标注"：只有前 3 个目标每帧都有框，后 3 个目标只在首末帧有框。
 * 这样点击"轨迹插值补全"能直观看到中间帧凭空多出 9 个框 —— 教学演示效果拉满。
 */
export function generateDemoSequence(frameCount = 5): FrameData[] {
  const frames: FrameData[] = []
  const dt = 0.5 // 帧间隔（秒）

  for (let f = 0; f < frameCount; f++) {
    const t = f * dt
    const pts: number[] = []

    // 地面每帧相同（真实场景中静止的地面对传感器来说也是同样的采样）
    const groundRng = makeRng(777)
    for (let i = 0; i < 5000; i++) {
      const x = (groundRng() - 0.5) * 80
      const y = (groundRng() - 0.5) * 60
      pts.push(x, y, (groundRng() - 0.5) * 0.05)
    }
    // 车道线
    for (let s = -35; s < 35; s += 2) {
      for (let d = 0; d < 12; d++) {
        for (const yLine of [-2.5, 2.5]) {
          pts.push(s + d * 0.08, yLine + (groundRng() - 0.5) * 0.1, 0.02)
        }
      }
    }

    const targetRng = makeRng(20261119 + f * 37) // 每帧点云噪声不同，模拟真实扫描
    const boxes: Box3D[] = []
    for (const [idx, sp] of DEMO_SPECS.entries()) {
      const cx = sp.cx + sp.vx * t
      const cy = sp.cy + sp.vy * t
      addBoxSurface(pts, cx, cy, 0, sp.L, sp.W, sp.H, sp.yaw, 14, targetRng)

      // 稀疏标注：首末帧 + 前三个目标全帧；后三个目标中间帧故意缺失
      const isLabeled = f === 0 || f === frameCount - 1 || idx < 3
      if (isLabeled) {
        boxes.push({
          id: sp.id,
          label: sp.label,
          position: { x: cx, y: cy, z: sp.H / 2 },
          scale: { x: sp.L, y: sp.W, z: sp.H },
          yaw: sp.yaw,
        })
      }
    }

    frames.push({
      index: f,
      cloud: { positions: new Float32Array(pts), count: pts.length / 3 },
      boxes,
    })
  }
  return frames
}

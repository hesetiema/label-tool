/**
 * ============================================================
 * 相机运镜轨迹 —— 借鉴 rviz_cinematographer 的 CameraTrajectory 模型
 * ============================================================
 *
 * 数据回放（第几帧）和镜头运动（相机在哪、看哪）是两条独立的时间线。
 * 这个模块只负责后者：把「若干关键帧 + 转场时间 + 停留时间」采样成连续的相机位姿。
 *
 * 核心概念对齐 rviz_cinematographer：
 *   CameraMovement  → CameraKeyframe（目标位姿 + transition + 停留）
 *   CameraTrajectory→ CameraTrajectory（一组关键帧 + 插值/循环参数）
 *
 * 关键设计：位姿用 position + target + roll 表示，而不是四元数。
 * 对标注工具来说「相机在哪、看向哪个点」比「绕任意轴转了多少度」直观得多，
 * 也更容易做 shortest-arc 的角度插值（roll 是绕视线方向的旋转）。
 */
import type { Vec3 } from '../types'

/** 一帧相机位姿：相机位置、注视点、绕视线的滚转角（弧度） */
export interface CameraPose {
  position: Vec3
  target: Vec3
  roll: number
}

/** 一个镜头关键帧，时间单位为秒 */
export interface CameraKeyframe {
  id: string
  pose: CameraPose
  /** 从上一关键帧运动到本关键帧所需时间；第一帧忽略 */
  transition: number
  /** 到达本关键帧后停留的时间 */
  hold: number
}

/** 运镜参数，对应 rviz 面板里的 Trajectory Parameters */
export interface TrajectoryOptions {
  /** 用 Catmull-Rom 样条替代线性插值，让路径更顺滑 */
  spline: boolean
  /** 缓入缓出：让每段转场的起止速度更平滑 */
  smoothVelocity: boolean
  /** 是否允许 roll；关闭时采样结果 roll 恒为 0 */
  allowRoll: boolean
  /** 播完后是否从末帧平滑回到首帧 */
  loop: boolean
  /** 新关键帧的默认转场时间 */
  defaultTransition: number
  /** 新关键帧的默认停留时间 */
  defaultHold: number
  /** 录制默认帧率 */
  fps: number
}

/** 一条完整运镜轨迹 */
export interface CameraTrajectory {
  version: 1
  name: string
  frames: CameraKeyframe[]
  options: TrajectoryOptions
}

export const DEFAULT_TRAJECTORY_OPTIONS: TrajectoryOptions = {
  spline: true,
  smoothVelocity: true,
  allowRoll: false,
  loop: false,
  defaultTransition: 2,
  defaultHold: 1,
  fps: 30,
}

/** 没有关键帧时的安全位姿，避免调用方处理 undefined */
export const IDENTITY_POSE: CameraPose = {
  position: { x: 30, y: -40, z: 30 },
  target: { x: 0, y: 0, z: 0 },
  roll: 0,
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function cloneVec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z }
}

export function clonePose(p: CameraPose): CameraPose {
  return { position: cloneVec(p.position), target: cloneVec(p.target), roll: p.roll }
}

export function createDefaultTrajectory(name = '未命名运镜'): CameraTrajectory {
  return { version: 1, name, frames: [], options: { ...DEFAULT_TRAJECTORY_OPTIONS } }
}

/** 关键帧 id 用递增数字，和标注框的 obj_id 风格保持一致 */
function nextKeyframeId(frames: CameraKeyframe[]): string {
  const max = frames.reduce((m, f) => Math.max(m, Number(f.id) || 0), 0)
  return String(max + 1)
}

/** 追加一个关键帧（返回新轨迹，方便 Vue 响应式替换） */
export function appendKeyframe(traj: CameraTrajectory, pose: CameraPose): CameraTrajectory {
  return {
    ...traj,
    frames: [
      ...traj.frames,
      {
        id: nextKeyframeId(traj.frames),
        pose: clonePose(pose),
        transition: traj.frames.length === 0 ? 0 : traj.options.defaultTransition,
        hold: traj.options.defaultHold,
      },
    ],
  }
}

/** 轨迹总时长 = 所有停留 + 所有转场（loop 时额外算上末帧回首帧） */
export function trajectoryDuration(traj: CameraTrajectory): number {
  const f = traj.frames
  if (!f.length) return 0
  let total = f.reduce((s, k) => s + Math.max(0, k.hold), 0)
  for (let i = 1; i < f.length; i++) total += Math.max(0, f[i].transition)
  if (traj.options.loop && f.length > 1) total += Math.max(0, f[0].transition)
  return total
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 角度最短弧插值：+3.1 → -3.1 只转 0.08 rad，不绕远路 6.2 rad */
function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * t
}

/** 三次缓入缓出：起点/终点速度为 0，中间加速，等价于简化版 smooth cam velocity */
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1)
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** Catmull-Rom 单段插值；端点用自身复制，避免首末段需要额外邻居 */
function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  return 0.5 * (
    2 * p1 +
    (-p0 + p2) * t +
    (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
    (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  )
}

function catmullVec(v0: Vec3, v1: Vec3, v2: Vec3, v3: Vec3, t: number): Vec3 {
  return {
    x: catmull(v0.x, v1.x, v2.x, v3.x, t),
    y: catmull(v0.y, v1.y, v2.y, v3.y, t),
    z: catmull(v0.z, v1.z, v2.z, v3.z, t),
  }
}

/** 在两帧之间采样位姿。prev/next 只在样条模式下使用 */
function mixPose(a: CameraPose, b: CameraPose, prev: CameraPose, next: CameraPose, t: number, traj: CameraTrajectory): CameraPose {
  const u = traj.options.smoothVelocity ? easeInOut(t) : t
  const allowRoll = traj.options.allowRoll
  if (traj.options.spline) {
    return {
      position: catmullVec(prev.position, a.position, b.position, next.position, u),
      target: catmullVec(prev.target, a.target, b.target, next.target, u),
      roll: allowRoll ? lerpAngle(a.roll, b.roll, u) : 0,
    }
  }
  return {
    position: {
      x: lerp(a.position.x, b.position.x, u),
      y: lerp(a.position.y, b.position.y, u),
      z: lerp(a.position.z, b.position.z, u),
    },
    target: {
      x: lerp(a.target.x, b.target.x, u),
      y: lerp(a.target.y, b.target.y, u),
      z: lerp(a.target.z, b.target.z, u),
    },
    roll: allowRoll ? lerpAngle(a.roll, b.roll, u) : 0,
  }
}

export interface TrajectorySample {
  pose: CameraPose
  /** 当前（或刚离开的）关键帧下标；UI 用它高亮 active marker */
  keyframeIndex: number
  /** 正在进行的转场编号，静止停留时为 -1 */
  segment: number
  /** 当前转场的局部进度 0..1 */
  localT: number
}

/**
 * 按时间采样轨迹。时间线由「停留 → 转场 → 停留 → 转场…」交替组成：
 * 第 0 帧在 t=0 就位，先停 hold[0]，再用 transition[1] 走向第 1 帧。
 * loop 打开时，末帧还会用 transition[0] 平滑回到首帧。
 */
export function sampleTrajectoryInfo(traj: CameraTrajectory, time: number): TrajectorySample {
  const f = traj.frames
  if (!f.length) {
    return { pose: clonePose(IDENTITY_POSE), keyframeIndex: -1, segment: -1, localT: 0 }
  }
  const total = trajectoryDuration(traj)
  let t = traj.options.loop && total > 0
    ? ((time % total) + total) % total
    : clamp(time, 0, total)

  let cursor = 0
  for (let i = 0; i < f.length; i++) {
    const hold = Math.max(0, f[i].hold)
    if (t < cursor + hold || (hold === 0 && t === cursor)) {
      return { pose: clonePose(f[i].pose), keyframeIndex: i, segment: -1, localT: 0 }
    }
    cursor += hold

    const nextIdx = i + 1 < f.length ? i + 1 : (traj.options.loop && f.length > 1 ? 0 : -1)
    if (nextIdx < 0) break
    const trans = Math.max(0, f[nextIdx].transition)
    if (trans > 0 && t < cursor + trans) {
      const localT = (t - cursor) / trans
      const prev = f[Math.max(0, i - 1)]
      const next = f[Math.min(f.length - 1, nextIdx + 1)]
      return {
        pose: mixPose(f[i].pose, f[nextIdx].pose, prev.pose, next.pose, localT, traj),
        keyframeIndex: localT < 0.5 ? i : nextIdx,
        segment: nextIdx,
        localT,
      }
    }
    cursor += trans
  }
  return { pose: clonePose(f[f.length - 1].pose), keyframeIndex: f.length - 1, segment: -1, localT: 0 }
}

/** 只要位姿时用这个简版 */
export function sampleTrajectory(traj: CameraTrajectory, time: number): CameraPose {
  return sampleTrajectoryInfo(traj, time).pose
}

/** 序列化与反序列化：轨迹和 labels.json 分开存，互不污染 */
export function serializeTrajectory(traj: CameraTrajectory): string {
  return JSON.stringify(traj, null, 2)
}

function finite(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function parsePose(raw: unknown): CameraPose {
  const p = (raw ?? {}) as Partial<CameraPose>
  const pos = (p.position ?? {}) as Partial<Vec3>
  const tgt = (p.target ?? {}) as Partial<Vec3>
  return {
    position: { x: finite(pos.x, 0), y: finite(pos.y, 0), z: finite(pos.z, 0) },
    target: { x: finite(tgt.x, 0), y: finite(tgt.y, 0), z: finite(tgt.z, 0) },
    roll: finite(p.roll, 0),
  }
}

export function parseTrajectory(json: string): CameraTrajectory {
  const raw = JSON.parse(json) as Partial<CameraTrajectory>
  if (!raw || !Array.isArray(raw.frames) || raw.frames.length === 0) {
    throw new Error('轨迹文件缺少 frames，或关键帧为空')
  }
  const frames: CameraKeyframe[] = raw.frames.map((f, i) => ({
    id: String(f.id ?? i + 1),
    pose: parsePose(f.pose),
    transition: clamp(finite(f.transition, DEFAULT_TRAJECTORY_OPTIONS.defaultTransition), 0, 60),
    hold: clamp(finite(f.hold, DEFAULT_TRAJECTORY_OPTIONS.defaultHold), 0, 60),
  }))
  const rawOpt = (raw.options ?? {}) as Partial<TrajectoryOptions>
  return {
    version: 1,
    name: String(raw.name ?? '导入的运镜'),
    frames,
    options: {
      spline: rawOpt.spline ?? DEFAULT_TRAJECTORY_OPTIONS.spline,
      smoothVelocity: rawOpt.smoothVelocity ?? DEFAULT_TRAJECTORY_OPTIONS.smoothVelocity,
      allowRoll: rawOpt.allowRoll ?? DEFAULT_TRAJECTORY_OPTIONS.allowRoll,
      loop: rawOpt.loop ?? DEFAULT_TRAJECTORY_OPTIONS.loop,
      defaultTransition: clamp(finite(rawOpt.defaultTransition, 2), 0, 60),
      defaultHold: clamp(finite(rawOpt.defaultHold, 1), 0, 60),
      fps: clamp(Math.round(finite(rawOpt.fps, 30)), 1, 120),
    },
  }
}

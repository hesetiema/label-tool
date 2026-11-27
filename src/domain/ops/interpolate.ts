/**
 * ============================================================
 * 轨迹插值 —— 从线性到运动模型
 * ============================================================
 *
 * 现有 `lerpBox`（core/sequence/sequence.ts:42）是逐轴线性插值：
 *   位置对、朝向对、尺寸也对 —— 但对"车辆"这个刚体来说是错的：
 *   逐轴插值会让尺寸在两端之间缓慢变化，插出"正在变形的车"。
 *
 * 这里给出工程化的三档：
 *   1. 位置：三次 Hermite，端点速度由相邻关键帧差分估计（边界为 0）；
 *   2. 朝向：最短弧 + Hermite，先规范化 Δyaw 再插值，绝不对展开角取模；
 *   3. 尺寸：默认 constant（取两端逐轴中位数），行人等非刚体可切 lerp。
 *
 * 【maxSpan 的处理：警告而不是拒绝】
 *   方案 5.1.3 写"超过 15 帧则拆段并要求人工确认"。实现上做成"照插但计数"：
 *   长段插值的结果是可见的、可撤销的，而"点了没反应"会让标注员困惑。
 *   调用方拿到 stats.longSpans 后在状态栏提示"其中 N 段超过 15 帧，建议补关键帧"，
 *   确认动作就是他自己看一眼 + 不满意就 Ctrl+Z。
 */
import type { BoxGeometry } from '../model/geometry'
import { angleDelta, cloneGeometry, hermite, lerpAngle } from '../model/geometry'
import type { ObservationState, Track } from '../model/track'
import { endpointVelocity, endpointYawRate, findKeyframeIndex, findKeyframeSpan } from '../model/track'

export interface InterpolateOptions {
  /** 'linear' | 'hermite'（默认，用相邻关键帧估速度） */
  mode: 'linear' | 'hermite'
  /** 尺寸策略：'constant'（车辆刚体，默认）| 'lerp'（行人/非刚体可开） */
  size: 'constant' | 'lerp'
  /** 单段超过该帧数会计入 longSpans，提示补关键帧 */
  maxSpan: number
  /** 端点超出关键帧范围时用 predicted 续接的最大帧数 */
  maxCoast: number
}

export const DEFAULT_INTERPOLATE_OPTIONS: InterpolateOptions = {
  mode: 'hermite',
  size: 'constant',
  maxSpan: 15,
  maxCoast: 3,
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * 单段插值：取第 index 与 index+1 个关键帧，算 frame 处的几何。
 * 调用方负责保证 a.frame < frame < b.frame。
 */
export function interpolateSegment(
  track: Track,
  index: number,
  frame: number,
  opts: InterpolateOptions = DEFAULT_INTERPOLATE_OPTIONS,
): BoxGeometry {
  const a = track.keyframes[index]
  const b = track.keyframes[index + 1]
  const span = b.frame - a.frame
  const t = span > 0 ? (frame - a.frame) / span : 0

  const scale =
    opts.size === 'lerp'
      ? {
          x: mix(a.geometry.scale.x, b.geometry.scale.x, t),
          y: mix(a.geometry.scale.y, b.geometry.scale.y, t),
          z: mix(a.geometry.scale.z, b.geometry.scale.z, t),
        }
      : {
          // 刚体：两端的逐轴中位数。对两帧而言就是均值，但语义是"一个尺寸"，
          // 不是"每帧各自一个尺寸"——避免下游把它当成可变的
          x: (a.geometry.scale.x + b.geometry.scale.x) / 2,
          y: (a.geometry.scale.y + b.geometry.scale.y) / 2,
          z: (a.geometry.scale.z + b.geometry.scale.z) / 2,
        }

  if (opts.mode === 'linear') {
    return {
      position: {
        x: mix(a.geometry.position.x, b.geometry.position.x, t),
        y: mix(a.geometry.position.y, b.geometry.position.y, t),
        z: mix(a.geometry.position.z, b.geometry.position.z, t),
      },
      scale,
      yaw: lerpAngle(a.geometry.yaw, b.geometry.yaw, t),
    }
  }

  const vA = endpointVelocity(track, index)
  const vB = endpointVelocity(track, index + 1)
  const wA = endpointYawRate(track, index)
  const wB = endpointYawRate(track, index + 1)
  // m 是"整段跨度内的位移量"，所以速度要乘 span
  const position = {
    x: hermite(a.geometry.position.x, b.geometry.position.x, vA.x * span, vB.x * span, t),
    y: hermite(a.geometry.position.y, b.geometry.position.y, vA.y * span, vB.y * span, t),
    z: hermite(a.geometry.position.z, b.geometry.position.z, vA.z * span, vB.z * span, t),
  }
  // 角度在"最短弧增量"上做 Hermite：起点 0、终点 Δ、端点角速度 w·span
  const delta = angleDelta(a.geometry.yaw, b.geometry.yaw)
  const yaw = a.geometry.yaw + hermite(0, delta, wA * span, wB * span, t)

  return { position, scale, yaw }
}

/**
 * 关键帧范围外的线性外推（coasting）。
 * 只在"lifecycle 超出关键帧"时有意义；当前模型两者同步，
 * 所以这条路径主要为 P2 的模型预测续接预留。
 */
export function extrapolateEdge(track: Track, frame: number): BoxGeometry | null {
  const kfs = track.keyframes
  if (!kfs.length) return null
  const after = frame > kfs[kfs.length - 1].frame
  const edge = after ? kfs[kfs.length - 1] : kfs[0]
  const neighbor = after ? (kfs.length >= 2 ? kfs[kfs.length - 2] : null) : kfs.length >= 2 ? kfs[1] : null
  const geometry = cloneGeometry(edge.geometry)
  if (!neighbor) return geometry

  const span = Math.abs(edge.frame - neighbor.frame) || 1
  const steps = Math.abs(frame - edge.frame)
  const dir = after ? 1 : -1
  geometry.position.x =
    edge.geometry.position.x + ((edge.geometry.position.x - neighbor.geometry.position.x) / span) * dir * steps
  geometry.position.y =
    edge.geometry.position.y + ((edge.geometry.position.y - neighbor.geometry.position.y) / span) * dir * steps
  geometry.position.z =
    edge.geometry.position.z + ((edge.geometry.position.z - neighbor.geometry.position.z) / span) * dir * steps
  geometry.yaw = edge.geometry.yaw + (angleDelta(neighbor.geometry.yaw, edge.geometry.yaw) / span) * dir * steps
  return geometry
}

/**
 * 任意帧的几何：命中关键帧直接返回；落在两帧之间按默认选项插值；
 * 落在范围外则外推。供"在缺口帧补一个遮挡标记"这类操作使用。
 */
export function geometryAtFrame(
  track: Track,
  frame: number,
  opts: InterpolateOptions = DEFAULT_INTERPOLATE_OPTIONS,
): BoxGeometry | null {
  const span = findKeyframeSpan(track, frame)
  if (!span) return extrapolateEdge(track, frame)
  if (span.a === span.b) return cloneGeometry(span.a.geometry)
  const index = findKeyframeIndex(track, span.a.frame)
  if (index < 0) return cloneGeometry(span.a.geometry)
  return interpolateSegment(track, index, frame, opts)
}

export interface InterpolationEntry {
  trackId: string
  frame: number
  geometry: BoxGeometry
  /** 尾部续接时同时写入 predicted 状态 */
  state?: ObservationState
}

export interface InterpolationStats {
  frames: number
  tracks: number
  /** 超过 maxSpan 的段数：结果仍写入，由调用方提示用户补关键帧 */
  longSpans: number
  coasted: number
}

export interface InterpolationPlan {
  entries: InterpolationEntry[]
  stats: InterpolationStats
}

/**
 * 为单条轨迹规划补帧。只返回"原本没有关键帧的位置"，
 * 因此调用方可以安全地生成 insertFrames 命令（回滚 = 删掉这些帧）。
 */
export function planTrackInterpolation(
  track: Track,
  range: [number, number],
  opts: InterpolateOptions = DEFAULT_INTERPOLATE_OPTIONS,
): InterpolationPlan {
  const entries: InterpolationEntry[] = []
  const stats: InterpolationStats = { frames: 0, tracks: 0, longSpans: 0, coasted: 0 }
  const kfs = track.keyframes
  if (kfs.length < 2) return { entries, stats }

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    const span = b.frame - a.frame
    if (span <= 1) continue
    if (span > opts.maxSpan) stats.longSpans++
    for (let f = a.frame + 1; f < b.frame; f++) {
      if (f < range[0] || f > range[1]) continue
      entries.push({
        trackId: track.id,
        frame: f,
        geometry: interpolateSegment(track, i, f, opts),
      })
    }
  }

  // ---- 尾部续接：lifecycle 比最后一个关键帧更远时，最多补 maxCoast 帧 ----
  const tail = Math.min(track.lifecycle.last, kfs[kfs.length - 1].frame + opts.maxCoast, range[1])
  for (let f = kfs[kfs.length - 1].frame + 1; f <= tail; f++) {
    const geometry = extrapolateEdge(track, f)
    if (!geometry) break
    entries.push({
      trackId: track.id,
      frame: f,
      geometry,
      state: { visibility: 'predicted', source: { kind: 'derived' }, review: 'none' },
    })
    stats.coasted++
  }

  stats.frames = entries.length
  stats.tracks = entries.length ? 1 : 0
  return { entries, stats }
}

export interface InterpolationPlanAll extends InterpolationPlan {
  /** trackId → 该轨迹的补帧数，供状态栏与审计摘要 */
  perTrack: Record<string, number>
}

/** 多条轨迹批量规划；onlyIds 为空表示全部 */
export function planInterpolation(
  tracks: Track[],
  range: [number, number],
  opts: InterpolateOptions = DEFAULT_INTERPOLATE_OPTIONS,
  onlyIds?: Set<string>,
): InterpolationPlanAll {
  const all: InterpolationEntry[] = []
  const stats: InterpolationStats = { frames: 0, tracks: 0, longSpans: 0, coasted: 0 }
  const perTrack: Record<string, number> = {}

  for (const track of tracks) {
    if (onlyIds && !onlyIds.has(track.id)) continue
    const plan = planTrackInterpolation(track, range, opts)
    if (!plan.entries.length) continue
    all.push(...plan.entries)
    perTrack[track.id] = plan.entries.length
    stats.frames += plan.stats.frames
    stats.tracks += 1
    stats.longSpans += plan.stats.longSpans
    stats.coasted += plan.stats.coasted
  }

  return { entries: all, stats, perTrack }
}

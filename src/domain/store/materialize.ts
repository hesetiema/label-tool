/**
 * ============================================================
 * 物化：Track + 帧号 → Box3D 视图
 * ============================================================
 *
 * 【这一层存在的唯一理由】
 *   渲染器、正交视图、质检、导出格式全都吃 `Box3D[]`，而它们的代码是对的、
 *   有测试锁着。P1 的目标不是"重写渲染"，而是把真值从 `frames[i].boxes`
 *   换成 Track，再在边界上物化出 `Box3D`。
 *
 *   于是 `viewer.setBoxes(...)` 签名不变、`OrthoView` 的 props 不变、
 *   `quality.ts` 不变 —— 回归面被压到最小。
 *
 * 【插值策略：默认只出关键帧（exact）】
 *   方案 6.1 给的是 Hermite。但物化是"每一帧都要算"的路径：
 *   稀疏关键帧上的 Hermite 在端点速度估计不准时会产生过冲（车头甩出去再回来），
 *   而渲染层没有办法提示"这是猜的"。
 *
 *   更关键的是产品语义：如果物化自己补间，用户点「轨迹插值」时画面不会变化
 *   （中间帧本来就已经画出来了），"补帧"这个动作就失去了反馈。
 *
 *   所以约定：
 *     - 默认 mode='exact'：只产出真正有关键帧的帧，与旧行为逐帧对齐；
 *     - 用户显式点「轨迹插值」：用 Hermite 算出结果并**落盘成关键帧**，
 *       之后物化读到的就是这些关键帧；
 *     - 'linear' / 'hermite' 保留为显式选项，供预览、导出预览等场景使用。
 *   两条路径的结果都能被质检和导出看到，不存在"渲染一套、导出另一套"。
 */
import type { Box3D } from '../../core/types'
import type { BoxGeometry } from '../model/geometry'
import { angleDelta, cloneVec3, geometryEquals, hermite, lerpAngle } from '../model/geometry'
import type { SampleDocument } from '../model/document'
import type { SourceKind, Track, Visibility } from '../model/track'
import { endpointVelocity, endpointYawRate, findKeyframeSpan } from '../model/track'
import type { TrackId } from '../model/ids'

/** 渲染层用的框视图：Box3D 的超集，能区分"投影视图"与"真值" */
export interface Box3DView extends Box3D {
  trackId: TrackId
  frame: number
  sourceKind: SourceKind
}

export type MaterializeInterp = 'exact' | 'linear' | 'hermite'

/**
 * 外部平滑路径（目前只有 RTS 平滑会产出）。
 *
 * 【为什么接口声明在这里，而不是 smooth.ts】
 *   物化只要求一件事："给我这一帧的位置"。它不关心这个数是 Kalman 后向平滑
 *   还是样条拟合出来的。把接口放在消费方，依赖方向就只有一个：
 *   `ops/smooth → store/materialize`，不会形成环。
 *
 * 【为什么只覆盖位置】
 *   平滑的收益在"抖动"，抖动的可见形式是位置跳动；尺寸与朝向由关键帧
 *   插值给出，硬套卡尔曼反而会让朝向在 ±π 处翻车（角度不是欧氏量）。
 */
export interface SmoothPath {
  at(frame: number): { x: number; y: number } | null
  /** 平滑前后最大位移（米）。超过阈值时调用方已经放弃这条轨迹 */
  maxShift: number
}

export interface MaterializeOptions {
  /** 关键帧之间怎么补：默认 exact（只出关键帧），见文件头说明 */
  mode?: MaterializeInterp
  /** 是否读取 states 里的可见性；默认 true。导出单帧标签时可关掉 */
  readStates?: boolean
  /**
   * 平滑路径表。只影响**关键帧之间**的补间位置，关键帧本身永远精确 ——
   * 用户手工确认过的框不该被算法移动。
   */
  paths?: ReadonlyMap<TrackId, SmoothPath>
}

/** 'outside' 是 domain 概念；渲染器只认三种状态，映射为 predicted */
function toLegacyVisibility(v: Visibility): NonNullable<Box3D['visibility']> {
  return v === 'outside' ? 'predicted' : v
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

export interface SampledGeometry {
  geometry: BoxGeometry
  visibility: Visibility
  sourceKind: SourceKind
  /** true 表示该帧几何是"外推/补间"得到的，不是人工确认 */
  interpolated: boolean
}

/**
 * 采样某条轨迹在某帧的几何与状态。
 * 返回 null 表示该帧这条轨迹不存在（超出生命周期）。
 */
export function sampleTrack(
  track: Track,
  frame: number,
  opts: MaterializeOptions = {},
): SampledGeometry | null {
  const { mode = 'exact', readStates = true } = opts
  const kfs = track.keyframes
  if (!kfs.length) return null
  if (frame < track.lifecycle.first || frame > track.lifecycle.last) return null

  const state = readStates ? track.states.get(frame) : undefined
  const span = findKeyframeSpan(track, frame)

  // ---- 命中关键帧 ----
  if (span && span.a === span.b) {
    return {
      geometry: {
        position: cloneVec3(span.a.geometry.position),
        scale: cloneVec3(span.a.geometry.scale),
        yaw: span.a.geometry.yaw,
      },
      visibility: state?.visibility ?? 'visible',
      sourceKind: state?.source.kind ?? span.a.source.kind,
      interpolated: false,
    }
  }

  // ---- 只出关键帧：中间帧由「轨迹插值」显式落盘，物化不猜 ----
  if (mode === 'exact') return null

  // ---- 关键帧之间 ----
  if (span) {
    const { a, b, t } = span
    let geometry: BoxGeometry
    if (mode === 'hermite') {
      const i = kfs.indexOf(a)
      const vA = endpointVelocity(track, i)
      const vB = endpointVelocity(track, i + 1)
      const wA = endpointYawRate(track, i)
      const wB = endpointYawRate(track, i + 1)
      const spanFrames = b.frame - a.frame
      geometry = {
        position: {
          x: hermite(a.geometry.position.x, b.geometry.position.x, vA.x * spanFrames, vB.x * spanFrames, t),
          y: hermite(a.geometry.position.y, b.geometry.position.y, vA.y * spanFrames, vB.y * spanFrames, t),
          z: hermite(a.geometry.position.z, b.geometry.position.z, vA.z * spanFrames, vB.z * spanFrames, t),
        },
        // 尺寸恒定：刚体车辆不会在补间过程中变长，逐轴插值会插出"变形的车"
        scale: { x: a.geometry.scale.x, y: a.geometry.scale.y, z: a.geometry.scale.z },
        yaw: a.geometry.yaw + hermite(0, angleDelta(a.geometry.yaw, b.geometry.yaw), wA * spanFrames, wB * spanFrames, t),
      }
    } else {
      geometry = {
        position: {
          x: lerp(a.geometry.position.x, b.geometry.position.x, t),
          y: lerp(a.geometry.position.y, b.geometry.position.y, t),
          z: lerp(a.geometry.position.z, b.geometry.position.z, t),
        },
        scale: {
          x: lerp(a.geometry.scale.x, b.geometry.scale.x, t),
          y: lerp(a.geometry.scale.y, b.geometry.scale.y, t),
          z: lerp(a.geometry.scale.z, b.geometry.scale.z, t),
        },
        yaw: lerpAngle(a.geometry.yaw, b.geometry.yaw, t),
      }
    }
    // ---- 平滑路径优先：只换位置，尺寸与朝向仍走插值 ----
    // 路径覆盖整条生命周期，理论上不会 miss；真 miss 了就退回插值结果，
    // 不会出现"这一帧没有框"（宁可略抖，不能闪）。
    const smoothed = opts.paths?.get(track.id)?.at(frame)
    if (smoothed) {
      geometry.position = { x: smoothed.x, y: smoothed.y, z: geometry.position.z }
    }
    return {
      geometry,
      visibility: state?.visibility ?? 'visible',
      sourceKind: state?.source.kind ?? (smoothed ? 'derived' : 'interp'),
      interpolated: true,
    }
  }

  // ---- 关键帧范围之外，但仍在生命周期内：线性外推（coasting） ----
  const after = frame > kfs[kfs.length - 1].frame
  const edge = after ? kfs[kfs.length - 1] : kfs[0]
  const prev = after
    ? (kfs.length >= 2 ? kfs[kfs.length - 2] : null)
    : (kfs.length >= 2 ? kfs[1] : null)
  let geometry: BoxGeometry = {
    position: cloneVec3(edge.geometry.position),
    scale: cloneVec3(edge.geometry.scale),
    yaw: edge.geometry.yaw,
  }
  if (prev) {
    const spanFrames = Math.abs(edge.frame - prev.frame) || 1
    const dir = after ? 1 : -1
    const steps = Math.abs(frame - edge.frame)
    const vx = ((edge.geometry.position.x - prev.geometry.position.x) / spanFrames) * dir
    const vy = ((edge.geometry.position.y - prev.geometry.position.y) / spanFrames) * dir
    const vz = ((edge.geometry.position.z - prev.geometry.position.z) / spanFrames) * dir
    const vyaw = (lerpAngle(0, edge.geometry.yaw - prev.geometry.yaw, 1) / spanFrames) * dir
    geometry = {
      position: {
        x: edge.geometry.position.x + vx * steps,
        y: edge.geometry.position.y + vy * steps,
        z: edge.geometry.position.z + vz * steps,
      },
      scale: cloneVec3(edge.geometry.scale),
      yaw: edge.geometry.yaw + vyaw * steps,
    }
  }
  return {
    geometry,
    visibility: state?.visibility ?? 'predicted',
    sourceKind: 'interp',
    interpolated: true,
  }
}

export function materializeTrack(
  track: Track,
  frame: number,
  opts: MaterializeOptions = {},
): Box3DView | null {
  const sampled = sampleTrack(track, frame, opts)
  if (!sampled) return null
  return {
    id: track.id,
    trackId: track.id,
    frame,
    label: track.classId,
    position: sampled.geometry.position,
    scale: sampled.geometry.scale,
    yaw: sampled.geometry.yaw,
    visibility: toLegacyVisibility(sampled.visibility),
    attributes: { ...track.attributes },
    sourceKind: sampled.sourceKind,
  }
}

/** 一帧的全部框，按文档内轨迹顺序（= 首次出现顺序），渲染层可直接消费 */
export function materializeFrame(
  doc: SampleDocument,
  frame: number,
  opts: MaterializeOptions = {},
): Box3DView[] {
  const out: Box3DView[] = []
  for (const track of doc.tasks.boxes.tracks) {
    const view = materializeTrack(track, frame, opts)
    if (view) out.push(view)
  }
  return out
}

/**
 * 物化后是否与给定几何一致 —— diff 用。
 * 把比较逻辑放这里，避免 EditSession 与 TrackStore 各写一份。
 */
export function viewGeometryEquals(view: Box3D, geometry: BoxGeometry): boolean {
  return geometryEquals(view, geometry)
}

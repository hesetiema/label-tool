/**
 * ============================================================
 * Track —— 目标的一生
 * ============================================================
 *
 * 这是 4D 标注与"逐帧画框"的分界线：
 *   逐帧画框把"同一目标在第 3 帧和第 4 帧"当成两个独立对象，
 *   Track 把身份、关键帧、逐帧观测状态合成一个实体，时间才成为模型的一部分。
 *
 * 【为什么关键帧稀疏】
 *   500 帧 × 200 目标 = 10 万个 (帧, 目标) 组合。如果每格都存完整几何，
 *   草稿就是几十 MB。只存人确认过的关键帧 + 稀疏的"非默认状态"，
 *   典型样本只有几百个关键帧，体积降到几十 KB。
 *
 * 【为什么 states 用 Map】
 *   同上：可见性/复核状态只在"非默认"的帧上记录。
 *   序列化边界必须转成 Array<[number, ObservationState]>（见 encodeStates），
 *   因为 JSON.stringify 会把 Map 变成空对象 —— 这是全项目最容易踩的坑之一。
 */
import type { BoxGeometry } from './geometry'
import { cloneGeometry } from './geometry'
import type { ClassId, TrackId } from './ids'

/**
 * 可见性。比现有 `core/types.ts` 的 Visibility 多一个 'outside'：
 * 'outside' 表示目标整体离开传感器视野（不是被挡住），P2 之后用于区分
 * "该出现但没标"（漏标）与"本来就不在视野里"（正常）。
 * 物化回 Box3D 时 'outside' 映射为 'predicted'，因为渲染器只认三种状态。
 */
export type Visibility = 'visible' | 'occluded' | 'predicted' | 'outside'

/** 数据来源。审计与"哪些帧是模型给的"全靠它 */
export type SourceKind = 'manual' | 'model' | 'interp' | 'derived' | 'import'

export interface SourceTag {
  kind: SourceKind
  /** 模型来源时才填 */
  model?: { id: string; version: string; confidence?: number }
  /** 来自哪次操作的命令 id，用于追溯"这一帧是谁改的" */
  commandId?: string
}

export interface Keyframe<G = BoxGeometry> {
  frame: number
  geometry: G
  source: SourceTag
  /** 人工确认过的关键帧不会被自动平滑覆盖 */
  locked?: boolean
}

export interface ObservationState {
  visibility: Visibility
  source: SourceTag
  review: 'none' | 'pending' | 'accepted' | 'rejected' | 'conflict'
  confidence?: number
  /** 遮挡原因：'truck' | 'building' | 'out_of_range'，用于规则豁免与统计 */
  occluder?: string
}

export interface TrackLifecycle {
  first: number
  last: number
  state: 'active' | 'occluded' | 'dead'
}

export interface Track<G = BoxGeometry> {
  id: TrackId
  classId: ClassId
  attributes: Record<string, string | number | boolean>
  /** 稀疏关键帧，按 frame 升序；至少 1 个（不变量 T1） */
  keyframes: Keyframe<G>[]
  /** 只在"非默认状态"的帧上记录，默认 visible/manual/none */
  states: Map<number, ObservationState>
  lifecycle: TrackLifecycle
}

export function observationState(
  visibility: Visibility,
  source: SourceTag = { kind: 'manual' },
  review: ObservationState['review'] = 'none',
): ObservationState {
  return { visibility, source, review }
}

/**
 * 建一条只有单个关键帧的轨迹 —— 画第一个框时的形态。
 * 不在这里校验 classId 是否在类别表内：类别表属于 UI 配置，domain 不持有它。
 */
export function createTrackRecord(opts: {
  id: TrackId
  classId: ClassId
  frame: number
  geometry: BoxGeometry
  source?: SourceTag
  attributes?: Record<string, string | number | boolean>
}): Track {
  return {
    id: opts.id,
    classId: opts.classId,
    attributes: opts.attributes ? { ...opts.attributes } : {},
    keyframes: [{
      frame: opts.frame,
      geometry: cloneGeometry(opts.geometry),
      source: opts.source ?? { kind: 'manual' },
    }],
    states: new Map(),
    lifecycle: { first: opts.frame, last: opts.frame, state: 'active' },
  }
}

/** 关键帧按帧升序比较器 */
export function byFrame(a: { frame: number }, b: { frame: number }): number {
  return a.frame - b.frame
}

/** 二分查找精确命中的关键帧下标；没有则 -1 */
export function findKeyframeIndex(track: Track, frame: number): number {
  const kfs = track.keyframes
  let lo = 0
  let hi = kfs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const f = kfs[mid].frame
    if (f === frame) return mid
    if (f < frame) lo = mid + 1
    else hi = mid - 1
  }
  return -1
}

export function getKeyframe(track: Track, frame: number): Keyframe | null {
  const i = findKeyframeIndex(track, frame)
  return i >= 0 ? track.keyframes[i] : null
}

/**
 * 找到 frame 落在哪两个关键帧之间。
 * 返回值语义：
 *   - `a === null`：frame 在首个关键帧之前
 *   - `b === null`：frame 在末个关键帧之后（需要 coast）
 *   - `a.frame === frame`：正好命中关键帧，t 为 0
 */
export function findKeyframeSpan(
  track: Track,
  frame: number,
): { a: Keyframe; b: Keyframe; t: number } | null {
  const kfs = track.keyframes
  if (!kfs.length) return null
  if (frame < kfs[0].frame || frame > kfs[kfs.length - 1].frame) return null
  let lo = 0
  let hi = kfs.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const f = kfs[mid].frame
    if (f === frame) return { a: kfs[mid], b: kfs[mid], t: 0 }
    if (f < frame) lo = mid + 1
    else hi = mid - 1
  }
  // 此时 hi 是最后一个 < frame 的下标，lo = hi + 1
  const a = kfs[hi]
  const b = kfs[lo]
  return { a, b, t: (frame - a.frame) / (b.frame - a.frame) }
}

/** 插入或替换一个关键帧，保持升序与生命周期同步 */
export function upsertKeyframe(track: Track, kf: Keyframe): void {
  const i = findKeyframeIndex(track, kf.frame)
  if (i >= 0) {
    track.keyframes[i] = kf
  } else {
    track.keyframes.push(kf)
    track.keyframes.sort(byFrame)
  }
  touchLifecycle(track)
}

/** 删除一个关键帧；删空时保留数组为空，由调用方决定是否删轨迹 */
export function removeKeyframe(track: Track, frame: number): Keyframe | null {
  const i = findKeyframeIndex(track, frame)
  if (i < 0) return null
  const [removed] = track.keyframes.splice(i, 1)
  touchLifecycle(track)
  return removed
}

/**
 * 重算 lifecycle 的 first/last。
 *
 * 只从关键帧推，不从 states 推：states 可以落在关键帧之外（例如尾部
 * predicted 段），拿它推范围会把"预测到第 20 帧"误当成"真实标注到第 20 帧"。
 */
export function touchLifecycle(track: Track): void {
  const kfs = track.keyframes
  if (!kfs.length) {
    track.lifecycle.first = 0
    track.lifecycle.last = 0
    return
  }
  track.lifecycle.first = kfs[0].frame
  track.lifecycle.last = kfs[kfs.length - 1].frame
}

/** 深拷贝轨迹 —— 删除/合并命令必须自带快照，否则撤销时数据已经被改掉了 */
export function cloneTrack(track: Track): Track {
  return {
    id: track.id,
    classId: track.classId,
    attributes: { ...track.attributes },
    keyframes: track.keyframes.map((kf) => ({
      frame: kf.frame,
      geometry: cloneGeometry(kf.geometry),
      source: { ...kf.source, ...(kf.source.model ? { model: { ...kf.source.model } } : {}) },
      ...(kf.locked ? { locked: true } : {}),
    })),
    states: new Map([...track.states].map(([f, s]) => [f, { ...s, source: { ...s.source } }])),
    lifecycle: { ...track.lifecycle },
  }
}

/**
 * 不变量检查（T1–T3，T4/T5 需要 Scene 级信息，由 TrackStore 检查）。
 * 返回违规描述数组而不是抛异常：导入脏数据时应"报告并尽量修复"，
 * 而不是让整个文档打不开。测试里断言返回空数组。
 */
export function trackInvariantViolations(track: Track): string[] {
  const out: string[] = []
  const kfs = track.keyframes
  if (!kfs.length) out.push(`${track.id}: T1 关键帧为空`)
  for (let i = 1; i < kfs.length; i++) {
    if (kfs[i].frame <= kfs[i - 1].frame) {
      out.push(`${track.id}: T1 关键帧未严格递增（${kfs[i - 1].frame} → ${kfs[i].frame}）`)
      break
    }
  }
  if (kfs.length) {
    if (kfs[0].frame < track.lifecycle.first || kfs[kfs.length - 1].frame > track.lifecycle.last) {
      out.push(`${track.id}: T2 关键帧越出生命周期 [${track.lifecycle.first}, ${track.lifecycle.last}]`)
    }
  }
  for (const [frame, state] of track.states) {
    const kf = getKeyframe(track, frame)
    // T3 的唯一例外：插值/预测段的关键帧允许带 predicted 状态，
    // 这是"几何是算出来的、可见性是标出来的"这一种自洽组合。
    if (kf && kf.source.kind !== 'interp' && state.visibility !== 'visible') {
      out.push(`${track.id}: T3 第 ${frame} 帧同时有人工关键帧和遮挡状态`)
    }
  }
  return out
}

/** 序列化边界：Map → 数组。JSON.stringify 会丢 Map，必须显式转换 */
export function encodeStates(track: Track): Array<[number, ObservationState]> {
  return [...track.states.entries()].sort((a, b) => a[0] - b[0])
}

/** 反序列化边界：数组 → Map */
export function decodeStates(entries: Array<[number, ObservationState]> | undefined): Map<number, ObservationState> {
  return new Map((entries ?? []).map(([f, s]) => [f, s]))
}

/* ------------------------------------------------------------------
 * 端点运动学：插值与 coasting 共用的速度估计
 * 放在 model 层是因为它是"关键帧序列"的固有属性，
 * 不该让 ops 依赖 store、也不该让 store 各写一份。
 * ------------------------------------------------------------------ */

/** 第 index 个关键帧处的线速度，单位 米/帧。由相邻关键帧差分，边界用单侧差分 */
export function endpointVelocity(track: Track, index: number): { x: number; y: number; z: number } {
  const kfs = track.keyframes
  if (kfs.length < 2 || index < 0 || index >= kfs.length) return { x: 0, y: 0, z: 0 }
  // 首帧没有"前一个"，用后向差分而不是 0：
  // 取 0 会让每个关键帧处都出现 ease-in（车在每个关键帧前先减速再加速），
  // 对只有首末两个关键帧的轨迹更会把直线插成 smoothstep —— 位置误差可达跨度的 12%。
  const a = index === 0 ? kfs[0] : kfs[index - 1]
  const b = index === 0 ? kfs[1] : kfs[index]
  const span = b.frame - a.frame
  if (span <= 0) return { x: 0, y: 0, z: 0 }
  return {
    x: (b.geometry.position.x - a.geometry.position.x) / span,
    y: (b.geometry.position.y - a.geometry.position.y) / span,
    z: (b.geometry.position.z - a.geometry.position.z) / span,
  }
}

/**
 * 第 index 个关键帧处的角速度，弧度/帧。
 * 差分前走最短弧：yaw 从 3.14 到 -3.14 实际只转了 0.003 弧度，
 * 直接相减会得到 -6.28，插值出来的转角会反向甩一圈。
 */
export function endpointYawRate(track: Track, index: number): number {
  const kfs = track.keyframes
  if (kfs.length < 2 || index < 0 || index >= kfs.length) return 0
  const a = index === 0 ? kfs[0] : kfs[index - 1]
  const b = index === 0 ? kfs[1] : kfs[index]
  const span = b.frame - a.frame
  if (span <= 0) return 0
  let d = b.geometry.yaw - a.geometry.yaw
  while (d > Math.PI) d -= 2 * Math.PI
  while (d <= -Math.PI) d += 2 * Math.PI
  return d / span
}

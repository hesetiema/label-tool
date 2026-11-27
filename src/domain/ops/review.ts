/**
 * ============================================================
 * 复核（review）—— 模型产出与人工裁决之间的那一层
 * ============================================================
 *
 * 预标注落库后不是"标注"，而是"待复核的候选"：
 *   模型给框 → pending → 人接受 / 拒绝 → accepted / rejected
 * 只有 accepted 与"人工自己标的"会进入导出。这条门禁放在**状态**上，
 * 而不是放在轨迹上 —— 同一条轨迹可能前 3 帧被人改过、后 7 帧还是模型猜的。
 *
 * 【为什么门禁只认 source.kind === 'model'】
 *   人工帧的 `review` 默认是 'none'，永远可导出。若按 review 一刀切，
 *   将来任何给人工帧打标记的功能（比如冲突提示）都会让标注**悄悄从导出里消失**。
 *   判据是"这帧是谁给的"，不是"这帧被谁看过"。
 */
import type { Command, CommandData } from '../model/command'
import { makeCommand } from '../model/command'
import type { SampleDocument } from '../model/document'
import type { ObservationState, Track } from '../model/track'

export type ReviewDecision = 'accepted' | 'rejected'

/** 待裁决的状态：模型给的、但还没被接受的 */
function isOpen(state: ObservationState): boolean {
  if (state.source.kind !== 'model') return false
  return state.review === 'pending' || state.review === 'conflict'
}

export interface ReviewRow {
  trackId: string
  classId: string
  /** 待复核的帧（升序） */
  frames: number[]
  /** 这些帧的平均置信度；缺失按 0（排在最前，符合"低置信优先"） */
  confidence: number
  review: 'pending' | 'conflict'
}

export interface ReviewStats {
  /** 待复核的轨迹数 */
  tracks: number
  /** 待复核的帧数（一条轨迹多帧只算一次门禁，但复核时要逐帧看） */
  frames: number
  /** 其中带冲突标记的帧数 */
  conflicts: number
  accepted: number
  rejected: number
  /** 模型产出的帧总数（含已裁决），用于"覆盖率" */
  modelFrames: number
}

/** 复核队列：冲突优先，其次置信度升序，最后按 id 稳定排序 */
export function collectReviewRows(doc: SampleDocument): ReviewRow[] {
  const rows: ReviewRow[] = []
  for (const track of doc.tasks.boxes.tracks) {
    const frames: number[] = []
    let confidenceSum = 0
    let hasConflict = false
    for (const [frame, state] of track.states) {
      if (!isOpen(state)) continue
      frames.push(frame)
      confidenceSum += state.confidence ?? 0
      if (state.review === 'conflict') hasConflict = true
    }
    if (!frames.length) continue
    frames.sort((a, b) => a - b)
    rows.push({
      trackId: track.id,
      classId: track.classId,
      frames,
      confidence: confidenceSum / frames.length,
      review: hasConflict ? 'conflict' : 'pending',
    })
  }
  return rows.sort((a, b) => {
    if (a.review !== b.review) return a.review === 'conflict' ? -1 : 1
    if (a.confidence !== b.confidence) return a.confidence - b.confidence
    return a.trackId.localeCompare(b.trackId)
  })
}

export function reviewStats(doc: SampleDocument): ReviewStats {
  const stats: ReviewStats = {
    tracks: 0,
    frames: 0,
    conflicts: 0,
    accepted: 0,
    rejected: 0,
    modelFrames: 0,
  }
  for (const track of doc.tasks.boxes.tracks) {
    let open = 0
    for (const state of track.states.values()) {
      if (state.source.kind !== 'model') continue
      stats.modelFrames++
      if (state.review === 'accepted') stats.accepted++
      else if (state.review === 'rejected') stats.rejected++
      else {
        open++
        stats.frames++
        if (state.review === 'conflict') stats.conflicts++
      }
    }
    if (open) stats.tracks++
  }
  return stats
}

/**
 * 裁决命令：把若干轨迹的待复核帧标成 accepted / rejected。
 *
 * 【为什么逐帧 setObservation 而不是加一条 setReview 命令】
 *   复核状态本来就存在 `ObservationState.review` 上，逐帧写是它的自然粒度。
 *   新命令类型要同时改 applyCommand / revertCommand / affectsOf / 序列化，
 *   而收益只是"命令条目少一点"。一条 batch 已经把撤销收成一步了。
 *
 * `frames` 给定时只裁决这些帧（复核队列里的"只处理当前帧"）。
 */
export function buildReviewCommand(tracks: readonly Track[], decision: ReviewDecision, frame?: number): Command | null {
  const children: CommandData[] = []
  const touched: number[] = []
  for (const track of tracks) {
    for (const [f, state] of track.states) {
      if (!isOpen(state)) continue
      if (frame !== undefined && f !== frame) continue
      children.push({
        type: 'setObservation',
        trackId: track.id,
        frame: f,
        before: { ...state, source: { ...state.source } },
        after: {
          ...state,
          source: { ...state.source },
          review: decision,
        },
      })
      touched.push(f)
    }
  }
  if (!children.length) return null
  const label = decision === 'accepted' ? `接受预标注（${children.length} 帧）` : `拒绝预标注（${children.length} 帧）`
  const command =
    children.length === 1
      ? makeCommand(children[0], { label })
      : makeCommand({ type: 'batch', commands: children }, { label })
  return command
}

/** 单帧/单轨迹的裁决（复核面板的按钮走这个） */
export function buildReviewCommandFor(
  doc: SampleDocument,
  ids: readonly string[],
  decision: ReviewDecision,
  frame?: number,
): Command | null {
  const want = new Set(ids)
  const tracks = doc.tasks.boxes.tracks.filter((t) => want.has(t.id))
  return buildReviewCommand(tracks, decision, frame)
}

/**
 * 导出闸门：只有"模型给的且未被接受"的帧要拦。
 * 人工帧（review 'none'）与插值帧一律放行。
 */
export function isExportableState(state?: Pick<ObservationState, 'review' | 'source'> | null): boolean {
  if (!state) return true
  if (state.source.kind !== 'model') return true
  return state.review === 'accepted'
}

/**
 * 视图级导出闸门（`Box3DView` 有 `review` 与 `sourceKind`，没有完整的 state）。
 * 与 `isExportableState` 同一套判据的两种入参形态，避免调用方自己拼 state 对象。
 */
export function isExportableView(view: { review?: string; sourceKind?: string }): boolean {
  if (view.review === undefined) return true
  if (view.sourceKind !== 'model') return true
  return view.review === 'accepted'
}

/**
 * ============================================================
 * 预标注合并（纯函数）
 * ============================================================
 *
 * 两段，各自可单测：
 *   1. `linkProposals`：把逐帧的模型框链成"轨迹提案" —— 解决身份问题；
 *   2. `buildMergeCommand`：把提案按策略并进文档 —— 解决冲突问题。
 *
 * 【为什么不在这里直接改文档】
 *   合并结果必须能撤销，所以只产出 `CommandData`。调用方（state 层）把它
 *   交给 `TrackStore.exec`，撤销栈与自动保存就不用再管一遍。
 *   顺带的好处：合并算法不需要 store、不需要 Vue，测试里给一份文档就能跑。
 *
 * 【为什么身份关联要放在 domain】
 *   模型内部有跟踪（`modelTrackId`）时关联是免费的；没有时只能靠 IoU。
 *   这是**标注语义**（"这两帧的车是同一辆"）而不是推理细节 ——
 *   换个模型、换个 Provider，判据都该一样。
 *
 * 【与方案 5.2.2 的偏差（有意）】
 *   方案写"复用 tracker.ts 的 Hungarian"。这里改成贪心匹配，理由：
 *   - 候选集是"同一帧的少量框"，n 通常 < 20，Hungarian 的全局最优没有收益；
 *   - 贪心按 IoU 降序一一占位，结果确定、可解释，测试断言能写死；
 *   - 不把 `core/sequence/tracker.ts`（541 行、含卡尔曼）拖进 domain 的依赖图。
 *   判据本身（IoU 阈值 + 类别一致）与方案一致。
 */
import type { Command, CommandData } from '../model/command'
import { makeCommand } from '../model/command'
import type { SampleDocument } from '../model/document'
import type { BoxGeometry } from '../model/geometry'
import { bevIoU, cloneGeometry } from '../model/geometry'
import type { ClassId, TrackId } from '../model/ids'
import type { ObservationState, SourceTag, Track } from '../model/track'
import { getKeyframe } from '../model/track'

/** 模型给出的单帧目标 */
export interface ModelObject {
  frame: number
  classId: ClassId
  geometry: BoxGeometry
  confidence: number
  modelTrackId?: string
  attributes?: Record<string, string | number | boolean>
  /** 血缘：哪个模型、哪个版本。落进 SourceTag，P6 的难度分要用 */
  model?: { id: string; version: string }
}

/** 链好的轨迹提案：同一目标的多帧观测 */
export interface Proposal {
  modelTrackId?: string
  classId: ClassId
  /** 按帧升序 */
  objects: ModelObject[]
  /** 平均置信度 */
  confidence: number
  model?: { id: string; version: string }
}

export interface LinkOptions {
  /**
   * 跨帧链接的 IoU 阈值。比同帧合并（0.5）松：相邻两帧车只前进 0.5m，
   * 车长 4.5m，IoU 本来就在 0.8 以上；掉到 0.25 通常意味着遮挡或漏检，
   * 这时仍应认为是同一辆 —— 拆成两条轨迹的代价比连错一条大得多。
   */
  iouThreshold?: number
  classMustMatch?: boolean
  /** 允许断多少帧后继续链接（遮挡导致的漏检通常 1–2 帧） */
  maxGap?: number
}

const DEFAULT_LINK: Required<LinkOptions> = {
  iouThreshold: 0.25,
  classMustMatch: true,
  maxGap: 2,
}

/** 单帧最多允许多少个框参与链接；超过视为脏数据（防止 O(n²) 爆掉） */
const MAX_OBJECTS_PER_FRAME = 512

function newProposal(obj: ModelObject): Proposal {
  return {
    ...(obj.modelTrackId ? { modelTrackId: obj.modelTrackId } : {}),
    classId: obj.classId,
    objects: [obj],
    confidence: obj.confidence,
    ...(obj.model ? { model: { ...obj.model } } : {}),
  }
}

function pushObject(proposal: Proposal, obj: ModelObject): void {
  const last = proposal.objects[proposal.objects.length - 1]
  // 同一帧重复（模型输出了两个同名 id）：保留置信度更高的那个
  if (last && last.frame === obj.frame) {
    if (obj.confidence > last.confidence) proposal.objects[proposal.objects.length - 1] = obj
    return
  }
  proposal.objects.push(obj)
  const n = proposal.objects.length
  proposal.confidence = (proposal.confidence * (n - 1) + obj.confidence) / n
  if (!proposal.model && obj.model) proposal.model = { ...obj.model }
}

/**
 * 逐帧模型框 → 轨迹提案。
 *
 * 规则：
 *   1. 有 `modelTrackId`：直接按 id 分组，帧序由排序保证；
 *   2. 没有：与"还开着"的提案（最后一帧距今 ≤ maxGap）做 IoU 贪心匹配，
 *      取得分最高的一个继续；都不够则开新提案。
 *
 * 【为什么贪心按帧推进、而不是先建全图再聚类】
 *   帧是天然的时间序：一个目标在第 3 帧出现、第 4 帧消失、第 9 帧又出现，
 *   全图聚类会把两段并成一条（中间 5 帧的猜测全错）。贪心 + maxGap 不做这种猜测。
 */
export function linkProposals(objects: ModelObject[], opts: LinkOptions = {}): Proposal[] {
  const cfg = { ...DEFAULT_LINK, ...opts }
  const sorted = [...objects].sort((a, b) => a.frame - b.frame || a.classId.localeCompare(b.classId))
  const byModelId = new Map<string, Proposal>()
  const loose: Proposal[] = []

  const perFrame = new Map<number, number>()
  for (const obj of sorted) {
    const n = (perFrame.get(obj.frame) ?? 0) + 1
    perFrame.set(obj.frame, n)
    // 超限的帧整体丢弃：宁可少合几帧，也不要为了脏数据卡住主线程
    if (n > MAX_OBJECTS_PER_FRAME) continue

    if (obj.modelTrackId) {
      const hit = byModelId.get(obj.modelTrackId)
      if (hit) pushObject(hit, obj)
      else {
        const p = newProposal(obj)
        byModelId.set(obj.modelTrackId, p)
        loose.push(p)
      }
      continue
    }

    let best: Proposal | null = null
    let bestIou = 0
    for (const p of loose) {
      if (p.modelTrackId) continue // 有 id 的提案不接受"无名"续接，避免两条身份体系串台
      if (cfg.classMustMatch && p.classId !== obj.classId) continue
      const last = p.objects[p.objects.length - 1]
      if (obj.frame <= last.frame || obj.frame - last.frame > cfg.maxGap) continue
      const iou = bevIoU(last.geometry, obj.geometry)
      if (iou >= cfg.iouThreshold && iou > bestIou) {
        best = p
        bestIou = iou
      }
    }
    if (best) pushObject(best, obj)
    else loose.push(newProposal(obj))
  }

  // 输出顺序固定：首帧 → 类别 → 模型 id。调用方据此分配 TrackId，
  // 同一批输入必须得到同一批 id，否则测试与复现都无从谈起
  return loose.sort((a, b) => {
    const fa = a.objects[0].frame
    const fb = b.objects[0].frame
    if (fa !== fb) return fa - fb
    if (a.classId !== b.classId) return a.classId.localeCompare(b.classId)
    return (a.modelTrackId ?? '').localeCompare(b.modelTrackId ?? '')
  })
}

/* ------------------------------------------------------------------
 * 合并策略
 * ------------------------------------------------------------------ */

export type MergeStrategy = 'append' | 'fill-gaps' | 'replace-track' | 'class-vote'

export interface MergePolicy {
  strategy: MergeStrategy
  /** 判定"同一个目标"的 IoU 阈值 */
  iouThreshold: number
  classMustMatch: boolean
  /** 低于此置信度的模型框直接丢弃 */
  minConfidence: number
  /** 人工框永不被模型覆盖 */
  protectManual: boolean
}

export function defaultMergePolicy(): MergePolicy {
  return {
    // 默认 append：最保守。它不会动任何已有标注，只往里加"待复核"，
    // 复核队列里逐条看就行。其他策略都是"模型有权改真值"，需要用户明确选。
    strategy: 'append',
    iouThreshold: 0.5,
    classMustMatch: true,
    minConfidence: 0.3,
    protectManual: true,
  }
}

export interface MergeConflict {
  frame: number
  trackId: TrackId
  manual: BoxGeometry
  model: ModelObject
  iou: number
}

export interface MergeResult {
  created: TrackId[]
  updated: TrackId[]
  conflicts: MergeConflict[]
  /** 被策略跳过的模型框数（低置信 / 填充模式撞上已有框 / 与人工冲突且无处可放） */
  skipped: number
  /** 实际写入的帧（升序、去重），用于增量刷新 */
  frames: number[]
}

export interface MergePlan {
  command: Command | null
  result: MergeResult
}

interface FrameEntry {
  track: Track
  geometry: BoxGeometry
  /** 该帧关键帧的来源，用于判断"这条轨迹是人标的还是模型给的" */
  sourceKind: SourceTag['kind']
}

interface Candidate {
  track: Track
  hits: Array<{ frame: number; iou: number; entry: FrameEntry; obj: ModelObject }>
  /** 命中的帧里只要有一帧不是模型来源，就整条按"人工轨迹"对待 */
  manual: boolean
  meanIou: number
}

function emptyResult(): MergeResult {
  return { created: [], updated: [], conflicts: [], skipped: 0, frames: [] }
}

/** 帧 → 该帧所有"确切关键帧"（不含插值），合并只认关键帧 */
function indexKeyframes(doc: SampleDocument): Map<number, FrameEntry[]> {
  const map = new Map<number, FrameEntry[]>()
  for (const track of doc.tasks.boxes.tracks) {
    for (const kf of track.keyframes) {
      const list = map.get(kf.frame)
      const entry: FrameEntry = { track, geometry: kf.geometry, sourceKind: kf.source.kind }
      if (list) list.push(entry)
      else map.set(kf.frame, [entry])
    }
  }
  return map
}

function modelSource(obj: ModelObject): SourceTag {
  return {
    kind: 'model',
    ...(obj.model ? { model: { id: obj.model.id, version: obj.model.version, confidence: obj.confidence } } : {}),
  } as SourceTag
}

function pendingState(obj: ModelObject): ObservationState {
  return {
    visibility: 'visible',
    source: modelSource(obj),
    review: 'pending',
    confidence: obj.confidence,
  }
}

function buildTrack(proposal: Proposal, id: TrackId, objects: ModelObject[]): Track {
  const sorted = [...objects].sort((a, b) => a.frame - b.frame)
  const states = new Map<number, ObservationState>()
  for (const obj of sorted) states.set(obj.frame, pendingState(obj))
  return {
    id,
    classId: proposal.classId,
    attributes: { ...(sorted[0].attributes ?? {}) },
    keyframes: sorted.map((obj) => ({
      frame: obj.frame,
      geometry: cloneGeometry(obj.geometry),
      source: modelSource(obj),
    })),
    states,
    lifecycle: {
      first: sorted[0].frame,
      last: sorted[sorted.length - 1].frame,
      state: 'active',
    },
  }
}

/**
 * 在已有轨迹里找与提案最匹配的一条。
 * 命中帧数优先，其次平均 IoU —— 只看单帧最高 IoU 会把"擦身而过的另一辆车"当成本目标。
 */
function findCandidate(
  proposal: Proposal,
  index: Map<number, FrameEntry[]>,
  policy: MergePolicy,
): Candidate | null {
  const byTrack = new Map<TrackId, Candidate>()
  for (const obj of proposal.objects) {
    for (const entry of index.get(obj.frame) ?? []) {
      if (entry.track.id === undefined) continue
      if (policy.classMustMatch && entry.track.classId !== proposal.classId) continue
      const iou = bevIoU(entry.geometry, obj.geometry)
      if (iou < policy.iouThreshold) continue
      let c = byTrack.get(entry.track.id)
      if (!c) {
        c = { track: entry.track, hits: [], manual: false, meanIou: 0 }
        byTrack.set(entry.track.id, c)
      }
      c.hits.push({ frame: obj.frame, iou, entry, obj })
      if (entry.sourceKind !== 'model') c.manual = true
    }
  }
  let best: Candidate | null = null
  for (const c of byTrack.values()) {
    c.meanIou = c.hits.reduce((n, h) => n + h.iou, 0) / c.hits.length
    if (
      !best ||
      c.hits.length > best.hits.length ||
      (c.hits.length === best.hits.length && c.meanIou > best.meanIou) ||
      (c.hits.length === best.hits.length && c.meanIou === best.meanIou && c.track.id < best.track.id)
    ) {
      best = c
    }
  }
  return best
}

/**
 * 把提案并进文档，产出可撤销的命令。
 *
 * 【四种策略的分工】
 *   append        不动任何已有标注，全部作为待复核新轨迹 —— 默认，最保守
 *   fill-gaps     只填空帧（该帧一个框都没有才算空），适合"人工标了关键帧、
 *                 让模型补中间帧"的工作流
 *   replace-track 命中已有轨迹就整条替换几何（`protectManual` 时人工轨迹除外）
 *   class-vote    按 IoU 加权投票改类别，几何不动 —— 用于"多模型校对人工类别"
 *
 * 【为什么冲突不静默覆盖】
 *   模型与人工在同帧给出不同框，是**最有价值的复核信号**（模型可能对，
 *   也可能错）。静默选一边等于把这个信息扔了，所以一律记进 `conflicts`，
 *   由复核队列逐条裁决。
 */
export function buildMergeCommand(
  doc: SampleDocument,
  proposals: Proposal[],
  policy: MergePolicy,
  nextId: (used: ReadonlySet<TrackId>) => TrackId,
): MergePlan {
  const result = emptyResult()
  const children: CommandData[] = []
  const index = indexKeyframes(doc)
  /**
   * 本次合并已占用的 id。
   *
   * 【为什么必须自己记账】命令要等 `exec` 之后才进文档，而 `nextId` 的典型实现
   * （扫 `TrackStore`）看不到还没落库的轨迹 —— 一次合并建 4 条，4 次都会返回同一个号，
   * 结果是 4 条轨迹共用一个 id：撤销、复核、导出全部串台。
   * 契约改成"把已占用集合交给分配器"，分配器就一定能避开它们。
   */
  const used = new Set<TrackId>(doc.tasks.boxes.tracks.map((t) => t.id))
  const allocId = (): TrackId => {
    const id = nextId(used)
    used.add(id)
    return id
  }
  const beforeOf = (track: Track, frame: number): BoxGeometry | null => {
    const kf = getKeyframe(track, frame)
    return kf ? cloneGeometry(kf.geometry) : null
  }
  const stateOf = (track: Track, frame: number): ObservationState | null => {
    const s = track.states.get(frame)
    return s ? { ...s, source: { ...s.source } } : null
  }

  const createNew = (proposal: Proposal, objects: ModelObject[]): void => {
    if (!objects.length) return
    const id = allocId()
    children.push({ type: 'createTrack', track: buildTrack(proposal, id, objects) })
    result.created.push(id)
    for (const o of objects) result.frames.push(o.frame)
  }

  /** 已有轨迹吸收模型观测：命中帧改几何，新帧插关键帧，状态一律回到待复核 */
  const absorbInto = (track: Track, objects: ModelObject[]): void => {
    const inserts: Array<{ frame: number; geometry: BoxGeometry; source: SourceTag; state: ObservationState }> = []
    for (const obj of objects) {
      const before = beforeOf(track, obj.frame)
      const state = pendingState(obj)
      if (before) {
        children.push({
          type: 'setKeyframe',
          trackId: track.id,
          frame: obj.frame,
          before,
          after: cloneGeometry(obj.geometry),
        })
      } else {
        inserts.push({
          frame: obj.frame,
          geometry: cloneGeometry(obj.geometry),
          source: modelSource(obj),
          state,
        })
      }
      children.push({
        type: 'setObservation',
        trackId: track.id,
        frame: obj.frame,
        before: stateOf(track, obj.frame),
        after: state,
      })
      result.frames.push(obj.frame)
    }
    if (inserts.length) children.push({ type: 'insertFrames', trackId: track.id, entries: inserts })
    if (!result.updated.includes(track.id)) result.updated.push(track.id)
  }

  if (policy.strategy === 'class-vote') {
    return mergeByClassVote(proposals, policy, index, children, result, allocId)
  }

  for (const proposal of proposals) {
    const lowConfidence = proposal.objects.filter((o) => o.confidence < policy.minConfidence)
    const objects = proposal.objects.filter((o) => o.confidence >= policy.minConfidence)
    result.skipped += lowConfidence.length
    if (!objects.length) continue
    const effective: Proposal = { ...proposal, objects, confidence: proposal.confidence }

    if (policy.strategy === 'append') {
      createNew(effective, objects)
      continue
    }

    if (policy.strategy === 'fill-gaps') {
      const free = objects.filter((o) => !(index.get(o.frame)?.length))
      result.skipped += objects.length - free.length
      createNew(effective, free)
      continue
    }

    // replace-track
    const candidate = findCandidate(effective, index, policy)
    if (!candidate) {
      createNew(effective, objects)
      continue
    }
    if (candidate.manual && policy.protectManual) {
      const hitFrames = new Set(candidate.hits.map((h) => h.frame))
      for (const hit of candidate.hits) {
        result.conflicts.push({
          frame: hit.frame,
          trackId: candidate.track.id,
          manual: cloneGeometry(hit.entry.geometry),
          model: hit.obj,
          iou: hit.iou,
        })
      }
      // 冲突帧不覆盖，但模型在同一提案里发现的其它帧仍要收下 ——
      // 否则"人工标了首帧、模型补了后 30 帧"这种最常见的场景会整条丢掉
      const rest = objects.filter((o) => !hitFrames.has(o.frame))
      result.skipped += objects.length - rest.length
      createNew(effective, rest)
      continue
    }
    absorbInto(candidate.track, objects)
  }

  return finish(children, result)
}

/**
 * class-vote：两遍。
 * 第一遍收集"每条已有轨迹被哪些类别、以多少 IoU 投过票"，
 * 第二遍每条轨迹只改一次类别 —— 逐提案改会来回翻烧饼。
 */
function mergeByClassVote(
  proposals: Proposal[],
  policy: MergePolicy,
  index: Map<number, FrameEntry[]>,
  children: CommandData[],
  result: MergeResult,
  nextId: () => TrackId,
): MergePlan {
  interface Ballot { track: Track; votes: Map<ClassId, number>; manual: boolean }
  const ballots = new Map<TrackId, Ballot>()

  for (const proposal of proposals) {
    const objects = proposal.objects.filter((o) => o.confidence >= policy.minConfidence)
    result.skipped += proposal.objects.length - objects.length
    if (!objects.length) continue
    const candidate = findCandidate({ ...proposal, objects }, index, policy)
    if (!candidate) {
      // 没有对应的既有轨迹：投类模式也要把新目标收下，否则"只改类别"会变成
      // "漏掉所有模型新发现的目标"
      const id = nextId()
      children.push({ type: 'createTrack', track: buildTrack(proposal, id, objects) })
      result.created.push(id)
      for (const o of objects) result.frames.push(o.frame)
      continue
    }
    let ballot = ballots.get(candidate.track.id)
    if (!ballot) {
      ballot = { track: candidate.track, votes: new Map(), manual: candidate.manual }
      ballots.set(candidate.track.id, ballot)
    }
    // 票重 = 命中帧的 IoU 之和：既考虑"贴得准"，也考虑"持续得久"
    const weight = candidate.hits.reduce((n, h) => n + h.iou, 0)
    ballot.votes.set(proposal.classId, (ballot.votes.get(proposal.classId) ?? 0) + weight)
    if (candidate.manual) ballot.manual = true
    for (const hit of candidate.hits) {
      if (hit.obj.classId !== candidate.track.classId) {
        result.conflicts.push({
          frame: hit.frame,
          trackId: candidate.track.id,
          manual: cloneGeometry(hit.entry.geometry),
          model: hit.obj,
          iou: hit.iou,
        })
      }
    }
  }

  for (const ballot of ballots.values()) {
    const ranked = [...ballot.votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    const [winner, winWeight] = ranked[0]
    if (!winner || winner === ballot.track.classId) continue
    // 人工轨迹在 protectManual 下不改类：冲突已经记下，交给人裁决
    if (ballot.manual && policy.protectManual) continue
    const runnerUp = ranked[1]?.[1] ?? 0
    if (winWeight <= runnerUp) continue // 平票不动，避免随机翻转
    children.push({
      type: 'setClass',
      trackId: ballot.track.id,
      before: ballot.track.classId,
      after: winner,
    })
    result.updated.push(ballot.track.id)
  }

  return finish(children, result)
}

function finish(children: CommandData[], result: MergeResult): MergePlan {
  result.frames = [...new Set(result.frames)].sort((a, b) => a - b)
  if (!children.length) return { command: null, result }
  const label = summarizeMerge(result)
  const command = children.length === 1
    ? makeCommand(children[0], { label })
    : makeCommand({ type: 'batch', commands: children }, { label })
  return { command, result }
}

function summarizeMerge(r: MergeResult): string {
  const parts: string[] = []
  if (r.created.length) parts.push(`新增 ${r.created.length} 条`)
  if (r.updated.length) parts.push(`更新 ${r.updated.length} 条`)
  if (r.conflicts.length) parts.push(`冲突 ${r.conflicts.length} 处`)
  if (r.skipped) parts.push(`跳过 ${r.skipped} 个框`)
  return `预标注合并：${parts.join('、') || '无变化'}`
}

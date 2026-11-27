/**
 * ============================================================
 * 轨迹级编辑操作 —— 把"用户意图"翻译成命令
 * ============================================================
 *
 * 这一层只构造命令，不直接改文档（apply 是 TrackStore 的事）。
 * 好处：同一条操作既能被 UI 调用，也能被测试直接调用；
 * 未来接服务端时，命令本身就是提交体，不需要再写一遍业务逻辑。
 *
 * 现有点击路径（面板按钮）最终都落到这几个函数：
 *   插值补全 → buildInterpolateCommand
 *   跨帧传播 → buildPropagateCommand
 *   复制到其他帧 → buildCopyToFramesCommand
 *   轨迹合并/拆分 → buildMergeCommand / buildSplitCommand
 */
import type { BoxGeometry } from '../model/geometry'
import { angleDelta, cloneGeometry } from '../model/geometry'
import type { Command, CommandData, InsertedFrame } from '../model/command'
import { makeCommand } from '../model/command'
import type { Track } from '../model/track'
import { cloneTrack, findKeyframeIndex, touchLifecycle } from '../model/track'
import type { TrackId } from '../model/ids'
import {
  DEFAULT_INTERPOLATE_OPTIONS,
  planInterpolation,
  type InterpolateOptions,
  type InterpolationStats,
} from './interpolate'

/**
 * 改生命周期（时间线拖两端）。
 *
 * 夹取规则在这里定，而不是在组件里：`first <= last`、且不越出文档范围
 * 是数据的**不变量**，任何入口（时间线、右键菜单、将来的批量操作）都必须满足。
 * 落在新范围外的关键帧不动 —— 拖短再拖回来应该原样恢复。
 */
export function buildSetLifecycleCommand(
  track: Track,
  first: number,
  last: number,
  docRange: [number, number],
): Command | null {
  const lo = Math.max(docRange[0], Math.round(first))
  const hi = Math.min(docRange[1], Math.round(last))
  const next = { first: Math.min(lo, hi), last: Math.max(lo, hi), state: track.lifecycle.state }
  const cur = track.lifecycle
  if (next.first === cur.first && next.last === cur.last) return null
  return makeCommand(
    {
      type: 'setLifecycle',
      trackId: track.id,
      before: { ...cur },
      after: next,
    },
    { label: `#${track.id} 生命周期 ${cur.first}–${cur.last} → ${next.first}–${next.last}` },
  )
}

export function buildInsertFramesCommand(trackId: TrackId, entries: InsertedFrame[], label: string): Command {
  return makeCommand({ type: 'insertFrames', trackId, entries }, { label })
}

export interface InterpolateCommandResult {
  command: Command | null
  stats: InterpolationStats
}

/**
 * 轨迹插值命令：一条命令覆盖所有轨迹的所有补帧，撤销一次全退。
 * 这解决了旧实现"插值后直接 resetHistory，改错只能重来"的问题。
 */
export function buildInterpolateCommand(
  tracks: Track[],
  range: [number, number],
  opts: InterpolateOptions = DEFAULT_INTERPOLATE_OPTIONS,
  onlyIds?: Set<TrackId>,
): InterpolateCommandResult {
  const plan = planInterpolation(tracks, range, opts, onlyIds)
  if (!plan.entries.length) return { command: null, stats: plan.stats }

  // 按轨迹拆成 insertFrames 子命令，再包一层 batch：
  // 撤销时子命令逆序回滚，每条轨迹的关键帧一次删干净
  const children: CommandData[] = []
  const grouped = new Map<TrackId, InsertedFrame[]>()
  for (const e of plan.entries) {
    const list = grouped.get(e.trackId) ?? []
    list.push({
      frame: e.frame,
      geometry: e.geometry,
      source: { kind: 'interp' },
      ...(e.state ? { state: e.state } : {}),
    })
    grouped.set(e.trackId, list)
  }
  for (const [trackId, entries] of grouped) {
    entries.sort((a, b) => a.frame - b.frame)
    children.push({ type: 'insertFrames', trackId, entries })
  }

  const command =
    children.length === 1
      ? makeCommand(children[0], { label: `插值补全 ${plan.stats.frames} 帧` })
      : makeCommand(
          { type: 'batch', commands: children },
          { label: `插值补全 ${plan.stats.tracks} 条轨迹 / ${plan.stats.frames} 帧` },
        )

  return { command, stats: plan.stats }
}

export type PropagateScope = 'all' | 'forward' | 'backward'
export type PropagateStrategy = 'replace' | 'offset'

/**
 * 跨帧传播命令。
 *
 * @param track 目标轨迹
 * @param fromFrame 当前帧
 * @param reference 编辑前的几何（用于算 offset 增量）
 * @param edited 编辑后的几何
 * @param scope 前/后/全部
 * @param strategy 整框替换 / 增量平移
 */
export function buildPropagateCommand(
  track: Track,
  fromFrame: number,
  reference: BoxGeometry,
  edited: BoxGeometry,
  scope: PropagateScope,
  strategy: PropagateStrategy,
): Command | null {
  const dx = edited.position.x - reference.position.x
  const dy = edited.position.y - reference.position.y
  const dz = edited.position.z - reference.position.z
  const dyaw = angleDelta(reference.yaw, edited.yaw)

  const children: CommandData[] = []
  for (const kf of track.keyframes) {
    if (kf.frame === fromFrame) continue
    if (scope === 'forward' && kf.frame < fromFrame) continue
    if (scope === 'backward' && kf.frame > fromFrame) continue
    const before = cloneGeometry(kf.geometry)
    let after: BoxGeometry
    if (strategy === 'replace') {
      after = cloneGeometry(edited)
    } else {
      after = {
        position: {
          x: kf.geometry.position.x + dx,
          y: kf.geometry.position.y + dy,
          z: kf.geometry.position.z + dz,
        },
        scale: { ...kf.geometry.scale },
        yaw: kf.geometry.yaw + dyaw,
      }
    }
    children.push({ type: 'setKeyframe', trackId: track.id, frame: kf.frame, before, after })
  }
  if (!children.length) return null

  const scopeText = { all: '全部帧', forward: '后续帧', backward: '前序帧' }[scope]
  const strategyText = strategy === 'replace' ? '整框替换' : '增量平移'
  return children.length === 1
    ? makeCommand(children[0], { label: `传播 #${track.id}（${strategyText}）` })
    : makeCommand(
        { type: 'batch', commands: children },
        { label: `传播 #${track.id} 到${scopeText}（${strategyText}）` },
      )
}

/** 把当前帧的几何复制到若干目标帧（目标帧已有该轨迹关键帧则跳过，由调用方过滤） */
export function buildCopyToFramesBatchCommand(
  items: Array<{ trackId: TrackId; frames: number[]; geometry: BoxGeometry }>,
  label: string,
): Command | null {
  const children: CommandData[] = []
  let total = 0
  for (const item of items) {
    if (!item.frames.length) continue
    const entries: InsertedFrame[] = [...item.frames]
      .sort((a, b) => a - b)
      .map((frame) => ({ frame, geometry: cloneGeometry(item.geometry), source: { kind: 'manual' } }))
    children.push({ type: 'insertFrames', trackId: item.trackId, entries })
    total += entries.length
  }
  if (!children.length) return null
  return children.length === 1
    ? makeCommand(children[0], { label: `${label}（${total} 帧）` })
    : makeCommand({ type: 'batch', commands: children }, { label: `${label}（${total} 帧）` })
}

export function buildCopyToFramesCommand(trackId: TrackId, frames: number[], geometry: BoxGeometry): Command | null {
  return buildCopyToFramesBatchCommand([{ trackId, frames, geometry }], `#${trackId} 复制到其他帧`)
}

/**
 * 合并两条轨迹（串 ID 修复）。
 * 关键帧取并集：同帧冲突时保留 keep 的几何 —— keep 是用户点"保留"的那条，
 * 它的位置是人工确认过的，被吸收的那条多半是错的。
 */
export function buildMergeCommand(keep: Track, absorbed: Track[]): Command | null {
  if (!absorbed.length) return null
  const merged = cloneTrack(keep)
  for (const other of absorbed) {
    for (const kf of other.keyframes) {
      if (findKeyframeIndex(merged, kf.frame) >= 0) continue
      merged.keyframes.push({
        frame: kf.frame,
        geometry: cloneGeometry(kf.geometry),
        source: { ...kf.source },
      })
    }
    merged.keyframes.sort((a, b) => a.frame - b.frame)
    for (const [frame, state] of other.states) {
      if (!merged.states.has(frame)) merged.states.set(frame, { ...state, source: { ...state.source } })
    }
    merged.lifecycle.first = Math.min(merged.lifecycle.first, other.lifecycle.first)
    merged.lifecycle.last = Math.max(merged.lifecycle.last, other.lifecycle.last)
    merged.attributes = { ...other.attributes, ...merged.attributes }
  }
  touchLifecycle(merged)

  return makeCommand(
    {
      type: 'mergeTracks',
      keep: keep.id,
      absorb: absorbed.map((t) => t.id),
      before: [cloneTrack(keep), ...absorbed.map(cloneTrack)],
      after: merged,
    },
    { label: `合并 ${absorbed.length + 1} 条轨迹为 #${keep.id}` },
  )
}

/**
 * 拆分轨迹：atFrame 及之后的帧归新 id。
 * 典型场景：前车驶离、后车补位，两段被标成了同一个 obj_id。
 */
export function buildSplitCommand(track: Track, atFrame: number, newId: TrackId): Command | null {
  const leftKfs = track.keyframes.filter((k) => k.frame < atFrame)
  const rightKfs = track.keyframes.filter((k) => k.frame >= atFrame)
  if (!leftKfs.length || !rightKfs.length) return null

  const left = cloneTrack(track)
  left.keyframes = leftKfs.map((k) => ({
    frame: k.frame,
    geometry: cloneGeometry(k.geometry),
    source: { ...k.source },
  }))
  left.states = new Map([...track.states].filter(([f]) => f < atFrame))
  touchLifecycle(left)

  const right: Track = {
    ...cloneTrack(track),
    id: newId,
    keyframes: rightKfs.map((k) => ({
      frame: k.frame,
      geometry: cloneGeometry(k.geometry),
      source: { ...k.source },
    })),
    states: new Map([...track.states].filter(([f]) => f >= atFrame)),
  }
  touchLifecycle(right)

  return makeCommand(
    {
      type: 'splitTrack',
      source: track.id,
      atFrame,
      newId,
      before: cloneTrack(track),
      after: [left, right],
    },
    { label: `拆分 #${track.id} → #${newId}` },
  )
}

/**
 * 遮挡标记命令：在缺口帧补一个"观察不到但位置已知"的关键帧。
 * 这是旧 `runOcclusionDemo` 的正式版本 —— 它以前直接往 frames[i].boxes 里 push，
 * 既不进历史也不进文档，切帧就丢。
 */
export function buildOcclusionMarkerCommand(track: Track, frame: number, geometry: BoxGeometry): Command {
  return makeCommand(
    {
      type: 'insertFrames',
      trackId: track.id,
      entries: [
        {
          frame,
          geometry: cloneGeometry(geometry),
          source: { kind: 'manual' },
          state: { visibility: 'occluded', source: { kind: 'manual' }, review: 'none' },
        },
      ],
    },
    { label: `标记 #${track.id} 第 ${frame} 帧遮挡` },
  )
}

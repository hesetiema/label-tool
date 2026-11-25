/**
 * ============================================================
 * 命令应用 / 回滚 —— 唯一允许改真值的地方
 * ============================================================
 *
 * 约定：`applyCommand` 与 `revertCommand` 必须是同一份数据的两向映射。
 * 任何"只在 apply 里做、revert 里忘了"的动作都会在撤销时留下幽灵数据，
 * 所以两者写在同一个文件里、按 type 一一对照。
 *
 * 另一条铁律：**命令里存的对象一律 clone 后再写入文档**。
 * 否则 apply 之后用户继续编辑，改的是命令自己持有的那份，
 * redo 时拿到的"原始快照"已经被改花了。
 */
import type { SampleDocument } from '../model/document'
import type { Command, CommandData, InsertedFrame } from '../model/command'
import type { BoxGeometry } from '../model/geometry'
import { cloneGeometry } from '../model/geometry'
import type { ObservationState, Track } from '../model/track'
import { cloneTrack, removeKeyframe, touchLifecycle, upsertKeyframe } from '../model/track'
import type { TrackId } from '../model/ids'

/** 轨迹索引：TrackStore 持有，避免每帧渲染都 O(n) 扫数组 */
export interface TrackIndex {
  get(id: TrackId): Track | undefined
  set(track: Track): void
  delete(id: TrackId): void
}

export class MapTrackIndex implements TrackIndex {
  private map = new Map<TrackId, Track>()

  get(id: TrackId): Track | undefined {
    return this.map.get(id)
  }

  set(track: Track): void {
    this.map.set(track.id, track)
  }

  delete(id: TrackId): void {
    this.map.delete(id)
  }

  get size(): number {
    return this.map.size
  }

  ids(): IterableIterator<TrackId> {
    return this.map.keys()
  }
}

function docTracks(doc: SampleDocument): Track[] {
  return doc.tasks.boxes.tracks
}

/**
 * 任务载荷描述对象的克隆。
 * 优先 structuredClone（保 TypedArray），失败退回 JSON —— 传进来的可能是
 * Vue 的响应式 Proxy，structuredClone 对 Proxy 会抛 DataCloneError。
 */
function clonePayload<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value)
    } catch {
      /* Proxy / 不可克隆对象，落到 JSON */
    }
  }
  return JSON.parse(JSON.stringify(value)) as T
}

/** 非 boxes 任务的大载荷槽位。boxes 走 Track，绝不能被这条路径覆盖 */
function payloadSlot(doc: SampleDocument): Record<string, unknown> {
  return doc.tasks as unknown as Record<string, unknown>
}

function addTrack(doc: SampleDocument, track: Track, index: TrackIndex): void {
  docTracks(doc).push(track)
  index.set(track)
}

function dropTrack(doc: SampleDocument, id: TrackId, index: TrackIndex): void {
  const list = docTracks(doc)
  const i = list.findIndex((t) => t.id === id)
  if (i >= 0) list.splice(i, 1)
  index.delete(id)
}

function setKeyframeGeometry(
  track: Track,
  frame: number,
  geometry: BoxGeometry | null,
  source: InsertedFrame['source'] = { kind: 'manual' },
  state?: ObservationState,
): void {
  if (!geometry) {
    removeKeyframe(track, frame)
    return
  }
  upsertKeyframe(track, { frame, geometry: cloneGeometry(geometry), source: { ...source } })
  if (state) track.states.set(frame, { ...state, source: { ...state.source } })
  else track.states.delete(frame)
  touchLifecycle(track)
}

function applyOne(doc: SampleDocument, cmd: CommandData, index: TrackIndex): void {
  switch (cmd.type) {
    case 'createTrack': {
      addTrack(doc, cloneTrack(cmd.track), index)
      return
    }
    case 'deleteTracks': {
      for (const t of cmd.tracks) dropTrack(doc, t.id, index)
      return
    }
    case 'setKeyframe': {
      const track = index.get(cmd.trackId)
      if (!track) return
      setKeyframeGeometry(track, cmd.frame, cmd.after)
      return
    }
    case 'setObservation': {
      const track = index.get(cmd.trackId)
      if (!track) return
      if (cmd.after) track.states.set(cmd.frame, { ...cmd.after, source: { ...cmd.after.source } })
      else track.states.delete(cmd.frame)
      return
    }
    case 'setClass': {
      const track = index.get(cmd.trackId)
      if (!track) return
      track.classId = cmd.after
      return
    }
    case 'setLifecycle': {
      const track = index.get(cmd.trackId)
      if (!track) return
      track.lifecycle = { ...cmd.after }
      return
    }
    case 'insertFrames': {
      const track = index.get(cmd.trackId)
      if (!track) return
      for (const entry of cmd.entries) {
        setKeyframeGeometry(track, entry.frame, entry.geometry, entry.source, entry.state)
      }
      return
    }
    case 'mergeTracks': {
      const merged = cloneTrack(cmd.after)
      for (const id of cmd.absorb) dropTrack(doc, id, index)
      const list = docTracks(doc)
      const at = list.findIndex((t) => t.id === cmd.keep)
      if (at >= 0) list[at] = merged
      else list.push(merged)
      index.set(merged)
      return
    }
    case 'splitTrack': {
      const [left, right] = cmd.after
      const list = docTracks(doc)
      const at = list.findIndex((t) => t.id === cmd.source)
      const leftClone = cloneTrack(left)
      if (at >= 0) list[at] = leftClone
      else list.push(leftClone)
      index.set(leftClone)
      addTrack(doc, cloneTrack(right), index)
      return
    }
    case 'batch': {
      for (const child of cmd.commands) applyOne(doc, child, index)
      return
    }
    case 'setTaskPayload': {
      // 防御：即使类型层被绕过，也不能让 boxes 被整体替换成描述对象
      if (cmd.task === 'boxes') return
      const slot = payloadSlot(doc)
      if (cmd.after === null || cmd.after === undefined) delete slot[cmd.task]
      else slot[cmd.task] = clonePayload(cmd.after)
      return
    }
  }
}

function revertOne(doc: SampleDocument, cmd: CommandData, index: TrackIndex): void {
  switch (cmd.type) {
    case 'createTrack': {
      dropTrack(doc, cmd.track.id, index)
      return
    }
    case 'deleteTracks': {
      for (const t of cmd.tracks) addTrack(doc, cloneTrack(t), index)
      return
    }
    case 'setKeyframe': {
      const track = index.get(cmd.trackId)
      if (!track) return
      setKeyframeGeometry(track, cmd.frame, cmd.before)
      return
    }
    case 'setObservation': {
      const track = index.get(cmd.trackId)
      if (!track) return
      if (cmd.before) track.states.set(cmd.frame, { ...cmd.before, source: { ...cmd.before.source } })
      else track.states.delete(cmd.frame)
      return
    }
    case 'setClass': {
      const track = index.get(cmd.trackId)
      if (!track) return
      track.classId = cmd.before
      return
    }
    case 'setLifecycle': {
      const track = index.get(cmd.trackId)
      if (!track) return
      track.lifecycle = { ...cmd.before }
      return
    }
    case 'insertFrames': {
      // 约定：insertFrames 只插入原本不存在的帧（插值/传播的入口保证这一点），
      // 因此回滚就是把这些帧删掉。若调用方覆盖了已有视频帧，回滚会丢原关键帧。
      const track = index.get(cmd.trackId)
      if (!track) return
      for (const entry of cmd.entries) {
        removeKeyframe(track, entry.frame)
        track.states.delete(entry.frame)
      }
      return
    }
    case 'mergeTracks': {
      const [keepBefore, ...absorbed] = cmd.before
      const list = docTracks(doc)
      const at = list.findIndex((t) => t.id === cmd.keep)
      const restored = cloneTrack(keepBefore)
      if (at >= 0) list[at] = restored
      else list.push(restored)
      index.set(restored)
      for (const t of absorbed) addTrack(doc, cloneTrack(t), index)
      return
    }
    case 'splitTrack': {
      dropTrack(doc, cmd.newId, index)
      const restored = cloneTrack(cmd.before)
      const list = docTracks(doc)
      const at = list.findIndex((t) => t.id === cmd.source)
      if (at >= 0) list[at] = restored
      else list.push(restored)
      index.set(restored)
      return
    }
    case 'batch': {
      for (let i = cmd.commands.length - 1; i >= 0; i--) revertOne(doc, cmd.commands[i], index)
      return
    }
    case 'setTaskPayload': {
      if (cmd.task === 'boxes') return
      const slot = payloadSlot(doc)
      if (cmd.before === null || cmd.before === undefined) delete slot[cmd.task]
      else slot[cmd.task] = clonePayload(cmd.before)
      return
    }
  }
}

export function applyCommand(doc: SampleDocument, cmd: Command, index: TrackIndex): void {
  applyOne(doc, cmd, index)
}

export function revertCommand(doc: SampleDocument, cmd: Command, index: TrackIndex): void {
  revertOne(doc, cmd, index)
}

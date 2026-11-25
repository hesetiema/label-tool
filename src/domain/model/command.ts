/**
 * ============================================================
 * Command —— 可逆、可审计、可重放
 * ============================================================
 *
 * 【关键决策：命令是数据，不是闭包】
 *   闭包式命令（{ do, undo }）写起来最省事，但不可序列化、不可重放、
 *   不可跨端同步，审计日志里只剩一句 label。
 *   改成"数据 + 注册表"后，「插值补全」这条命令能完整记录
 *   "给哪 12 条轨迹补了哪 37 帧"，回滚时逐条删除，同时它本身就是一条审计记录。
 *
 * 【为什么有 batch】
 *   一次多选拖拽会同时产生"几何变化 + 可见性变化"，一次预标注合并会同时
 *   "新建若干轨迹 + 删除若干轨迹"。用 batch 把子命令收成一步撤销，
 *   比给每种组合再定义一种命令类型更不容易漏。
 *
 * 【大载荷按引用存】
 *   占据一帧 60KB，一次 ROI 编辑可能改十几帧。把 before/after 内联进命令，
 *   500 步历史能吃掉几百 MB。所以这类任务用 setTaskPayload 只存 BlobStore 的
 *   内容哈希（P3 实现，届时先写 blob 回收再开 ROI 编辑）。
 */
import type { BoxGeometry } from './geometry'
import type { ClassId, TrackId } from './ids'
import type { ObservationState, SourceTag, Track, TrackLifecycle } from './track'
import type { TaskKey } from './document'

export interface InsertedFrame {
  frame: number
  geometry: BoxGeometry
  source: SourceTag
  /** 尾部续接等场景需要同时写入非默认可见性 */
  state?: ObservationState
}

export type CommandData =
  | { type: 'createTrack'; track: Track }
  | { type: 'deleteTracks'; tracks: Track[] }
  | { type: 'setKeyframe'; trackId: TrackId; frame: number; before: BoxGeometry | null; after: BoxGeometry | null }
  | { type: 'setObservation'; trackId: TrackId; frame: number; before: ObservationState | null; after: ObservationState | null }
  | { type: 'setClass'; trackId: TrackId; before: ClassId; after: ClassId }
  /**
   * 改生命周期（时间线上拖两端）。
   * 只动 `lifecycle`，**不删**落在范围外的关键帧 —— 拖短再拖回来应该原样恢复，
   * 而不是让用户在拖拽中意外丢掉标注。真要删帧是 `insertFrames` 的反操作。
   */
  | { type: 'setLifecycle'; trackId: TrackId; before: TrackLifecycle; after: TrackLifecycle }
  | { type: 'insertFrames'; trackId: TrackId; entries: InsertedFrame[] }
  /** before[0] 是 keep 的原样，其余是被吸收轨迹；after 是合并结果 */
  | { type: 'mergeTracks'; keep: TrackId; absorb: TrackId[]; before: Track[]; after: Track }
  /** before 是拆分前；after[0] 保留原 id（前半段），after[1] 是新 id（后半段） */
  | { type: 'splitTrack'; source: TrackId; atFrame: number; newId: TrackId; before: Track; after: [Track, Track] }
  /**
   * 大任务载荷（占据 / 光流 / 语义）整体替换。
   * `before`/`after` 是**描述对象**（几十字节，里面带 `payload/<hash>` 引用），
   * blob 本体在 BlobStore；`beforeRef`/`afterRef` 是主载荷引用，
   * 便于审计与"提前释放"判断，不重复存字节。
   */
  | {
    type: 'setTaskPayload'
    task: TaskKey
    before: unknown | null
    after: unknown | null
    beforeRef: string | null
    afterRef: string | null
  }
  | { type: 'batch'; commands: CommandData[] }

export interface CommandAffects {
  frames: number[]
  tracks: TrackId[]
  tasks: TaskKey[]
}

export interface CommandMeta {
  id: string
  /** UI 文案："插值补全 12 条轨迹" */
  label: string
  at: number
  actor: string
  /** 合并键：拖拽连续事件合成一步 */
  coalesceKey?: string
  /** 受影响范围，供增量渲染与增量质检 */
  affects: CommandAffects
}

export type Command = CommandData & { meta: CommandMeta }

let commandSeq = 0

/**
 * 命令 id。带时间戳是为了跨会话可读（审计日志里能看出先后），
 * 单调序号保证同一毫秒内也不重复。
 */
export function nextCommandId(prefix = 'cmd'): string {
  commandSeq += 1
  return `${prefix}-${Date.now().toString(36)}-${commandSeq.toString(36)}`
}

function uniq<T>(list: T[]): T[] {
  return [...new Set(list)]
}

/** 从命令数据推出受影响范围 —— 手写 affects 必然漏，统一在这里算 */
export function affectsOf(data: CommandData): CommandAffects {
  switch (data.type) {
    case 'createTrack':
      return { frames: data.track.keyframes.map((k) => k.frame), tracks: [data.track.id], tasks: ['boxes'] }
    case 'deleteTracks':
      return {
        frames: uniq(data.tracks.flatMap((t) => t.keyframes.map((k) => k.frame))).sort((a, b) => a - b),
        tracks: data.tracks.map((t) => t.id),
        tasks: ['boxes'],
      }
    case 'setKeyframe':
      return { frames: [data.frame], tracks: [data.trackId], tasks: ['boxes'] }
    case 'setObservation':
      return { frames: [data.frame], tracks: [data.trackId], tasks: ['boxes'] }
    case 'setClass':
      return { frames: [], tracks: [data.trackId], tasks: ['boxes'] }
    case 'setLifecycle':
      // 只报端点：真正"新增/消失了哪些帧"是区间差，交给下游按区间处理。
      // 硬铺成数组的话，拖一次 500 帧的轨迹就要生成 500 个数字
      return {
        frames: uniq([data.before.first, data.before.last, data.after.first, data.after.last]).sort((a, b) => a - b),
        tracks: [data.trackId],
        tasks: ['boxes'],
      }
    case 'insertFrames':
      return {
        frames: uniq(data.entries.map((e) => e.frame)).sort((a, b) => a - b),
        tracks: [data.trackId],
        tasks: ['boxes'],
      }
    case 'mergeTracks':
      return {
        frames: uniq(data.before.flatMap((t) => t.keyframes.map((k) => k.frame))).sort((a, b) => a - b),
        tracks: [data.keep, ...data.absorb],
        tasks: ['boxes'],
      }
    case 'splitTrack':
      return {
        frames: uniq([...data.before.keyframes, ...data.after[0].keyframes, ...data.after[1].keyframes]
          .map((k) => k.frame)).sort((a, b) => a - b),
        tracks: [data.source, data.newId],
        tasks: ['boxes'],
      }
    case 'setTaskPayload':
      return { frames: [], tracks: [], tasks: [data.task] }
    case 'batch': {
      const parts = data.commands.map(affectsOf)
      return {
        frames: uniq(parts.flatMap((p) => p.frames)).sort((a, b) => a - b),
        tracks: uniq(parts.flatMap((p) => p.tracks)),
        tasks: uniq(parts.flatMap((p) => p.tasks)),
      }
    }
  }
}

export function makeCommand(
  data: CommandData,
  opts: { label: string; actor?: string; coalesceKey?: string; at?: number },
): Command {
  return {
    ...data,
    meta: {
      id: nextCommandId(),
      label: opts.label,
      at: opts.at ?? Date.now(),
      actor: opts.actor ?? 'local',
      ...(opts.coalesceKey ? { coalesceKey: opts.coalesceKey } : {}),
      affects: affectsOf(data),
    },
  }
}

/** 人读的变更摘要，审计列表与状态栏共用 */
export function summarizeCommand(data: CommandData): string {
  switch (data.type) {
    case 'createTrack':
      return `新建轨迹 #${data.track.id}`
    case 'deleteTracks':
      return `删除 ${data.tracks.length} 条轨迹`
    case 'setKeyframe':
      if (data.after && !data.before) return `#${data.trackId} 第 ${data.frame} 帧新增关键帧`
      if (!data.after && data.before) return `#${data.trackId} 第 ${data.frame} 帧删除关键帧`
      return `#${data.trackId} 第 ${data.frame} 帧调整几何`
    case 'setObservation':
      return `#${data.trackId} 第 ${data.frame} 帧标记为 ${data.after?.visibility ?? '默认'}`
    case 'setClass':
      return `#${data.trackId} 类别 ${data.before} → ${data.after}`
    case 'setLifecycle':
      return `#${data.trackId} 生命周期 ${data.before.first}–${data.before.last} → ${data.after.first}–${data.after.last}`
    case 'insertFrames':
      return `#${data.trackId} 插入 ${data.entries.length} 帧`
    case 'mergeTracks':
      return `合并 ${data.absorb.length + 1} 条轨迹为 #${data.keep}`
    case 'splitTrack':
      return `拆分 #${data.source} → #${data.newId}（第 ${data.atFrame} 帧）`
    case 'setTaskPayload':
      if (!data.beforeRef && data.afterRef) return `${data.task} 载荷写入`
      if (data.beforeRef && !data.afterRef) return `${data.task} 载荷清除`
      return `${data.task} 载荷替换`
    case 'batch': {
      const counts = new Map<string, number>()
      for (const c of data.commands) counts.set(c.type, (counts.get(c.type) ?? 0) + 1)
      return [...counts].map(([t, n]) => `${t}×${n}`).join('、')
    }
  }
}

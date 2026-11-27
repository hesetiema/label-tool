/**
 * ============================================================
 * CommandHistory —— 文档级撤销栈 + 审计流
 * ============================================================
 *
 * 与 `core/history.ts` 的 HistoryStack 的区别：
 *   - 那个存的是"整帧 Box3D[] 快照"，内存 O(帧内框数)，且跨帧操作无法用一份快照表达；
 *   - 这个存的是命令（差异），500 步历史只占几十 KB，且天然可审计、可重放。
 *
 * 【切帧不再清空历史】
 *   历史是文档级的，不是帧级的。旧实现切帧就 resetHistory，
 *   用户实际感受是"改错了只能重来" —— 这是 P1 要修掉的核心体验问题。
 *
 * 【合并窗口】
 *   拖 yaw 滑杆会触发几十次事件。相同 coalesceKey 且在 700ms 内的连续命令
 *   合并成一条：只更新 after，不新增条目。与旧 `history.ts:68-73` 同一语义。
 */
import type { Command, CommandData } from '../model/command'
import { affectsOf, summarizeCommand } from '../model/command'

export interface AuditEntry {
  commandId: string
  type: Command['type']
  label: string
  actor: string
  at: number
  affects: Command['meta']['affects']
  /** 变更摘要，用于审计列表展示："新增 37 个框 / 12 条轨迹" */
  summary: string
}

type SetKeyframeCmd = Extract<CommandData, { type: 'setKeyframe' }>
type SetObservationCmd = Extract<CommandData, { type: 'setObservation' }>
type SetClassCmd = Extract<CommandData, { type: 'setClass' }>
type InsertFramesCmd = Extract<CommandData, { type: 'insertFrames' }>
type BatchCmd = Extract<CommandData, { type: 'batch' }>

/**
 * 原地把 next 合并进 prev。返回 false 表示"不能合并，请新增一条"。
 *
 * 只合并"同一目标的同类修改"：几何、可见性、类别、插值帧。
 * 新建/删除/合并/拆分不合并 —— 它们的目标集合不同，硬合并会让撤销语义变得不可解释。
 */
function mergeInto(prev: CommandData, next: CommandData): boolean {
  if (prev.type !== next.type) return false
  switch (prev.type) {
    case 'setKeyframe': {
      const p = prev as SetKeyframeCmd
      const n = next as SetKeyframeCmd
      if (p.trackId !== n.trackId || p.frame !== n.frame) return false
      p.after = n.after
      return true
    }
    case 'setObservation': {
      const p = prev as SetObservationCmd
      const n = next as SetObservationCmd
      if (p.trackId !== n.trackId || p.frame !== n.frame) return false
      p.after = n.after
      return true
    }
    case 'setClass': {
      const p = prev as SetClassCmd
      const n = next as SetClassCmd
      if (p.trackId !== n.trackId) return false
      p.after = n.after
      return true
    }
    case 'insertFrames': {
      const p = prev as InsertFramesCmd
      const n = next as InsertFramesCmd
      if (p.trackId !== n.trackId) return false
      // 同帧覆盖：保留最初的 before（虽然 insertFrames 的约定是只插空帧）
      const frames = new Set(p.entries.map((e) => e.frame))
      for (const entry of n.entries) {
        if (!frames.has(entry.frame)) p.entries.push(entry)
      }
      return true
    }
    case 'batch': {
      const p = prev as BatchCmd
      const n = next as BatchCmd
      if (p.commands.length !== n.commands.length) return false
      let mergedAny = false
      for (let i = 0; i < p.commands.length; i++) {
        if (mergeInto(p.commands[i], n.commands[i])) mergedAny = true
        else return false
      }
      return mergedAny
    }
    default:
      return false
  }
}

export class CommandHistory {
  private undoStack: Command[] = []
  private redoStack: Command[] = []
  private log: AuditEntry[] = []
  private readonly limit: number
  private readonly mergeWindowMs: number
  private readonly now: () => number
  private readonly onDrop?: (cmd: Command) => void

  constructor(
    options: {
      limit?: number
      mergeWindowMs?: number
      now?: () => number
      /**
       * 命令被**永久**丢弃时回调：超出 limit、提交新分支清空 redo、clear。
       * 撤销/重做只是在两个栈之间搬运，不算丢弃 —— 引用仍然活着。
       * 这是 blob 回收唯一的释放信号源，漏调用的后果是存储只增不减。
       */
      onCommandDropped?: (cmd: Command) => void
    } = {},
  ) {
    this.limit = options.limit ?? 500
    this.mergeWindowMs = options.mergeWindowMs ?? 700
    this.now = options.now ?? (() => Date.now())
    this.onDrop = options.onCommandDropped
  }

  /**
   * 记录一条已经 apply 过的命令。
   * 注意顺序：调用方必须"先 apply 再 commit"，否则合并逻辑会把 after 覆盖掉。
   */
  commit(cmd: Command): void {
    const top = this.undoStack[this.undoStack.length - 1]
    const key = cmd.meta.coalesceKey
    if (
      key &&
      top &&
      top.meta.coalesceKey === key &&
      this.now() - top.meta.at < this.mergeWindowMs &&
      mergeInto(top, cmd)
    ) {
      top.meta.at = cmd.meta.at
      top.meta.affects = affectsOf(top)
      this.dropRedo()
      this.refreshLastAudit(top)
      return
    }

    this.undoStack.push(cmd)
    if (this.undoStack.length > this.limit) {
      const evicted = this.undoStack.shift()
      if (evicted) this.onDrop?.(evicted)
    }
    this.dropRedo()
    this.pushAudit(cmd)
  }

  undo(): Command | null {
    const cmd = this.undoStack.pop()
    if (!cmd) return null
    this.redoStack.push(cmd)
    return cmd
  }

  redo(): Command | null {
    const cmd = this.redoStack.pop()
    if (!cmd) return null
    this.undoStack.push(cmd)
    return cmd
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
  get undoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.meta.label ?? ''
  }
  get redoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.meta.label ?? ''
  }
  get undoCount(): number {
    return this.undoStack.length
  }
  get redoCount(): number {
    return this.redoStack.length
  }

  /** 当前可撤销命令（只读用途：诊断、测试） */
  peekUndo(): Command | null {
    return this.undoStack[this.undoStack.length - 1] ?? null
  }

  /**
   * 仍被视为"活着"的全部命令：撤销栈 + 重做栈。
   * 撤销过的命令还能重做，所以它引用的 blob 不能回收 —— 这是 refCounter
   * 与 liveRefs 都基于两个栈、而不是只基于 undoStack 的原因。
   */
  commands(): Command[] {
    return [...this.undoStack, ...this.redoStack]
  }

  /** 审计流：按执行顺序，包含已被撤销的条目 —— 审计要的是"发生过什么" */
  auditLog(): AuditEntry[] {
    return this.log.map((e) => ({ ...e, affects: { ...e.affects } }))
  }

  clear(): void {
    const dropped = [...this.undoStack, ...this.redoStack]
    this.undoStack = []
    this.redoStack = []
    this.log = []
    if (this.onDrop) for (const cmd of dropped) this.onDrop(cmd)
  }

  /** 新分支：重做栈里的命令永远不会再被执行，它们的引用可以释放 */
  private dropRedo(): void {
    if (!this.redoStack.length) return
    const dropped = this.redoStack
    this.redoStack = []
    if (this.onDrop) for (const cmd of dropped) this.onDrop(cmd)
  }

  private pushAudit(cmd: Command): void {
    this.log.push(toAuditEntry(cmd))
    if (this.log.length > 2000) this.log.shift()
  }

  private refreshLastAudit(cmd: Command): void {
    const last = this.log[this.log.length - 1]
    if (!last) return
    const next = toAuditEntry(cmd)
    last.at = next.at
    last.affects = next.affects
    last.summary = next.summary
  }
}

export function toAuditEntry(cmd: Command): AuditEntry {
  return {
    commandId: cmd.meta.id,
    type: cmd.type,
    label: cmd.meta.label,
    actor: cmd.meta.actor,
    at: cmd.meta.at,
    affects: { ...cmd.meta.affects },
    summary: summarizeCommand(cmd),
  }
}

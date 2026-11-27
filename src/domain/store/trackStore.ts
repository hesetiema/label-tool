/**
 * ============================================================
 * TrackStore —— 真值容器
 * ============================================================
 *
 * 【为什么不做深层响应式】
 *   Vue 的 ref 会递归代理 Track[]、Map、每个关键帧对象。10 万级对象下，
 *   首屏要花几百毫秒建立 Proxy，之后每次读字段都过一层拦截。
 *   真正的做法是只暴露一个版本号：
 *
 *     const docVersion = ref(0)
 *     const store = shallowRef(new TrackStore(doc))
 *     const frameBoxes = computed(() => store.value.materialize(currentFrame.value))
 *
 *   版本号变化驱动重算，其余时间 Track 是裸对象，物化路径没有 Proxy 开销。
 *
 * 【版本与文档版本】
 *   `version` 是 store 内的修订号（含 undo/redo），只用于触发 UI 重算；
 *   `doc.meta.version` 是提交版本，P7 与服务端冲突检测用。两者不要混。
 */
import type { SampleDocument } from '../model/document'
import type { Command } from '../model/command'
import type { Track } from '../model/track'
import type { TrackId } from '../model/ids'
import { nextNumericId } from '../model/ids'
import { applyCommand, MapTrackIndex, revertCommand } from './applyCommand'
import { CommandHistory } from './commandHistory'
import type { AuditEntry } from './commandHistory'
import { EditSession, type EditTarget } from './editSession'
import { commandBlobRefs, documentBlobRefs } from './blobRefs'
import { materializeFrame, materializeTrack, type Box3DView, type MaterializeOptions } from './materialize'

export class TrackStore implements Omit<EditTarget, 'frame'> {
  private doc: SampleDocument
  private index = new MapTrackIndex()
  private history: CommandHistory
  private revision = 0
  private dropHooks = new Set<(refs: string[]) => void>()

  constructor(doc: SampleDocument, options: { historyLimit?: number } = {}) {
    this.doc = doc
    this.history = new CommandHistory({
      limit: options.historyLimit,
      // 释放信号：命令被永久丢弃 → 它引用的 blob 进入回收候选。
      // 这里只做通知，真正删不删要由 GC 用 `liveBlobRefs()` 复核。
      onCommandDropped: (cmd) => this.emitDropped(commandBlobRefs(cmd)),
    })
    this.reindex()
  }

  get document(): SampleDocument {
    return this.doc
  }

  /** 修订号：每次 apply/undo/redo 自增，UI 用它触发重算 */
  get version(): number {
    return this.revision
  }

  get trackCount(): number {
    return this.doc.tasks.boxes.tracks.length
  }

  get tracks(): Track[] {
    return this.doc.tasks.boxes.tracks
  }

  getTrack(id: TrackId): Track | undefined {
    return this.index.get(id)
  }

  tracksInFrame(frame: number): Track[] {
    return this.doc.tasks.boxes.tracks.filter((t) => frame >= t.lifecycle.first && frame <= t.lifecycle.last)
  }

  materialize(frame: number, opts: MaterializeOptions = {}): Box3DView[] {
    return materializeFrame(this.doc, frame, opts)
  }

  materializeTrack(id: TrackId, frame: number, opts: MaterializeOptions = {}): Box3DView | null {
    const track = this.index.get(id)
    return track ? materializeTrack(track, frame, opts) : null
  }

  /**
   * 供导出/质检：全量物化，按帧流式产出。
   * 用 generator 而不是返回大数组 —— 500 帧 × 200 轨迹一次性物化是 10 万对象。
   */
  *materializeAll(opts: MaterializeOptions = {}): Generator<{ frame: number; boxes: Box3DView[] }> {
    const [from, to] = this.doc.range
    for (let f = from; f <= to; f++) {
      yield { frame: f, boxes: this.materialize(f, opts) }
    }
  }

  /** 执行一条命令（命令由 ops 层构造，store 不猜业务语义） */
  exec(cmd: Command): number {
    applyCommand(this.doc, cmd, this.index)
    this.history.commit(cmd)
    this.bump()
    return this.revision
  }

  undo(): Command | null {
    const cmd = this.history.undo()
    if (!cmd) return null
    revertCommand(this.doc, cmd, this.index)
    this.bump()
    return cmd
  }

  redo(): Command | null {
    const cmd = this.history.redo()
    if (!cmd) return null
    applyCommand(this.doc, cmd, this.index)
    this.bump()
    return cmd
  }

  beginEdit(frame: number): EditSession {
    return new EditSession(this, frame)
  }

  /** 下一个可用 id：扫过全部已用 id，不复用被删轨迹的号 */
  nextTrackId(): TrackId {
    return nextNumericId(this.index.ids())
  }

  get canUndo(): boolean {
    return this.history.canUndo
  }
  get canRedo(): boolean {
    return this.history.canRedo
  }
  get undoLabel(): string {
    return this.history.undoLabel
  }
  get redoLabel(): string {
    return this.history.redoLabel
  }
  get undoCount(): number {
    return this.history.undoCount
  }

  auditLog(): AuditEntry[] {
    return this.history.auditLog()
  }

  /**
   * 当前仍然被引用的 blob 键（历史命令 ∪ 文档直接引用）。
   * GC 的唯一真相来源：任何删除动作都必须先问它，而不是相信计数器的增量通知。
   */
  liveBlobRefs(): Set<string> {
    const out = documentBlobRefs(this.doc)
    for (const cmd of this.history.commands()) {
      for (const ref of commandBlobRefs(cmd)) out.add(ref)
    }
    return out
  }

  /**
   * 订阅"命令被永久丢弃"事件。返回取消订阅函数。
   * 换文档（rebuild / replaceDocument）时旧 store 连同订阅一起被丢弃，
   * 所以调用方不需要手工解绑；watch 上新 store 即可。
   */
  onCommandDropped(cb: (refs: string[]) => void): () => void {
    this.dropHooks.add(cb)
    return () => {
      this.dropHooks.delete(cb)
    }
  }

  clearHistory(): void {
    this.history.clear()
  }

  /** 换文档（导入/恢复草稿）：历史必须一起清，否则命令会打在旧文档上 */
  replaceDocument(doc: SampleDocument): void {
    this.doc = doc
    this.reindex()
    this.history.clear()
    this.bump()
  }

  /** 不变量自检：返回所有违规，空数组表示健康 */
  validate(): string[] {
    const out: string[] = []
    const seen = new Set<TrackId>()
    for (const t of this.doc.tasks.boxes.tracks) {
      if (seen.has(t.id)) out.push(`${t.id}: T4 轨迹 id 重复`)
      seen.add(t.id)
    }
    return out
  }

  private reindex(): void {
    const next = new MapTrackIndex()
    for (const t of this.doc.tasks.boxes.tracks) next.set(t)
    this.index = next
  }

  private bump(): void {
    this.revision += 1
    this.doc.meta.version += 1
    this.doc.meta.updatedAt = Date.now()
  }

  private emitDropped(refs: string[]): void {
    if (!refs.length) return
    for (const hook of this.dropHooks) hook(refs)
  }
}

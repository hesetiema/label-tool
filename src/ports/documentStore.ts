/**
 * 端口：DocumentStore
 *
 * 【为什么不是"存一个 JSON"】
 *   一个样本的文档包含点云引用、上百条轨迹、占据体素。整文档写入是典型的写放大：
 *   改一个框要重写几百 KB。
 *
 *   物理上按任务分段（meta / boxes / occupancy / flow / vla 各一条记录），
 *   逻辑上仍是一个文档 —— 读取时按 sampleId 聚合，写入时只写脏任务。
 *   这是方案 4.3 "写放大"一节给的缓解手段。
 */
import type { SampleDocument, TaskKey } from '../domain/model/document'
import type { SampleId } from '../domain/model/ids'

export interface StoredDocumentSummary {
  sampleId: SampleId
  sceneId: string
  updatedAt: number
  version: number
  /**
   * 帧范围与任务段。
   *
   * 【为什么让列表也知道这些】
   *   样本列表要帮用户判断"这份是不是我要删的"：只有一个 `sampleId` 时，
   *   用户看到的是 `scene#0-499` 这种拼出来的 id，仍然要猜。帧数与
   *   "有没有占据/光流"才是能对上记忆的线索。
   *   这两项都在文档头里，`listSamples` 本来就把头读出来了，不额外解码任务段。
   *
   * 声明成可选：旧文档头可能没有 range/tasks（v1 迁移来的），
   * 让读端自己做兜底比让写端回填历史数据更实际。
   */
  range?: [number, number]
  tasks?: TaskKey[]
}

export interface DocumentStore {
  load(sampleId: SampleId): Promise<SampleDocument | null>
  /**
   * 合并保存：写本次带来的任务段，并把它登记进 head；
   * **不会**删除库里已有、本次没带的其它任务段。
   *
   * 这是刻意的：工作台的自动保存只构造 boxes 段，若按整文档覆盖，
   * 一次改框就会让占据/光流段从 head 里消失（字节还在，但读不出来）。
   * 同理，删任务不能用 save 表达，只能 `removeTask`。
   */
  save(doc: SampleDocument): Promise<void>
  /** 只写一个任务段；调用前文档必须已 save 过（否则段永远读不出来） */
  saveTask(sampleId: SampleId, task: TaskKey, payload: unknown): Promise<void>
  /** 删一个任务段并摘掉 head 登记 */
  removeTask(sampleId: SampleId, task: TaskKey): Promise<void>
  listSamples(): Promise<StoredDocumentSummary[]>
  remove(sampleId: SampleId): Promise<void>
  /**
   * 所有已落盘文档里的大载荷引用（不做完整解码）。
   *
   * 垃圾回收在**启动时**必须知道这个集合：内存里的历史已经被清空，
   * 但文档还指着那些 blob。若只看内存引用，启动清扫会把它们全删掉，
   * 表现为"下次打开占据任务，帧数据全没了"。
   *
   * 刻意不做 `load()` 聚合：boxes 段可能有上万关键帧，为了拿几个 ref
   * 把整份文档解码出来，比回收本身还贵。
   */
  listBlobRefs(): Promise<string[]>
  usage(): Promise<{ used: number; quota: number }>
}

/**
 * ============================================================
 * SampleDocument —— 一个样本上的所有任务
 * ============================================================
 *
 * 【为什么多任务放一个文档】
 *   ref.md 的核心诉求是"同一数据样本上维护多种任务标注的一致关联"。
 *   如果 boxes 和 occupancy 分属两个文件，一致性校验就退化成跨文件对齐，
 *   需要额外的事务与版本协商 —— 而这个项目没有后端事务能力。
 *   放在一个文档里，一致性规则能在一次读取内完成，一条命令也能原子地改两个任务。
 *
 * 【代价：写放大】
 *   改一个框会重写整个文档。缓解手段是 meta.hashes + 任务级脏标记 +
 *   IndexedDB 按任务分段存储（逻辑一个文档，物理多条记录，见 P0 的 documentStore）。
 *
 * 【schema 只认 2】
 *   v1 的 SessionSnapshot 是"全量帧 + 单 boxes"，迁移到 v2 走
 *   `domain/io/legacyDocument.ts`，不做"兼容两套内存模型"的傻事。
 */
import type { Vec3 } from './geometry'
import type { SampleId } from './ids'
import type { SourceTag, Track } from './track'
import type { VlaTaskData } from './vla'

export type TaskKey = 'boxes' | 'semantic' | 'occupancy' | 'flow' | 'lane' | 'vla'

export interface DocMeta {
  /** 单调递增，每次提交 +1 */
  version: number
  /** 提交时基于的版本；服务端冲突检测用 */
  baseVersion: number
  updatedAt: number
  updatedBy: string
  /** 每个任务的子文档哈希，支持"只锁 VLA 任务"这类细粒度并发 */
  hashes: Partial<Record<TaskKey, string>>
  /** 规则 profile 版本，保证"同一份报告可复现" */
  qaProfileVersion?: string
}

export interface BoxesTaskData {
  tracks: Track[]
}

/* ------------------------------------------------------------------
 * 其余任务的载荷：本期只定义"能存能取"的最小形状。
 * 真正的编辑能力在 P3/P4 落地，这里先让"一个文档装多任务"成立，
 * 避免 P1 的数据模型到 P3 又要改一次 schema。
 * ------------------------------------------------------------------ */

export interface SemanticTaskData {
  /** 逐点标签存 BlobStore，文档里只留引用 */
  pointLabelsRef?: string
  /** 实例 id → 轨迹 id 的映射（语义实例与 3D 框关联） */
  instanceMap?: Record<string, string>
  source?: SourceTag
}

export interface OccupancyGridSpec {
  resolution: number
  origin: Vec3
  size: { x: number; y: number; z: number }
  /** 占用类别表；free/unknown 不在此表，"未列出"即非占用 */
  classIds: string[]
}

export interface OccupancyTaskData {
  spec?: OccupancyGridSpec
  /** 每帧占据体素存 BlobStore（RLE 编码），文档只留引用 */
  frames?: Array<{ frame: number; ref: string }>
  source?: SourceTag
}

export interface FlowTaskData {
  /** 自车运动：只落盘 (dx, dy, dyaw, rmse)，4 个数/帧 */
  ego?: Array<{ frame: number; dx: number; dy: number; dyaw: number; rmse?: number }>
  pointFlowRef?: string
  source?: SourceTag
}

export interface LaneTaskData {
  lanes?: Array<{ id: string; points: Vec3[]; attributes?: Record<string, string | number | boolean> }>
  source?: SourceTag
}

/**
 * VLA 的载荷结构定义在 `./vla`，这里只做转出。
 *
 * 【为什么不在本文件就地写】
 *   这份文档只该回答"一个样本上有哪些任务、各挂什么"，任务载荷的内部结构
 *   越写越厚（占据 3 个类型、VLA 5 个类型）。留在本文件会让"文档是什么"
 *   被"占据是什么"和"VLA 是什么"淹没。boxes 早在 `./track` 里就是这样处理的。
 */
export type {
  VlaTaskData, InstructionSegment, ActionChannel, AlignmentLink, VlaSign, ChannelUnit, ChannelName,
} from './vla'

export interface SampleDocument {
  schema: 2
  sampleId: SampleId
  sceneId: string
  range: [number, number]
  tasks: {
    boxes: BoxesTaskData
    semantic?: SemanticTaskData
    occupancy?: OccupancyTaskData
    flow?: FlowTaskData
    lane?: LaneTaskData
    vla?: VlaTaskData
  }
  meta: DocMeta
}

export function createEmptyDocument(opts: {
  sampleId: SampleId
  sceneId: string
  range: [number, number]
  updatedBy?: string
  updatedAt?: number
}): SampleDocument {
  return {
    schema: 2,
    sampleId: opts.sampleId,
    sceneId: opts.sceneId,
    range: [opts.range[0], opts.range[1]],
    tasks: { boxes: { tracks: [] } },
    meta: {
      version: 0,
      baseVersion: 0,
      updatedAt: opts.updatedAt ?? Date.now(),
      updatedBy: opts.updatedBy ?? 'local',
      hashes: {},
    },
  }
}

/** 文档是否覆盖某帧 */
export function documentCovers(doc: SampleDocument, frame: number): boolean {
  return frame >= doc.range[0] && frame <= doc.range[1]
}

/**
 * 端口：预标注 Provider
 *
 * 【为什么是 AsyncGenerator 而不是 Promise<Result>】
 *   500 帧推理是分钟级任务。Promise 只有"开始"与"全部结束"两个时刻，
 *   中间既没有进度也没法中断 —— 用户按了取消要等它跑完，进度条只能靠猜。
 *   AsyncGenerator 让调用方 `for await` 逐块消费，`break` 就是取消，
 *   `signal` 传给实现方用于中断底层请求。三件事（进度 / 中断 / 逐帧合入）
 *   都不需要额外协议。
 *
 * 【为什么按帧产块，而不是按轨迹】
 *   模型侧的推理天然按帧批处理（一张 BEV 出一帧结果）。若按轨迹组织，
 *   实现方必须先缓存整个片段才能吐第一块，进度就变成了摆设。
 *   跨帧的身份关联放在 domain（`mergePreLabel.linkProposals`）——
 *   那是**标注语义**（同名同物），不是推理实现的技术细节。
 *
 * 【为什么 capabilities 是方法不是字段】
 *   能力来自远端服务，可能随版本变化；做成方法后可以在打开对话框时
 *   现问一次，而不是把首次探测的结果缓存到页面生命周期结束。
 */
import type { BoxGeometry } from '../domain/model/geometry'
import type { ClassId, SampleId } from '../domain/model/ids'

export interface ProviderCapabilities {
  /** 能产出哪些任务。本轮只消费 'boxes' */
  tasks: string[]
  /** 支持的类别；null 表示"不声明"，调用方不据此过滤 */
  classes: ClassId[] | null
  /** 单次请求最多多少帧；超出由调用方切段 */
  maxFramesPerRequest: number
  /** 是否流式返回。false 时实现方也应逐帧 yield，只是会先攒齐再吐 */
  supportsStreaming: boolean
  /** 是否需要相机图像（BEVFormer 类需要，纯点云模型不需要） */
  requiresImages: boolean
}

export interface PreAnnotateRequest {
  sampleId: SampleId
  /** 闭区间 [from, to] */
  frameRange: [number, number]
  sensors: string[]
  /**
   * 模型提示。
   * `classes` 为空表示"按模型默认类别表"，不要理解成"不要类别"。
   */
  hints?: {
    scoreThreshold?: number
    classes?: ClassId[]
    roi?: BoxGeometry
  }
}

export interface PreObject {
  classId: ClassId
  geometry: BoxGeometry
  confidence: number
  /**
   * 模型内部的轨迹 id。
   *
   * 【为什么值得单独传】模型往往在内部已经做了跟踪（BEV 时序融合）。
   * 有这个 id 时，跨帧关联是"直接分组"，不会因为两帧之间 IoU 掉到阈值
   * 以下就把一辆车拆成两条轨迹。没有时退回 IoU 链（见 linkProposals）。
   */
  modelTrackId?: string
  attributes?: Record<string, string | number | boolean>
}

export interface PreAnnotateChunk {
  frame: number
  objects: PreObject[]
  /** 0..1。允许非单调（重试会回退），调用方只取最后值 */
  progress: number
  /** 产出这一块的模型身份。落进 SourceTag，P6 的难度分要用 */
  model: { id: string; version: string; runtimeMs?: number }
}

export interface PreAnnotationProvider {
  readonly id: string
  readonly label: string
  capabilities(): ProviderCapabilities
  run(req: PreAnnotateRequest, signal?: AbortSignal): AsyncGenerator<PreAnnotateChunk>
}

/** 统一的取消判断：实现方在每帧之间调一次，浏览器与 Node 都有 DOMException */
export function isAborted(signal?: AbortSignal): boolean {
  return !!signal?.aborted
}

/** 中断错误。调用方据此区分"用户取消"与"真的失败" */
export function abortError(): Error {
  const err = new Error('预标注已取消')
  err.name = 'AbortError'
  return err
}

/**
 * 端口：DataSource
 *
 * 【为什么这里要"打开样本"而不是"直接给我所有帧"】
 *   现有 `parsePCD` 是一次性全量解析，500 帧就是 1GB 常驻。
 *   P0 要把它换成"打开一个句柄，按需取帧"，缓存策略交给 FrameCache。
 *
 * 【为什么 frame() 返回 Promise】
 *   解码在 worker 里做（PCD 解析是纯 CPU 活），主线程只接收 transferable。
 *   即使现在的实现是同步的，也保持异步签名 —— 否则接入 worker 时要改所有调用点。
 */
import type { PointCloud } from '../core/types'
import type { Calibration } from '../core/io/calibration'
import type { FrameRef, SceneMeta } from '../domain/model/scene'
import type { Pose } from '../domain/model/geometry'
import type { SampleId } from '../domain/model/ids'

export interface SampleSummary {
  sampleId: SampleId
  sceneId: string
  name: string
  frameRange: [number, number]
  sensorKinds: Array<'lidar' | 'camera' | 'radar'>
  bytes?: number
}

export interface FramePayload {
  ref: FrameRef
  /** 已解码的点云；解码在 worker 完成，主线程只接收 transferable */
  cloud: PointCloud
}

/**
 * 解码优先级。
 *
 * 端口层定义而不是适配器层：它是**调用方的意图**（"这帧用户正在看" vs
 * "这帧只是预热"），不是某种解析实现的技术细节。换 WASM 解析器时这个语义不变。
 */
export type ParsePriority = 'high' | 'low'

export interface FrameRequestOptions {
  /**
   * 默认 `high`。预取路径必须显式传 `low`，否则预取会挤掉用户正在等的帧。
   * 已经开始的解码不会被打断 —— 优先级只在排队时生效（worker 没有中断点）。
   */
  priority?: ParsePriority
}

export interface SampleHandle {
  meta(): SceneMeta
  /** 懒加载单帧 */
  frame(i: number, opts?: FrameRequestOptions): Promise<FramePayload>
  calibrations(): Promise<Record<string, Calibration>>
  egoPose?(i: number): Promise<Pose | null>
  close(): void
  /**
   * 帧能否重新解码。
   *
   * - `true`：句柄背后有原始数据（导入的 File、解析 worker）。
   *   删掉它的帧缓存只是"下次切回来重解一次"，代价几百毫秒。
   * - `false` / 省略：句柄只读缓存（恢复草稿时的 `createCachedCloudHandle`）。
   *   **删掉就是永久丢失** —— 源文件早已不在，缓存是唯一副本。
   *
   * 【为什么默认 false】这类判断错了会丢用户数据。默认"不可淘汰"时，
   * 忘了声明的后果只是磁盘多占一点；默认 true 则是静默销毁。
   */
  reloadable?: boolean
}

export interface DataSource {
  readonly id: string
  listSamples(): Promise<SampleSummary[]>
  openSample(sampleId: string): Promise<SampleHandle>
}

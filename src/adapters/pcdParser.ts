/**
 * ============================================================
 * 异步 PCD 解析 —— worker 池 + 优先级双队列 + 主线程兜底
 * ============================================================
 *
 * 【调用方只看到 Promise】
 *   导入 / 懒加载 / 草稿恢复都走 `parsePcdAsync`，不直接碰 `parsePCD`。
 *   这样将来把解析换成 WASM 或流式实现时，改一个文件即可。
 *
 * 【为什么是"池"而不是一个 worker】
 *   一帧 150k 点约 200ms。切帧时用户会连续翻几帧，单 worker 只能排队，
 *   第 3 帧要等前两帧解析完；两个 worker 就能并行覆盖"当前帧 + 预取帧"。
 *   上限取 `hardwareConcurrency - 1`（留一个核给渲染和 UI），最多 4 个。
 *
 * 【为什么还要优先级队列】
 *   池子只解决"能并行"，不解决"先做谁"。预取会把前后几帧一次性投进队列，
 *   用户点第 30 帧时队列里可能已经排着预取的第 12、13、14 帧，
 *   当前帧就得等它们全部解析完 —— 表现为"点了没反应，过一秒突然跳三帧"。
 *   所以提交时带 `priority`：当前帧 high、预取 low，高优先级严格优先。
 *   队列细节见 `adapters/jobQueue.ts`。
 *
 * 【已经在解析的帧不能插队】
 *   优先级只在**入队时**生效。若某帧已被低优先级任务占用 worker，
 *   后来的高优先级请求不会中断它 —— worker 没有可抢占的中断点，
 *   强杀重建的代价（丢 200ms 进度 + 重建 worker）比等它跑完更大。
 *   实际影响很小：预取半径 1，最坏多等一帧。
 *
 * 【兜底路径】
 *   Node（跑测试）、老浏览器、worker 被 CSP 拦截时 `new Worker` 会抛异常。
 *   这时退回主线程同步解析：慢，但功能必须可用 —— 不能让"不能建 worker"
 *   变成"打不开文件"。兜底路径不看优先级（主线程只有一条）。
 */
import { parseCloudBuffer, type CloudFormat } from '../core/io/cloud'
import type { PointCloud, SemanticLabels } from '../core/types'
import type { ParsePriority } from '../ports/dataSource'
import { PriorityQueue } from './jobQueue'

interface PendingJob {
  resolve: (cloud: PointCloud) => void
  reject: (err: Error) => void
}

interface QueuedJob extends PendingJob {
  id: number
  buffer: ArrayBuffer
  /** 文件名与已知格式：worker 靠它决定用哪个解析器 */
  name?: string
  format?: CloudFormat
}

interface WorkerResponse {
  id: number
  ok: boolean
  count?: number
  positions?: Float32Array
  colors?: Float32Array
  labels?: SemanticLabels
  intensity?: Float32Array
  error?: string
}

const MAX_WORKERS = 4

let workers: Worker[] | null = null
/** 空闲 worker。池子大小固定，忙闲只在这两个集合之间搬 */
let idle: Worker[] = []
const queue = new PriorityQueue<QueuedJob>()
/** worker 基建不可用（Node / CSP / 构造失败）时置 true，之后一律走主线程 */
let workerUnavailable = false
let seq = 0
const pending = new Map<number, PendingJob>()

function targetWorkerCount(): number {
  const hw = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 4
  return Math.max(1, Math.min(MAX_WORKERS, hw - 1))
}

function failAllPending(reason: Error): void {
  for (const job of pending.values()) job.reject(reason)
  pending.clear()
  // 队列里的也必须拒掉：调用方在等 Promise，静默丢弃等于让它永远挂着
  for (const job of queue.clear()) job.reject(reason)
}

function teardownWorkers(): void {
  if (!workers) return
  for (const w of workers) w.terminate()
  workers = null
  idle = []
}

/** 把队列里的任务按优先级填进空闲 worker */
function pump(): void {
  if (!workers) return
  while (idle.length) {
    const job = queue.shift()
    if (!job) return
    const worker = idle.pop()!
    pending.set(job.id, { resolve: job.resolve, reject: job.reject })
    try {
      worker.postMessage({ id: job.id, buffer: job.buffer, name: job.name, format: job.format }, [job.buffer])
    } catch (err) {
      // 转移失败（buffer 已被转移过等）：当场失败，别让 worker 卡在空闲表外
      pending.delete(job.id)
      job.reject(err as Error)
      idle.push(worker)
    }
  }
}

function ensureWorkers(): Worker[] | null {
  if (workerUnavailable) return null
  if (workers) return workers
  if (typeof Worker === 'undefined') {
    workerUnavailable = true
    return null
  }
  try {
    const count = targetWorkerCount()
    const pool: Worker[] = []
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('../workers/parse.worker.ts', import.meta.url), {
        type: 'module',
        name: `pcd-parse-${i}`,
      })
      worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
        const msg = e.data
        const job = pending.get(msg.id)
        // 无论成功失败，这个 worker 都腾出来了：先回空闲表，再唤醒队列
        if (workers) idle.push(worker)
        if (job) {
          pending.delete(msg.id)
          if (!msg.ok || !msg.positions) {
            job.reject(new Error(msg.error ?? 'PCD 解析失败'))
          } else {
            job.resolve({
              positions: msg.positions,
              count: msg.count ?? msg.positions.length / 3,
              ...(msg.colors ? { colors: msg.colors } : {}),
              ...(msg.labels ? { labels: msg.labels } : {}),
              ...(msg.intensity ? { intensity: msg.intensity } : {}),
            })
          }
        }
        pump()
      }
      worker.onerror = (e: ErrorEvent) => {
        // 基建级失败（脚本加载失败 / CSP）：整体降级，避免每次都等一个必然失败的 worker
        workerUnavailable = true
        teardownWorkers()
        failAllPending(new Error(`解析 worker 不可用：${e.message || '加载失败'}`))
      }
      pool.push(worker)
    }
    workers = pool
    idle = [...pool]
    return workers
  } catch {
    workerUnavailable = true
    workers = null
    idle = []
    return null
  }
}

/** 解析请求的可选参数 */
export interface ParseCloudOptions {
  /** 用户触发的解析用 `high`，预取请显式传 `low` */
  priority?: ParsePriority
  /** 文件名：`.pcd` / `.ply` / `.bin` 靠它和内容一起判定格式 */
  name?: string
  /** 已知格式时直接指定，跳过内容嗅探（草稿恢复会带上这个） */
  format?: CloudFormat
}

/**
 * 解析一个点云文件（PCD / PLY / KITTI .bin 由 `core/io/cloud.ts` 分发）。
 * @param buffer 文件原始字节。**注意：会转移给 worker，调用后不要再用这个 buffer。**
 */
export async function parseCloudAsync(buffer: ArrayBuffer, opts: ParseCloudOptions = {}): Promise<PointCloud> {
  const pool = ensureWorkers()
  if (!pool) {
    // 让出一个微任务，保证调用方拿到的失败/成功都是异步的（避免时序差异导致 UI 闪烁）
    await Promise.resolve()
    return parseCloudBuffer(buffer, { name: opts.name, format: opts.format })
  }
  const id = ++seq
  return new Promise<PointCloud>((resolve, reject) => {
    queue.push({ id, buffer, resolve, reject, name: opts.name, format: opts.format }, opts.priority ?? 'high')
    pump()
  })
}

/**
 * @deprecated 名字带 PCD 但已能解析三种格式，请用 `parseCloudAsync`。
 * 保留它是因为老测试与老调用点还在用，删掉得不偿失。
 */
export function parsePcdAsync(buffer: ArrayBuffer, opts: { priority?: ParsePriority } = {}): Promise<PointCloud> {
  return parseCloudAsync(buffer, opts)
}

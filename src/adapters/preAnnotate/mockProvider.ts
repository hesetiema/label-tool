/**
 * 适配器：mock 预标注
 *
 * 【为什么这不算"玩具"】
 *   接真模型之前，复核流程、合并策略、导出闸门都需要能被**反复回归**。
 *   真模型有网络、有显存、有版本漂移，拿它当测试基准等于把测试绑在外部服务上。
 *   这里用固定种子生成"位置连续、偶尔漏检、置信度有高低"的框，
 *   恰好覆盖复核队列最需要的三种情形（低置信、漏帧、跨帧连续）。
 *
 * 【为什么用自带的 PRNG 而不是 Math.random】
 *   同一份种子必须产出同一批框，否则测试断言无法写死，手测也没法复现
 *   "上次那个奇怪的框"。mulberry32 是 6 行、周期足够、分布够好的选择。
 */
import type { BoxGeometry } from '../../domain/model/geometry'
import type {
  PreAnnotationProvider,
  PreAnnotateChunk,
  PreAnnotateRequest,
  ProviderCapabilities,
} from '../../ports/preAnnotation'
import { abortError, isAborted } from '../../ports/preAnnotation'

export interface MockProviderOptions {
  seed?: number
  /** 每帧目标数（含 1 个行人）。默认 4 */
  perFrame?: number
  /** 漏检概率，0..1。默认 0.15 —— 有漏检才需要"复核"，全命中反而看不出流程 */
  dropRate?: number
  /** 场景包围盒；给了就把目标摆在点云内部，否则摆在原点附近 */
  bounds?: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }
  /** 每帧之间的延迟（毫秒）。手测给 120 能看清进度，测试保持 0 */
  delayMs?: number
  /**
   * 是否输出 `modelTrackId`。
   * 关掉后可验证"只靠 IoU 也能把跨帧目标链起来"这条降级路径。
   */
  withTrackIds?: boolean
  model?: { id: string; version: string }
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 字符串 → 32 位种子。样本 id 参与播种：不同样本不该产出同一批框 */
function seedOf(sampleId: string, seed: number): number {
  let h = 2166136261 ^ seed
  for (let i = 0; i < sampleId.length; i++) {
    h ^= sampleId.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

interface Actor {
  id: string
  classId: string
  lane: number
  speed: number
  scale: { x: number; y: number; z: number }
}

export function createMockProvider(opts: MockProviderOptions = {}): PreAnnotationProvider {
  const perFrame = Math.max(1, opts.perFrame ?? 4)
  const dropRate = clamp(opts.dropRate ?? 0.15, 0, 0.9)
  const delayMs = Math.max(0, opts.delayMs ?? 0)
  const withTrackIds = opts.withTrackIds !== false
  const model = opts.model ?? { id: 'mock-bev', version: '0.1.0' }

  return {
    id: 'mock',
    label: '演示模型（确定性）',
    capabilities(): ProviderCapabilities {
      return {
        tasks: ['boxes'],
        classes: ['Car', 'Pedestrian'],
        maxFramesPerRequest: 500,
        supportsStreaming: true,
        requiresImages: false,
      }
    },

    async *run(req: PreAnnotateRequest, signal?: AbortSignal): AsyncGenerator<PreAnnotateChunk> {
      const [from, to] = req.frameRange
      if (to < from) return
      const total = to - from + 1
      const rng = mulberry32(seedOf(req.sampleId, opts.seed ?? 7))

      // 目标构成：最后一辆是行人（更慢、更小），其余是车 —— 让复核列表里
      // 不只有一种类别，顺带覆盖"按类别投票"的分支
      const actors: Actor[] = []
      for (let i = 0; i < perFrame; i++) {
        const pedestrian = i === perFrame - 1 && perFrame > 1
        actors.push({
          id: `${pedestrian ? 'ped' : 'car'}-${i + 1}`,
          classId: pedestrian ? 'Pedestrian' : 'Car',
          lane: pedestrian ? 6.5 : -6 + i * 3.5,
          speed: pedestrian ? 0.12 : 0.6 + (i % 3) * 0.15,
          scale: pedestrian ? { x: 0.8, y: 0.8, z: 1.75 } : { x: 4.4, y: 1.9, z: 1.55 },
        })
      }

      const b = opts.bounds
      const cx = b ? (b.min.x + b.max.x) / 2 : 0
      const cy = b ? (b.min.y + b.max.y) / 2 : 0
      const cz = b ? b.min.z : 0

      for (let f = from; f <= to; f++) {
        if (isAborted(signal)) throw abortError()
        const objects = []
        for (const actor of actors) {
          // 漏检：按种子决定，"这一帧这辆车没被检出"是可复现的
          if (rng() < dropRate) continue
          const t = f - from
          const geometry: BoxGeometry = {
            position: {
              x: cx + actor.speed * t,
              y: cy + actor.lane,
              // 车底贴地：z 取半高，与画框时的默认一致
              z: cz + actor.scale.z / 2,
            },
            scale: { ...actor.scale },
            yaw: 0,
          }
          // 置信度随帧轻微波动，但同一目标不会从 0.9 掉到 0.3 ——
          // 真模型的表现就是这样，剧烈跳变会让"低置信优先"的排序失去意义
          const confidence = clamp(0.55 + rng() * 0.4, 0, 0.99)
          objects.push({
            classId: actor.classId,
            geometry,
            confidence,
            ...(withTrackIds ? { modelTrackId: actor.id } : {}),
          })
        }
        yield {
          frame: f,
          objects,
          progress: (f - from + 1) / total,
          model: { ...model, runtimeMs: 0 },
        }
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
      }
    },
  }
}

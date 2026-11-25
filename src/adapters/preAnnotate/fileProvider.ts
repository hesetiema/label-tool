/**
 * 适配器：离线文件预标注
 *
 * 三个用途，都不需要网络：
 *   1. **无模型环境兜底**：手上有别的工具跑出的结果，直接导入复核、比对；
 *   2. **回放评测**：把历史模型输出当作"预标注"再走一遍流程，看复核耗时与漏检；
 *   3. **测试夹具**：一份固定 JSON 就是最稳的集成测试输入。
 *
 * 接受的形状（按顺序探测，都不满足则报错）：
 *   { frames: [{ index|frame, objects: [...] }], model?: {id, version} }   ← 本项目导出格式
 *   [{ frame, objects }]                                                   ← 裸数组
 *   { frames: [{ index, objects: [{ psr, obj_type, obj_id, score }] }] }    ← SUSTechPOINTS
 *
 * 【为什么不让用户先转格式】
 *   "导出 → 改字段名 → 再导入"是最容易出错的一步。字段容错放在解析层
 *   （见 `parse.ts`），比写一份转换文档更可靠。
 */
import type {
  PreAnnotationProvider, PreAnnotateChunk, PreAnnotateRequest, PreObject, ProviderCapabilities,
} from '../../ports/preAnnotation'
import { abortError, isAborted } from '../../ports/preAnnotation'
import { parsePreObject } from './parse'

export interface FileProviderOptions {
  /** 文件名，仅用于 label 与血缘标识 */
  name?: string
  model?: { id: string; version: string }
}

interface FrameLike {
  index?: unknown
  frame?: unknown
  objects?: unknown
}

function framesOf(payload: unknown): FrameLike[] {
  if (Array.isArray(payload)) return payload as FrameLike[]
  if (payload && typeof payload === 'object') {
    const frames = (payload as { frames?: unknown }).frames
    if (Array.isArray(frames)) return frames as FrameLike[]
  }
  return []
}

function modelOf(payload: unknown): { id: string; version: string } | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const m = (payload as { model?: { id?: unknown; version?: unknown } }).model
  if (!m || typeof m.id !== 'string') return undefined
  return { id: m.id, version: String(m.version ?? 'unknown') }
}

/** 解析结果：帧号升序、每帧对象数组（脏对象已剔除） */
export function parsePreAnnotationFile(
  payload: unknown,
): { frames: Array<{ frame: number; objects: PreObject[] }>; model?: { id: string; version: string } } {
  const raw = framesOf(payload)
  const out: Array<{ frame: number; objects: PreObject[] }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const frame = Number(item.frame ?? item.index)
    if (!Number.isFinite(frame)) continue
    const objects = Array.isArray(item.objects)
      ? item.objects.map(parsePreObject).filter((o): o is PreObject => !!o)
      : []
    out.push({ frame, objects })
  }
  out.sort((a, b) => a.frame - b.frame)
  return { frames: out, ...(modelOf(payload) ? { model: modelOf(payload)! } : {}) }
}

export function createFileProvider(payload: unknown, opts: FileProviderOptions = {}): PreAnnotationProvider {
  const parsed = parsePreAnnotationFile(payload)
  if (!parsed.frames.length) {
    throw new Error('预标注文件里没有可用的帧（需要 frames: [{ frame, objects }] 或裸数组）')
  }
  const model = opts.model ?? parsed.model ?? { id: `file:${opts.name ?? 'import'}`, version: 'file' }

  return {
    id: 'file',
    label: opts.name ? `离线结果 · ${opts.name}` : '离线结果',
    capabilities(): ProviderCapabilities {
      const classes = new Set<string>()
      for (const f of parsed.frames) for (const o of f.objects) classes.add(o.classId)
      return {
        tasks: ['boxes'],
        classes: [...classes].sort(),
        maxFramesPerRequest: parsed.frames.length,
        supportsStreaming: false,
        requiresImages: false,
      }
    },

    async *run(req: PreAnnotateRequest, signal?: AbortSignal): AsyncGenerator<PreAnnotateChunk> {
      const [from, to] = req.frameRange
      const inRange = parsed.frames.filter((f) => f.frame >= from && f.frame <= to)
      // 进度按"请求范围"算：文件里可能只有一部分帧，分母用请求帧数更符合直觉
      const total = Math.max(1, to - from + 1)
      for (const item of inRange) {
        if (isAborted(signal)) throw abortError()
        yield {
          frame: item.frame,
          objects: item.objects,
          progress: Math.min(1, (item.frame - from + 1) / total),
          model: { ...model },
        }
      }
    },
  }
}

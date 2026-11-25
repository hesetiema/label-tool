/**
 * 预标注结果的解析（HTTP / 文件两个适配器共用）
 *
 * 【为什么要单独一层】
 *   同一份模型结果会从两条路进来：推理服务流式吐、或者离线 JSON 导入。
 *   字段容错（`classId` / `label` / `obj_type`，`position+scale+yaw` / `psr`）
 *   只该写一遍 —— 两份各写一遍，必然出现"在线能进、离线进不来"的怪事。
 *
 * 【为什么脏数据是跳过而不是抛错】
 *   一个 500 帧的结果里有一两个 NaN 框，正确反应是"合入其它帧、报告跳过了几个"，
 *   而不是让整批预标注失败。异常只留给"协议完全不对"（不是 JSON、没有 frame）。
 */
import type { BoxGeometry } from '../../domain/model/geometry'
import type { PreAnnotateChunk, PreObject } from '../../ports/preAnnotation'

interface VecLike { x?: unknown; y?: unknown; z?: unknown }

function vec(v: VecLike | undefined): { x: number; y: number; z: number } | null {
  if (!v) return null
  const out = { x: Number(v.x), y: Number(v.y), z: Number(v.z) }
  return [out.x, out.y, out.z].every(Number.isFinite) ? out : null
}

/**
 * 单个目标。接受两种几何写法：
 *   { position, scale, yaw }        —— 本项目的格式
 *   { psr: { position, scale, rotation:{z} } } —— SUSTechPOINTS
 */
export function parsePreObject(raw: unknown): PreObject | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>

  let position = vec(r.position as VecLike | undefined)
  let scale = vec(r.scale as VecLike | undefined)
  let yaw = Number(r.yaw ?? 0)

  const psr = r.psr as { position?: VecLike; scale?: VecLike; rotation?: { z?: unknown } } | undefined
  if (psr) {
    position = position ?? vec(psr.position)
    scale = scale ?? vec(psr.scale)
    if (r.yaw === undefined && psr.rotation && Number.isFinite(Number(psr.rotation.z))) {
      yaw = Number(psr.rotation.z)
    }
  }
  if (!position || !scale) return null
  if (!(scale.x > 0) || !(scale.y > 0)) return null

  const classId = String(r.classId ?? r.label ?? r.obj_type ?? r.type ?? '')
  if (!classId) return null

  const geometry: BoxGeometry = { position, scale, yaw: Number.isFinite(yaw) ? yaw : 0 }
  const confidenceRaw = Number(r.confidence ?? r.score)
  const confidence = Number.isFinite(confidenceRaw) ? confidenceRaw : 0

  // obj_id 就是模型的跨帧身份（SUSTech 的 obj_id 语义与 modelTrackId 一致）
  const trackRaw = r.modelTrackId ?? r.obj_id ?? r.trackId
  const modelTrackId = typeof trackRaw === 'string' || typeof trackRaw === 'number'
    ? String(trackRaw)
    : undefined

  return {
    classId,
    geometry,
    confidence: Math.min(1, Math.max(0, confidence)),
    ...(modelTrackId ? { modelTrackId } : {}),
    ...(r.attributes && typeof r.attributes === 'object'
      ? { attributes: r.attributes as Record<string, string | number | boolean> }
      : {}),
  }
}

/** 一行 NDJSON → chunk。坏行返回 null */
export function parseChunkLine(line: string, fallbackModel: { id: string; version: string }): PreAnnotateChunk | null {
  let text = line.trim()
  if (!text) return null
  if (text.startsWith('data:')) text = text.slice(5).trim()
  if (!text) return null
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const frame = Number(r.frame ?? r.index)
  if (!Number.isFinite(frame)) return null
  const objects = Array.isArray(r.objects)
    ? r.objects.map(parsePreObject).filter((o): o is PreObject => !!o)
    : []
  const progress = Number(r.progress)
  const model = r.model as { id?: string; version?: string; runtimeMs?: number } | undefined
  return {
    frame,
    objects,
    progress: Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0,
    model: {
      id: model?.id ?? fallbackModel.id,
      version: model?.version ?? fallbackModel.version,
      ...(Number.isFinite(model?.runtimeMs) ? { runtimeMs: Number(model?.runtimeMs) } : {}),
    },
  }
}

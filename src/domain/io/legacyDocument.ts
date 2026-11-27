/**
 * ============================================================
 * v1 数据 → v2 文档
 * ============================================================
 *
 * v1（现有内存模型）= `frames[i].boxes: Box3D[]`，身份靠 obj_id 约定；
 * v2 = `SampleDocument`，身份是 Track，几何在稀疏关键帧上。
 *
 * 这里做的是"逐框聚合成轨迹"，不是简单换壳：
 *   - 同一 obj_id 跨帧的框合成一条 Track；
 *   - 每帧的框都是一个关键帧（它是人标的，不是插值出来的，这个信息不能丢）；
 *   - visibility !== visible 的帧写进 states，维持"稀疏状态"约定；
 *   - 单帧数据集（frames 为空、只有 boxes）也要能迁移，否则"打开旧草稿什么都没有"。
 *
 * 与方案 8.3 的 `migrateV1` 是同一套逻辑；区别是这里直接被 UI 的装载路径复用，
 * 不等到 P0 的 IndexedDB v2 落地才生效 —— 先把内存模型换掉，性能改造可以后跟。
 */
import type { Box3D } from '../../core/types'
import { createEmptyDocument, type SampleDocument } from '../model/document'
import type { Track, Visibility } from '../model/track'
import { createTrackRecord, touchLifecycle } from '../model/track'
import { toGeometry } from '../model/geometry'
import { sampleIdOf } from '../model/ids'
import { materializeFrame } from '../store/materialize'

export interface LegacyFrame {
  index: number
  boxes: Box3D[]
}

export interface BuildDocumentOptions {
  sceneId?: string
  sampleId?: string
  updatedBy?: string
  updatedAt?: number
}

/**
 * @param frames 按 index 升序的帧；单帧数据集传 `[{ index: 0, boxes }]`
 */
export function buildDocumentFromFrames(frames: LegacyFrame[], opts: BuildDocumentOptions = {}): SampleDocument {
  const sceneId = opts.sceneId ?? 'imported'
  const sorted = [...frames].sort((a, b) => a.index - b.index)
  const indices = sorted.map((f) => f.index)
  const range: [number, number] = indices.length ? [indices[0], indices[indices.length - 1]] : [0, 0]

  const doc = createEmptyDocument({
    sampleId: opts.sampleId ?? sampleIdOf(sceneId, range),
    sceneId,
    range,
    updatedBy: opts.updatedBy,
    updatedAt: opts.updatedAt,
  })

  const byId = new Map<string, Track>()

  for (const frame of sorted) {
    for (const box of frame.boxes) {
      let track = byId.get(box.id)
      if (!track) {
        track = createTrackRecord({
          id: box.id,
          classId: box.label,
          frame: frame.index,
          geometry: toGeometry(box),
          attributes: box.attributes,
        })
        byId.set(box.id, track)
        doc.tasks.boxes.tracks.push(track)
      } else {
        // 关键帧按帧升序；v1 的 frames 顺序不保证与 index 一致，所以每次重排
        track.keyframes.push({
          frame: frame.index,
          geometry: toGeometry(box),
          source: { kind: 'import' },
        })
        track.keyframes.sort((a, b) => a.frame - b.frame)
      }
      const visibility = box.visibility as Visibility | undefined
      if (visibility && visibility !== 'visible') {
        track.states.set(frame.index, {
          visibility,
          source: { kind: 'import' },
          review: 'none',
        })
      }
    }
  }

  for (const track of doc.tasks.boxes.tracks) touchLifecycle(track)
  return doc
}

/**
 * 反向导出：文档 → 逐帧 Box3D 列表。
 * 导出仍走旧的 formats/*，所以这里必须产出完全兼容的 Box3D（多出的字段会被忽略）。
 */
export function documentToFrameBoxes(doc: SampleDocument): LegacyFrame[] {
  const out: LegacyFrame[] = []
  for (let f = doc.range[0]; f <= doc.range[1]; f++) {
    const boxes = materializeFrame(doc, f).map((v) => ({
      id: v.id,
      label: v.label,
      position: { ...v.position },
      scale: { ...v.scale },
      yaw: v.yaw,
      ...(v.visibility ? { visibility: v.visibility } : {}),
      ...(v.attributes && Object.keys(v.attributes).length ? { attributes: { ...v.attributes } } : {}),
    })) as Box3D[]
    out.push({ index: f, boxes })
  }
  return out
}

/** 文档体检：给状态栏/测试用的轻量统计 */
export function documentStats(doc: SampleDocument): {
  tracks: number
  keyframes: number
  states: number
  frames: number
} {
  let keyframes = 0
  let states = 0
  for (const t of doc.tasks.boxes.tracks) {
    keyframes += t.keyframes.length
    states += t.states.size
  }
  return {
    tracks: doc.tasks.boxes.tracks.length,
    keyframes,
    states,
    frames: doc.range[1] - doc.range[0] + 1,
  }
}

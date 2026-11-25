/**
 * ============================================================
 * 恢复计划：v2 文档 + v1 快照 → 该建什么
 * ============================================================
 *
 * 【为什么需要这一层】
 *   doc-first 恢复不是"直接 new TrackStore(doc)"就完事：界面上还有 frames 镜像、
 *   当前帧、哪些帧有内联点云、哪些帧要按需解码。这些判断如果散在 useDataset 里，
 *   Node 侧测不到（要起浏览器），而它们恰恰是最容易出错的地方 ——
 *   单帧数据集被当成多帧、当前帧越界、快照与文档帧区间不一致。
 *
 *   所以把"怎么拼"抽成纯函数：输入文档与快照提示，输出一份可断言的计划，
 *   `useDataset` 只负责照着计划赋值。
 *
 * 【两个来源的职责划分】
 *   - 文档 = 标注真值（轨迹、关键帧、生命周期、状态、复核标记），唯一权威；
 *   - 快照 = 帧布局与点云（懒加载下点云可能只在 blob store，快照里只有 `lazy` 标记）。
 *   帧布局以快照为准，因为布局来自数据源（用户选了哪几个文件），文档的 range
 *   只是"标注覆盖到哪里"。
 *
 * 【为什么区间不符就放弃】
 *   文档的 sampleId 由 `sceneId#start-end` 生成，两个帧数相同的数据集会撞号。
 *   撞号本身不可怕（保存时会被覆盖），可怕的是"拿 A 的标注去恢复 B"。
 *   所以只要快照里有帧落在文档 range 之外，就判定两者不是同一个样本，
 *   退回 v1 快照恢复 —— 宁可少恢复生命周期，也不能把框安到别的帧上。
 */
import type { SampleDocument } from '../model/document'
import { materializeFrame } from './materialize'

/** 快照能提供的最小信息（不依赖 core/io/session 的具体类型） */
export interface SnapshotLayoutHint {
  frames: Array<{ index: number; hasCloud: boolean }>
  currentFrame: number
  /** 单帧数据集的点云（frames 为空时） */
  hasSingleCloud: boolean
}

export interface DocumentRestorePlan {
  ok: boolean
  /** 不能按文档恢复的原因；ok=false 时调用方应回退到 v1 快照 */
  reason?: 'range-mismatch'
  /** 单帧数据集：界面上 frames 为空，点云走 `cloud` 而不是 `frames[i]` */
  singleFrame: boolean
  /** 逐帧帧号（frames 数组的顺序 = 这里的顺序） */
  layout: number[]
  current: number
  /** 快照里带内联点云的帧（可以直接显示） */
  cloudFrames: number[]
  /** 需要按需解码的帧（切帧时从 blob store 读；读不到就提示重新导入） */
  lazyFrames: number[]
  /** 文档能物化出的框总数，用于状态栏"已恢复 N 个框" */
  totalBoxes: number
}

const EMPTY: DocumentRestorePlan = {
  ok: false,
  singleFrame: true,
  layout: [],
  current: 0,
  cloudFrames: [],
  lazyFrames: [],
  totalBoxes: 0,
}

/**
 * @param doc 已从 DocumentStore 读出的文档
 * @param hint 快照的帧布局提示；没有快照（纯 doc-first）时传 null
 */
export function planDocumentRestore(
  doc: SampleDocument,
  hint: SnapshotLayoutHint | null,
): DocumentRestorePlan {
  const [docFrom, docTo] = doc.range
  const hintFrames = hint?.frames ?? []

  if (hintFrames.length === 0) {
    // 快照没给帧布局。两种情况：
    //   1. 真正的单帧数据集（range 只有一个点）→ 走 `cloud` 字段；
    //   2. 快照丢了但文档还在（配额淘汰、只清 session）→ 文档 range 就是帧布局，
    //      点云全部标懒加载，靠数据集键从 blob store 回读。
    // 后者不能当单帧处理：21 帧的标注只显示第一帧，等于静默丢掉 20 帧的框。
    if (docTo > docFrom) {
      const layout: number[] = []
      for (let f = docFrom; f <= docTo; f++) layout.push(f)
      let boxes = 0
      for (const f of layout) boxes += materializeFrame(doc, f).length
      return {
        ok: true,
        singleFrame: false,
        layout,
        current: 0,
        cloudFrames: [],
        lazyFrames: [...layout],
        totalBoxes: boxes,
      }
    }
    // 无帧布局：单帧数据集。点云在快照的 `cloud` 上，或本来就没有
    return {
      ok: true,
      singleFrame: true,
      layout: [],
      current: 0,
      cloudFrames: [],
      lazyFrames: [],
      totalBoxes: countBoxes(doc, docFrom),
    }
  }

  const layout = hintFrames.map((f) => f.index)

  // 快照里有帧不在文档区间内 → 两者不是同一个样本
  if (layout.some((f) => f < docFrom || f > docTo)) {
    return { ...EMPTY, reason: 'range-mismatch' }
  }

  const hasCloud = new Set(hintFrames.filter((f) => f.hasCloud).map((f) => f.index))
  const cloudFrames: number[] = []
  const lazyFrames: number[] = []
  for (const f of layout) {
    if (hasCloud.has(f)) cloudFrames.push(f)
    else lazyFrames.push(f)
  }

  let totalBoxes = 0
  for (const f of layout) totalBoxes += materializeFrame(doc, f).length

  const current = Math.min(Math.max(0, hint?.currentFrame ?? 0), Math.max(0, layout.length - 1))

  return {
    ok: true,
    singleFrame: false,
    layout,
    current,
    cloudFrames,
    lazyFrames,
    totalBoxes,
  }
}

function countBoxes(doc: SampleDocument, frame: number): number {
  return materializeFrame(doc, frame).length
}

/**
 * ============================================================
 * 数据集加载
 * ============================================================
 * 五个入口，覆盖从"零依赖演示"到"真实数据"的完整梯度：
 *   loadDemo      合成场景，无外部文件，打开即用
 *   loadSequence  5 帧演示序列，目标会动、部分只标首末帧
 *   loadRealData  SUSTechPOINTS 真实点云 + 标注 + 相机标定
 *   importFiles   本地多选 PCD（自动拼成时序）+ 可选同名 JSON 标注
 *   restore       IndexedDB 草稿恢复
 *
 * 所有加载器都遵循同一套收尾动作：
 *   清视图残留 → 重置历史 → 清点云缓存 → 同步渲染 → 相机对焦 → 标脏。
 */
import { ref } from 'vue'
import { generateDemoScene } from '../core/sample'
import { parsePCD } from '../core/io/pcd'
import { parseLabels } from '../core/io/label'
import { parseCalibration } from '../core/io/calibration'
import { generateDemoSequence, type FrameData } from '../core/sequence/sequence'
import { cloneBoxes } from '../core/history'
import { fromStoredCloud, type SessionSnapshot } from '../core/io/session'
import type { Box3D } from '../core/types'
import type { StudioCore } from './studioCore'

export function useDataset(core: StudioCore) {
  const {
    boxes, selectedId, cloud, frames, currentFrame, calib, imageUrl, showTrajectories,
    statusText, datasetName, categories, resetHistory, syncViewer, invalidateCloud,
    getViewer, resetViewerState, markDirty, layout, saveState, lastSavedAt, ensureCategories,
  } = core

  const fileInput = ref<HTMLInputElement | null>(null)
  const importCount = ref(0)

  /** 统计首末帧都有标注、但中间帧缺失的轨迹数量（用来展示插值的价值） */
  function missingTrackCount(): number {
    if (frames.value.length < 2) return 0
    const firstIds = new Set(frames.value[0].boxes.map((b) => b.id))
    const lastIds = new Set(frames.value[frames.value.length - 1].boxes.map((b) => b.id))
    let missing = 0
    for (const id of firstIds) {
      if (!lastIds.has(id)) continue
      for (let i = 1; i < frames.value.length - 1; i++) {
        if (!frames.value[i].boxes.some((b) => b.id === id)) { missing++; break }
      }
    }
    return missing
  }

  /** 统一的装载收尾 */
  function afterLoad() {
    selectedId.value = null
    resetHistory()
    invalidateCloud()
    syncViewer()
    markDirty()
    const first = cloud.value
    if (first) getViewer()?.focusOnCloud(first)
  }

  /** 加载 5 帧演示序列 */
  function loadSequence() {
    resetViewerState()
    const seq = generateDemoSequence(5)
    frames.value = seq
    currentFrame.value = 0
    cloud.value = seq[0].cloud
    boxes.value = cloneBoxes(seq[0].boxes)
    datasetName.value = '演示序列 · 5 帧'
    showTrajectories.value = true
    afterLoad()
    statusText.value = `已加载 ${seq.length} 帧序列 · ${missingTrackCount()} 条轨迹中间帧未标注，点「轨迹插值」补全`
  }

  function loadDemo() {
    resetViewerState()
    const { cloud: c, boxes: b } = generateDemoScene()
    frames.value = []
    currentFrame.value = 0
    cloud.value = c
    boxes.value = b
    datasetName.value = '演示场景'
    showTrajectories.value = false
    afterLoad()
    statusText.value = `已加载演示场景：${c.count.toLocaleString()} 个点，${b.length} 个目标`
  }

  /** 一键加载 SUSTechPOINTS 真实数据（点云 + 24 个标注框 + 相机） */
  async function loadRealData() {
    statusText.value = '正在加载真实点云（3MB）…'
    try {
      const [pcRes, labelRes, calibRes] = await Promise.all([
        fetch('/data/000970.pcd'),
        fetch('/data/000970.json'),
        fetch('/data/calib_front.json'),
      ])
      if (!pcRes.ok || !labelRes.ok) throw new Error('数据文件缺失')
      const [pcBuf, labelText] = await Promise.all([pcRes.arrayBuffer(), labelRes.text()])
      resetViewerState()
      frames.value = []
      currentFrame.value = 0
      cloud.value = parsePCD(pcBuf)
      boxes.value = parseLabels(labelText)
      ensureCategories(boxes.value)
      datasetName.value = '000970 · SUSTechPOINTS 样例'
      showTrajectories.value = false
      if (calibRes.ok) {
        calib.value = parseCalibration(await calibRes.text())
        imageUrl.value = '/data/front_000970.jpg'
        layout.value = 'split'
      }
      afterLoad()
      statusText.value = `真实数据已加载：${cloud.value.count.toLocaleString()} 个点，${boxes.value.length} 个标注框`
    } catch (err) {
      statusText.value = `真实数据加载失败：${(err as Error).message}`
    }
  }

  /**
   * 本地导入：支持一次选多个 PCD，按文件名排序拼成时序。
   * 同时选中的 JSON 会按文件名（去掉扩展名）匹配到对应帧。
   */
  async function importFiles(e: Event) {
    const input = e.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length) return

    const pcds = files
      .filter((f) => /\.pcd$/i.test(f.name))
      .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
    const jsons = files.filter((f) => /\.json$/i.test(f.name))

    if (!pcds.length) {
      statusText.value = '请选择 .pcd 文件（可多选，按文件名排序组成时序）'
      return
    }

    resetViewerState()
    showTrajectories.value = false
    importCount.value = pcds.length
    const nextFrames: FrameData[] = []

    try {
      for (let i = 0; i < pcds.length; i++) {
        const file = pcds[i]
        statusText.value = `解析 ${i + 1}/${pcds.length}：${file.name} …`
        // 让出主线程，避免多帧解析时界面完全冻住
        await new Promise((r) => setTimeout(r, 0))
        const parsed = parsePCD(await file.arrayBuffer())
        const stem = file.name.replace(/\.pcd$/i, '')
        const labelFile = jsons.find((j) => j.name.replace(/\.json$/i, '') === stem)
        let labelBoxes: Box3D[] = []
        if (labelFile) {
          try { labelBoxes = parseLabels(await labelFile.text()) } catch { /* 标注坏了不影响点云 */ }
        }
        nextFrames.push({ index: i, cloud: parsed, boxes: labelBoxes })
      }

      frames.value = nextFrames.length > 1 ? nextFrames : []
      currentFrame.value = 0
      cloud.value = nextFrames[0].cloud
      boxes.value = cloneBoxes(nextFrames[0].boxes)
      datasetName.value = nextFrames.length > 1 ? `${pcds[0].name} 等 ${pcds.length} 帧` : pcds[0].name
      showTrajectories.value = nextFrames.length > 1
      ensureCategories(nextFrames.flatMap((f) => f.boxes))
      afterLoad()
      const total = nextFrames.reduce((n, f) => n + f.cloud.count, 0)
      statusText.value = nextFrames.length > 1
        ? `已导入 ${nextFrames.length} 帧（共 ${total.toLocaleString()} 点），可用顶部帧导航逐帧标注`
        : `已加载 ${pcds[0].name}：${nextFrames[0].cloud.count.toLocaleString()} 个点`
    } catch (err) {
      statusText.value = `解析失败：${(err as Error).message}`
    } finally {
      importCount.value = 0
    }
  }

  /** 从 IndexedDB 草稿恢复 */
  async function restore(snapshot: SessionSnapshot): Promise<boolean> {
    try {
      const restoredFrames: FrameData[] = snapshot.frames.map((f) => ({
        index: f.index,
        cloud: fromStoredCloud(f.cloud),
        boxes: f.boxes,
      }))
      resetViewerState()
      categories.value = snapshot.categories
      frames.value = restoredFrames
      currentFrame.value = Math.min(snapshot.currentFrame, Math.max(0, restoredFrames.length - 1))
      cloud.value = snapshot.cloud ? fromStoredCloud(snapshot.cloud) : restoredFrames[0]?.cloud ?? null
      boxes.value = snapshot.cloud
        ? snapshot.boxes
        : cloneBoxes(restoredFrames[currentFrame.value]?.boxes ?? snapshot.boxes)
      datasetName.value = snapshot.datasetName || '本地草稿'
      showTrajectories.value = restoredFrames.length > 1
      ensureCategories([
        ...snapshot.boxes,
        ...restoredFrames.flatMap((f) => f.boxes),
      ])
      lastSavedAt.value = snapshot.savedAt
      saveState.value = 'saved'
      selectedId.value = null
      resetHistory()
      invalidateCloud()
      syncViewer()
      if (cloud.value) getViewer()?.focusOnCloud(cloud.value)
      const time = new Date(snapshot.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      statusText.value = `已恢复 ${time} 的本地草稿：${boxes.value.length} 个框`
      return true
    } catch (err) {
      statusText.value = `草稿恢复失败：${(err as Error).message}`
      return false
    }
  }

  return {
    fileInput, importCount, loadDemo, loadSequence, loadRealData, importFiles, restore, missingTrackCount,
  }
}

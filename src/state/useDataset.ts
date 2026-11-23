/**
 * ============================================================
 * 数据集加载
 * ============================================================
 * 五个入口，覆盖从"零依赖演示"到"真实 nuScenes 序列"的完整梯度：
 *   loadDemo      合成场景，无外部文件，打开即用
 *   loadSequence  5 帧演示序列，目标会动、部分只标首末帧
 *   loadRealData  SUSTechPOINTS 真实点云 + 标注 + 相机标定
 *   loadNuScenes  nuScenes mini 真实序列（局部坐标系 / 4D-BEV 世界系）
 *
 * 所有加载器都遵循同一套收尾动作：重置历史 → 清空点云缓存 → 同步渲染 → 相机对焦。
 */
import { ref } from 'vue'
import { generateDemoScene } from '../core/sample'
import { parsePCD } from '../core/io/pcd'
import { parseLabels } from '../core/io/label'
import { parseCalibration, type Calibration } from '../core/io/calibration'
import { generateDemoSequence, type FrameData } from '../core/sequence/sequence'
import { cloneBoxes } from '../core/history'
import type { StudioCore } from './studioCore'

export function useDataset(core: StudioCore) {
  const {
    boxes, selectedId, cloud, frames, currentFrame, calib, imageUrl, showTrajectories,
    statusText, resetHistory, syncViewer, setLayout, invalidateCloud, getViewer,
  } = core

  const fileInput = ref<HTMLInputElement | null>(null)

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

  /** 加载 5 帧演示序列：目标会动，且部分目标只标了首末帧 */
  function loadSequence() {
    frames.value = generateDemoSequence(5)
    currentFrame.value = 0
    cloud.value = frames.value[0].cloud
    boxes.value = cloneBoxes(frames.value[0].boxes)
    selectedId.value = null
    calib.value = null
    imageUrl.value = ''
    showTrajectories.value = true // 4D 演示默认打开轨迹叠加，进入即可看到运动路径
    setLayout('cloud')
    resetHistory() // 会通过 playback 钩子停掉回放
    invalidateCloud()
    syncViewer()
    getViewer()?.focusOnCloud(cloud.value)
    statusText.value = `已加载 ${frames.value.length} 帧序列 · ${missingTrackCount()} 条轨迹中间帧未标注，点「轨迹插值」补全`
  }

  function loadDemo() {
    const { cloud: c, boxes: b } = generateDemoScene()
    frames.value = []
    cloud.value = c
    boxes.value = b
    selectedId.value = null
    resetHistory()
    invalidateCloud()
    syncViewer()
    getViewer()?.focusOnCloud(c)
    statusText.value = `已加载演示场景：${c.count.toLocaleString()} 个点，${b.length} 个目标`
  }

  /** 一键加载下载的 SUSTechPOINTS 真实数据（点云 + 24个标注框） */
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
      frames.value = []
      cloud.value = parsePCD(pcBuf)
      boxes.value = parseLabels(labelText)
      selectedId.value = null
      resetHistory()
      invalidateCloud()
      // 加载相机标定 + 图像，启用分屏对照
      if (calibRes.ok) {
        calib.value = parseCalibration(await calibRes.text())
        imageUrl.value = '/data/front_000970.jpg'
        setLayout('split')
      }
      syncViewer()
      getViewer()?.focusOnCloud(cloud.value)
      statusText.value = `真实数据已加载：${cloud.value.count.toLocaleString()} 个点，${boxes.value.length} 个标注框（SUSTechPOINTS 样例）`
    } catch (err) {
      statusText.value = `真实数据加载失败：${(err as Error).message}`
    }
  }

  /**
   * 加载 nuScenes mini 真实序列（由 scripts/convert_nuscenes.py 转换而来）。
   * 每一帧都是真实激光雷达点云 + 官方 3D 标注 + 真实相机内外参，
   * 复用多帧机制，切帧即可逐帧核对标注与相机投影。
   */
  async function loadNuScenes(world = false) {
    const dataDir = world ? '/data/nuscenes_world' : '/data/nuscenes'
    const label = world ? '4D-BEV 世界系' : 'nuScenes'
    statusText.value = `正在加载 ${label} 真实序列…`
    try {
      const idxRes = await fetch(`${dataDir}/index.json`)
      if (!idxRes.ok) {
        statusText.value = `未找到 ${label} 数据，请先运行 python scripts/convert_nuscenes.py --mode ${world ? 'world' : 'lidar'}`
        return
      }
      const index = await idxRes.json() as Array<{
        id: string; 点云: string; 标注: string; 标定: string
        图像: string | null; 点数: number; 框数: number; 时间戳: number
      }>
      if (!index.length) {
        statusText.value = 'nuScenes 数据为空'
        return
      }
      statusText.value = `正在加载 ${index.length} 帧真实数据…`

      const loaded: FrameData[] = []
      let firstCalib: Calibration | null = null
      let firstImage = ''
      for (let fi = 0; fi < index.length; fi++) {
        const item = index[fi]
        const [pcRes, labelRes] = await Promise.all([
          fetch(`${dataDir}/${item.点云}`),
          fetch(`${dataDir}/${item.标注}`),
        ])
        if (!pcRes.ok || !labelRes.ok) continue
        const [pcBuf, labelText] = await Promise.all([pcRes.arrayBuffer(), labelRes.text()])
        loaded.push({
          index: fi,
          cloud: parsePCD(pcBuf),
          boxes: parseLabels(labelText),
        })
        // 用第一帧的标定与图像做相机对照（同一段序列标定基本稳定）
        if (!firstCalib) {
          const calibRes = await fetch(`${dataDir}/${item.标定}`)
          if (calibRes.ok) firstCalib = parseCalibration(await calibRes.text())
          if (item.图像) firstImage = `${dataDir}/${item.图像}`
        }
      }
      if (!loaded.length) {
        statusText.value = 'nuScenes 帧加载失败'
        return
      }
      frames.value = loaded
      currentFrame.value = 0
      cloud.value = loaded[0].cloud
      boxes.value = cloneBoxes(loaded[0].boxes)
      selectedId.value = null
      calib.value = firstCalib
      imageUrl.value = firstImage
      setLayout(!world && firstCalib ? 'split' : 'cloud')
      resetHistory()
      invalidateCloud()
      syncViewer()
      getViewer()?.focusOnCloud(cloud.value)
      const totalPts = loaded.reduce((s, f) => s + f.cloud.count, 0)
      statusText.value = `${label} 真实序列：${loaded.length} 帧 · ${totalPts.toLocaleString()} 点 · 当前 ${boxes.value.length} 个标注框${world ? ' · 静止背景已对齐、运动目标拖出轨迹' : ''}`
    } catch (err) {
      statusText.value = `nuScenes 加载失败：${(err as Error).message}`
    }
  }

  async function onPcdFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    statusText.value = '正在解析 PCD…'
    try {
      const buf = await file.arrayBuffer()
      frames.value = []
      cloud.value = parsePCD(buf)
      boxes.value = []
      selectedId.value = null
      resetHistory()
      invalidateCloud()
      syncViewer()
      statusText.value = `已加载 ${file.name}：${cloud.value.count.toLocaleString()} 个点`
    } catch (err) {
      statusText.value = `解析失败：${(err as Error).message}`
    }
  }

  return {
    fileInput, loadDemo, loadSequence, loadRealData, loadNuScenes, onPcdFile,
  }
}

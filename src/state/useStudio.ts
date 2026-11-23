/**
 * ============================================================
 * 工作台装配层
 * ============================================================
 * 这里只做五件事：创建 core、装配五个功能模块、绑定 viewer 与 DOM 事件、
 * 按 URL / 本地草稿决定启动数据集、驱动自动保存。
 * 业务实现分别在：
 *   studioCore        共享状态 / 历史栈 / 渲染同步
 *   useAnnotation     画框、框编辑、撤销重做、导入导出
 *   useDataset        演示 / 真实数据 / 多帧导入 / 草稿恢复
 *   useSequence       帧切换、回放、插值、跨帧传播、时序质检
 *   useQuality        质检报告、关联演示、百万点压测
 *   useCameraDirector 关键帧、运镜播放、WebM 录制
 */
import { onMounted, onBeforeUnmount, nextTick, ref, toRaw, watch } from 'vue'
import { PointCloudViewer } from '../viewer/PointCloudViewer'
import { issueTypeName } from '../core/sequence/temporalQA'
import { cloneBoxes } from '../core/history'
import {
  clearSession, estimateSnapshotBytes, loadSession, saveSession, toStoredCloud,
} from '../core/io/session'
import type { Box3D, ObjectCategory, PointCloud } from '../core/types'
import { createStudioCore, numVal, strVal } from './studioCore'
import { useAnnotation } from './useAnnotation'
import { useDataset } from './useDataset'
import { useSequence } from './useSequence'
import { useQuality } from './useQuality'
import { useCameraDirector } from './useCameraDirector'

export function useStudio() {
  const core = createStudioCore()
  const annotation = useAnnotation(core)
  const dataset = useDataset(core)
  const sequence = useSequence(core)
  const quality = useQuality(core)
  const camera = useCameraDirector(core)

  const showHelp = ref(false)
  const menuOpen = ref(false)

  let saveTimer: number | undefined
  let saving = false

  /**
   * IndexedDB 的结构化克隆不接受 Vue 的响应式 Proxy（会抛 DataCloneError），
   * 所以落盘前必须把数据剥回原始对象：框/类别用 JSON 深拷贝，点云取 toRaw。
   */
  function plainBoxes(list: Box3D[]): Box3D[] {
    return JSON.parse(JSON.stringify(list)) as Box3D[]
  }

  function storedCloud(cloud: PointCloud) {
    const raw = toRaw(cloud)
    const stored = toStoredCloud({
      positions: toRaw(raw.positions),
      count: raw.count,
      ...(raw.colors ? { colors: toRaw(raw.colors) } : {}),
    })
    return stored
  }

  /** 把当前帧工作副本写回序列 + 组织快照 */
  function buildSnapshot() {
    if (core.frames.value.length) {
      core.frames.value[core.currentFrame.value].boxes = cloneBoxes(core.boxes.value)
    }
    return {
      datasetName: core.datasetName.value,
      cloud: core.cloud.value && !core.frames.value.length ? storedCloud(core.cloud.value) : null,
      frames: core.frames.value.map((f) => ({
        index: f.index,
        cloud: storedCloud(f.cloud),
        boxes: plainBoxes(f.boxes),
      })),
      currentFrame: core.currentFrame.value,
      boxes: plainBoxes(core.boxes.value),
      categories: JSON.parse(JSON.stringify(core.categories.value)) as ObjectCategory[],
    }
  }

  async function persistNow(manual = false) {
    if (saving) return
    if (!core.cloud.value) return
    const snapshot = buildSnapshot()
    const bytes = estimateSnapshotBytes(snapshot)
    // 超过 80MB 时 IndexedDB 写入会明显卡顿，宁可提示用户手动导出
    if (bytes > 80 * 1024 * 1024) {
      core.saveState.value = 'error'
      if (manual) core.statusText.value = '数据超过 80MB，自动保存已跳过，请手动导出'
      return
    }
    saving = true
    core.saveState.value = 'saving'
    try {
      await saveSession(snapshot)
      core.saveState.value = 'saved'
      core.lastSavedAt.value = Date.now()
      if (manual) core.statusText.value = '草稿已保存到本地（IndexedDB）'
    } catch (err) {
      core.saveState.value = 'error'
      core.statusText.value = `草稿保存失败：${(err as Error).message}`
    } finally {
      saving = false
    }
  }

  function scheduleSave() {
    if (!core.autosaveEnabled.value) {
      core.saveState.value = 'off'
      return
    }
    if (saveTimer) window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => { void persistNow() }, 1200)
  }

  watch(core.dirtyVersion, scheduleSave)

  watch(core.autosaveEnabled, (on) => {
    if (on) scheduleSave()
    else {
      if (saveTimer) window.clearTimeout(saveTimer)
      core.saveState.value = 'off'
    }
  })

  async function clearDraft() {
    try {
      await clearSession()
      core.lastSavedAt.value = null
      core.saveState.value = 'idle'
      core.statusText.value = '已清除本地草稿'
    } catch (err) {
      core.statusText.value = `清除草稿失败：${(err as Error).message}`
    }
  }

  /** 离开页面前兜底保存：浏览器只允许同步提示，保存动作仍走异步但通常来得及 */
  function onBeforeUnload(e: BeforeUnloadEvent) {
    if (core.saveState.value === 'dirty') {
      void persistNow()
      e.preventDefault()
      e.returnValue = ''
    }
  }

  function onResizeShortcut(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    if (e.key === 'F1' || (e.key === '?' && !e.shiftKey)) {
      e.preventDefault()
      showHelp.value = !showHelp.value
    }
    if (e.key === 'Escape') {
      showHelp.value = false
      menuOpen.value = false
    }
  }

  onMounted(async () => {
    await nextTick()
    if (!core.viewportRef.value) return

    const viewer = new PointCloudViewer(core.viewportRef.value)
    core.setViewer(viewer)
    camera.syncCameraVisual()

    // 3D 视口点击拾取：OrbitControls 拖拽结束也会触发 click，用位移阈值过滤
    const el = viewer.renderLoopElement()
    let downX = 0, downY = 0
    const onDown = (e: MouseEvent) => { downX = e.clientX; downY = e.clientY }
    const onClick = (e: MouseEvent) => {
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 4) return
      annotation.onViewerClick(e)
    }
    el.addEventListener('mousedown', onDown)
    el.addEventListener('click', onClick)

    window.addEventListener('keydown', annotation.onKeyDown)
    window.addEventListener('keydown', onResizeShortcut)
    window.addEventListener('beforeunload', onBeforeUnload)

    // 排定启动数据集：显式 URL 参数优先，其次本地草稿，最后演示场景
    const params = new URLSearchParams(location.search)
    const demo = params.get('data')
    if (demo === 'real') {
      await dataset.loadRealData()
    } else if (demo === 'sequence') {
      dataset.loadSequence()
      if (params.get('autoplay') === '1') sequence.play()
    } else if (demo === 'qa') {
      dataset.loadDemo()
      quality.runQualityCheck()
    } else {
      let restored = false
      try {
        const snapshot = await loadSession()
        if (snapshot) restored = await dataset.restore(snapshot)
      } catch { /* 草稿坏了就当没有 */ }
      if (!restored) dataset.loadDemo()
    }

    // 首屏尺寸可能在 v-show 切换后变化，补一次
    requestAnimationFrame(() => viewer.resize())

    ;(function animate() {
      requestAnimationFrame(animate)
      viewer.render()
    })()
  })

  // 主视口 / 正交条显隐后必须重算 WebGL 画布尺寸
  watch([core.orthoMax, core.showOrtho, core.layout], () => {
    nextTick(() => core.getViewer()?.resize())
  })

  onBeforeUnmount(() => {
    sequence.pausePlay()
    camera.cleanup()
    if (saveTimer) window.clearTimeout(saveTimer)
    if (core.saveState.value === 'dirty') void persistNow()

    const viewer = core.getViewer()
    window.removeEventListener('keydown', annotation.onKeyDown)
    window.removeEventListener('keydown', onResizeShortcut)
    window.removeEventListener('beforeunload', onBeforeUnload)
    viewer?.dispose()
  })

  return {
    ...core,
    ...annotation,
    ...dataset,
    ...sequence,
    ...quality,
    ...camera,
    showHelp,
    menuOpen,
    persistNow,
    clearDraft,
    issueTypeName,
    numVal,
    strVal,
  }
}

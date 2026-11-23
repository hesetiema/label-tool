/**
 * ============================================================
 * 工作台装配层
 * ============================================================
 * 这里只做四件事：创建 core、装配五个功能模块、绑定 viewer 与 DOM 事件、按 URL 参数路由演示场景。
 * 业务实现分别在：
 *   studioCore        共享状态 / 历史栈 / 渲染同步
 *   useAnnotation     画框、框编辑、撤销重做、导入导出
 *   useDataset        演示 / 真实 / nuScenes 加载
 *   useSequence       帧切换、回放、插值、跨帧传播、时序质检
 *   useQuality        质检报告、关联演示、性能压测
 *   useCameraDirector 关键帧、运镜播放、视频录制
 */
import { onMounted, onBeforeUnmount, nextTick } from 'vue'
import { PointCloudViewer } from '../viewer/PointCloudViewer'
import { DEFAULT_CATEGORIES } from '../core/types'
import { issueTypeName } from '../core/sequence/temporalQA'
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

  onMounted(async () => {
    await nextTick()
    if (!core.viewportRef.value) return

    const viewer = new PointCloudViewer(core.viewportRef.value)
    core.setViewer(viewer)
    viewer.setMode(core.mode.value)
    camera.syncCameraVisual()

    const el = viewer.renderLoopElement()
    el.addEventListener('mousedown', annotation.onMouseDown)
    el.addEventListener('mousemove', annotation.onMouseMove)
    window.addEventListener('mouseup', annotation.onMouseUp)
    el.addEventListener('wheel', annotation.onWheel, { passive: false })
    window.addEventListener('keydown', annotation.onKeyDown)

    // URL 预设：只保留「换数据集」与「质检」两类直达链接。
    // 压测 / 关联演示 / 演示运镜都有面板按钮，不再单独占一个 URL 入口。
    const params = new URLSearchParams(location.search)
    const demo = params.get('data')
    if (demo === 'real') {
      await dataset.loadRealData()
    } else if (demo === 'nuscenes') {
      await dataset.loadNuScenes()
    } else if (demo === 'world') {
      await dataset.loadNuScenes(true)
      if (params.get('autoplay') === '1') sequence.play()
    } else if (demo === 'sequence') {
      dataset.loadSequence()
      if (params.get('autoplay') === '1') sequence.play()
    } else if (demo === 'qa') {
      dataset.loadDemo()
      quality.runQualityCheck()
    } else {
      dataset.loadDemo()
    }

    ;(function animate() {
      requestAnimationFrame(animate)
      viewer.render()
    })()
  })

  onBeforeUnmount(() => {
    sequence.pausePlay()
    camera.cleanup()
    const viewer = core.getViewer()
    if (viewer) {
      const el = viewer.renderLoopElement()
      el.removeEventListener('mousedown', annotation.onMouseDown)
      el.removeEventListener('mousemove', annotation.onMouseMove)
      window.removeEventListener('mouseup', annotation.onMouseUp)
      el.removeEventListener('wheel', annotation.onWheel)
    }
    window.removeEventListener('keydown', annotation.onKeyDown)
    viewer?.dispose()
  })

  return {
    ...core,
    ...annotation,
    ...dataset,
    ...sequence,
    ...quality,
    ...camera,
    DEFAULT_CATEGORIES,
    issueTypeName,
    numVal,
    strVal,
  }
}

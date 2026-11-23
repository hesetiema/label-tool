/**
 * ============================================================
 * 相机导演 + 视频录制
 * ============================================================
 * 借鉴 rviz_cinematographer 的两段式设计：
 *   - 镜头时间线：相机在哪、看哪里、看多久（cameraTrajectory）
 *   - 录制器：渲染方产出帧，录制方消费并回执（MediaRecorder.onstop）
 *
 * 与标注数据完全解耦：不读 boxes、不碰 history，只控制 viewer 的相机与画布。
 * 因此它是从 useStudio 拆出来的第一块，也是最容易独立验证的一块。
 */
import { ref, computed } from 'vue'
import {
  createDefaultTrajectory, appendKeyframe, sampleTrajectoryInfo, trajectoryDuration,
  serializeTrajectory, parseTrajectory, clamp,
  type CameraTrajectory, type CameraPose,
} from '../core/camera/cameraTrajectory'
import { downloadJson, downloadBlob } from '../core/io/label'
import type { StudioCore } from './studioCore'

export function useCameraDirector(core: StudioCore) {
  const { statusText, mode, setMode, getViewer } = core
  const trajectoryInput = ref<HTMLInputElement | null>(null)

  // 镜头时间线与帧时间线彼此独立：这里管"相机在哪、看哪里、看多久"
  const cameraTrajectory = ref<CameraTrajectory>(createDefaultTrajectory())
  const activeKeyframe = ref(0)
  const cameraElapsed = ref(0)
  const isCameraPlaying = ref(false)
  let cameraRaf = 0
  let cameraLastTs = 0

  // 视频录制状态
  const recordState = ref<'idle' | 'recording' | 'finishing'>('idle')
  const recordFps = ref(30)
  const recordCodec = ref('vp9')
  const addWatermark = ref(true)
  let mediaRecorder: MediaRecorder | null = null
  let recordedChunks: Blob[] = []
  let recordedStream: MediaStream | null = null

  const cameraDuration = computed(() => trajectoryDuration(cameraTrajectory.value))
  const activePose = computed<CameraPose | null>(() =>
    cameraTrajectory.value.frames[activeKeyframe.value]?.pose ?? null)
  const recordingEstimate = computed(() => {
    const d = cameraDuration.value
    const count = Math.max(1, Math.round(d * recordFps.value))
    return `预计 ${d.toFixed(1)}s · ${count} 帧 · ${recordCodec.value.toUpperCase()}`
  })

  // ---- 关键帧编辑 ----
  function ensureCameraVisible() {
    if (mode.value !== '3d') setMode('3d')
  }

  function syncCameraVisual() {
    getViewer()?.setCameraTrajectory(cameraTrajectory.value, activeKeyframe.value)
  }

  /** 把当前 3D 视角追加为关键帧（对应 rviz 的 Append at Cam Pose） */
  function captureCurrentPose() {
    const viewer = getViewer()
    if (!viewer) return
    ensureCameraVisible()
    cameraTrajectory.value = appendKeyframe(cameraTrajectory.value, viewer.getCameraPose())
    activeKeyframe.value = cameraTrajectory.value.frames.length - 1
    syncCameraVisual()
    statusText.value = `已记录第 ${activeKeyframe.value + 1} 个镜头关键帧（共 ${cameraTrajectory.value.frames.length} 个）`
  }

  function selectKeyframe(i: number) {
    const frames = cameraTrajectory.value.frames
    if (!frames.length) return
    activeKeyframe.value = clamp(i, 0, frames.length - 1)
    ensureCameraVisible()
    getViewer()?.applyCameraPose(frames[activeKeyframe.value].pose)
    syncCameraVisual()
    statusText.value = `镜头 #${activeKeyframe.value + 1}/${frames.length} · 转场 ${frames[activeKeyframe.value].transition}s`
  }

  function stepKeyframe(delta: number) {
    selectKeyframe(activeKeyframe.value + delta)
  }

  function applyActivePose() {
    const pose = activePose.value
    if (!pose) return
    ensureCameraVisible()
    getViewer()?.applyCameraPose(pose)
    statusText.value = `相机已回到关键帧 #${activeKeyframe.value + 1}`
  }

  function deleteActiveKeyframe() {
    const frames = cameraTrajectory.value.frames
    if (!frames.length) return
    pauseTrajectory()
    const next = frames.filter((_, i) => i !== activeKeyframe.value)
    cameraTrajectory.value = { ...cameraTrajectory.value, frames: next }
    activeKeyframe.value = clamp(activeKeyframe.value, 0, Math.max(0, next.length - 1))
    cameraElapsed.value = 0
    if (activePose.value) getViewer()?.applyCameraPose(activePose.value)
    syncCameraVisual()
    statusText.value = `已删除关键帧，剩余 ${next.length} 个`
  }

  function clearCameraTrajectory() {
    pauseTrajectory()
    cameraTrajectory.value = createDefaultTrajectory()
    activeKeyframe.value = 0
    cameraElapsed.value = 0
    getViewer()?.setCameraTrajectory(null)
    statusText.value = '相机运镜轨迹已清空'
  }

  function setKeyframeTime(field: 'transition' | 'hold', e: Event) {
    const value = clamp(Number((e.target as HTMLInputElement).value) || 0, 0, 60)
    const frames = cameraTrajectory.value.frames.map((f, i) =>
      i === activeKeyframe.value ? { ...f, [field]: value } : f)
    cameraTrajectory.value = { ...cameraTrajectory.value, frames }
    syncCameraVisual()
    statusText.value = `关键帧 #${activeKeyframe.value + 1} ${field === 'transition' ? '转场' : '停留'}时间 ${value}s`
  }

  function saveTrajectory() {
    downloadJson('camera-trajectory.json', serializeTrajectory(cameraTrajectory.value))
    statusText.value = `已导出 ${cameraTrajectory.value.frames.length} 个镜头关键帧`
  }

  async function openTrajectory(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    if (!file) return
    try {
      pauseTrajectory()
      cameraTrajectory.value = parseTrajectory(await file.text())
      activeKeyframe.value = 0
      cameraElapsed.value = 0
      ensureCameraVisible()
      if (activePose.value) getViewer()?.applyCameraPose(activePose.value)
      syncCameraVisual()
      statusText.value = `已导入运镜「${cameraTrajectory.value.name}」· ${cameraTrajectory.value.frames.length} 个关键帧`
    } catch (err) {
      statusText.value = `轨迹导入失败：${(err as Error).message}`
    }
    input.value = ''
  }

  /** 一键生成绕演示场景的 4 个镜头位姿，配合 ?data=sequence&cinema=1 直达 */
  function loadCinematicDemo() {
    const kf = (
      id: string,
      position: CameraPose['position'],
      target: CameraPose['target'],
      transition: number,
    ): CameraTrajectory['frames'][number] => ({
      id, pose: { position, target, roll: 0 }, transition, hold: 1,
    })
    pauseTrajectory()
    cameraTrajectory.value = {
      ...createDefaultTrajectory('4D 演示运镜'),
      frames: [
        kf('1', { x: 55, y: -55, z: 40 }, { x: 0, y: 0, z: 0 }, 0),
        kf('2', { x: 5, y: -70, z: 22 }, { x: 0, y: 0, z: 2 }, 2.5),
        kf('3', { x: -55, y: -30, z: 30 }, { x: 0, y: 0, z: 1 }, 2),
        kf('4', { x: 25, y: 35, z: 55 }, { x: 0, y: 0, z: 0 }, 2.5),
      ],
    }
    activeKeyframe.value = 0
    cameraElapsed.value = 0
    ensureCameraVisible()
    if (activePose.value) getViewer()?.applyCameraPose(activePose.value)
    syncCameraVisual()
    statusText.value = '已加载演示运镜：4 个关键帧，点「▶ 播放运镜」或「● 录制视频」'
  }

  // ---- 时间线播放 ----
  /** 让镜头停到指定时间点；拖动进度条和播放循环共用 */
  function applyCameraAtTime(t: number) {
    cameraElapsed.value = Math.max(0, t)
    const viewer = getViewer()
    if (!viewer) return
    const sample = sampleTrajectoryInfo(cameraTrajectory.value, cameraElapsed.value)
    viewer.applyCameraPose(sample.pose)
    // 只在关键帧切换时重建 marker 几何体，避免每帧 dispose/create
    if (sample.keyframeIndex >= 0 && sample.keyframeIndex !== activeKeyframe.value) {
      activeKeyframe.value = sample.keyframeIndex
      if (recordState.value === 'idle') syncCameraVisual()
    }
  }

  function pauseTrajectory() {
    if (cameraRaf) cancelAnimationFrame(cameraRaf)
    cameraRaf = 0
    isCameraPlaying.value = false
  }

  function playTrajectory(opts: { oneShot?: boolean; onDone?: () => void } = {}) {
    if (!getViewer() || cameraTrajectory.value.frames.length < 2 || isCameraPlaying.value) return
    ensureCameraVisible()
    isCameraPlaying.value = true
    cameraLastTs = performance.now()
    const total = cameraDuration.value
    const tick = (ts: number) => {
      if (!isCameraPlaying.value) return
      const dt = Math.max(0, (ts - cameraLastTs) / 1000)
      cameraLastTs = ts
      let next = cameraElapsed.value + dt
      if (total > 0 && next >= total) {
        // loop 录制只跑一圈：在结束前 1 帧停下，避免末帧直接跳回首帧
        const endT = opts.oneShot && cameraTrajectory.value.options.loop
          ? Math.max(0, total - 1 / Math.max(1, recordFps.value))
          : total
        applyCameraAtTime(endT)
        cameraElapsed.value = total
        isCameraPlaying.value = false
        opts.onDone?.()
        if (opts.oneShot) return
        if (!cameraTrajectory.value.options.loop) {
          statusText.value = `运镜播放结束 · ${total.toFixed(1)}s`
          return
        }
        next = 0
      }
      applyCameraAtTime(next)
      cameraRaf = requestAnimationFrame(tick)
    }
    cameraRaf = requestAnimationFrame(tick)
  }

  function toggleCameraPlay() {
    if (isCameraPlaying.value) {
      pauseTrajectory()
      statusText.value = `运镜已暂停 · ${cameraElapsed.value.toFixed(1)}s / ${cameraDuration.value.toFixed(1)}s`
      return
    }
    if (cameraTrajectory.value.frames.length < 2) {
      statusText.value = '至少需要 2 个关键帧才能播放运镜'
      return
    }
    playTrajectory()
    statusText.value = `运镜播放中 · ${cameraDuration.value.toFixed(1)}s（与数据帧回放相互独立）`
  }

  function stopTrajectory() {
    pauseTrajectory()
    cameraElapsed.value = 0
    activeKeyframe.value = 0
    if (activePose.value) getViewer()?.applyCameraPose(activePose.value)
    syncCameraVisual()
    statusText.value = '运镜已复位到第 1 个关键帧'
  }

  function onCameraScrub(e: Event) {
    pauseTrajectory()
    applyCameraAtTime(Number((e.target as HTMLInputElement).value))
  }

  // ---- 视频录制 ----
  function finishRecording() {
    if (recordState.value !== 'recording') return
    recordState.value = 'finishing'
    pauseTrajectory()
    mediaRecorder?.stop()
    statusText.value = '录制结束，正在封装视频…'
  }

  /** canvas.captureStream + MediaRecorder：渲染方与录制方解耦，结束时用 onDone 回执 */
  function toggleRecording() {
    if (recordState.value === 'recording') { finishRecording(); return }
    if (recordState.value === 'finishing') return
    const viewer = getViewer()
    if (!viewer || cameraTrajectory.value.frames.length < 2) {
      statusText.value = '录制运镜需要至少 2 个关键帧'
      return
    }
    const canvas = viewer.renderLoopElement()
    const captureStream = (canvas as HTMLCanvasElement & {
      captureStream?: (fps?: number) => MediaStream
    }).captureStream
    if (typeof captureStream !== 'function' || typeof MediaRecorder === 'undefined') {
      statusText.value = '当前浏览器不支持 canvas.captureStream / MediaRecorder，请使用 Chrome 或 Edge'
      return
    }
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
      .find((m) => MediaRecorder.isTypeSupported(m))
    if (!mime) {
      statusText.value = '当前浏览器没有可用的 WebM 编码器'
      return
    }
    try {
      recordedStream = captureStream.call(canvas, recordFps.value)
      mediaRecorder = new MediaRecorder(recordedStream, {
        mimeType: mime,
        videoBitsPerSecond: 8_000_000,
      })
    } catch (err) {
      statusText.value = `录制启动失败：${(err as Error).message}`
      return
    }
    recordedChunks = []
    mediaRecorder.ondataavailable = (ev) => { if (ev.data.size) recordedChunks.push(ev.data) }
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mime })
      downloadBlob(`cinematic-${Date.now()}.webm`, blob)
      recordedStream?.getTracks().forEach((track) => track.stop())
      recordedStream = null
      mediaRecorder = null
      recordState.value = 'idle'
      getViewer()?.setWatermark(false)
      statusText.value = `视频已导出：${(blob.size / 1024 / 1024).toFixed(1)} MB · ${recordFps.value} FPS`
    }
    mediaRecorder.start(250)
    recordState.value = 'recording'
    viewer.setWatermark(addWatermark.value)
    cameraElapsed.value = 0
    ensureCameraVisible()
    playTrajectory({ oneShot: true, onDone: finishRecording })
    statusText.value = `录制中：按运镜轨迹播放一圈（${cameraDuration.value.toFixed(1)}s），再点一次可提前结束`
  }

  /** 卸载时收尾：停播放、停录制、关轨道、摘水印 */
  function cleanup() {
    pauseTrajectory()
    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.onstop = null
      mediaRecorder.stop()
    }
    recordedStream?.getTracks().forEach((track) => track.stop())
    recordedStream = null
    getViewer()?.setWatermark(false)
  }

  return {
    trajectoryInput, cameraTrajectory, activeKeyframe, cameraElapsed, isCameraPlaying,
    recordState, recordFps, recordCodec, addWatermark, cameraDuration,
    recordingEstimate, syncCameraVisual, captureCurrentPose, selectKeyframe,
    stepKeyframe, applyActivePose, deleteActiveKeyframe, clearCameraTrajectory,
    setKeyframeTime, saveTrajectory, openTrajectory, loadCinematicDemo,
    playTrajectory, pauseTrajectory, toggleCameraPlay, stopTrajectory,
    onCameraScrub, toggleRecording, cleanup,
  }
}

export type CameraDirector = ReturnType<typeof useCameraDirector>

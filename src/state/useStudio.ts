/**
 * ============================================================
 * 工作台状态层
 * ============================================================
 * 标注编辑、多帧时序、质量检查、相机导演与视频录制的唯一状态源。
 * 渲染细节在 viewer/PointCloudViewer，界面在 components/，这里不碰 DOM 结构。
 *
 * 统一约定：所有会改变标注的编辑动作都走 mutate()，保证撤销栈完整。
 */
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import { PointCloudViewer, type ViewMode } from '../viewer/PointCloudViewer'
import { generateDemoScene } from '../core/sample'
import { parsePCD } from '../core/io/pcd'
import { parseLabels, serializeLabels, downloadJson, downloadBlob } from '../core/io/label'
import {
  createDefaultTrajectory, appendKeyframe, sampleTrajectoryInfo, trajectoryDuration,
  serializeTrajectory, parseTrajectory, clamp,
  type CameraTrajectory, type CameraPose,
} from '../core/camera/cameraTrajectory'
import { fitBoxToPoints, estimateYawByPCA, pointInBoxBev } from '../core/geometry/box'
import { parseCalibration, type Calibration } from '../core/io/calibration'
import { HistoryStack, cloneBoxes } from '../core/history'
import { generateDemoSequence, interpolateTracks, extractTrajectories, propagateBox, type FrameData, type PropagateScope } from '../core/sequence/sequence'
import { evaluateTemporal, injectTemporalDefects, issueTypeName, type TemporalReport } from '../core/sequence/temporalQA'
import { voxelDownsample, distanceLod, generateMassiveCloud } from '../core/geometry/downsample'
import {
  evaluateQuality,
  perturbLabels,
  type QualityReport,
} from '../core/quality/quality'
import { demoCrossingCase } from '../core/sequence/tracker'
import { DEFAULT_CATEGORIES, type Box3D, type PointCloud } from '../core/types'

export function useStudio() {
  const viewportRef = ref<HTMLDivElement | null>(null)
  let viewer: PointCloudViewer | null = null

  const boxes = ref<Box3D[]>([])
  const selectedId = ref<string | null>(null)
  const mode = ref<ViewMode>('bev')
  const currentCategory = ref('Car')
  const cloud = ref<PointCloud | null>(null)
  const statusText = ref('就绪')
  const fileInput = ref<HTMLInputElement | null>(null)
  const labelInput = ref<HTMLInputElement | null>(null)

  // ---- 相机视图相关 ----
  /** 布局：'cloud' 仅点云 | 'split' 分屏 | 'camera' 仅相机 */
  const layout = ref<'cloud' | 'split' | 'camera'>('cloud')
  const calib = ref<Calibration | null>(null)
  const imageUrl = ref('')
  const camViewRef = ref<{ redraw: () => void } | null>(null)

  // ---- 相机导演（借鉴 rviz_cinematographer）----
  /** 镜头时间线与帧时间线彼此独立：这里管"相机在哪、看哪里、看多久" */
  const cameraTrajectory = ref<CameraTrajectory>(createDefaultTrajectory())
  const activeKeyframe = ref(0)
  const cameraElapsed = ref(0)
  const isCameraPlaying = ref(false)
  const trajectoryInput = ref<HTMLInputElement | null>(null)
  let cameraRaf = 0
  let cameraLastTs = 0

  // ---- 视频录制：渲染方产出帧，录制方消费并回执（对应 rviz 的 Recorder）----
  const recordState = ref<'idle' | 'recording' | 'finishing'>('idle')
  const recordFps = ref(30)
  const recordCodec = ref('vp9')
  const addWatermark = ref(true)
  let mediaRecorder: MediaRecorder | null = null
  let recordedChunks: Blob[] = []
  let recordedStream: MediaStream | null = null

  // ---- 撤销重做 ----
  // 用 Box3D[] 的完整快照作为命令状态：框数据很小，快照比逐字段写逆操作更可靠
  const history = new HistoryStack<Box3D[]>({ limit: 100 })
  const canUndo = ref(false)
  const canRedo = ref(false)
  const undoLabel = ref('')
  function syncHistoryUi() {
    canUndo.value = history.canUndo
    canRedo.value = history.canRedo
    undoLabel.value = history.undoLabel
  }

  // ---- 多帧时序 ----
  const frames = ref<FrameData[]>([])
  const currentFrame = ref(0)
  const perfBusy = ref(false)
  const perfStats = ref('')

  // ---- 4D 轨迹叠加回放 ----
  const showTrajectories = ref(false)
  const isPlaying = ref(false)
  const playSpeed = ref(0.6) // 每帧间隔（秒）
  let playTimer: number | undefined

  // ---- 4D 跨帧编辑 ----
  /** 选中框时记录"编辑前"的快照，用于计算跨帧传播的增量 */
  let selectedBoxOrigin: Box3D | null = null
  const propagateScope = ref<PropagateScope>('forward')
  const propagateStrategy = ref<'replace' | 'offset'>('offset')

  // ---- 4D 时序质检 ----
  const temporalReport = ref<TemporalReport | null>(null)

  // ---- 质检与一致性 ----
  /** 待评估版本（模拟第二位标注员 / 模型预标注的结果） */
  const reviewBoxes = ref<Box3D[]>([])
  /** 质检报告：把"标得准不准"变成可计算的指标 */
  const qaReport = ref<QualityReport | null>(null)
  /** 是否在视口里叠加显示待评估版本的框（便于肉眼核对差异） */
  const showReview = ref(false)

  // ---- 全局最优关联演示（Hungarian + Kalman）----
  /** 关联算法对比结果：贪心 vs Hungarian+Kalman */
  const trackDemo = ref<{
    costText: string
    greedyText: string
    kalmanText: string
    greedySwapped: boolean
    kalmanCorrect: boolean
    gated: number
  } | null>(null)

  const selectedBox = computed(() => boxes.value.find((b) => b.id === selectedId.value) ?? null)
  const cameraDuration = computed(() => trajectoryDuration(cameraTrajectory.value))
  const activePose = computed<CameraPose | null>(() =>
    cameraTrajectory.value.frames[activeKeyframe.value]?.pose ?? null)
  const recordingEstimate = computed(() => {
    const d = cameraDuration.value
    const count = Math.max(1, Math.round(d * recordFps.value))
    return `预计 ${d.toFixed(1)}s · ${count} 帧 · ${recordCodec.value.toUpperCase()}`
  })

  // ---- BEV 拖拽画框相关状态 ----
  let dragging = false
  let dragStart = { x: 0, y: 0 }
  let dragEnd = { x: 0, y: 0 }

  /** 上一份已上传 GPU 的点云引用。避免每次编辑框都重建几何体（这是性能优化的关键点之一） */
  let lastCloudRef: PointCloud | null = null

  function syncViewer() {
    if (!viewer) return
    if (cloud.value && cloud.value !== lastCloudRef) {
      viewer.setPointCloud(cloud.value)
      lastCloudRef = cloud.value
    }
    // 质检模式下把"待评估版本"一起渲染，用 id 前缀区分（视觉上叠加对照）
    const display = showReview.value && reviewBoxes.value.length
      ? [...boxes.value, ...reviewBoxes.value]
      : boxes.value
    viewer.setBoxes(display, selectedId.value)
    // 4D 轨迹叠加：从帧序列提取轨迹，按当前帧高亮。关闭时传空数组清掉轨迹层
    viewer.setTrajectories(
      showTrajectories.value ? extractTrajectories(frames.value) : [],
      currentFrame.value,
      selectedId.value,
    )
    // 相机视图会在 props 变化时自动重绘（watch deep）
  }

  /**
   * 统一的"可撤销变更"入口 —— 所有编辑操作都必须走这里。
   * 这样历史记录才完整，不会出现"有些操作能撤销、有些不能"的尴尬。
   * @param mergeKey 相同 key 且在时间窗口内的连续操作合并成一条（滑杆拖动只算一次撤销）
   */
  function mutate(label: string, fn: () => void, mergeKey?: string) {
    const before = cloneBoxes(boxes.value)
    fn()
    const after = cloneBoxes(boxes.value)
    history.commit(before, after, label, mergeKey)
    syncHistoryUi()
    syncViewer()
  }

  function doUndo() {
    const label = history.undoLabel
    const state = history.undo()
    if (!state) return
    boxes.value = state
    if (selectedId.value && !boxes.value.some((b) => b.id === selectedId.value)) selectedId.value = null
    syncHistoryUi()
    syncViewer()
    statusText.value = `已撤销：${label}`
  }

  function doRedo() {
    const label = history.redoLabel
    const state = history.redo()
    if (!state) return
    boxes.value = state
    if (selectedId.value && !boxes.value.some((b) => b.id === selectedId.value)) selectedId.value = null
    syncHistoryUi()
    syncViewer()
    statusText.value = `已重做：${label}`
  }

  /** 加载新数据集时清空历史：不同数据集之间不应该能互相撤销 */
  function resetHistory(clearPlayback = true, clearQA = true) {
    history.clear()
    syncHistoryUi()
    if (clearPlayback) pausePlay()
    // 数据集切换时清空质检结果，避免拿 A 帧的报告去解释 B 帧
    if (clearQA) {
      reviewBoxes.value = []
      qaReport.value = null
      showReview.value = false
      temporalReport.value = null
      selectedBoxOrigin = null
    }
  }

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
    pausePlay()
    frames.value = generateDemoSequence(5)
    currentFrame.value = 0
    cloud.value = frames.value[0].cloud
    boxes.value = cloneBoxes(frames.value[0].boxes)
    selectedId.value = null
    calib.value = null
    imageUrl.value = ''
    showTrajectories.value = true // 4D 演示默认打开轨迹叠加，进入即可看到运动路径
    setLayout('cloud')
    resetHistory()
    lastCloudRef = null
    syncViewer()
    viewer?.focusOnCloud(cloud.value)
    statusText.value = `已加载 ${frames.value.length} 帧序列 · ${missingTrackCount()} 条轨迹中间帧未标注，点「轨迹插值」补全`
  }

  /** 切换帧：先把当前帧的编辑结果写回序列，否则切走再切回会丢失修改 */
  function gotoFrame(fi: number) {
    if (!frames.value.length) return
    const target = Math.max(0, Math.min(frames.value.length - 1, fi))
    if (target === currentFrame.value) return
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    currentFrame.value = target
    cloud.value = frames.value[target].cloud
    boxes.value = cloneBoxes(frames.value[target].boxes)
    selectedId.value = null
    selectedBoxOrigin = null
    resetHistory(false, false) // 跨帧撤销语义复杂，教学版切帧即清空历史；但不打断回放，也保留质检报告
    syncViewer()
    statusText.value = `第 ${target + 1}/${frames.value.length} 帧 · ${boxes.value.length} 个框`
  }

  /** 轨迹插值：用首末帧的框线性补全中间帧，obj_id 保持一致 */
  function doInterpolate() {
    if (!frames.value.length) return
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    const added = interpolateTracks(frames.value)
    boxes.value = cloneBoxes(frames.value[currentFrame.value].boxes)
    selectedId.value = null
    resetHistory()
    syncViewer()
    statusText.value = added > 0
      ? `轨迹插值完成：补出 ${added} 个中间帧框（obj_id 跨帧一致）`
      : '所有轨迹的中间帧都已完整，无需插值'
  }

  /** 4D 轨迹叠加开关 */
  function toggleTrajectories() {
    showTrajectories.value = !showTrajectories.value
    syncViewer()
    statusText.value = showTrajectories.value
      ? `轨迹叠加已开启：${extractTrajectories(frames.value).length} 条轨迹`
      : '轨迹叠加已关闭'
  }

  /** 停止回放（切数据集 / 卸载 / 手动暂停时调用） */
  function pausePlay() {
    if (playTimer !== undefined) {
      window.clearInterval(playTimer)
      playTimer = undefined
    }
    isPlaying.value = false
  }

  /** 逐帧回放：到末帧后从头循环，直到手动暂停 */
  function play() {
    if (frames.value.length < 2 || isPlaying.value) return
    isPlaying.value = true
    playTimer = window.setInterval(() => {
      const next = currentFrame.value + 1
      gotoFrame(next >= frames.value.length ? 0 : next)
    }, playSpeed.value * 1000)
  }

  function togglePlay() {
    if (isPlaying.value) {
      pausePlay()
      statusText.value = `回放已暂停 · 第 ${currentFrame.value + 1}/${frames.value.length} 帧`
    } else {
      play()
      statusText.value = `回放中 · ${frames.value.length} 帧循环 · 间隔 ${playSpeed.value}s`
    }
  }

  /** 调速时若正在播放，重启定时器以应用新间隔 */
  function onSpeedChange(e: Event) {
    playSpeed.value = Number((e.target as HTMLSelectElement).value)
    if (isPlaying.value) {
      pausePlay()
      play()
    }
  }

  function onScopeChange(e: Event) { propagateScope.value = strVal(e) as PropagateScope }
  function onStrategyChange(e: Event) { propagateStrategy.value = strVal(e) as 'replace' | 'offset' }

  /** 跨帧编辑：把选中框的当前修改传播到其他帧的同 id 框。
   * 用 selectedBoxOrigin（选中时快照）作为"编辑前"基准，配合 propagateBox 计算增量或整框替换。
   */
  function doPropagate() {
    if (!frames.value.length || !selectedId.value) {
      statusText.value = '跨帧传播需要先加载帧序列，并选中一个框'
      return
    }
    const edited = boxes.value.find((b) => b.id === selectedId.value)
    if (!edited || !selectedBoxOrigin) {
      statusText.value = '请先选中一个框再传播'
      return
    }
    // 先把当前帧的编辑写回序列，再传播
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    const changed = propagateBox(
      frames.value,
      currentFrame.value,
      selectedId.value,
      selectedBoxOrigin,
      edited,
      propagateScope.value,
      propagateStrategy.value,
    )
    // 把传播后的当前帧重新读回（内容未变，保持引用一致）
    boxes.value = cloneBoxes(frames.value[currentFrame.value].boxes)
    selectedBoxOrigin = cloneBoxes([edited])[0] // 更新基准为"本次编辑后"
    resetHistory()
    syncViewer()
    const scopeText = { all: '全部帧', forward: '后续帧', backward: '前序帧' }[propagateScope.value]
    const strategyText = propagateStrategy.value === 'replace' ? '整框替换' : '增量平移'
    statusText.value = changed > 0
      ? `跨帧传播完成：${strategyText} → ${scopeText}，修改了 ${changed} 帧的目标 #${selectedId.value}`
      : `没有可传播的目标：${scopeText}里未找到 id=${selectedId.value} 的框`
  }

  /** 时序质检：对当前帧序列做 4D 一致性检查 */
  function runTemporalQA() {
    if (frames.value.length < 2) {
      statusText.value = '时序质检需要至少 2 帧（先加载序列演示）'
      return
    }
    // 确保当前帧编辑已写回
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    temporalReport.value = evaluateTemporal(frames.value)
    const r = temporalReport.value
    statusText.value = r.issues.length === 0
      ? `时序质检通过：${r.trackCount} 条轨迹、${r.frameCount} 帧，未发现异常`
      : `时序质检发现 ${r.issues.length} 处问题（ID跳变 ${r.counts.id_switch} / 速度突变 ${r.counts.speed_jump} / 抖动 ${r.counts.jitter} / 断裂 ${r.counts.track_gap}），健康分 ${r.score}`
  }

  /** 演示"显式标记遮挡"：把有 track_gap 的目标在当前帧标为 occluded，看健康分回升 */
  function runOcclusionDemo() {
    if (frames.value.length < 2) {
      statusText.value = '请先加载序列演示（至少 2 帧）'
      return
    }
    pausePlay()
    // 先把当前帧编辑写回，再对第一个有断裂的目标在缺口帧标记遮挡
    frames.value[currentFrame.value].boxes = cloneBoxes(boxes.value)
    const before = evaluateTemporal(frames.value)
    const gap = before.issues.find((i) => i.type === 'track_gap')
    if (!gap) {
      statusText.value = '当前序列没有轨迹断裂，无需标记遮挡。可先点「演示缺陷注入」制造断裂'
      temporalReport.value = before
      return
    }
    // 在断裂帧给该目标补一个 occluded 标记框（用 markOccluded 纯函数，从种子框复制）
    const seed = frames.value[0]?.boxes.find((b) => b.id === gap.objId)
      ?? frames.value.find((fr) => fr.boxes.some((b) => b.id === gap.objId))?.boxes.find((b) => b.id === gap.objId)
    if (!seed) return
    frames.value[gap.frame].boxes.push({ ...cloneBoxes([seed])[0], visibility: 'occluded' })
    const after = evaluateTemporal(frames.value)
    temporalReport.value = after
    statusText.value = `已把 ${gap.objId} 在第 ${gap.frame} 帧标记为遮挡：健康分 ${before.score} → ${after.score}，该处断裂不再误报（遮挡点 ${after.occludedPoints} 个）`
    gotoFrame(gap.frame)
    syncViewer()
  }

  /** 把当前选中框切换 可见 / 遮挡 状态（插入历史，可撤销） */
  function toggleSelectedVisibility() {
    if (!selectedId.value) return
    const box = boxes.value.find((b) => b.id === selectedId.value)
    if (!box) return
    const next = box.visibility === 'occluded' ? 'visible' : 'occluded'
    mutate(`标记 ${selectedId.value} 为${next === 'occluded' ? '遮挡' : '可见'}`, () => {
      box.visibility = next
    })
    statusText.value = `目标 #${selectedId.value} 已标记为${next === 'occluded' ? '遮挡（虚线显示，质检不误报）' : '可见'}`
  }

  /** 注入时序缺陷并立即质检，用于演示四类问题 */
  function runTemporalDemo() {
    if (frames.value.length < 2) {
      statusText.value = '请先加载序列演示'
      return
    }
    pausePlay()
    const defective = injectTemporalDefects(frames.value)
    temporalReport.value = evaluateTemporal(defective)
    const r = temporalReport.value
    statusText.value = `已注入 4 类时序缺陷：检出 ${r.issues.length} 处，健康分 ${r.score}/100（点下方问题行可跳到对应帧）`
  }

  /** 点击质检问题行：跳到出问题的帧 */
  function gotoIssueFrame(frame: number) {
    gotoFrame(frame)
  }

  /** 用 requestAnimationFrame 实测渲染帧率 —— 用数据说话，而不是凭感觉说"优化后更快" */
  function measureFps(durationMs = 1500): Promise<number> {
    return new Promise((resolve) => {
      let n = 0
      const start = performance.now()
      const tick = () => {
        n++
        const dt = performance.now() - start
        if (dt < durationMs) requestAnimationFrame(tick)
        else resolve(Math.round((n * 1000) / dt))
      }
      requestAnimationFrame(tick)
    })
  }

  /** 百万点性能压测：原始 → 体素下采样 → 距离 LOD → 实测 FPS */
  async function runPerfTest() {
    if (perfBusy.value) return
    perfBusy.value = true
    statusText.value = '正在生成 100 万点…'
    await nextTick()
    const raw = generateMassiveCloud(1_000_000)
    statusText.value = '体素下采样 + 距离 LOD 处理中…'
    await nextTick()
    const voxel = voxelDownsample(raw, 0.5)
    const lod = distanceLod(voxel.cloud, { nearRadius: 45, farKeep: 0.5 })

    frames.value = []
    calib.value = null
    imageUrl.value = ''
    setLayout('cloud')
    cloud.value = lod.cloud
    boxes.value = []
    selectedId.value = null
    resetHistory()
    syncViewer()
    viewer?.focusOnCloud(cloud.value)

    const fps = await measureFps(1500)
    const fmt = (n: number) => n.toLocaleString()
    perfStats.value = `${fmt(raw.count)} → 体素 ${fmt(voxel.outputCount)}（${voxel.elapsedMs.toFixed(0)}ms）→ LOD ${fmt(lod.outputCount)}（${lod.elapsedMs.toFixed(0)}ms）· ${fps} FPS`
    statusText.value = `性能压测完成：${fmt(lod.outputCount)} 点 @ ${fps} FPS`
    perfBusy.value = false
  }

  // ---- 质检功能 ----
  /** 百分比显示（指标面板统一格式） */
  function pct(v: number): string {
    return `${Math.round(v * 100)}%`
  }

  /**
   * 演示"贪心最近邻串 ID vs Hungarian+Kalman 正确保持"的经典交叉案例。
   *
   * 两车相向而行 0.5 秒后交叉换位：
   *   纯距离贪心会给出总距离 0 的"完美匹配"，但两个 ID 完全串了；
   *   Kalman 用速度预测出正确位置，Hungarian 给出同样距离 0 但 ID 正确的配对。
   * 这是面试讲"为什么生产用 Hungarian+Kalman"最有力的一张图。
   */
  function runTrackingDemo() {
    const d = demoCrossingCase()
    const fmt = (a: { row: number; col: number }[]) =>
      a.length ? a.map((x) => `轨迹${x.row}→检测${x.col}`).join('，') : '无匹配'
    // row0=A(原左车) 应该配 col0(x=12)，row1=B(原右车) 应该配 col1(x=8)
    const greedySwapped = d.greedy.some((a) =>
      (a.row === 0 && a.col === 1) || (a.row === 1 && a.col === 0))
    const kalmanCorrect = d.kalman.assignments.some((a) =>
      (a.row === 0 && a.col === 0) || (a.row === 1 && a.col === 1))
    trackDemo.value = {
      costText: `A(8)→检测 ${d.cost[0].map((x) => x.toFixed(0)).join(' / ')}　B(12)→检测 ${d.cost[1].map((x) => x.toFixed(0)).join(' / ')}`,
      greedyText: fmt(d.greedy),
      kalmanText: fmt(d.kalman.assignments),
      greedySwapped,
      kalmanCorrect,
      gated: d.kalman.gated,
    }
    statusText.value = greedySwapped && kalmanCorrect
      ? '关联演示：贪心把两个 ID 串了（总距离却是 0），Kalman+Hungarian 正确保持'
      : '关联演示已运行'
  }

  /**
   * 生成"待评估版本"并计算质检报告。
   *
   * 演示逻辑：把当前标注当作 ground truth，用确定性扰动生成第二版标注
   * （模拟新人标注或模型预标注），然后跑完整的质检测量链路。
   * 真实系统里，这两份数据分别来自「质检员复核结果」和「待验收标注」。
   */
  function runQualityCheck() {
    if (!boxes.value.length) {
      statusText.value = '质检需要至少有标注框（先加载演示场景或真实数据）'
      return
    }
    reviewBoxes.value = perturbLabels(boxes.value)
    qaReport.value = evaluateQuality(boxes.value, reviewBoxes.value)
    showReview.value = true
    syncViewer() // 会把待评估框一起渲染，方便肉眼对照差异
    const m = qaReport.value.metrics
    statusText.value = `质检完成：${qaReport.value.matched.length} 框匹配 · IoU ${m.meanIoU.toFixed(2)} · kappa ${m.kappa.toFixed(2)} · 漏标 ${pct(m.missRate)}`
  }

  /** 显示/隐藏待评估框的叠加层 */
  function toggleReviewOverlay() {
    showReview.value = !showReview.value
    syncViewer()
  }

  /** 切换布局后，通知渲染器重新计算尺寸（分屏时视口变窄） */
  function setLayout(l: 'cloud' | 'split' | 'camera') {
    layout.value = l
    nextTick(() => {
      viewer?.resize()
      camViewRef.value?.redraw()
    })
  }

  function loadDemo() {
    const { cloud: c, boxes: b } = generateDemoScene()
    frames.value = []
    cloud.value = c
    boxes.value = b
    selectedId.value = null
    resetHistory()
    lastCloudRef = null
    syncViewer()
    viewer?.focusOnCloud(c)
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
      lastCloudRef = null
      // 加载相机标定 + 图像，启用分屏对照
      if (calibRes.ok) {
        calib.value = parseCalibration(await calibRes.text())
        imageUrl.value = '/data/front_000970.jpg'
        setLayout('split')
      }
      syncViewer()
      viewer?.focusOnCloud(cloud.value)
      statusText.value = `真实数据已加载：${cloud.value.count.toLocaleString()} 个点，${boxes.value.length} 个标注框（SUSTechPOINTS 样例）`
    } catch (err) {
      statusText.value = `真实数据加载失败：${(err as Error).message}`
    }
  }

  /** 4D-BEV 世界系入口：静止背景已对齐，运动目标拖出轨迹 */
  function loadWorld() {
    void loadNuScenes(true)
  }

  /** 局部坐标系入口：逐帧相机视角，配合分屏对照投影 */
  function loadLocal() {
    void loadNuScenes(false)
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
      lastCloudRef = null
      syncViewer()
      viewer?.focusOnCloud(cloud.value)
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
      lastCloudRef = null
      syncViewer()
      statusText.value = `已加载 ${file.name}：${cloud.value.count.toLocaleString()} 个点`
    } catch (err) {
      statusText.value = `解析失败：${(err as Error).message}`
    }
  }

  async function onLabelFile(e: Event) {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return
    try {
      boxes.value = parseLabels(await file.text())
      selectedId.value = null
      resetHistory()
      syncViewer()
      statusText.value = `已导入 ${boxes.value.length} 个标注框`
    } catch (err) {
      statusText.value = `导入失败：${(err as Error).message}`
    }
  }

  function nextId(): string {
    const max = boxes.value.reduce((m, b) => Math.max(m, Number(b.id) || 0), 0)
    return String(max + 1)
  }

  // ---- 鼠标交互 ----
  function onMouseDown(e: MouseEvent) {
    if (mode.value !== 'bev' || e.button !== 0) return
    const p = viewer!.screenToBev(e.clientX, e.clientY)
    dragStart = p
    dragEnd = p
    dragging = true
  }

  function onMouseMove(e: MouseEvent) {
    if (!dragging || mode.value !== 'bev') return
    dragEnd = viewer!.screenToBev(e.clientX, e.clientY)
    viewer!.showDraft(dragStart, dragEnd)
  }

  function onMouseUp(_e: MouseEvent) {
    if (!dragging) return
    dragging = false
    viewer!.clearDraft()
    const dx = Math.abs(dragEnd.x - dragStart.x)
    const dy = Math.abs(dragEnd.y - dragStart.y)

    // 拖拽距离很小 → 视为点击选中
    if (dx < 0.4 && dy < 0.4) {
      const hit = [...boxes.value].reverse().find((b) => pointInBoxBev(b, dragStart.x, dragStart.y))
      selectedId.value = hit?.id ?? null
      syncViewer()
      return
    }

    // 否则：收集矩形内的点索引 → 自动拟合出 3D 框
    if (!cloud.value) return
    const x0 = Math.min(dragStart.x, dragEnd.x), x1 = Math.max(dragStart.x, dragEnd.x)
    const y0 = Math.min(dragStart.y, dragEnd.y), y1 = Math.max(dragStart.y, dragEnd.y)
    const indices: number[] = []
    const pos = cloud.value.positions
    for (let i = 0; i < cloud.value.count; i++) {
      const px = pos[i * 3], py = pos[i * 3 + 1]
      if (px >= x0 && px <= x1 && py >= y0 && py <= y1) indices.push(i)
    }
    if (indices.length < 5) {
      statusText.value = '框选区域内点数太少，无法拟合'
      return
    }
    // 用 PCA 估计主方向，再据此拟合（这两步是自动标注的核心算法）
    const yaw = estimateYawByPCA(pos, indices)
    const fitted = fitBoxToPoints(pos, indices, yaw)
    const cat = DEFAULT_CATEGORIES.find((c) => c.name === currentCategory.value)!
    const box: Box3D = {
      id: nextId(),
      label: currentCategory.value,
      position: fitted?.position ?? { x: (x0 + x1) / 2, y: (y0 + y1) / 2, z: cat.defaultSize[2] / 2 },
      scale: fitted?.scale ?? { x: x1 - x0, y: y1 - y0, z: cat.defaultSize[2] },
      yaw: fitted?.yaw ?? 0,
    }
    mutate('新建框', () => {
      boxes.value.push(box)
      selectedId.value = box.id
    })
    statusText.value = `新建框 ${box.label} #${box.id}（用 ${indices.length} 个点自动拟合）`
  }

  function onWheel(e: WheelEvent) {
    if (mode.value === 'bev') {
      e.preventDefault()
      viewer!.zoomBev(e.deltaY > 0 ? 5 : -5)
    }
  }

  // ---- 键盘快捷键：编辑选中的框 ----
  function onKeyDown(e: KeyboardEvent) {
    const tag = (e.target as HTMLElement)?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    const box = selectedBox.value
    const key = e.key.toLowerCase()

    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault()
      doExport()
      return
    }
    // 撤销/重做：即使没有选中框也要能用
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) doRedo(); else doUndo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'y') {
      e.preventDefault()
      doRedo()
      return
    }
    if (!box) return
    const step = e.shiftKey ? 0.5 : 0.1
    // mergeKey 把连续按同一个键（或连续拖滑杆）合并成一条历史
    const mk = (suffix: string) => `k:${box.id}:${suffix}`
    switch (key) {
      case 'w': mutate('平移框', () => { box.position.x += step }, mk('x+')); break
      case 's': mutate('平移框', () => { box.position.x -= step }, mk('x-')); break
      case 'a': mutate('平移框', () => { box.position.y += step }, mk('y+')); break
      case 'd': mutate('平移框', () => { box.position.y -= step }, mk('y-')); break
      case 'q': mutate('旋转框', () => { box.yaw += 0.05 }, mk('yaw+')); break
      case 'e': mutate('旋转框', () => { box.yaw -= 0.05 }, mk('yaw-')); break
      case 'r': mutate('缩放框', () => { box.scale.x = Math.max(0.2, box.scale.x + step) }, mk('len+')); break
      case 'f': mutate('缩放框', () => { box.scale.x = Math.max(0.2, box.scale.x - step) }, mk('len-')); break
      case 'delete':
      case 'backspace':
        mutate('删除框', () => {
          boxes.value = boxes.value.filter((b) => b.id !== box.id)
          selectedId.value = null
        })
        break
      default: return
    }
    e.preventDefault()
  }

  function doExport() {
    downloadJson('labels.json', serializeLabels(boxes.value))
    statusText.value = `已导出 ${boxes.value.length} 个框（兼容 SUSTechPOINTS 格式）`
  }

  function setMode(m: ViewMode) {
    mode.value = m
    viewer?.setMode(m)
  }

  // ---- 相机导演：关键帧编辑、时间线播放、轨迹存盘 ----
  function ensureCameraVisible() {
    if (mode.value !== '3d') setMode('3d')
  }

  function syncCameraVisual() {
    viewer?.setCameraTrajectory(cameraTrajectory.value, activeKeyframe.value)
  }

  /** 把当前 3D 视角追加为关键帧（对应 rviz 的 Append at Cam Pose） */
  function captureCurrentPose() {
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
    viewer?.applyCameraPose(frames[activeKeyframe.value].pose)
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
    viewer?.applyCameraPose(pose)
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
    if (activePose.value) viewer?.applyCameraPose(activePose.value)
    syncCameraVisual()
    statusText.value = `已删除关键帧，剩余 ${next.length} 个`
  }

  function clearCameraTrajectory() {
    pauseTrajectory()
    cameraTrajectory.value = createDefaultTrajectory()
    activeKeyframe.value = 0
    cameraElapsed.value = 0
    viewer?.setCameraTrajectory(null)
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
      if (activePose.value) viewer?.applyCameraPose(activePose.value)
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
    if (activePose.value) viewer?.applyCameraPose(activePose.value)
    syncCameraVisual()
    statusText.value = '已加载演示运镜：4 个关键帧，点「▶ 播放运镜」或「● 录制视频」'
  }

  /** 让镜头停到指定时间点；拖动进度条和播放循环共用 */
  function applyCameraAtTime(t: number) {
    cameraElapsed.value = Math.max(0, t)
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
    if (!viewer || cameraTrajectory.value.frames.length < 2 || isCameraPlaying.value) return
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
    if (activePose.value) viewer?.applyCameraPose(activePose.value)
    syncCameraVisual()
    statusText.value = '运镜已复位到第 1 个关键帧'
  }

  function onCameraScrub(e: Event) {
    pauseTrajectory()
    applyCameraAtTime(Number((e.target as HTMLInputElement).value))
  }

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
      viewer?.setWatermark(false)
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

  function selectBox(id: string) {
    selectedId.value = id
    const b = boxes.value.find((x) => x.id === id)
    selectedBoxOrigin = b ? cloneBoxes([b])[0] : null
    syncViewer()
  }

  /** 从 input 的 input 事件里安全读取数值，避免模板里的类型推断问题 */
  function numVal(e: Event): number {
    return Number((e.target as HTMLInputElement).value)
  }
  function strVal(e: Event): string {
    return (e.target as HTMLSelectElement).value
  }

  /**
   * 属性面板统一入口：所有属性修改都可撤销，且同类连续修改（拖滑杆）合并为一条历史。
   * 注意 mutate 会替换 boxes 数组，所以回调里必须用 id 重新查找框，不能持有旧引用。
   */
  function setBoxProp(prop: string, value: number | string) {
    const id = selectedId.value
    if (!id) return
    mutate('修改属性', () => {
      const b = boxes.value.find((x) => x.id === id)
      if (!b) return
      switch (prop) {
        case 'label': b.label = value as string; break
        case 'x': b.position.x = value as number; break
        case 'y': b.position.y = value as number; break
        case 'z': b.position.z = value as number; break
        case 'length': b.scale.x = value as number; break
        case 'width': b.scale.y = value as number; break
        case 'height': b.scale.z = value as number; break
        case 'yaw': b.yaw = value as number; break
      }
    }, `prop:${id}:${prop}`)
  }

  onMounted(async () => {
    await nextTick()
    if (!viewportRef.value) return
    viewer = new PointCloudViewer(viewportRef.value)
    viewer.setMode(mode.value)
    syncCameraVisual()
    const el = viewer.renderLoopElement()
    el.addEventListener('mousedown', onMouseDown)
    el.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('keydown', onKeyDown)
    // URL 参数直达不同演示场景（便于分享与自动化验证）
    const params = new URLSearchParams(location.search)
    const demo = params.get('data')
    if (demo === 'real') {
      await loadRealData()
    } else if (demo === 'nuscenes') {
      await loadNuScenes()
    } else if (demo === 'world') {
      await loadNuScenes(true)
      if (params.get('autoplay') === '1') play()
    } else if (demo === 'sequence') {
      loadSequence()
      if (params.get('cinema') === '1') loadCinematicDemo()
      if (params.get('autoplay') === '1') play()
    } else if (demo === 'perf') {
      await runPerfTest()
    } else if (demo === 'qa') {
      loadDemo()
      runQualityCheck()
    } else if (demo === 'track') {
      loadSequence()
      runTrackingDemo()
    } else {
      loadDemo()
    }
    ;(function animate() {
      requestAnimationFrame(animate)
      viewer?.render()
    })()
  })

  onBeforeUnmount(() => {
    pausePlay()
    pauseTrajectory()
    if (mediaRecorder?.state === 'recording') {
      mediaRecorder.onstop = null
      mediaRecorder.stop()
    }
    recordedStream?.getTracks().forEach((track) => track.stop())
    viewer?.setWatermark(false)
    if (viewer) {
      const el = viewer.renderLoopElement()
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      el.removeEventListener('wheel', onWheel)
    }
    window.removeEventListener('keydown', onKeyDown)
    viewer?.dispose()
  })

  return {
    viewportRef, fileInput, labelInput, trajectoryInput, camViewRef, boxes, selectedId, mode,
    currentCategory, cloud, statusText, layout, calib, imageUrl, cameraTrajectory,
    activeKeyframe, cameraElapsed, isCameraPlaying, recordState, recordFps, recordCodec,
    addWatermark, canUndo, canRedo, undoLabel, frames, currentFrame, perfBusy, perfStats,
    showTrajectories, isPlaying, playSpeed, propagateScope, propagateStrategy, temporalReport,
    qaReport, showReview, trackDemo, selectedBox, cameraDuration, recordingEstimate,
    DEFAULT_CATEGORIES, issueTypeName, doUndo, doRedo, loadSequence, gotoFrame, doInterpolate,
    toggleTrajectories, togglePlay, onSpeedChange, onScopeChange, onStrategyChange,
    doPropagate, runTemporalQA, runOcclusionDemo, toggleSelectedVisibility, runTemporalDemo,
    gotoIssueFrame, runPerfTest, pct, runTrackingDemo, runQualityCheck, toggleReviewOverlay,
    setLayout, loadDemo, loadRealData, loadWorld, loadLocal, onPcdFile, onLabelFile, doExport,
    setMode, captureCurrentPose, selectKeyframe, stepKeyframe, applyActivePose,
    deleteActiveKeyframe, clearCameraTrajectory, setKeyframeTime, saveTrajectory,
    openTrajectory, loadCinematicDemo, toggleCameraPlay, stopTrajectory, onCameraScrub,
    toggleRecording, selectBox, numVal, strVal, setBoxProp,
  }
}

<script setup lang="ts">
/**
 * ============================================================
 * 主界面 —— 把数据层、渲染层、交互层粘合起来
 * ============================================================
 *
 * 交互设计（对照原仓库）：
 *  - BEV 视图：鼠标拖拽画矩形 → 自动拟合出 3D 框（核心标注方式）
 *  - 点击框选中；WASD 平移、Q/E 旋转、R/F 缩放
 *  - Delete 删除，Ctrl+S 导出
 */
import { ref, onMounted, onBeforeUnmount, computed, nextTick } from 'vue'
import { PointCloudViewer, type ViewMode } from './viewer/PointCloudViewer'
import { generateDemoScene } from './core/sample'
import { parsePCD } from './core/pcd'
import { parseLabels, serializeLabels, downloadJson } from './core/label'
import { fitBoxToPoints, estimateYawByPCA, pointInBoxBev } from './core/box'
import { parseCalibration, type Calibration } from './core/calibration'
import { HistoryStack, cloneBoxes } from './core/history'
import { generateDemoSequence, interpolateTracks, extractTrajectories, propagateBox, type FrameData, type PropagateScope } from './core/sequence'
import { evaluateTemporal, injectTemporalDefects, issueTypeName, type TemporalReport } from './core/temporalQA'
import { voxelDownsample, distanceLod, generateMassiveCloud } from './core/downsample'
import {
  evaluateQuality,
  perturbLabels,
  type QualityReport,
} from './core/quality'
import { demoCrossingCase } from './core/tracker'
import CameraView from './components/CameraView.vue'
import { DEFAULT_CATEGORIES, type Box3D, type PointCloud } from './core/types'

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
const camViewRef = ref<InstanceType<typeof CameraView> | null>(null)

// ---- P0-1 撤销重做 ----
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

// ---- P0-2 多帧时序 ----
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

// ---- 质检相关（DeepSeek 第7项：质检、指标与数据治理）----
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

/**
 * 加载 nuScenes mini 真实序列（由 scripts/convert_nuscenes.py 转换而来）。
 * 每一帧都是真实激光雷达点云 + 官方 3D 标注 + 真实相机内外参，
 * 复用多帧机制，切帧即可逐帧核对标注与相机投影。
 */
/** 4D-BEV 世界系入口（按钮点击用，避免模板里传参的类型冲突） */
function loadWorld() {
  void loadNuScenes(true)
}
function loadLocal() {
  void loadNuScenes(false)
}

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
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand">
        <span class="logo">◈</span>
        <div>
          <div class="title">Point Cloud Label Studio</div>
          <div class="subtitle">点云标注学习工具 · Vue3 + Three.js</div>
        </div>
      </div>
      <div class="top-actions">
        <button :disabled="!canUndo" :title="canUndo ? `撤销：${undoLabel}` : '无可撤销操作'" @click="doUndo">↶ 撤销</button>
        <button :disabled="!canRedo" title="重做" @click="doRedo">↷ 重做</button>
        <button class="real" @click="loadRealData">◉ 真实数据</button>
        <button class="real" @click="loadLocal">◉ nuScenes</button>
        <button class="real" @click="loadWorld">◉ 4D-BEV</button>
        <button @click="fileInput?.click()">导入 PCD</button>
        <button @click="labelInput?.click()">导入标注</button>
        <button class="primary" @click="doExport">导出 JSON ↓</button>
        <input ref="fileInput" type="file" accept=".pcd" hidden @change="onPcdFile" />
        <input ref="labelInput" type="file" accept=".json" hidden @change="onLabelFile" />
      </div>
    </header>

    <div class="body">
      <!-- 左侧工具栏 -->
      <aside class="sidebar">
        <section>
          <h3>视图</h3>
          <div class="seg">
            <button :class="{ active: mode === 'bev' }" @click="setMode('bev')">鸟瞰 BEV</button>
            <button :class="{ active: mode === '3d' }" @click="setMode('3d')">3D 透视</button>
          </div>
          <div class="seg" style="margin-top:6px">
            <button :class="{ active: layout === 'cloud' }" @click="setLayout('cloud')">点云</button>
            <button :class="{ active: layout === 'split' }" :disabled="!calib" @click="setLayout('split')">分屏</button>
            <button :class="{ active: layout === 'camera' }" :disabled="!calib" @click="setLayout('camera')">相机</button>
          </div>
          <div v-if="!calib" class="hint-small">加载真实数据后可对照相机图</div>
        </section>

        <!-- P0-2 多帧时序：帧时间轴 -->
        <section v-if="frames.length">
          <h3>时序帧 <span class="count">{{ frames.length }}</span></h3>
          <div class="timeline">
            <button :disabled="currentFrame === 0" @click="gotoFrame(currentFrame - 1)">◀</button>
            <button
              v-for="(_f, i) in frames"
              :key="i"
              :class="{ active: currentFrame === i }"
              @click="gotoFrame(i)"
            >{{ i + 1 }}</button>
            <button :disabled="currentFrame === frames.length - 1" @click="gotoFrame(currentFrame + 1)">▶</button>
          </div>
          <button class="ghost wide" @click="doInterpolate">⟲ 轨迹插值补全</button>
          <div class="hint-small">前 3 个目标逐帧标注，后 3 个只标首末帧 —— 插值可自动补全中间帧</div>

          <!-- 4D 轨迹叠加回放 -->
          <div class="replay-box">
            <div class="replay-row">
              <button
                class="ghost"
                :class="{ active: showTrajectories }"
                @click="toggleTrajectories"
              >{{ showTrajectories ? '◉ 轨迹已显示' : '◌ 显示轨迹' }}</button>
              <button class="play-btn" @click="togglePlay">{{ isPlaying ? '⏸ 暂停' : '▶ 回放' }}</button>
            </div>
            <div class="replay-row">
              <label>速度</label>
              <select :value="playSpeed" @change="onSpeedChange">
                <option value="1.2">慢</option>
                <option value="0.6">中</option>
                <option value="0.25">快</option>
              </select>
              <span class="replay-hint">同目标跨帧连成轨迹线，白点=当前帧</span>
            </div>
          </div>

          <!-- 4D 时序质检 -->
          <div class="temporal-box">
            <div class="replay-row">
              <button class="ghost" @click="runTemporalQA">✓ 时序质检</button>
              <button class="ghost" @click="runTemporalDemo">⚠ 演示缺陷注入</button>
            </div>
            <div class="replay-row" style="margin-top:6px">
              <button class="ghost" @click="runOcclusionDemo">◐ 演示遮挡标记</button>
            </div>
            <div v-if="temporalReport" class="temporal-report">
              <div class="qa-row">
                <span>健康分</span>
                <b :class="temporalReport.score >= 80 ? 'qa-good' : 'qa-warn'">{{ temporalReport.score }} / 100</b>
              </div>
              <div class="temporal-summary">
                <span>ID跳变 {{ temporalReport.counts.id_switch }}</span>
                <span>速度突变 {{ temporalReport.counts.speed_jump }}</span>
                <span>抖动 {{ temporalReport.counts.jitter }}</span>
                <span>断裂 {{ temporalReport.counts.track_gap }}</span>
                <span>遮挡 {{ temporalReport.occludedPoints }}</span>
              </div>
              <div class="temporal-issues">
                <div
                  v-for="(issue, i) in temporalReport.issues"
                  :key="i"
                  class="temporal-issue"
                  :class="issue.severity"
                  @click="gotoIssueFrame(issue.frame)"
                  :title="'跳到第 ' + (issue.frame + 1) + ' 帧'"
                >
                  <span class="issue-tag">{{ issueTypeName(issue.type) }}</span>
                  <span class="issue-detail">{{ issue.detail }}</span>
                </div>
                <div v-if="!temporalReport.issues.length" class="issue-clean">✓ 未发现时序异常</div>
              </div>
            </div>
          </div>
          <button class="ghost wide" style="margin-top:8px" @click="runTrackingDemo">⚯ 贪心 vs Hungarian 关联演示</button>
          <div v-if="trackDemo" class="track-demo">
            <div class="qa-row"><span>观测距离（上一帧→当前帧）</span></div>
            <div class="track-mono">{{ trackDemo.costText }}</div>
            <div class="qa-row"><span>贪心最近邻</span><b class="qa-warn">{{ trackDemo.greedyText }}</b></div>
            <div class="qa-row"><span>Kalman+Hungarian</span><b class="qa-good">{{ trackDemo.kalmanText }}</b></div>
            <div class="qa-row"><span>门控拒绝的错误配对</span><b>{{ trackDemo.gated }}</b></div>
            <div class="track-conclusion">{{ trackDemo.greedySwapped ? '贪心总距离=0 却把两个 ID 串了；Kalman 用速度预测出正确位置' : '两种算法结果一致' }}</div>
          </div>
        </section>

        <!-- P0-3 性能实验室 -->
        <section>
          <h3>性能实验室</h3>
          <button class="ghost wide" :disabled="perfBusy" @click="runPerfTest">
            {{ perfBusy ? '压测中…' : '⚡ 生成 100 万点压测' }}
          </button>
          <div v-if="perfStats" class="perf-stats mono">{{ perfStats }}</div>
          <div class="hint-small">体素下采样 + 距离 LOD，实测优化后的渲染帧率</div>
        </section>

        <!-- 质检面板：DeepSeek 第7项，把"标得准不准"量化 -->
        <section>
          <h3>质检与一致性</h3>
          <button class="ghost wide" @click="runQualityCheck">✓ 生成质检报告</button>
          <button
            v-if="qaReport"
            class="ghost wide"
            @click="toggleReviewOverlay"
          >{{ showReview ? '◌ 隐藏' : '◉ 显示' }}待评估框</button>
          <div v-if="qaReport" class="qa-report">
            <div class="qa-row"><span>匹配 / 漏标 / 误标</span><b>{{ qaReport.matched.length }} / {{ qaReport.missed.length }} / {{ qaReport.spurious.length }}</b></div>
            <div class="qa-row"><span>平均 IoU（边界精度）</span><b>{{ qaReport.metrics.meanIoU.toFixed(2) }}</b></div>
            <div class="qa-row"><span>BEV IoU</span><b>{{ qaReport.metrics.meanBevIoU.toFixed(2) }}</b></div>
            <div class="qa-row"><span>召回率 / 精确率</span><b>{{ pct(qaReport.metrics.recall) }} / {{ pct(qaReport.metrics.precision) }}</b></div>
            <div class="qa-row"><span>F1</span><b>{{ qaReport.metrics.f1.toFixed(2) }}</b></div>
            <div class="qa-row"><span>类别一致性 kappa</span><b :class="qaReport.metrics.kappa >= 0.8 ? 'qa-good' : 'qa-warn'">{{ qaReport.metrics.kappa.toFixed(2) }}</b></div>
            <div class="qa-row"><span>中心误差 / 朝向误差</span><b>{{ qaReport.metrics.centerError.toFixed(2) }}m / {{ qaReport.metrics.yawError.toFixed(2) }}rad</b></div>
          </div>
          <div class="hint-small">用当前标注作基准，生成一份扰动版模拟"新人标注 / 模型预标注"，再量化差异</div>
        </section>

        <section>
          <h3>标注类别</h3>
          <div class="cat-list">
            <button
              v-for="c in DEFAULT_CATEGORIES"
              :key="c.name"
              class="cat"
              :class="{ active: currentCategory === c.name }"
              @click="currentCategory = c.name"
            >
              <span class="dot" :style="{ background: '#' + c.color.toString(16).padStart(6, '0') }"></span>
              {{ c.name }}
            </button>
          </div>
        </section>

        <section>
          <h3>对象列表 <span class="count">{{ boxes.length }}</span></h3>
          <div class="obj-list">
            <div
              v-for="b in boxes"
              :key="b.id"
              class="obj"
              :class="{ active: selectedId === b.id }"
              @click="selectBox(b.id)"
            >
              <span class="obj-name">{{ b.label }} #{{ b.id }}</span>
              <span class="obj-meta">x{{ b.position.x.toFixed(0) }} y{{ b.position.y.toFixed(0) }}</span>
            </div>
            <div v-if="!boxes.length" class="empty">暂无标注</div>
          </div>
        </section>

        <section v-if="selectedBox" class="props">
          <h3>属性编辑</h3>
          <label>类别
            <select :value="selectedBox.label" @change="setBoxProp('label', strVal($event))">
              <option v-for="c in DEFAULT_CATEGORIES" :key="c.name" :value="c.name">{{ c.name }}</option>
            </select>
          </label>
          <div class="grid3">
            <label>x<input type="number" step="0.1" :value="selectedBox.position.x" @input="setBoxProp('x', numVal($event))" /></label>
            <label>y<input type="number" step="0.1" :value="selectedBox.position.y" @input="setBoxProp('y', numVal($event))" /></label>
            <label>z<input type="number" step="0.1" :value="selectedBox.position.z" @input="setBoxProp('z', numVal($event))" /></label>
            <label>长<input type="number" step="0.1" :value="selectedBox.scale.x" @input="setBoxProp('length', numVal($event))" /></label>
            <label>宽<input type="number" step="0.1" :value="selectedBox.scale.y" @input="setBoxProp('width', numVal($event))" /></label>
            <label>高<input type="number" step="0.1" :value="selectedBox.scale.z" @input="setBoxProp('height', numVal($event))" /></label>
          </div>
          <label>朝向 yaw <span class="mono">{{ selectedBox.yaw.toFixed(2) }} rad</span>
            <input type="range" min="-3.14" max="3.14" step="0.01" :value="selectedBox.yaw" @input="setBoxProp('yaw', numVal($event))" />
          </label>
          <!-- 4D 跨帧编辑：把当前框的修改传播到其他帧的同 id 框（仅在有时序帧时显示） -->
          <div v-if="selectedBox" class="propagate-box" style="margin-top:8px">
            <button class="ghost wide" @click="toggleSelectedVisibility">
              {{ selectedBox.visibility === 'occluded' ? '◉ 恢复可见' : '◐ 标记为遮挡' }}
            </button>
            <div class="hint-small">遮挡框用虚线显示，4D 质检不把它算作漏标/跳变</div>
          </div>
          <div v-if="frames.length" class="propagate-box">
            <div class="propagate-title">跨帧传播（目标 #{{ selectedBox.id }}）</div>
            <div class="replay-row">
              <select :value="propagateScope" @change="onScopeChange">
                <option value="forward">后续帧</option>
                <option value="backward">前序帧</option>
                <option value="all">全部帧</option>
              </select>
              <select :value="propagateStrategy" @change="onStrategyChange">
                <option value="offset">增量平移</option>
                <option value="replace">整框替换</option>
              </select>
            </div>
            <button class="ghost wide" @click="doPropagate">⇢ 应用到其他帧</button>
            <div class="hint-small">增量平移保留各帧位置、只带去本次改动；整框替换用当前框覆盖其他帧</div>
          </div>
        </section>

        <button class="ghost wide" @click="loadDemo">重置演示场景</button>
        <button class="ghost wide" @click="loadSequence">加载 5 帧序列</button>
      </aside>

      <!-- 中间渲染视口 -->
      <main class="stage" :class="'layout-' + layout">
        <div ref="viewportRef" class="viewport" v-show="layout !== 'camera'"></div>
        <div class="hud" v-show="layout !== 'camera'">
          <span class="mode-tag">{{ mode === 'bev' ? '鸟瞰视图 (BEV)' : '3D 透视视图' }}</span>
          <span v-if="mode === 'bev'" class="hint">拖拽画框 · 滚轮缩放</span>
          <span v-else class="hint">左键旋转 · 右键平移 · 滚轮缩放</span>
        </div>
        <div class="camera-pane" v-show="layout !== 'cloud' && calib">
          <CameraView
            ref="camViewRef"
            :boxes="boxes"
            :calib="calib"
            :image-url="imageUrl"
            :selected-id="selectedId"
          />
        </div>
      </main>

      <!-- 右侧帮助 -->
      <aside class="help">
        <h3>快捷键</h3>
        <div class="keyrow"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>平移选中框</span></div>
        <div class="keyrow"><kbd>Q</kbd><kbd>E</kbd><span>旋转朝向</span></div>
        <div class="keyrow"><kbd>R</kbd><kbd>F</kbd><span>调整长度</span></div>
        <div class="keyrow"><kbd>Shift</kbd><span>大步长</span></div>
        <div class="keyrow"><kbd>Del</kbd><span>删除</span></div>
        <div class="keyrow"><kbd>Ctrl</kbd>+<kbd>Z</kbd><span>撤销</span></div>
        <div class="keyrow"><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Z</kbd><span>重做</span></div>
        <div class="keyrow"><kbd>Ctrl</kbd>+<kbd>S</kbd><span>导出</span></div>
        <div class="tip">
          <b>工作原理</b>
          <p>在 BEV 拖拽框选点云 → PCA 估计主方向 → 自动拟合出贴合的 3D 框。这就是原仓库"半自动标注"的核心思路。</p>
        </div>
      </aside>
    </div>

    <footer class="statusbar">
      <span class="status-dot"></span>{{ statusText }}
      <span class="spacer"></span>
      <span class="mono">{{ cloud?.count.toLocaleString() ?? 0 }} points</span>
    </footer>
  </div>
</template>

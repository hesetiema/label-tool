/**
 * ============================================================
 * 工作台核心状态
 * ============================================================
 * 唯一的状态容器：标注数据、点云、帧序列、历史栈与 viewer 句柄。
 *
 * 为什么单独抽这一层：撤销栈、渲染同步、数据集切换时的清理，
 * 是五个功能模块（标注 / 数据 / 时序 / 质检 / 运镜）共同依赖的东西。
 * 把它们放在这里，各模块之间就不需要互相 import，只依赖 core。
 *
 * 约定：所有会改变标注的编辑动作都走 mutate()，保证撤销栈完整。
 */
import { ref, computed, nextTick } from 'vue'
import type { PointCloudViewer, ViewMode } from '../viewer/PointCloudViewer'
import { HistoryStack, cloneBoxes } from '../core/history'
import { extractTrajectories, type FrameData } from '../core/sequence/sequence'
import type { TemporalReport } from '../core/sequence/temporalQA'
import type { QualityReport } from '../core/quality/quality'
import type { Calibration } from '../core/io/calibration'
import type { Box3D, PointCloud } from '../core/types'

/** 主视口布局：仅点云 / 点云+相机分屏 / 仅相机 */
export type Layout = 'cloud' | 'split' | 'camera'

/**
 * 重置历史时的清理范围。
 * 切帧要保留回放和质检结果，换数据集则两者都该清空，所以按范围注册钩子。
 */
export type ResetScope = 'playback' | 'qa'

/** 从表单事件里安全读取值，避免模板中的类型推断问题 */
export function numVal(e: Event): number {
  return Number((e.target as HTMLInputElement).value)
}

export function strVal(e: Event): string {
  return (e.target as HTMLSelectElement).value
}

export function createStudioCore() {
  const viewportRef = ref<HTMLDivElement | null>(null)
  const camViewRef = ref<{ redraw: () => void } | null>(null)
  let viewer: PointCloudViewer | null = null

  // ---- 标注数据 ----
  const boxes = ref<Box3D[]>([])
  const selectedId = ref<string | null>(null)
  const cloud = ref<PointCloud | null>(null)
  const statusText = ref('就绪')

  // ---- 帧序列 ----
  const frames = ref<FrameData[]>([])
  const currentFrame = ref(0)

  // ---- 视图与相机标定 ----
  const mode = ref<ViewMode>('bev')
  const layout = ref<Layout>('cloud')
  const calib = ref<Calibration | null>(null)
  const imageUrl = ref('')

  // ---- 叠加层开关（syncViewer 直接读取，因此放在 core）----
  const showTrajectories = ref(false)
  const reviewBoxes = ref<Box3D[]>([])
  const showReview = ref(false)

  // ---- 报告类结果（由各模块写入，面板只读）----
  const qaReport = ref<QualityReport | null>(null)
  const temporalReport = ref<TemporalReport | null>(null)

  // ---- 撤销重做 ----
  // 用 Box3D[] 的完整快照作为命令状态：框数据很小，快照比逐字段写逆操作更可靠
  const history = new HistoryStack<Box3D[]>({ limit: 100 })
  const canUndo = ref(false)
  const canRedo = ref(false)
  const undoLabel = ref('')

  /** 跨帧传播的"编辑前"基准：选中框时由标注模块写入，时序模块读取 */
  const origin: { value: Box3D | null } = { value: null }

  /** 上一份已上传 GPU 的点云引用。避免每次编辑框都重建几何体（性能优化的关键点之一） */
  let lastCloudRef: PointCloud | null = null

  const selectedBox = computed(() => boxes.value.find((b) => b.id === selectedId.value) ?? null)

  function getViewer() { return viewer }
  function setViewer(v: PointCloudViewer | null) { viewer = v }

  /** 点云被替换时调用，下次 syncViewer 会强制重传几何体 */
  function invalidateCloud() { lastCloudRef = null }

  function syncHistoryUi() {
    canUndo.value = history.canUndo
    canRedo.value = history.canRedo
    undoLabel.value = history.undoLabel
  }

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

  /** 取出上一步快照（连同操作名）。调用方负责把结果写回 boxes 并同步 UI */
  function undoState(): { label: string; state: Box3D[] } | null {
    const label = history.undoLabel
    const state = history.undo()
    return state ? { label, state } : null
  }

  function redoState(): { label: string; state: Box3D[] } | null {
    const label = history.redoLabel
    const state = history.redo()
    return state ? { label, state } : null
  }

  const resetHooks: { scope: ResetScope; fn: () => void }[] = []

  /** 注册"历史被重置时该做的清理"。回放状态由时序模块注册，质检结果由 core 自己清 */
  function onReset(scope: ResetScope, fn: () => void) {
    resetHooks.push({ scope, fn })
  }

  /**
   * 清空撤销栈。数据集切换必须调用；切帧时用 keepPlayback/keepQA 保留回放与质检报告。
   */
  function resetHistory(opts: { keepPlayback?: boolean; keepQA?: boolean } = {}) {
    history.clear()
    syncHistoryUi()
    for (const hook of resetHooks) {
      if (hook.scope === 'playback' && opts.keepPlayback) continue
      if (hook.scope === 'qa' && opts.keepQA) continue
      hook.fn()
    }
  }

  // 质检结果跟着数据集走：换数据后不能拿 A 帧的报告解释 B 帧
  onReset('qa', () => {
    reviewBoxes.value = []
    qaReport.value = null
    showReview.value = false
    temporalReport.value = null
    origin.value = null
  })

  function setMode(m: ViewMode) {
    mode.value = m
    viewer?.setMode(m)
  }

  /** 切换布局后通知渲染器重算尺寸（分屏时视口变窄） */
  function setLayout(l: Layout) {
    layout.value = l
    nextTick(() => {
      viewer?.resize()
      camViewRef.value?.redraw()
    })
  }

  return {
    viewportRef, camViewRef, boxes, selectedId, cloud, statusText, frames, currentFrame,
    mode, layout, calib, imageUrl, showTrajectories, reviewBoxes, showReview,
    qaReport, temporalReport, canUndo, canRedo, undoLabel, origin, selectedBox,
    getViewer, setViewer, invalidateCloud, mutate, syncViewer, syncHistoryUi,
    undoState, redoState, resetHistory, onReset, setMode, setLayout,
  }
}

/** 五个功能模块共用的 core 类型 */
export type StudioCore = ReturnType<typeof createStudioCore>

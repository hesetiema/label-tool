/**
 * ============================================================
 * 工作台核心状态
 * ============================================================
 * 唯一的状态容器：标注数据、点云、帧序列、历史栈、视图与外观选项、viewer 句柄。
 *
 * 为什么单独抽这一层：撤销栈、渲染同步、数据集切换时的清理，
 * 是五个功能模块（标注 / 数据 / 时序 / 质检 / 运镜）共同依赖的东西。
 * 把它们放在这里，各模块之间就不需要互相 import，只依赖 core。
 *
 * 约定：所有会改变标注的编辑动作都走 mutate()，保证撤销栈完整。
 */
import { ref, computed, nextTick } from 'vue'
import type { PointCloudViewer } from '../viewer/PointCloudViewer'
import { HistoryStack, cloneBoxes } from '../core/history'
import { extractTrajectories, type FrameData } from '../core/sequence/sequence'
import type { TemporalReport } from '../core/sequence/temporalQA'
import type { QualityReport } from '../core/quality/quality'
import type { Calibration } from '../core/io/calibration'
import { DEFAULT_CATEGORIES, type Box3D, type ObjectCategory, type PointCloud } from '../core/types'

/** 主视口布局：仅点云 / 点云+相机分屏 / 仅相机 */
export type Layout = 'cloud' | 'split' | 'camera'

/** 左侧工具条当前工具 */
export type Tool = 'select' | 'pan' | 'draw'

/** 正交视图名，与 CVAT 的 Top / Side / Front 对应 */
export type OrthoAxis = 'top' | 'side' | 'front'

/** 自动保存状态，直接驱动状态栏文案 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'off'

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

/** 实例配色：按 id 稳定哈希，保证同一目标在任何视图里颜色一致 */
const INSTANCE_PALETTE = [
  0x4fc3f7, 0xff7043, 0x66bb6a, 0xab47bc, 0xffca28,
  0x26c6da, 0xff4081, 0x8bc34a, 0xffa726, 0x7e57c2,
]

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
  return Math.abs(h)
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
  const datasetName = ref('演示场景')

  // ---- 帧序列 ----
  const frames = ref<FrameData[]>([])
  const currentFrame = ref(0)

  // ---- 视图与相机标定 ----
  const layout = ref<Layout>('cloud')
  const calib = ref<Calibration | null>(null)
  const imageUrl = ref('')

  // ---- 工具与正交视图 ----
  const tool = ref<Tool>('select')
  const showOrtho = ref(true)
  /** 被最大化的正交视图；非空时主 3D 视口让位 */
  const orthoMax = ref<OrthoAxis | null>(null)

  // ---- 外观（对应 CVAT 的 Appearance 面板）----
  const colorBy = ref<'label' | 'instance'>('label')
  const opacity = ref(0.9)
  const outlinedBorders = ref(true)
  const showOrientation = ref(true)

  // ---- 对象锁定 / 隐藏：用新 Set 赋值保证 Vue 能感知 ----
  const hiddenIds = ref<Set<string>>(new Set())
  const lockedIds = ref<Set<string>>(new Set())

  // ---- 类别配置（可编辑，随草稿持久化）----
  const categories = ref<ObjectCategory[]>(
    DEFAULT_CATEGORIES.map((c) => ({ ...c, defaultSize: [...c.defaultSize] as [number, number, number] })),
  )

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

  // ---- 自动保存 ----
  const saveState = ref<SaveState>('idle')
  const lastSavedAt = ref<number | null>(null)
  /** 任何需要落盘的改动都 +1，装配层 watch 它做防抖保存 */
  const dirtyVersion = ref(0)
  const autosaveEnabled = ref(true)

  /** 跨帧传播的"编辑前"基准：选中框时由标注模块写入，时序模块读取 */
  const origin: { value: Box3D | null } = { value: null }

  /** 上一份已上传 GPU 的点云引用。避免每次编辑框都重建几何体（性能优化的关键点之一） */
  let lastCloudRef: PointCloud | null = null

  const selectedBox = computed(() => boxes.value.find((b) => b.id === selectedId.value) ?? null)
  const visibleBoxes = computed(() => boxes.value.filter((b) => !hiddenIds.value.has(b.id)))

  function getViewer() { return viewer }
  function setViewer(v: PointCloudViewer | null) { viewer = v }

  /** 点云被替换时调用，下次 syncViewer 会强制重传几何体 */
  function invalidateCloud() { lastCloudRef = null }

  function syncHistoryUi() {
    canUndo.value = history.canUndo
    canRedo.value = history.canRedo
    undoLabel.value = history.undoLabel
  }

  /** 任何改动都调用它：驱动自动保存 + 让 3D 视口重绘 */
  function markDirty() {
    dirtyVersion.value++
    if (saveState.value === 'saved' || saveState.value === 'idle') saveState.value = 'dirty'
    viewer?.requestRender()
  }

  function categoryOf(label: string): ObjectCategory | undefined {
    return categories.value.find((c) => c.name === label)
  }

  /** 统一的取色入口：3D 视口、正交视图、对象列表、相机投影都调它 */
  function colorOf(box: Box3D): number {
    if (colorBy.value === 'instance') {
      return INSTANCE_PALETTE[hashString(box.id) % INSTANCE_PALETTE.length]
    }
    return categoryOf(box.label)?.color ?? 0x4fc3f7
  }

  /** 轨迹提取结果缓存：避免拖动框时每帧重建轨迹层 */
  let trajCache: { key: string; tracks: ReturnType<typeof extractTrajectories> } | null = null
  function trajectoryKey(): string {
    // 只用位置与 id 做签名，成本 O(框数)，远低于重建 Three 对象
    let key = ''
    for (const f of frames.value) {
      key += f.index + ':'
      for (const b of f.boxes) {
        key += b.id + b.position.x.toFixed(2) + b.position.y.toFixed(2) + b.position.z.toFixed(2) + ';'
      }
      key += '|'
    }
    return key
  }

  function currentTrajectories() {
    const key = trajectoryKey()
    if (trajCache?.key !== key) trajCache = { key, tracks: extractTrajectories(frames.value) }
    return trajCache.tracks
  }

  function syncViewer() {
    if (!viewer) return
    if (cloud.value && cloud.value !== lastCloudRef) {
      viewer.setPointCloud(cloud.value)
      lastCloudRef = cloud.value
    }
    // 隐藏对象不进入渲染；质检模式下把"待评估版本"一起渲染（id 前缀区分）
    const base = visibleBoxes.value
    const display = showReview.value && reviewBoxes.value.length
      ? [...base, ...reviewBoxes.value]
      : base
    viewer.setAppearance({
      colorBy: colorBy.value,
      opacity: opacity.value,
      outlinedBorders: outlinedBorders.value,
      showOrientation: showOrientation.value,
    })
    viewer.setBoxes(display, selectedId.value, colorOf)
    // 4D 轨迹叠加：关闭时传空数组清掉轨迹层
    viewer.setTrajectories(
      showTrajectories.value ? currentTrajectories() : [],
      currentFrame.value,
      selectedId.value,
    )
    viewer.requestRender()
  }

  /**
   * 统一的"可撤销变更"入口 —— 所有编辑操作都必须走这里。
   * @param mergeKey 相同 key 且在时间窗口内的连续操作合并成一条（拖拽只算一次撤销）
   */
  function mutate(label: string, fn: () => void, mergeKey?: string) {
    const before = cloneBoxes(boxes.value)
    fn()
    const after = cloneBoxes(boxes.value)
    history.commit(before, after, label, mergeKey)
    syncHistoryUi()
    syncViewer()
    markDirty()
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

  /** 切换布局后通知渲染器重算尺寸（分屏时视口变窄） */
  function setLayout(l: Layout) {
    layout.value = l
    nextTick(() => {
      viewer?.resize()
      camViewRef.value?.redraw()
    })
  }

  /** 全局唯一的框 id：必须扫过所有帧，否则第 2 帧新建框会撞上第 1 帧别的目标 */
  function nextBoxId(): string {
    const used = new Set<string>()
    for (const b of boxes.value) used.add(b.id)
    for (const f of frames.value) for (const b of f.boxes) used.add(b.id)
    let max = 0
    for (const id of used) {
      const n = Number(id)
      if (Number.isFinite(n) && n > max) max = n
    }
    let next = max + 1
    while (used.has(String(next))) next++
    return String(next)
  }

  function toggleHidden(id: string) {
    const next = new Set(hiddenIds.value)
    if (next.has(id)) next.delete(id); else next.add(id)
    hiddenIds.value = next
    syncViewer()
    markDirty()
  }

  function toggleLocked(id: string) {
    const next = new Set(lockedIds.value)
    if (next.has(id)) next.delete(id); else next.add(id)
    lockedIds.value = next
    markDirty()
  }

  function toggleAllLocked() {
    lockedIds.value = lockedIds.value.size === boxes.value.length
      ? new Set()
      : new Set(boxes.value.map((b) => b.id))
    markDirty()
  }

  function isLocked(id: string | null): boolean {
    return !!id && lockedIds.value.has(id)
  }

  function upsertCategory(cat: ObjectCategory) {
    const i = categories.value.findIndex((c) => c.name === cat.name)
    if (i >= 0) categories.value[i] = { ...cat }
    else categories.value.push({ ...cat })
    syncViewer()
    markDirty()
  }

  function removeCategory(name: string) {
    categories.value = categories.value.filter((c) => c.name !== name)
    syncViewer()
    markDirty()
  }

  /**
   * 导入数据里出现的新类别自动登记。
   * 不这么做的话，真实数据里的 Bus / Van / Tricycle 会全部落到同一个兜底色，
   * 对象列表看起来像一堆同色方块（CVAT 靠 label spec 避免这个问题）。
   * 默认尺寸取该类第一个框的尺寸，后续画同类框更贴合。
   */
  function ensureCategories(list: Box3D[]) {
    const known = new Set(categories.value.map((c) => c.name))
    let added = 0
    for (const box of list) {
      if (known.has(box.label)) continue
      known.add(box.label)
      categories.value.push({
        name: box.label,
        color: INSTANCE_PALETTE[(categories.value.length + 3) % INSTANCE_PALETTE.length],
        defaultSize: [box.scale.x, box.scale.y, box.scale.z],
      })
      added++
    }
    if (added) {
      syncViewer()
      markDirty()
    }
    return added
  }

  /** 清空画布相关状态；换数据集时统一调用，避免相机图和旧标定残留 */
  function resetViewerState() {
    calib.value = null
    imageUrl.value = ''
    layout.value = 'cloud'
    orthoMax.value = null
    hiddenIds.value = new Set()
    lockedIds.value = new Set()
    tool.value = 'select'
  }

  return {
    viewportRef, camViewRef, boxes, selectedId, cloud, statusText, datasetName, frames, currentFrame,
    layout, calib, imageUrl, tool, showOrtho, orthoMax,
    colorBy, opacity, outlinedBorders, showOrientation,
    hiddenIds, lockedIds, categories, showTrajectories, reviewBoxes, showReview,
    qaReport, temporalReport, canUndo, canRedo, undoLabel, origin, selectedBox, visibleBoxes,
    saveState, lastSavedAt, dirtyVersion, autosaveEnabled,
    getViewer, setViewer, invalidateCloud, mutate, syncViewer, syncHistoryUi, markDirty,
    undoState, redoState, resetHistory, onReset, setLayout,
    categoryOf, colorOf, trajectoryKey, currentTrajectories,
    nextBoxId, toggleHidden, toggleLocked, toggleAllLocked, isLocked,
    upsertCategory, removeCategory, ensureCategories, resetViewerState,
  }
}

/** 五个功能模块共用的 core 类型 */
export type StudioCore = ReturnType<typeof createStudioCore>

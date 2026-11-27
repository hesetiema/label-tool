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
import { ref, computed, nextTick, watch, shallowRef } from 'vue'
import type { PointCloudViewer, OccupancyLayerData } from '../viewer/PointCloudViewer'
import { HistoryStack, cloneBoxes } from '../core/history'
import { extractTrajectories, type FrameData } from '../core/sequence/sequence'
import type { TemporalReport } from '../core/sequence/temporalQA'
import type { QualityReport } from '../core/quality/quality'
import type { Calibration } from '../core/io/calibration'
import { DEFAULT_CATEGORIES, type Box3D, type ObjectCategory, type PointCloud } from '../core/types'
import { TrackStore } from '../domain/store/trackStore'
import type { SampleDocument } from '../domain/model/document'
import { buildDocumentFromFrames } from '../domain/io/legacyDocument'
import type { FrameLoader } from '../adapters/frameLoader'

/** 主视口布局：仅点云 / 点云+相机分屏 / 仅相机 */
export type Layout = 'cloud' | 'split' | 'camera'

/** 左侧工具条当前工具 */
export type Tool = 'select' | 'pan' | 'draw'

/** 正交视图名，与 CVAT 的 Top / Side / Front 对应 */
export type OrthoAxis = 'top' | 'side' | 'front'

/**
 * 自动保存状态，直接驱动状态栏文案。
 * `readonly` 是跨标签页协调的产物：同一样本已有别的标签页在写，
 * 本页只能看不能存（见 adapters/tabBus.ts）。
 */
export type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'off' | 'readonly'

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
  0x4fc3f7, 0xff7043, 0x66bb6a, 0xab47bc, 0xffca28, 0x26c6da, 0xff4081, 0x8bc34a, 0xffa726, 0x7e57c2,
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
  /**
   * 选中集合。CVAT 允许 Ctrl 点选与框选多目标，所以内部以 Set 为准；
   * primaryId 是「主选中」——属性面板、画布手柄、轨迹高亮只认它。
   * 对外仍暴露 selectedId，写成 computed 是为了让历史上所有
   * `selectedId.value = x` 的调用点语义不变（赋值即收敛为单选）。
   */
  const selectedIds = ref<Set<string>>(new Set())
  const primaryId = ref<string | null>(null)
  const selectedId = computed<string | null>({
    get: () => primaryId.value,
    set: (id) => {
      primaryId.value = id
      selectedIds.value = id ? new Set([id]) : new Set()
    },
  })
  const cloud = ref<PointCloud | null>(null)
  const statusText = ref('就绪')
  const datasetName = ref('演示场景')

  // ---- 帧序列 ----
  const frames = ref<FrameData[]>([])
  const currentFrame = ref(0)
  /**
   * 懒加载数据源句柄。为空表示"所有帧的点云都在内存里"（演示、小数据集、草稿恢复）。
   * 有值时 `frames[i].lazy === true` 的帧要调 `loadFrameCloud` 才能显示。
   */
  const frameLoader = shallowRef<FrameLoader | null>(null)
  /**
   * 数据集缓存键：`local#<首文件名>#<帧数>`。
   * 逐帧点云落盘/回读、草稿恢复都用它；不用 doc.sampleId 是因为文档 id
   * 由 sceneId+range 生成，而 range 在导入前后可能变，键必须稳定。
   */
  const datasetKey = ref('')

  // ---- 4D 真值容器 ----
  /**
   * P1 之后，`boxes` 不再是真值，而是"当前帧的物化视图"：
   *   TrackStore 才是唯一可写真值，boxes 由它物化而来。
   *
   * 为什么还保留这个 ref：全仓 58 处 `boxes.value` 读写（渲染、质检、导出都吃它）。
   * 改签名会波及十几个模块，而语义降级后它们全部继续正确 —— 这正是方案 4.6 的兼容层。
   */
  const doc = shallowRef<SampleDocument | null>(null)
  const store = shallowRef<TrackStore | null>(null)
  /** 文档修订号：TrackStore 不做深层响应式，UI 靠它触发重算 */
  const docVersion = ref(0)
  /** 旧的整帧快照栈：仅在 store 尚未建立（空工作区）时兜底 */
  const history = new HistoryStack<Box3D[]>({ limit: 100 })

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
  /** 点云着色模式；语义标签存在时才有意义 */
  const pointColorBy = ref<'default' | 'semantic' | 'intensity' | 'height'>('default')
  /** 非空表示 3D 视口初始化失败（WebGL 不可用），Stage 用它显示说明而不是空画布 */
  const viewerUnavailable = ref<string | null>(null)
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

  /**
   * 多任务渲染层（占据 / 光流）。
   *
   * 【为什么放在 core 而不是 useTasks】
   *   `syncViewer` 是唯一的渲染同步入口，它只认识 core 里的 ref。
   *   如果把层数据藏在业务模块里，syncViewer 就得回调业务模块取值，
   *   于是"切帧 → 业务算 → 渲染"多了一跳，还制造了循环依赖。
   *   业务模块负责"算出层数据"，core 负责"把层数据送进渲染器"。
   */
  const occLayer = shallowRef<OccupancyLayerData | null>(null)
  const occSlice = ref<[number, number] | null>(null)
  const flowSegments = shallowRef<Float32Array | null>(null)

  // ---- 报告类结果（由各模块写入，面板只读）----
  const qaReport = ref<QualityReport | null>(null)
  const temporalReport = ref<TemporalReport | null>(null)

  // ---- 撤销重做 ----
  // store 存在时走文档级命令历史；不存在时退回整帧快照（空工作区兜底）
  const canUndo = ref(false)
  const canRedo = ref(false)
  const undoLabel = ref('')

  // ---- 自动保存 ----
  const saveState = ref<SaveState>('idle')
  const lastSavedAt = ref<number | null>(null)
  /** 任何需要落盘的改动都 +1，装配层 watch 它做防抖保存 */
  const dirtyVersion = ref(0)
  const autosaveEnabled = ref(true)

  /**
   * 只读形态：同一样本已经在另一个标签页里被编辑。
   *
   * 为什么用"只读"而不是"两边都写、冲突时合并"：
   *   文档是整段覆盖写的，两侧的内存状态没有任何共同祖先可参照，
   *   三方合并在标注场景里会产出"框复活""轨迹重复"这类更难解释的结果。
   *   同一样本单写者 + 显式接管，是唯一能保证"不会静默丢框"的做法。
   */
  const readOnly = ref(false)
  const readOnlyNote = ref('只读：该样本已在另一个标签页打开')

  /** 跨帧传播的"编辑前"基准：选中框时由标注模块写入，时序模块读取 */
  const origin: { value: Box3D | null } = { value: null }

  /** 光标处的点云坐标（状态栏实时显示）。null 表示光标不在点上 */
  const cursor = ref<{ x: number; y: number; z: number } | null>(null)

  /**
   * 全局悬停对象。3D 视口与三张正交视图共用同一个值：
   * 在任一视图里指向某个框，其余视图与 3D 视口一起高亮——
   * 24 个框叠在一起时，这是"我到底指着哪一个"的唯一可靠答案。
   */
  const hoverId = ref<string | null>(null)

  /** 三视图联动缩放：开着时任一视图缩放，其余视图同步到相同「米/像素」 */
  const linkZoom = ref(false)
  /** 联动缩放的广播信号。nonce 保证相同缩放值也能触发（否则 watch 收不到） */
  const orthoZoom = ref<{ scale: number; from: OrthoAxis; nonce: number } | null>(null)
  let zoomNonce = 0

  /**
   * 三视图联动平移：与联动缩放配成一对。
   * 缩放管「多远算一米」，平移管「看着哪一块」——两件事都同步，
   * 三张图才是同一个观察窗口的三个切面，而不是三张各自漂移的图。
   */
  const linkPan = ref(false)
  /** 平移量用世界米而不是像素：三视图尺寸不同（三联 / 最大化），像素不可比 */
  const orthoPan = ref<{ da: number; db: number; from: OrthoAxis; nonce: number } | null>(null)
  let panNonce = 0

  // 切帧后旧的悬停目标多半已经不在这帧了：直接清掉，否则光晕会停在鼠标早已离开的位置
  watch(currentFrame, () => {
    hoverId.value = null
    viewer?.setHover(null)
  })

  /**
   * 帧导航回调。切帧要先写回当前帧，逻辑在时序模块里；
   * 标注模块的键盘快捷键通过这个桥调用，避免两个模块互相 import。
   */
  const frameNav: {
    next?: () => void
    prev?: () => void
    jumpToBox?: (dir: 1 | -1) => void
  } = {}

  /** 上一份已上传 GPU 的点云引用。避免每次编辑框都重建几何体（性能优化的关键点之一） */
  let lastCloudRef: PointCloud | null = null

  const selectedBox = computed(() => boxes.value.find((b) => b.id === primaryId.value) ?? null)
  /** 所有选中的框（多选时为多项，属性面板的批量操作看它） */
  const selectedBoxes = computed(() => boxes.value.filter((b) => selectedIds.value.has(b.id)))
  const selectedCount = computed(() => selectedIds.value.size)
  const visibleBoxes = computed(() => boxes.value.filter((b) => !hiddenIds.value.has(b.id)))

  function isSelected(id: string): boolean {
    return selectedIds.value.has(id)
  }

  /**
   * 多选 / 单选统一入口。
   * @param primary 手柄与属性面板挂在哪个框上；不传则取最后一个
   */
  function selectMany(ids: string[], primary?: string | null) {
    const uniq = [...new Set(ids)]
    selectedIds.value = new Set(uniq)
    if (!uniq.length) {
      primaryId.value = null
      return
    }
    primaryId.value = primary && uniq.includes(primary) ? primary : uniq[uniq.length - 1]
  }

  /** Ctrl / Cmd 点选：在集合里增删一个，并把主选中移到它上面 */
  function toggleSelect(id: string) {
    const next = new Set(selectedIds.value)
    if (next.has(id)) {
      next.delete(id)
      if (primaryId.value === id) primaryId.value = [...next].pop() ?? null
    } else {
      next.add(id)
      primaryId.value = id
    }
    selectedIds.value = next
  }

  function selectAll() {
    selectMany(visibleBoxes.value.map((b) => b.id))
  }

  /** 删除 / 撤销后清掉已不存在的 id，避免选中集合里留幽灵 */
  function pruneSelection() {
    const alive = new Set(boxes.value.map((b) => b.id))
    const stale = [...selectedIds.value].some((id) => !alive.has(id))
    if (!stale) return
    const next = new Set([...selectedIds.value].filter((id) => alive.has(id)))
    selectedIds.value = next
    if (primaryId.value && !alive.has(primaryId.value)) primaryId.value = [...next].pop() ?? null
  }

  function getViewer() {
    return viewer
  }
  function setViewer(v: PointCloudViewer | null) {
    viewer = v
  }

  /** 点云被替换时调用，下次 syncViewer 会强制重传几何体 */
  function invalidateCloud() {
    lastCloudRef = null
  }

  /** 当前帧在文档里的帧号（frames 数组下标 ≠ frame.index，导入数据可能跳号） */
  function frameNumber(index = currentFrame.value): number {
    if (!frames.value.length) return 0
    return frames.value[index]?.index ?? index
  }

  /**
   * 文档的场景标识 —— 也就是 `sampleId = sceneId#start-end` 的前半段。
   *
   * 【为什么不能写死 'workspace'】
   *   帧数相同的两个数据集会算出同一个 sampleId，而 sampleId 就是文档在
   *   IndexedDB 里的主键：导入第二个 21 帧数据集会把第一个的文档覆盖掉。
   *   doc-first 恢复信任文档，一旦撞号就会把 A 的框安到 B 的帧上 ——
   *   这种错不会报错，只会让人标错车。
   *
   *   所以身份取"数据集键"（懒加载导入有 `local#文件名#帧数`），
   *   没有键时退回显示名（演示、单帧导入）。两者都比固定字符串强。
   */
  function sceneIdentity(): string {
    if (datasetKey.value) return datasetKey.value
    return `workspace:${datasetName.value || 'imported'}`
  }

  /**
   * 用当前 frames / boxes 重建文档与 store。
   * 数据集装载、标注导入、草稿恢复都调用它 —— 这些路径的输入还是 v1 结构
   * （整帧 Box3D），迁移在 `buildDocumentFromFrames` 里完成。
   */
  function rebuildDocument(): SampleDocument | null {
    if (!frames.value.length && !boxes.value.length) {
      doc.value = null
      store.value = null
      docVersion.value++
      return null
    }
    const legacy = frames.value.length
      ? frames.value.map((f) => ({ index: f.index, boxes: f.boxes }))
      : [{ index: 0, boxes: boxes.value }]
    const next = buildDocumentFromFrames(legacy, { sceneId: sceneIdentity(), updatedBy: 'local' })
    doc.value = next
    store.value = new TrackStore(next)
    docVersion.value++
    // 物化回来：保证内存里只有一份"视图"，且 id/label/visibility 已被规范化
    boxes.value = store.value.materialize(frameNumber())
    return next
  }

  /**
   * 直接装载一份已存在的文档（doc-first 恢复用）。
   *
   * 与 `rebuildDocument()` 的区别：那边从 v1 逐帧框重新聚合轨迹，
   * 会丢掉生命周期、稀疏状态、复核标记、轨迹属性 —— 这些只存在 v2 文档里。
   * 恢复时必须"原样装上"，所以这里不做任何迁移，只建 store 并物化当前帧。
   *
   * 调用前提：`frames` / `currentFrame` 已经设好（物化要知道当前是哪一帧）。
   */
  function installDocument(next: SampleDocument): void {
    doc.value = next
    store.value = new TrackStore(next)
    docVersion.value++
    boxes.value = store.value.materialize(frameNumber())
  }

  /** 从真值物化指定帧（不传则当前帧） */
  function materializeNow(index = currentFrame.value): Box3D[] {
    const s = store.value
    if (!s) return cloneBoxes(boxes.value)
    return s.materialize(frameNumber(index))
  }

  function frameBoxCount(index: number): number {
    const s = store.value
    if (s) return s.materialize(frameNumber(index)).length
    return frames.value[index]?.boxes.length ?? 0
  }

  /**
   * 换数据源时必须显式调用：旧加载器的 LRU 里还挂着上一个数据集几十 MB 的点云，
   * 不清掉就是"打开新数据集后内存一直不降"。
   */
  function setFrameLoader(loader: FrameLoader | null) {
    frameLoader.value?.dispose()
    frameLoader.value = loader
  }

  /** 该帧的点云是否需要按需解码。未建立加载器时永远返回 false */
  function isFrameLazy(index: number): boolean {
    const f = frames.value[index]
    if (!f || !frameLoader.value) return false
    return f.lazy === true || f.cloud.count === 0
  }

  /**
   * 按需解码一帧点云，并回填 `frames[index].cloud`。
   * 并发调用同一帧由 FrameLoader 折叠成一个 Promise，所以切帧抖动不会重复解码。
   */
  async function loadFrameCloud(index: number): Promise<PointCloud | null> {
    const f = frames.value[index]
    if (!f) return null
    if (f.cloud.count > 0) {
      f.lazy = false
      return f.cloud
    }
    const loader = frameLoader.value
    if (!loader) return null
    // 传数组下标而不是 f.index：草稿恢复可能帧号跳号（0,1,5,6），
    // 而数据源句柄是按"第几个可用帧"寻址的，两者不能混用。
    const cloud = await loader.get(index)
    f.cloud = cloud
    f.lazy = false
    // 预取相邻帧：用户绝大多数操作是"往后翻"，点一帧等三帧的账很难受
    loader.prefetch(index, 1)
    return cloud
  }

  /**
   * 把真值写回 frames 的镜像。
   *
   * frames 仍然是质检 / 导出 / 轨迹叠加的输入（它们吃 FrameData[]），
   * P1 不重写这些模块，所以每次命令后只刷新受影响的帧。
   * 不传 list 表示全量刷新 —— 只在导出/质检前调用，O(帧数 × 轨迹数)。
   */
  function refreshFrameBoxes(list?: number[]) {
    if (!frames.value.length) return
    const s = store.value
    const only = list ? new Set(list) : null
    for (const f of frames.value) {
      if (only && !only.has(f.index)) continue
      f.boxes = s ? s.materialize(f.index) : cloneBoxes(f.boxes)
    }
    docVersion.value++
  }

  function bumpDoc() {
    docVersion.value++
  }

  function syncHistoryUi() {
    const s = store.value
    canUndo.value = s ? s.canUndo : history.canUndo
    canRedo.value = s ? s.canRedo : history.canRedo
    undoLabel.value = s ? s.undoLabel : history.undoLabel
  }

  /** 任何改动都调用它：驱动自动保存 + 让 3D 视口重绘 */
  function markDirty() {
    dirtyVersion.value++
    if (saveState.value === 'saved' || saveState.value === 'idle') saveState.value = 'dirty'
    viewer?.requestRender()
  }

  /**
   * 写光标坐标。鼠标移动每秒几十次，按厘米取整比较，
   * 值没变就不触发状态栏重渲染（否则整条状态栏跟着鼠标抖）。
   */
  function setCursor(p: { x: number; y: number; z: number } | null) {
    const cur = cursor.value
    if (!p) {
      if (cur) cursor.value = null
      return
    }
    const q = (v: number) => Math.round(v * 100) / 100
    const nx = q(p.x),
      ny = q(p.y),
      nz = q(p.z)
    if (cur && q(cur.x) === nx && q(cur.y) === ny && q(cur.z) === nz) return
    cursor.value = { x: nx, y: ny, z: nz }
  }

  function categoryOf(label: string): ObjectCategory | undefined {
    return categories.value.find((c) => c.name === label)
  }

  /**
   * 设置全局悬停对象。只推进 3D 视口的高亮层，不走 syncViewer——
   * 后者会重算轨迹签名，鼠标移动时每秒几十次跑不起。
   */
  function setHover(id: string | null) {
    if (hoverId.value === id) {
      // 值没变，但悬停中的框可能刚被拖动 / 改尺寸，光晕要跟着走
      if (id) viewer?.setHover(visibleBoxes.value.find((b) => b.id === id) ?? null)
      return
    }
    hoverId.value = id
    viewer?.setHover(id ? (visibleBoxes.value.find((b) => b.id === id) ?? null) : null)
  }

  /** 三视图联动缩放：把某个视图的「像素/米」广播给其余视图 */
  function broadcastZoom(from: OrthoAxis, scale: number) {
    if (!linkZoom.value) return
    orthoZoom.value = { scale, from, nonce: ++zoomNonce }
  }

  /**
   * 三视图联动平移：把某个视图走过的世界位移广播给其余视图。
   * da / db 是该视图两个平面轴上的世界米数（Top 是 x/y，Side 是 x/z，Front 是 y/z）。
   */
  function broadcastPan(from: OrthoAxis, da: number, db: number) {
    if (!linkPan.value) return
    if (!Number.isFinite(da) || !Number.isFinite(db)) return
    if (Math.abs(da) < 1e-4 && Math.abs(db) < 1e-4) return
    orthoPan.value = { da, db, from, nonce: ++panNonce }
  }

  /** 统一的取色入口：3D 视口、正交视图、对象列表、相机投影都调它 */
  function colorOf(box: Box3D): number {
    // 复核状态优先于类别配色：待复核的框一眼要能认出来，
    // 否则"模型猜的"和"人标的"在画面上长得一模一样，复核就退化成逐条读列表
    const review = (box as Box3D & { review?: string }).review
    if (review === 'pending') return 0x9aa4b2
    if (review === 'conflict') return 0xff7043
    if (review === 'rejected') return 0x546070
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
    const display = showReview.value && reviewBoxes.value.length ? [...base, ...reviewBoxes.value] : base
    viewer.setAppearance({
      colorBy: colorBy.value,
      pointColorBy: pointColorBy.value,
      opacity: opacity.value,
      outlinedBorders: outlinedBorders.value,
      showOrientation: showOrientation.value,
    })
    viewer.setBoxes(display, selectedIds.value, primaryId.value, colorOf)
    // 悬停光晕单独一层：它的几何体不随框重建，框被拖动时要跟着挪
    viewer.setHover(hoverId.value ? (visibleBoxes.value.find((b) => b.id === hoverId.value) ?? null) : null)
    // 4D 轨迹叠加：关闭时传空数组清掉轨迹层
    viewer.setTrajectories(showTrajectories.value ? currentTrajectories() : [], currentFrame.value, primaryId.value)
    // 占据层按类别上色；切片只影响显示，不改数据
    viewer.setOccupancyLayer(occLayer.value, {
      slice: occSlice.value,
      colorOf: (classId: string) => categoryOf(classId)?.color ?? 0x8fa3c8,
    })
    viewer.setFlowLayer(flowSegments.value)
    viewer.requestRender()
  }

  /**
   * 统一的"可撤销变更"入口 —— 所有编辑操作都必须走这里。
   *
   * 双写期的实现（方案 5.1.2）：老代码继续直接改 `boxes.value`，
   * 这里在前后各物化一次当前帧、按 trackId 对比差异，自动翻译成命令。
   * 好处是 30+ 个编辑调用点一行都不用改，坏处是每次编辑多两次物化
   * （当前帧几十个框，成本远低于一次渲染）。
   *
   * @param mergeKey 相同 key 且在时间窗口内的连续操作合并成一条（拖拽只算一次撤销）
   * @returns 是否真的执行了。只读形态下为 false —— 调用方据此不要再报"已新建 / 已删除"，
   *          否则界面上一片"成功"，画布上什么都没发生。
   */
  function mutate(label: string, fn: () => void, mergeKey?: string): boolean {
    if (readOnly.value) {
      statusText.value = readOnlyNote.value
      return false
    }
    const s = store.value
    if (s) {
      const frame = frameNumber()
      const session = s.beginEdit(frame)
      fn()
      const cmd = session.diffAfter(boxes.value, label, mergeKey)
      if (cmd) {
        s.exec(cmd)
        boxes.value = s.materialize(frame)
        refreshFrameBoxes([frame])
      }
    } else {
      const before = cloneBoxes(boxes.value)
      fn()
      history.commit(before, cloneBoxes(boxes.value), label, mergeKey)
    }
    syncHistoryUi()
    syncViewer()
    markDirty()
    return true
  }

  /** 取出上一步（连同操作名）。跨帧历史由 TrackStore 保证，切帧不再清空 */
  function undoState(): { label: string; state: Box3D[] } | null {
    if (readOnly.value) {
      statusText.value = readOnlyNote.value
      return null
    }
    const s = store.value
    if (!s) {
      const label = history.undoLabel
      const state = history.undo()
      return state ? { label, state } : null
    }
    const label = s.undoLabel
    const cmd = s.undo()
    if (!cmd) return null
    boxes.value = s.materialize(frameNumber())
    refreshFrameBoxes(cmd.meta.affects.frames)
    return { label, state: boxes.value }
  }

  function redoState(): { label: string; state: Box3D[] } | null {
    if (readOnly.value) {
      statusText.value = readOnlyNote.value
      return null
    }
    const s = store.value
    if (!s) {
      const label = history.redoLabel
      const state = history.redo()
      return state ? { label, state } : null
    }
    const label = s.redoLabel
    const cmd = s.redo()
    if (!cmd) return null
    boxes.value = s.materialize(frameNumber())
    refreshFrameBoxes(cmd.meta.affects.frames)
    return { label, state: boxes.value }
  }

  const resetHooks: { scope: ResetScope; fn: () => void }[] = []

  /** 注册"历史被重置时该做的清理"。回放状态由时序模块注册，质检结果由 core 自己清 */
  function onReset(scope: ResetScope, fn: () => void) {
    resetHooks.push({ scope, fn })
  }

  /**
   * 清空撤销栈。数据集切换必须调用；切帧不再调用（历史是文档级的）。
   * 注意只清命令历史，不动文档本身 —— 真值是数据，历史是操作记录。
   */
  function resetHistory(opts: { keepPlayback?: boolean; keepQA?: boolean } = {}) {
    history.clear()
    store.value?.clearHistory()
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
    // 占据与光流同理：A 数据集派生出来的层挂到 B 的帧上，是最难解释的一种错
    occLayer.value = null
    occSlice.value = null
    flowSegments.value = null
  })

  /** 切换布局后通知渲染器重算尺寸（分屏时视口变窄） */
  function setLayout(l: Layout) {
    layout.value = l
    nextTick(() => {
      viewer?.resize()
      camViewRef.value?.redraw()
    })
  }

  /** 全局唯一的框 id：必须扫过所有轨迹，否则第 2 帧新建框会撞上第 1 帧别的目标 */
  function nextBoxId(): string {
    const used = new Set<string>()
    if (store.value) for (const t of store.value.tracks) used.add(t.id)
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
    if (next.has(id)) next.delete(id)
    else next.add(id)
    hiddenIds.value = next
    syncViewer()
    markDirty()
  }

  function toggleLocked(id: string) {
    const next = new Set(lockedIds.value)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    lockedIds.value = next
    markDirty()
  }

  function toggleAllLocked() {
    lockedIds.value = lockedIds.value.size === boxes.value.length ? new Set() : new Set(boxes.value.map((b) => b.id))
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
    selectedIds.value = new Set()
    primaryId.value = null
    hoverId.value = null
    tool.value = 'select'
  }

  return {
    viewportRef,
    camViewRef,
    boxes,
    selectedId,
    selectedIds,
    selectedBoxes,
    selectedCount,
    cloud,
    statusText,
    datasetName,
    frames,
    currentFrame,
    doc,
    store,
    docVersion,
    rebuildDocument,
    installDocument,
    materializeNow,
    frameBoxCount,
    frameNumber,
    refreshFrameBoxes,
    bumpDoc,
    frameLoader,
    setFrameLoader,
    isFrameLazy,
    loadFrameCloud,
    datasetKey,
    layout,
    calib,
    imageUrl,
    tool,
    showOrtho,
    orthoMax,
    colorBy,
    pointColorBy,
    viewerUnavailable,
    opacity,
    outlinedBorders,
    showOrientation,
    hiddenIds,
    lockedIds,
    categories,
    showTrajectories,
    reviewBoxes,
    showReview,
    occLayer,
    occSlice,
    flowSegments,
    qaReport,
    temporalReport,
    canUndo,
    canRedo,
    undoLabel,
    origin,
    selectedBox,
    visibleBoxes,
    saveState,
    lastSavedAt,
    dirtyVersion,
    autosaveEnabled,
    cursor,
    frameNav,
    readOnly,
    readOnlyNote,
    hoverId,
    setHover,
    linkZoom,
    orthoZoom,
    broadcastZoom,
    linkPan,
    orthoPan,
    broadcastPan,
    getViewer,
    setViewer,
    invalidateCloud,
    mutate,
    syncViewer,
    syncHistoryUi,
    markDirty,
    setCursor,
    undoState,
    redoState,
    resetHistory,
    onReset,
    setLayout,
    categoryOf,
    colorOf,
    trajectoryKey,
    currentTrajectories,
    nextBoxId,
    toggleHidden,
    toggleLocked,
    toggleAllLocked,
    isLocked,
    isSelected,
    selectMany,
    toggleSelect,
    selectAll,
    pruneSelection,
    upsertCategory,
    removeCategory,
    ensureCategories,
    resetViewerState,
  }
}

/** 五个功能模块共用的 core 类型 */
export type StudioCore = ReturnType<typeof createStudioCore>

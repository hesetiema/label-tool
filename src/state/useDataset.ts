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
 * 【P0 之后的核心变化：大序列不再一次性解析】
 *   旧实现选 500 个 PCD 就解析 500 个点云，900MB 常驻，标签页直接崩。
 *   现在按规模分两条路：
 *     小数据集（≤20 帧且 ≤120MB）→ 全部解析进内存，行为与旧版一致；
 *     大数据集 → 标注全量解析（几十 KB/帧，4D 能力需要它），
 *                点云只解码首帧，其余帧切到时按需解码并落盘缓存。
 *   两条路的 `frames[i].boxes` 都是全量的，所以插值、时间线、时序质检
 *   在两条路上完全一致 —— 只有"点云在不在内存"不同。
 *
 * 所有加载器都遵循同一套收尾动作：
 *   清视图残留 → 重建文档 → 重置历史 → 清点云缓存 → 同步渲染 → 相机对焦 → 标脏。
 */
import { ref } from 'vue'
import { generateDemoScene, generateSemanticDemoScene } from '../core/sample'
import { parseLabels } from '../core/io/label'
import { parseLabelsAuto } from '../core/io/formats'
import { parseSemanticLabelBin, SEMANTIC_KITTI_CLASSES } from '../core/semantics'
import { parseCalibration } from '../core/io/calibration'
import { generateDemoSequence, type FrameData } from '../core/sequence/sequence'
import { cloneBoxes } from '../core/history'
import { fromStoredCloud, type SessionSnapshot } from '../core/io/session'
import type { Box3D, PointCloud } from '../core/types'
import type { StudioCore } from './studioCore'
import { parseCloudAsync } from '../adapters/pcdParser'
import {
  createLocalFileSource,
  pairLocalFiles,
  placeholderCloud,
  type LocalFilePair,
} from '../adapters/localFileSource'
import { createFrameLoader } from '../adapters/frameLoader'
import { createCachedCloudHandle, saveFrameCloud } from '../adapters/frameCloudStore'
import type { SampleDocument } from '../domain/model/document'
import { materializeFrame } from '../domain/store/materialize'
import { planDocumentRestore } from '../domain/store/restorePlan'

/** 静态资源跟随 Vite base，兼容本地根路径与 GitHub Pages 子路径部署 */
const assetUrl = (path: string) => `${import.meta.env.BASE_URL}${path}`

/** 超过任一阈值就切懒加载。20 帧 × 3MB ≈ 60MB，是浏览器舒适区的上限 */
const LAZY_FRAME_THRESHOLD = 20
const LAZY_BYTES_THRESHOLD = 120 * 1024 * 1024

export function useDataset(core: StudioCore) {
  const {
    boxes,
    selectedId,
    cloud,
    frames,
    currentFrame,
    calib,
    imageUrl,
    showTrajectories,
    pointColorBy,
    statusText,
    datasetName,
    categories,
    resetHistory,
    syncViewer,
    invalidateCloud,
    getViewer,
    resetViewerState,
    markDirty,
    layout,
    saveState,
    lastSavedAt,
    ensureCategories,
    setFrameLoader,
    datasetKey,
  } = core

  const fileInput = ref<HTMLInputElement | null>(null)
  const semanticInput = ref<HTMLInputElement | null>(null)
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
        if (!frames.value[i].boxes.some((b) => b.id === id)) {
          missing++
          break
        }
      }
    }
    return missing
  }

  /** 统一的装载收尾 */
  function afterLoad() {
    // 装载路径的输入还是 v1（整帧框），先迁移成 v2 文档 + TrackStore，
    // 之后 boxes 就是真值的物化视图，编辑一律走命令
    core.rebuildDocument()
    selectedId.value = null
    resetHistory()
    invalidateCloud()
    syncViewer()
    markDirty()
    const first = cloud.value
    if (first) getViewer()?.focusOnCloud(first)
  }

  /**
   * 逐帧落盘预算。
   * 回放 500 帧会把每一帧都解码并写进 IndexedDB（≈900MB），
   * 那不是"断点续标"，是把浏览器配额一次性吃光。
   * 超过预算后只保留内存缓存，不再落盘 —— 用户重新导入源文件即可。
   */
  const PERSIST_BUDGET = 200 * 1024 * 1024
  let persistedBytes = 0

  /**
   * 哪些帧真的落盘了。
   *
   * 快照要不要内联点云，取决于"能不能回读"这个事实，而不是"有没有 datasetKey"。
   * 落盘是 `void saveFrameCloud(...)`（不阻塞解码），所以用 `.then` 记账：
   *   - `decodedFrames` 在解码完成时加入；
   *   - `persistedFrames` 在写入成功时加入。
   * 只要有一个解码帧没进 `persistedFrames`（配额满、超预算、写失败），
   * 就整体退回内联 —— 宁可快照大一点，也不能刷新后点云凭空消失。
   */
  const decodedFrames = new Set<number>()
  const persistedFrames = new Set<number>()

  /**
   * 当前帧缓存的来源是否"可再生"。
   *
   * `true` 只有一种情况：句柄背后是用户这次导入的 File，删了缓存还能重解。
   * 恢复草稿时句柄读的是缓存本身（`createCachedCloudHandle`），源文件早没了，
   * 淘汰一帧就是永久丢一帧 —— 所以那种情况必须是 false。
   *
   * GC 的 LRU 阶段只碰这个标志为 true 的数据集（见 adapters/blobGc.ts）。
   */
  const framesReloadable = ref(false)

  /** 换数据集：先释放旧的帧加载器与缓存键，否则旧点云会一直挂在 LRU 里 */
  function detachLoader() {
    setFrameLoader(null)
    datasetKey.value = ''
    persistedBytes = 0
    decodedFrames.clear()
    persistedFrames.clear()
    framesReloadable.value = false
  }

  /**
   * 配额压力下能不能淘汰当前数据集的帧。
   * 没有帧加载器（演示数据 / 单帧内联）时压根没有帧缓存，也就无从淘汰。
   */
  function canEvictFrames(): boolean {
    return framesReloadable.value
  }

  /**
   * 帧被 GC 淘汰后，把记账撤回来。
   *
   * 【为什么必须撤】`canSpillClouds()` 的全部依据是"解码过的帧都还在 blob 里"。
   * 淘汰之后它们不在了，如果不撤，快照仍会写 `spill`（只留封面帧），
   * 而恢复时那些帧读不出来 —— 用户会看到"刷新后点云全空"，比慢严重得多。
   * 撤掉之后快照退回内联：大一点，但能完整恢复。
   * 这些帧下次被解码时 `onLoad` 会重新落盘并重新记账。
   */
  function forgetPersistedFrames(evicted: Array<{ frame: number; bytes: number }>): void {
    let freed = 0
    for (const e of evicted) {
      persistedFrames.delete(e.frame)
      freed += e.bytes
    }
    // 落盘预算也要退回来：否则"腾出了空间却再也不会落盘" ——
    // PERSIST_BUDGET 是个只增不减的计数器，淘汰后不减就永远卡在上限
    persistedBytes = Math.max(0, persistedBytes - freed)
  }

  /**
   * 整份数据集的落盘记账全部作废。
   *
   * 【什么时候用】另一个标签页淘汰了本端数据集的帧，但淘汰量太大
   * （广播里只发了"全部"），此时无法精确到帧 —— 宁可全部按"不在库里"处理。
   * 后果是快照退回内联（大一点但能完整恢复），比写出一份乐观的 spill 强。
   */
  function forgetAllPersistedFrames(): number {
    const n = persistedFrames.size
    persistedFrames.clear()
    decodedFrames.clear()
    persistedBytes = 0
    return n
  }

  /**
   * 落盘记账快照（排障/手测用）。
   *
   * 这三个数字解释了"为什么这次保存没有走点云外置"：
   * `decoded` 有帧但 `persisted` 少了，就说明有帧没写进库。
   */
  function persistedSnapshot(): { decoded: number; persisted: number; bytes: number } {
    return { decoded: decodedFrames.size, persisted: persistedFrames.size, bytes: persistedBytes }
  }

  /**
   * 快照是否可以只留"封面帧 + 当前帧"的点云，其余帧只写 `lazy` 标记。
   *
   * 判定标准是"每个解码过的帧都能从 blob store 读回来"。没有 datasetKey、
   * 或者有帧没落盘，都必须内联 —— 否则用户刷新后会看到一片空场景。
   */
  function canSpillClouds(): boolean {
    if (!datasetKey.value) return false
    if (!decodedFrames.size) return false
    for (const f of decodedFrames) if (!persistedFrames.has(f)) return false
    return true
  }

  /**
   * 加载演示序列。
   *
   * 【为什么帧数可配】
   *   固定 5 帧对轨迹时间线、VLA 对齐这类"按时间看"的功能太短：
   *   5 帧里放 5 条指令，每条只剩 1 帧，曲线是一条直线，什么都测不出来。
   *   默认仍是 5 帧（用户点菜单看到的就是原来那个演示），
   *   `?data=sequence&frames=N` 给手测与回归用，上限 600 防止误写成 10 万帧把页面卡死。
   */
  function loadSequence(count = 5) {
    detachLoader()
    resetViewerState()
    const n = Math.max(1, Math.min(600, Math.round(count) || 5))
    const seq = generateDemoSequence(n)
    frames.value = seq
    currentFrame.value = 0
    cloud.value = seq[0].cloud
    boxes.value = cloneBoxes(seq[0].boxes)
    datasetName.value = `演示序列 · ${n} 帧`
    showTrajectories.value = true
    afterLoad()
    statusText.value = `已加载 ${seq.length} 帧序列 · ${missingTrackCount()} 条轨迹中间帧未标注，点「轨迹插值」补全`
  }

  function loadDemo() {
    detachLoader()
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

  /** 语义分割演示：带逐点类别标签，进入后自动切到语义着色 */
  function loadSemanticDemo() {
    detachLoader()
    resetViewerState()
    const { cloud: c, boxes: b } = generateSemanticDemoScene()
    frames.value = []
    currentFrame.value = 0
    cloud.value = c
    boxes.value = b
    datasetName.value = '语义分割演示 · 程序化场景'
    showTrajectories.value = false
    pointColorBy.value = 'semantic'
    afterLoad()
    statusText.value = `语义演示：${c.count.toLocaleString()} 个带标签点，${b.length} 个目标 · 点右侧「语义」切换着色`
  }

  /** 一键加载 SUSTechPOINTS 真实数据（点云 + 24 个标注框 + 相机） */
  async function loadRealData() {
    statusText.value = '正在加载真实点云（3MB）…'
    try {
      const [pcRes, labelRes, calibRes] = await Promise.all([
        fetch(assetUrl('data/000970.pcd')),
        fetch(assetUrl('data/000970.json')),
        fetch(assetUrl('data/calib_front.json')),
      ])
      if (!pcRes.ok || !labelRes.ok) throw new Error('数据文件缺失')
      const [pcBuf, labelText] = await Promise.all([pcRes.arrayBuffer(), labelRes.text()])
      detachLoader()
      resetViewerState()
      frames.value = []
      currentFrame.value = 0
      // 走 worker：3MB / 10 万点的解析不该占着主线程
      cloud.value = await parseCloudAsync(pcBuf, { name: '000970.pcd' })
      boxes.value = parseLabels(labelText)
      ensureCategories(boxes.value)
      datasetName.value = '000970 · SUSTechPOINTS 样例'
      showTrajectories.value = false
      if (calibRes.ok) {
        calib.value = parseCalibration(await calibRes.text())
        imageUrl.value = assetUrl('data/front_000970.jpg')
        layout.value = 'split'
      }
      afterLoad()
      statusText.value = `真实数据已加载：${cloud.value.count.toLocaleString()} 个点，${boxes.value.length} 个标注框`
    } catch (err) {
      statusText.value = `真实数据加载失败：${(err as Error).message}`
    }
  }

  /**
   * 读取全部同名 JSON 标注。
   * 标注很小（几十 KB/帧）且 4D 能力需要全量框，所以这里不做懒加载；
   * 每 8 帧让出一次主线程，避免 500 个 JSON 解析把 UI 卡住。
   */
  async function readAllLabels(pairs: LocalFilePair[]): Promise<Box3D[][]> {
    const out: Box3D[][] = []
    for (let i = 0; i < pairs.length; i++) {
      const pair = pairs[i]
      if (i % 8 === 0) {
        statusText.value = `读取标注 ${i + 1}/${pairs.length} …`
        await new Promise((r) => setTimeout(r, 0))
      }
      if (!pair.labels) {
        out.push([])
        continue
      }
      try {
        out.push(parseLabelsAuto(await pair.labels.text(), pair.labels.name).boxes)
      } catch {
        // 单个标注坏掉不该让整个导入失败，只是这一帧少框
        out.push([])
      }
    }
    return out
  }

  /**
   * 本地导入：支持一次选多个 PCD，按文件名排序拼成时序。
   * 小数据集全量解析；大数据集只解析首帧，其余按需（见文件头说明）。
   */
  async function importFiles(e: Event) {
    const input = e.target as HTMLInputElement
    const files = Array.from(input.files ?? [])
    input.value = ''
    if (!files.length) return

    const pairs = pairLocalFiles(files)
    if (!pairs.length) {
      statusText.value = '请选择点云文件 .pcd / .ply / .bin（可多选，按文件名排序组成时序）'
      return
    }

    resetViewerState()
    showTrajectories.value = false
    importCount.value = pairs.length
    const totalBytes = pairs.reduce((n, p) => n + p.cloud.size, 0)
    const lazy = pairs.length > LAZY_FRAME_THRESHOLD || totalBytes > LAZY_BYTES_THRESHOLD

    try {
      const labelSets = await readAllLabels(pairs)
      ensureCategories(labelSets.flat())

      if (lazy) {
        const source = createLocalFileSource(pairs, {
          name: `${pairs[0].cloud.name} 等 ${pairs.length} 帧`,
        })
        const summary = (await source.listSamples())[0]
        const handle = await source.openSample(summary.sampleId)
        handle.primeLabels(labelSets)

        detachLoader()
        datasetKey.value = `local#${pairs[0].cloud.name}#${pairs.length}`
        const key = datasetKey.value
        const loader = createFrameLoader(handle, {
          // 解码成功即落盘：刷新后能直接回读，不用重新选文件
          onLoad: (frame, c) => {
            decodedFrames.add(frame)
            const bytes = c.positions.byteLength + (c.colors?.byteLength ?? 0)
            if (persistedBytes + bytes > PERSIST_BUDGET) return
            persistedBytes += bytes
            void saveFrameCloud(key, frame, c)
              .then(() => {
                persistedFrames.add(frame)
              })
              .catch(() => {
                /* 尽力而为：没落盘的帧会让快照退回内联 */
              })
          },
        })
        setFrameLoader(loader)
        // 必须在 detachLoader() 之后设：换数据集会把它重置成 false，
        // 而 detachLoader 就在上面——写在 handle 一创建的位置等于白写
        framesReloadable.value = handle.reloadable === true

        statusText.value = `解码首帧 …`
        const firstCloud = await loader.get(0)
        frames.value = pairs.map((_, i) => ({
          index: i,
          cloud: i === 0 ? firstCloud : placeholderCloud(),
          boxes: labelSets[i] ?? [],
          lazy: i !== 0,
        }))
        currentFrame.value = 0
        cloud.value = firstCloud
        boxes.value = cloneBoxes(frames.value[0].boxes)
        datasetName.value = `${pairs[0].cloud.name} 等 ${pairs.length} 帧`
        showTrajectories.value = true
        afterLoad()
        statusText.value = `已导入 ${pairs.length} 帧（${(totalBytes / 1048576).toFixed(0)}MB，点云按需解码）：首帧已显示，切帧时自动解析并缓存`
        return
      }

      detachLoader()
      const nextFrames: FrameData[] = []
      for (let i = 0; i < pairs.length; i++) {
        statusText.value = `解析 ${i + 1}/${pairs.length}：${pairs[i].cloud.name} …`
        // 让出主线程，避免多帧解析时界面完全冻住
        await new Promise((r) => setTimeout(r, 0))
        const parsed = await parseCloudAsync(await pairs[i].cloud.arrayBuffer(), { name: pairs[i].cloud.name })
        nextFrames.push({ index: i, cloud: parsed, boxes: labelSets[i] ?? [] })
      }

      frames.value = nextFrames.length > 1 ? nextFrames : []
      currentFrame.value = 0
      cloud.value = nextFrames[0].cloud
      boxes.value = cloneBoxes(nextFrames[0].boxes)
      datasetName.value = nextFrames.length > 1 ? `${pairs[0].cloud.name} 等 ${pairs.length} 帧` : pairs[0].cloud.name
      showTrajectories.value = nextFrames.length > 1
      afterLoad()
      const total = nextFrames.reduce((n, f) => n + f.cloud.count, 0)
      statusText.value =
        nextFrames.length > 1
          ? `已导入 ${nextFrames.length} 帧（共 ${total.toLocaleString()} 点），可用顶部帧导航逐帧标注`
          : `已加载 ${pairs[0].cloud.name}：${nextFrames[0].cloud.count.toLocaleString()} 个点`
    } catch (err) {
      statusText.value = `解析失败：${(err as Error).message}`
    } finally {
      importCount.value = 0
    }
  }

  /**
   * 导入 SemanticKITTI .label 二进制（每点一个 uint32：低 16 位语义、高 16 位实例）。
   * 必须与当前点云点数一致，否则直接报错——错位标签比没有标签更危险。
   * 类别表用官方原始 id，保证 moving-car(252) 等不会被错认成别的类。
   */
  async function onSemanticFile(e: Event) {
    const input = e.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    const current = cloud.value
    if (!current) {
      statusText.value = '请先加载点云，再导入语义标签'
      return
    }
    try {
      const { labels, instances, classCount, instanceCount } = parseSemanticLabelBin(
        await file.arrayBuffer(),
        current.count,
      )
      // 替换整个点云对象而非原地改字段，保证 Vue 响应式与渲染缓存都失效
      cloud.value = {
        ...current,
        labels,
        instances,
        semanticClasses: SEMANTIC_KITTI_CLASSES,
      }
      invalidateCloud()
      pointColorBy.value = 'semantic'
      syncViewer()
      markDirty()
      statusText.value = `已导入 ${labels.length.toLocaleString()} 点 / ${classCount} 类 / ${instanceCount} 个实例（${file.name}）`
    } catch (err) {
      statusText.value = `语义标签导入失败：${(err as Error).message}`
    }
  }

  /**
   * doc-first 恢复：标注真值来自 v2 文档，点云来自快照 / 帧缓存。
   *
   * 【为什么不复用 restore()】
   *   restore() 把快照里的 boxes 当输入，再走 `buildDocumentFromFrames()` 迁移成文档。
   *   迁移只会重建"逐帧框"能表达的东西：生命周期、稀疏状态、复核标记、
   *   轨迹属性全部丢失 —— 用户拖短过的生命周期刷新后自己变长，这是不能接受的。
   *   doc-first 直接把文档装进 TrackStore，一个字段都不改写。
   *
   * 【点云怎么来】
   *   快照里带内联点云的帧直接读回；其余帧建"从 IndexedDB 读"的加载器。
   *   当前帧必须内联（保存时已保证），否则首屏就是空的。
   *
   * 返回 false 表示"这份文档不该用"（帧区间对不上、数据损坏），
   * 调用方应回退到 v1 快照恢复 —— 宁可少恢复生命周期，不能把框安到别的帧上。
   */
  async function restoreFromDocument(
    doc: SampleDocument,
    snapshot: SessionSnapshot | null,
    pointerDatasetKey = '',
  ): Promise<boolean> {
    try {
      // 快照自报的文档 id 与收到的文档不一致：两个来源已经指错，直接放弃
      if (snapshot?.sampleId && snapshot.sampleId !== doc.sampleId) return false

      const plan = planDocumentRestore(
        doc,
        snapshot
          ? {
              frames: snapshot.frames.map((f) => ({
                index: f.index,
                hasCloud: !!f.cloud && f.cloud.count > 0,
              })),
              currentFrame: snapshot.currentFrame,
              hasSingleCloud: !!snapshot.cloud,
            }
          : null,
      )
      if (!plan.ok) {
        console.warn('[restore] 文档与快照帧区间不一致，回退 v1 快照', doc.sampleId, doc.range)
        return false
      }

      detachLoader()
      resetViewerState()

      // 快照没了也可能有数据集键（草稿指针里），点云还能从 blob store 回读
      const key = snapshot?.datasetKey || pointerDatasetKey
      const cloudByIndex = new Map<number, PointCloud>()
      for (const f of snapshot?.frames ?? []) {
        if (f.cloud && f.cloud.count > 0) cloudByIndex.set(f.index, fromStoredCloud(f.cloud))
      }

      const boxesAt = (frame: number): Box3D[] =>
        materializeFrame(doc, frame).map((v) => ({
          id: v.id,
          label: v.label,
          position: { ...v.position },
          scale: { ...v.scale },
          yaw: v.yaw,
          ...(v.visibility ? { visibility: v.visibility } : {}),
          ...(v.attributes && Object.keys(v.attributes).length ? { attributes: { ...v.attributes } } : {}),
        }))

      let restoredFrames: FrameData[] = []
      if (!plan.singleFrame) {
        restoredFrames = plan.layout.map((index) => {
          const restored = cloudByIndex.get(index)
          return {
            index,
            cloud: restored ?? placeholderCloud(),
            boxes: boxesAt(index),
            ...(restored ? {} : { lazy: true }),
          }
        })
      }

      const currentCloud = plan.singleFrame
        ? snapshot?.cloud
          ? fromStoredCloud(snapshot.cloud)
          : null
        : (cloudByIndex.get(plan.layout[plan.current]) ?? null)

      categories.value = snapshot?.categories ?? []
      frames.value = restoredFrames
      currentFrame.value = plan.current
      cloud.value = currentCloud
      datasetName.value = snapshot?.datasetName || '本地草稿'
      showTrajectories.value = restoredFrames.length > 1

      const allBoxes = restoredFrames.length ? restoredFrames.flatMap((f) => f.boxes) : boxesAt(doc.range[0])
      ensureCategories(allBoxes)

      // 装文档：不做迁移，生命周期/状态/复核标记原样保留
      core.installDocument(doc)
      boxes.value = core.materializeNow()

      if (plan.lazyFrames.length && key) {
        setFrameLoader(createFrameLoader(createCachedCloudHandle(key, plan.layout)))
        datasetKey.value = key
      }
      // 手里已有的点云都是从帧缓存读回来的 —— 记账为"已落盘"，
      // 下次保存才能继续走"快照只留封面帧"的路径。
      // 放在 if 外面：即使这轮没有待解码帧，也不能让后续保存退回内联。
      for (const index of plan.cloudFrames) {
        decodedFrames.add(index)
        persistedFrames.add(index)
        const c = cloudByIndex.get(index)
        if (c) persistedBytes += c.positions.byteLength + (c.colors?.byteLength ?? 0)
      }

      lastSavedAt.value = snapshot?.savedAt ?? null
      saveState.value = snapshot ? 'saved' : 'idle'
      selectedId.value = null
      resetHistory()
      invalidateCloud()
      syncViewer()
      if (cloud.value) getViewer()?.focusOnCloud(cloud.value)
      else if (plan.lazyFrames.length) {
        // 当前帧没有内联点云（老快照或帧缓存被清）：补一次异步解码
        void core
          .loadFrameCloud(plan.current)
          .then((c) => {
            if (!c || currentFrame.value !== plan.current) return
            cloud.value = c
            syncViewer()
          })
          .catch(() => {
            /* 状态栏在切帧路径里会提示 */
          })
      }

      const time = snapshot
        ? new Date(snapshot.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        : ''
      const lazyNote = plan.lazyFrames.length ? ` · ${plan.lazyFrames.length} 帧点云待解码（切帧时自动读取）` : ''
      const trimmed = doc.tasks.boxes.tracks.filter(
        (t) =>
          t.lifecycle.first !== t.keyframes[0]?.frame ||
          t.lifecycle.last !== t.keyframes[t.keyframes.length - 1]?.frame,
      ).length
      const trimNote = trimmed ? ` · ${trimmed} 条生命周期已裁剪` : ''
      statusText.value = snapshot
        ? `已恢复 ${time} 的草稿：${plan.totalBoxes} 个框${trimNote}${lazyNote}`
        : `已从文档恢复：${plan.totalBoxes} 个框${lazyNote}`
      return true
    } catch (err) {
      statusText.value = `文档恢复失败：${(err as Error).message}`
      return false
    }
  }

  /**
   * 从 IndexedDB 草稿恢复。
   *
   * 【懒加载数据集的恢复策略】
   *   快照里只保存了"已解码帧"的点云，其余帧 `lazy: true`。
   *   恢复时给这些帧建一个"从 IndexedDB 读点云"的加载器：
   *   切到哪帧读哪帧，没缓存过就如实提示，而不是显示一个空场景。
   *   标注（boxes）永远在快照里，所以恢复后 4D 能力完整、不丢标注。
   */
  async function restore(snapshot: SessionSnapshot): Promise<boolean> {
    try {
      detachLoader()
      resetViewerState()
      const key = snapshot.datasetKey ?? ''

      const restoredFrames: FrameData[] = snapshot.frames.map((f) => {
        const missing = f.lazy === true || !f.cloud || f.cloud.count === 0
        return {
          index: f.index,
          cloud: missing ? placeholderCloud() : fromStoredCloud(f.cloud),
          boxes: f.boxes,
          ...(missing ? { lazy: true } : {}),
        }
      })

      const lazyCount = restoredFrames.filter((f) => f.lazy).length
      if (lazyCount && key) {
        const handle = createCachedCloudHandle(
          key,
          restoredFrames.map((f) => f.index),
        )
        setFrameLoader(createFrameLoader(handle))
        datasetKey.value = key
      }

      categories.value = snapshot.categories
      frames.value = restoredFrames
      currentFrame.value = Math.min(snapshot.currentFrame, Math.max(0, restoredFrames.length - 1))
      const frameCloud = restoredFrames[currentFrame.value]?.cloud
      cloud.value = snapshot.cloud
        ? fromStoredCloud(snapshot.cloud)
        : frameCloud && frameCloud.count > 0
          ? frameCloud
          : null
      boxes.value = snapshot.cloud
        ? snapshot.boxes
        : cloneBoxes(restoredFrames[currentFrame.value]?.boxes ?? snapshot.boxes)
      datasetName.value = snapshot.datasetName || '本地草稿'
      showTrajectories.value = restoredFrames.length > 1
      ensureCategories([...snapshot.boxes, ...restoredFrames.flatMap((f) => f.boxes)])
      lastSavedAt.value = snapshot.savedAt
      saveState.value = 'saved'
      selectedId.value = null
      core.rebuildDocument()
      resetHistory()
      invalidateCloud()
      syncViewer()
      if (cloud.value) getViewer()?.focusOnCloud(cloud.value)
      const time = new Date(snapshot.savedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
      const lazyNote = lazyCount ? ` · ${lazyCount} 帧点云待解码（切帧时自动读取）` : ''
      statusText.value = `已恢复 ${time} 的本地草稿：${boxes.value.length} 个框${lazyNote}`
      return true
    } catch (err) {
      statusText.value = `草稿恢复失败：${(err as Error).message}`
      return false
    }
  }

  return {
    fileInput,
    semanticInput,
    importCount,
    loadDemo,
    loadSequence,
    loadRealData,
    loadSemanticDemo,
    importFiles,
    onSemanticFile,
    restore,
    restoreFromDocument,
    canSpillClouds,
    missingTrackCount,
    framesReloadable,
    canEvictFrames,
    forgetPersistedFrames,
    forgetAllPersistedFrames,
    persistedSnapshot,
  }
}

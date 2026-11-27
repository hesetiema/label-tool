/**
 * ============================================================
 * 多任务：占据派生 / 光流 / 跨任务一致性
 * ============================================================
 *
 * 【这一层只做四件事】
 *   1. 把 domain 的纯函数接到文档与 BlobStore 上；
 *   2. 每次改动都走一条 `setTaskPayload` 命令（可撤销、可审计）；
 *   3. 维护"当前帧渲染层"所需的最小缓存（不是整段都读进内存）；
 *   4. 把"生成了多少 / 还差多少 / 有哪些不一致"变成状态栏能说的话。
 *
 * 【为什么缓存要按引用失效，而不是按 docVersion 全清】
 *   撤销/重做会换回旧引用，缓存里那份是新引用对应的字节 —— 全清会让
 *   每次撤销都重新读一遍 IndexedDB（大样本上是几百毫秒的卡顿）。
 *   记录"帧号 → 引用"的对应关系，引用变了才丢，撤销回旧引用时正好命中。
 */
import { computed, ref, shallowRef, watch } from 'vue'
import type { StudioCore } from './studioCore'
import type { BlobStore } from '../ports/blobStore'
import type { Command } from '../domain/model/command'
import type { OccupancyGridSpec, OccupancyTaskData, FlowTaskData } from '../domain/model/document'
import type { QaIssue } from '../domain/model/issue'
import type { TrackId } from '../domain/model/ids'
import {
  carveFromTracks,
  defaultOccupancySpec,
  editOccupancy,
  encodeOccBundle,
  estimateGround,
  occStats,
  occupancySpecKey,
  worldToIndex,
  type GroundField,
  type OccStats,
  type OccupancyFrame,
} from '../domain/derive/occupancy'
import { estimateEgoMotion, flowSegments, type EgoMotion } from '../domain/derive/flow'
import { checkCrossTaskFrames, type CrossTaskInput } from '../domain/qa/crossTask'
import { buildTaskPayloadCommand } from '../domain/ops/taskPayload'
import { createDefaultRegistry } from '../domain/model/task'
import { getOccFrame, occFrameEntries, putOccFrame } from '../adapters/occupancyStore'

/** 一次最多派生多少帧：500 帧全量在浏览器里要几十秒，宁可分批也不要把页面卡死 */
const MAX_GENERATE_FRAMES = 200
/** 一致性校验一次最多读多少帧占据 */
const MAX_CHECK_FRAMES = 24
/** 光流箭头上限：再多也看不清，还会拖慢渲染 */
const MAX_FLOW_ARROWS = 1200

export interface TaskDeps {
  applyEdit: (cmd: Command) => void
  blobs: () => BlobStore | null
  say: (msg: string) => void
  gotoFrame: (frame: number) => void
}

export function useTasks(core: StudioCore, deps: TaskDeps) {
  const registry = createDefaultRegistry()

  /* ---------------- 任务清单与进度 ---------------- */

  const taskRows = computed(() => {
    // 读 docVersion 建立依赖：store 不是深层响应式，靠修订号触发
    void core.docVersion.value
    const doc = core.doc.value
    if (!doc) return []
    const issues = registry.validate(doc)
    return registry.progress(doc).map((row) => ({
      ...row,
      issues: issues.filter((i) => i.targets.some((t) => t.task === row.key)).length,
    }))
  })

  const taskIssues = computed(() => {
    void core.docVersion.value
    const doc = core.doc.value
    return doc ? registry.validate(doc) : []
  })

  /* ---------------- 占据 ---------------- */

  const occSpec = ref<OccupancyGridSpec | null>(null)
  const showOcc = ref(false)
  const occBusy = ref('')
  const occStatsNow = shallowRef<OccStats | null>(null)
  const occNote = ref('')
  const sliceLow = ref(-1)
  const sliceHigh = ref(5.4)

  /** 内存缓存：帧号 → 已解码的帧。上限跟着"当前帧 + 邻域"走，不整段读 */
  const occCache = new Map<number, OccupancyFrame>()
  /** 帧号 → 引用。引用变了说明内容被撤销/替换，缓存必须丢 */
  const occRefs = new Map<number, string>()
  const occLoaded = ref(0)

  const occTask = computed(() => {
    void core.docVersion.value
    return core.doc.value?.tasks.occupancy
  })
  const occEntries = computed(() => occFrameEntries(occTask.value))
  const occCoverage = computed(() => {
    const doc = core.doc.value
    if (!doc) return 0
    const span = Math.max(0, doc.range[1] - doc.range[0] + 1)
    return span ? occEntries.value.length / span : 0
  })

  function frameCloud(frame: number) {
    const idx = core.frames.value.findIndex((f) => f.index === frame)
    if (idx < 0) return null
    const cloud = core.frames.value[idx].cloud
    return cloud && cloud.count > 0 ? cloud : null
  }

  function currentFrameNumber(): number {
    return core.frameNumber()
  }

  /** 清空缓存并让渲染层跟着清 —— 换样本、清占据都调它 */
  function resetOccCache(): void {
    occCache.clear()
    occRefs.clear()
    occLoaded.value = 0
    occStatsNow.value = null
    core.occLayer.value = null
    core.occSlice.value = null
  }

  /**
   * 让"当前帧"的占据层与统计跟上文档。
   * 只在"显示占据"打开时读 blob：关着的时候读进来纯属浪费。
   */
  async function refreshCurrentOcc(): Promise<void> {
    const blobs = deps.blobs()
    const spec = occSpec.value ?? occTask.value?.spec ?? null
    const frame = currentFrameNumber()
    if (!showOcc.value || !blobs || !spec) {
      core.occLayer.value = null
      occStatsNow.value = null
      return
    }
    const entry = occEntries.value.find((e) => e.frame === frame)
    if (!entry) {
      core.occLayer.value = null
      occStatsNow.value = null
      occNote.value = `第 ${frame} 帧没有占据（覆盖 ${occEntries.value.length} 帧）`
      return
    }
    // 引用变了就丢缓存：撤销后旧引用回来，这里不会命中"新内容"的旧副本
    const cachedRef = occRefs.get(frame)
    if (cachedRef && cachedRef !== entry.ref) occCache.delete(frame)
    occRefs.set(frame, entry.ref)

    let occ = occCache.get(frame)
    if (!occ) {
      try {
        occ = await getOccFrame(blobs, entry.ref)
        occCache.set(frame, occ)
        occLoaded.value = occCache.size
      } catch (err) {
        occNote.value = `第 ${frame} 帧占据读取失败：${(err as Error).message}`
        core.occLayer.value = null
        return
      }
    }
    occSpec.value = spec
    core.occLayer.value = { ...spec, occupied: occ.occupied, labels: occ.labels }
    core.occSlice.value = [sliceLow.value, sliceHigh.value]
    // 帧的 spec 指纹与当前 spec 不一致时统计仍按当前 spec 解释下标 ——
    // 两套网格混用本来就是错的，`validate` 会在任务面板报出来，这里不静默修正
    occStatsNow.value = occStats(occ, spec)
    occNote.value = ''
    core.syncViewer()
  }

  /** 规格来自类别表：类别顺序决定 labels 下标，必须与生成时一致 */
  function buildSpec(): OccupancyGridSpec {
    // 只放标注类别。地面**不**进类别表 —— 占据训练里地面是 free，
    // 把它写成 occupied 会让"占用"这个标签本身失去意义（见 docs 26.5）
    return defaultOccupancySpec(core.categories.value.map((c) => c.name))
  }

  async function generateOccupancy(scope: 'frame' | 'all'): Promise<void> {
    const blobs = deps.blobs()
    const doc = core.doc.value
    const store = core.store.value
    if (!blobs || !doc || !store) {
      deps.say('当前环境不支持大载荷落盘，占据无法生成')
      return
    }
    if (!store.tracks.length) {
      deps.say('还没有轨迹：占据由框派生，先标注或用预标注跑一批')
      return
    }
    if (occBusy.value) return

    const targets =
      scope === 'frame'
        ? [currentFrameNumber()]
        : core.frames.value.length
          ? core.frames.value.slice(0, MAX_GENERATE_FRAMES).map((f) => f.index)
          : [currentFrameNumber()]
    if (!targets.length) {
      deps.say('没有可用的帧')
      return
    }

    occBusy.value = `生成占据 0/${targets.length}`
    const t0 = performance.now()
    const entries: Array<{ frame: number; ref: string }> = []
    const spec = buildSpec()
    let groundFrames = 0
    let overlap = 0
    let skipped = 0

    try {
      for (let i = 0; i < targets.length; i++) {
        const frame = targets[i]
        const cloud = frameCloud(frame)
        let ground: GroundField | null = null
        if (cloud) {
          ground = estimateGround(cloud)
          if (ground.observed > 0) groundFrames++
          else ground = null
        }
        const result = carveFromTracks(store.tracks, frame, spec, {
          mode: ground ? 'box+ground' : 'box-only',
          ground,
          // 地面只用来剪掉框底以下的体素，不写成占据体素：
          // 占据的标准口径里地面是 free，写成 occupied 等于把标签本身搞错
          groundClass: null,
          source: { kind: 'derived' },
        })
        overlap += result.overlapVoxels
        skipped += result.skipped.length
        const ref = await putOccFrame(blobs, result.frame)
        entries.push({ frame, ref })
        occRefs.set(frame, ref)
        occCache.set(frame, result.frame)
        occBusy.value = `生成占据 ${i + 1}/${targets.length}`
      }

      // 只重算这一帧时，其余帧必须保留 —— 否则"生成本帧"会静默清掉全段，
      // 用户还以为只是刷新了当前帧。网格换了（类别表变了）才整段替换，
      // 因为不同网格的帧混在一份载荷里，读的人没有任何办法分辨。
      const before = occTask.value ?? null
      const sameSpec = !!before?.spec && occupancySpecKey(before.spec) === occupancySpecKey(spec)
      const replaced = new Set(entries.map((e) => e.frame))
      const kept = sameSpec ? (before?.frames ?? []).filter((e) => !replaced.has(e.frame)) : []
      const merged = [...kept, ...entries].sort((a, b) => a.frame - b.frame)
      const payload: OccupancyTaskData = {
        spec,
        frames: merged,
        source: { kind: 'derived' },
      }
      occSpec.value = spec
      deps.applyEdit(
        buildTaskPayloadCommand({
          task: 'occupancy',
          before,
          after: payload,
          label: `生成占据（${entries.length} 帧${groundFrames ? '，含地面剪裁' : ''}）`,
        }),
      )
      const ms = Math.round(performance.now() - t0)
      deps.say(
        `占据已生成：${entries.length} 帧 / ${ms}ms（${Math.round(ms / entries.length)}ms/帧）` +
          `${groundFrames ? `，${groundFrames} 帧剪掉地面以下体素` : ''}` +
          `${kept.length ? `，保留其余 ${kept.length} 帧` : ''}` +
          `${overlap ? `，${overlap} 个体素被多框覆盖` : ''}${skipped ? `，${skipped} 条轨迹跳过` : ''}`,
      )
      showOcc.value = true
      await refreshCurrentOcc()
    } catch (err) {
      deps.say(`占据生成失败：${(err as Error).message}`)
    } finally {
      occBusy.value = ''
    }
  }

  async function clearOccupancy(): Promise<void> {
    const doc = core.doc.value
    const before = doc?.tasks.occupancy
    if (!before) {
      deps.say('当前样本没有占据')
      return
    }
    deps.applyEdit(
      buildTaskPayloadCommand({
        task: 'occupancy',
        before,
        after: null,
        label: '清除占据',
      }),
    )
    resetOccCache()
    showOcc.value = false
    core.syncViewer()
    deps.say('占据已清除（可撤销）')
  }

  /**
   * ROI 编辑：光标处补一格 / 删一格。
   *
   * 【为什么用光标而不是三维笔刷】三维笔刷要处理相机投影、穿模、拖拽轨迹，
   * 是另一个交互子系统；而"单格增删 + 可撤销"已经能回答最常见的问题：
   * 这辆车底下多了一层、那面墙缺了一角。批量笔刷留到占据编辑器成型时再做。
   */
  async function paintVoxel(action: 'add' | 'remove', classId?: string): Promise<void> {
    const blobs = deps.blobs()
    const doc = core.doc.value
    const spec = occSpec.value ?? doc?.tasks.occupancy?.spec ?? null
    if (!blobs || !doc || !spec) {
      deps.say('还没有占据：先点「生成本帧」')
      return
    }
    const cursor = core.cursor.value
    if (!cursor) {
      deps.say('光标不在点云上：把鼠标移到点云再试')
      return
    }
    const frame = currentFrameNumber()
    const entry = occEntries.value.find((e) => e.frame === frame)
    if (!entry) {
      deps.say(`第 ${frame} 帧没有占据`)
      return
    }
    const index = worldToIndex(spec, cursor)
    if (index < 0) {
      deps.say('光标不在占据网格范围内')
      return
    }
    const label = classId ?? core.selectedBox.value?.label ?? spec.classIds[0] ?? 'Car'
    const labelIdx = spec.classIds.indexOf(label)
    if (action === 'add' && labelIdx < 0) {
      deps.say(`类别 ${label} 不在占据类别表里（重新生成占据即可带上）`)
      return
    }

    const occ = occCache.get(frame) ?? (await getOccFrame(blobs, entry.ref))
    const beforeRef = entry.ref
    const next = editOccupancy(occ, spec, [{ index, label: action === 'add' ? labelIdx : null }])
    const ref = await putOccFrame(blobs, next)

    const payload: OccupancyTaskData = {
      ...(doc.tasks.occupancy as OccupancyTaskData),
      spec,
      frames: occEntries.value.map((e) => (e.frame === frame ? { frame, ref } : e)),
    }
    deps.applyEdit(
      buildTaskPayloadCommand({
        task: 'occupancy',
        before: doc.tasks.occupancy ?? null,
        after: payload,
        label: `${action === 'add' ? '补' : '删'}占据体素（第 ${frame} 帧）`,
      }),
    )

    occCache.set(frame, next)
    occRefs.set(frame, ref)
    if (beforeRef !== ref) occLoaded.value = occCache.size
    await refreshCurrentOcc()
    deps.say(`${action === 'add' ? '已补' : '已删'}一格（${label}）· 第 ${frame} 帧 · 可撤销`)
  }

  function toggleOcc(): void {
    showOcc.value = !showOcc.value
    if (showOcc.value) {
      // 首次打开：默认显示全高，否则用户会看到"占据了但没有画面"
      const spec = occSpec.value ?? occTask.value?.spec ?? null
      sliceLow.value = spec?.origin.z ?? -1
      sliceHigh.value = sliceLow.value + (spec ? spec.size.z * spec.resolution : 6.4)
      void refreshCurrentOcc()
    } else {
      core.occLayer.value = null
      occStatsNow.value = null
      core.syncViewer()
    }
  }

  function setSlice(low: number, high: number): void {
    sliceLow.value = low
    sliceHigh.value = Math.max(low + 0.4, high)
    core.occSlice.value = [sliceLow.value, sliceHigh.value]
    core.syncViewer()
  }

  /* ---------------- 光流 / 自车运动 ---------------- */

  const ego = shallowRef<EgoMotion | null>(null)
  const showFlow = ref(false)
  const flowNote = ref('')

  const egoRecord = computed(() => {
    void core.docVersion.value
    const frame = currentFrameNumber()
    return core.doc.value?.tasks.flow?.ego?.find((e) => e.frame === frame) ?? null
  })

  /**
   * 估计"上一帧 → 当前帧"的自车运动并落盘。
   *
   * 落盘的是**估计值**，不是真值：没有位姿的数据集本来就没有真值可落。
   * 所以同时落 `rmse`，让下游知道这一次估得靠不靠谱（>0.2m 时规则会提示）。
   */
  async function estimateEgo(): Promise<void> {
    if (occBusy.value) return
    const doc = core.doc.value
    if (!doc) return
    const frame = currentFrameNumber()
    const prev = core.frames.value.find((f) => f.index === frame - 1)
    const cur = core.frames.value.find((f) => f.index === frame)
    if (!prev?.cloud.count || !cur?.cloud.count) {
      deps.say('估计自车运动需要当前帧与上一帧的点云都在内存里')
      return
    }
    occBusy.value = '估计自车运动…'
    try {
      const m = estimateEgoMotion(prev.cloud, cur.cloud)
      if (m.samples < 20 || m.inliers < 10) {
        flowNote.value = `地面点太少（采样 ${m.samples} / 内点 ${m.inliers}）`
        deps.say(`自车运动估计不可用：${flowNote.value}`)
        return
      }
      ego.value = m
      const entry = { frame, dx: m.dx, dy: m.dy, dyaw: m.dyaw, rmse: m.rmse }
      const before: FlowTaskData | undefined = doc.tasks.flow
      const rest = (before?.ego ?? []).filter((e) => e.frame !== frame)
      const payload: FlowTaskData = {
        ...(before ?? {}),
        ego: [...rest, entry].sort((a, b) => a.frame - b.frame),
        source: { kind: 'derived' },
      }
      deps.applyEdit(
        buildTaskPayloadCommand({
          task: 'flow',
          before: before ?? null,
          after: payload,
          label: `估计自车运动（第 ${frame} 帧）`,
        }),
      )
      const warn = m.rmse > 0.2 ? '（残差偏大，仅参考）' : ''
      deps.say(
        `自车运动：dx ${m.dx.toFixed(2)}m · dy ${m.dy.toFixed(2)}m · dyaw ${((m.dyaw * 180) / Math.PI).toFixed(1)}° · 内点 ${m.inliers}/${m.samples} · rmse ${m.rmse.toFixed(3)}m${warn}`,
      )
      flowNote.value = `${m.inliers}/${m.samples} 内点 · rmse ${m.rmse.toFixed(3)}m`
    } finally {
      occBusy.value = ''
    }
  }

  function insideBox(
    g: { position: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number }; yaw: number },
    x: number,
    y: number,
    z: number,
  ): boolean {
    const dx = x - g.position.x
    const dy = y - g.position.y
    const dz = z - g.position.z
    const c = Math.cos(g.yaw)
    const s = Math.sin(g.yaw)
    const lx = dx * c + dy * s
    const ly = -dx * s + dy * c
    return Math.abs(lx) <= g.scale.x / 2 && Math.abs(ly) <= g.scale.y / 2 && Math.abs(dz) <= g.scale.z / 2
  }

  /**
   * 生成箭头段：**上一帧框内的点 → 按刚体变换预测的位置**。
   *
   * 方向必须是"上一帧的观测点往前推"，不能拿当前帧的点算 ——
   * 当前帧的点本来就在当前位置，刚体变换把它映射回自己，箭头长度恒为 0。
   */
  function buildFlowSegments(): Float32Array | null {
    const store = core.store.value
    const frame = currentFrameNumber()
    const prev = core.frames.value.find((f) => f.index === frame - 1)
    if (!store || !prev?.cloud.count) return null
    const curBoxes = store.materialize(frame, { mode: 'linear' })
    const prevBoxes = new Map(store.materialize(frame - 1, { mode: 'linear' }).map((b) => [b.trackId, b]))
    const chunks: Float32Array[] = []
    let count = 0
    for (const box of curBoxes) {
      const before = prevBoxes.get(box.trackId)
      if (!before) continue
      const positions = prev.cloud.positions
      const inside: number[] = []
      const stride = Math.max(1, Math.floor(prev.cloud.count / 4000))
      for (let i = 0; i < prev.cloud.count && inside.length < 120; i += stride) {
        if (insideBox(before, positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])) inside.push(i)
      }
      if (!inside.length) continue
      // 传 indices：箭头必须从"框内那些点"出发，不能从整帧抽样的点出发
      chunks.push(flowSegments(positions, before, box, { indices: inside, maxArrows: inside.length }))
      count += inside.length
      if (count >= MAX_FLOW_ARROWS) break
    }
    if (!chunks.length) return null
    const total = chunks.reduce((n, c) => n + c.length, 0)
    const out = new Float32Array(total)
    let at = 0
    for (const c of chunks) {
      out.set(c, at)
      at += c.length
    }
    return out
  }

  function toggleFlow(): void {
    showFlow.value = !showFlow.value
    if (!showFlow.value) {
      core.flowSegments.value = null
      core.syncViewer()
      return
    }
    const seg = buildFlowSegments()
    if (!seg) {
      showFlow.value = false
      deps.say('光流箭头需要上一帧与当前帧的点云、且两帧都有框')
      return
    }
    core.flowSegments.value = seg
    core.syncViewer()
    deps.say(`光流箭头：${seg.length / 6} 支（上一帧框内点 → 刚体预测位置）`)
  }

  /* ---------------- 跨任务一致性 ---------------- */

  const issues = ref<QaIssue[]>([])
  const checkBusy = ref(false)
  const lastCheck = ref<{ checked: number; framesWithIssues: number } | null>(null)

  async function runCrossCheck(scope: 'current' | 'all' = 'current'): Promise<void> {
    const blobs = deps.blobs()
    const doc = core.doc.value
    const store = core.store.value
    if (!blobs || !doc || !store) return
    if (!occTask.value?.frames?.length) {
      deps.say('还没有占据：一致性校验需要占据与框两份真值')
      return
    }
    if (checkBusy.value) return
    checkBusy.value = true
    try {
      const spec = occTask.value.spec
      const trackIds = store.tracks.map((t) => t.id as TrackId)
      const entries =
        scope === 'current'
          ? occEntries.value.filter((e) => e.frame === currentFrameNumber())
          : occEntries.value.slice(0, MAX_CHECK_FRAMES)
      const inputs: CrossTaskInput[] = []
      for (const entry of entries) {
        let occ = occCache.get(entry.frame)
        if (!occ) {
          occ = await getOccFrame(blobs, entry.ref)
          occCache.set(entry.frame, occ)
        }
        inputs.push({
          frame: entry.frame,
          boxes: store.materialize(entry.frame, { mode: 'linear' }).map((b) => ({
            id: b.trackId,
            label: b.label,
            position: b.position,
            scale: b.scale,
            yaw: b.yaw,
          })),
          spec: spec ?? null,
          occ,
          instanceMap: doc.tasks.semantic?.instanceMap ?? null,
          trackIds,
        })
      }
      const result = checkCrossTaskFrames(inputs)
      issues.value = result.issues
      lastCheck.value = { checked: result.checked, framesWithIssues: result.framesWithIssues }
      occLoaded.value = occCache.size
      const byCode = new Map<string, number>()
      for (const i of result.issues) byCode.set(i.code, (byCode.get(i.code) ?? 0) + 1)
      const detail = [...byCode].map(([c, n]) => `${c}×${n}`).join('、')
      deps.say(
        result.issues.length
          ? `一致性校验：${result.checked} 帧里 ${result.issues.length} 个问题（${detail}）`
          : `一致性校验通过：${result.checked} 帧无明显冲突`,
      )
    } catch (err) {
      deps.say(`校验失败：${(err as Error).message}`)
    } finally {
      checkBusy.value = false
    }
  }

  function gotoIssue(issue: QaIssue): void {
    const target = issue.targets.find((t) => t.frame !== undefined)
    if (target?.frame === undefined) return
    deps.gotoFrame(target.frame)
  }

  /* ---------------- 导出 ---------------- */

  function download(name: string, body: ArrayBuffer | string, mime: string): void {
    const blob = new Blob([body], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    URL.revokeObjectURL(url)
  }

  async function exportOccupancy(): Promise<void> {
    const blobs = deps.blobs()
    const doc = core.doc.value
    const task = occTask.value
    if (!blobs || !doc || !task?.spec || !task.frames?.length) {
      deps.say('还没有占据可导出')
      return
    }
    const frames: OccupancyFrame[] = []
    for (const entry of occEntries.value) {
      let occ = occCache.get(entry.frame)
      if (!occ) {
        occ = await getOccFrame(blobs, entry.ref)
        occCache.set(entry.frame, occ)
      }
      frames.push(occ)
    }
    const base = (core.datasetName.value || 'sample').replace(/[^\w\u4e00-\u9fa5-]+/g, '_')
    download(`${base}-occupancy.occ`, encodeOccBundle(task.spec, frames), 'application/octet-stream')
    download(`${base}-occupancy-spec.json`, JSON.stringify(task.spec, null, 2), 'application/json')
    deps.say(`已导出 ${frames.length} 帧占据（.occ + spec.json，scripts/occ2npz.py 可转 npz）`)
  }

  /* ---------------- 跟随文档 / 帧 ---------------- */

  watch(currentFrameNumber, () => {
    if (showOcc.value) void refreshCurrentOcc()
  })
  watch(
    () => core.docVersion.value,
    () => {
      const spec = occTask.value?.spec ?? null
      if (spec) occSpec.value = spec
      // 引用变了才丢缓存（撤销/重做会换回来）
      for (const entry of occEntries.value) {
        const ref = occRefs.get(entry.frame)
        if (ref && ref !== entry.ref) occCache.delete(entry.frame)
        occRefs.set(entry.frame, entry.ref)
      }
      if (showOcc.value) void refreshCurrentOcc()
    },
  )
  watch(
    () => core.doc.value?.sampleId ?? '',
    () => {
      resetOccCache()
      issues.value = []
      lastCheck.value = null
      ego.value = null
      showFlow.value = false
      core.flowSegments.value = null
      occSpec.value = occTask.value?.spec ?? null
    },
  )

  return {
    // 任务
    taskRows,
    taskIssues,
    registry,
    // 占据
    occSpec,
    occEntries,
    occCoverage,
    occStatsNow,
    occNote,
    occBusy,
    showOcc,
    toggleOcc,
    sliceLow,
    sliceHigh,
    setSlice,
    generateOccupancy,
    clearOccupancy,
    paintVoxel,
    refreshCurrentOcc,
    // 光流
    ego,
    egoRecord,
    showFlow,
    toggleFlow,
    estimateEgo,
    flowNote,
    // 一致性
    issues,
    checkBusy,
    lastCheck,
    runCrossCheck,
    gotoIssue,
    // 导出
    exportOccupancy,
  }
}

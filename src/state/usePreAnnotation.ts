/**
 * ============================================================
 * 预标注 —— 跑模型、并进文档、逐条复核
 * ============================================================
 *
 * 三层职责分得很清：
 *   ports/preAnnotation    协议（流式、可中断）
 *   domain/ops/mergePreLabel 身份关联 + 四种合并策略（纯函数）
 *   domain/ops/review      复核队列、裁决命令、导出闸门（纯函数）
 * 这里只做"接线"：拿 provider 跑、把结果变成命令、把状态栏与面板填上。
 *
 * 【为什么合并结果一定要走 exec 而不是直接改 doc】
 *   合并是"一次能改几百帧"的重操作，用户最需要 Ctrl+Z 能整批退回。
 *   走命令栈之后，撤销、自动保存、脏标记、增量刷新全部自动成立。
 *
 * 【为什么状态栏要报"跳过了几个框"】
 *   合并是**有损**的：低置信被滤掉、填充模式撞上已有框、冲突帧不覆盖。
 *   只报"新增 N 条"会让用户以为全都进来了，回头发现漏检又无从查起。
 */
import { ref } from 'vue'
import type { Command } from '../domain/model/command'
import type { SampleDocument } from '../domain/model/document'
import type { TrackId } from '../domain/model/ids'
import {
  buildMergeCommand, defaultMergePolicy, linkProposals,
  type MergePolicy, type MergeResult, type MergeStrategy, type ModelObject,
} from '../domain/ops/mergePreLabel'
import { buildReviewCommandFor, collectReviewRows, reviewStats as statsOf, type ReviewRow } from '../domain/ops/review'
import type { PreAnnotationProvider } from '../ports/preAnnotation'
import { createMockProvider } from '../adapters/preAnnotate/mockProvider'
import { createFileProvider } from '../adapters/preAnnotate/fileProvider'
import { createHttpProvider } from '../adapters/preAnnotate/httpProvider'
import type { PointCloud } from '../core/types'

export interface PreAnnotationDeps {
  doc: () => SampleDocument | null
  range: () => [number, number]
  totalFrames: () => number
  currentFrame: () => number
  nextTrackId: (used: ReadonlySet<TrackId>) => TrackId
  /**
   * 执行命令并完成刷新（refreshFrameBoxes / materialize / syncViewer / markDirty）。
   * 由装配层提供，保证与其它编辑入口走完全相同的收尾。
   */
  applyEdit: (cmd: Command) => void
  gotoFrame: (frame: number) => void
  selectTrack: (id: string) => void
  cloud: () => PointCloud | null
  say: (msg: string) => void
}

const STRATEGY_LABEL: Record<MergeStrategy, string> = {
  append: '全部作为待复核',
  'fill-gaps': '只补空缺帧',
  'replace-track': '命中则替换轨迹',
  'class-vote': '按 IoU 投票改类别',
}

export function strategyLabel(s: MergeStrategy): string {
  return STRATEGY_LABEL[s]
}

export function usePreAnnotation(deps: PreAnnotationDeps) {
  /** 复核面板是否打开。打开时 A/X/Tab 归复核用，不再触发平移/缩放 */
  const reviewOpen = ref(false)
  const reviewRows = ref<ReviewRow[]>([])
  const reviewStats = ref({ tracks: 0, frames: 0, conflicts: 0, accepted: 0, rejected: 0, modelFrames: 0 })
  const selectedTrackId = ref<string>('')

  const policy = ref<MergePolicy>(defaultMergePolicy())
  const running = ref(false)
  const progress = ref(0)
  const lastError = ref('')
  const lastModel = ref('')
  const lastResult = ref<MergeResult | null>(null)
  /** 运行途中收到的帧数 / 目标数，用于进度文案与"取消后保留"的说明 */
  const received = ref({ frames: 0, objects: 0 })
  let controller: AbortController | null = null
  let activeProvider: PreAnnotationProvider | null = null

  function refresh(): void {
    const doc = deps.doc()
    reviewRows.value = doc ? collectReviewRows(doc) : []
    reviewStats.value = doc ? statsOf(doc) : { tracks: 0, frames: 0, conflicts: 0, accepted: 0, rejected: 0, modelFrames: 0 }
    if (selectedTrackId.value && !reviewRows.value.some((r) => r.trackId === selectedTrackId.value)) {
      selectedTrackId.value = reviewRows.value[0]?.trackId ?? ''
    }
  }

  function openReview(): void {
    refresh()
    reviewOpen.value = true
    if (!selectedTrackId.value) selectedTrackId.value = reviewRows.value[0]?.trackId ?? ''
    deps.say(reviewRows.value.length
      ? `复核队列：${reviewStats.value.tracks} 条轨迹 / ${reviewStats.value.frames} 帧待裁决（低置信在前，A 接受 · X 拒绝 · Tab 下一处）`
      : '复核队列为空：没有待裁决的模型产出')
  }

  function closeReview(): void {
    reviewOpen.value = false
  }

  /** 点云包围盒（抽样，百万点也只扫 2000 个）：让 mock 的框落在数据里而不是漂在空中 */
  function cloudBounds(): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null {
    const cloud = deps.cloud()
    if (!cloud || cloud.count < 8) return null
    const step = Math.max(1, Math.floor(cloud.count / 2000))
    const p = cloud.positions
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    for (let i = 0; i < cloud.count; i += step) {
      const o = i * 3
      const x = p[o], y = p[o + 1], z = p[o + 2]
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null
    return { min: { x: minX, y: minY, z: minZ }, max: { x: maxX, y: maxY, z: maxZ } }
  }

  function mockProvider(): PreAnnotationProvider {
    const bounds = cloudBounds()
    return createMockProvider({
      // 演示场景是 5 帧；每帧 4 个目标 × 5 帧 = 20 个观测，
      // 链成 4 条轨迹 —— 刚好够看出"跨帧身份"与"复核队列"
      perFrame: 4,
      ...(bounds ? { bounds } : {}),
    })
  }

  /** 把 provider 的逐帧结果收成提案并合入文档 */
  async function runProvider(provider: PreAnnotationProvider, sourceLabel: string): Promise<void> {
    if (running.value) return
    const doc = deps.doc()
    if (!doc) {
      deps.say('还没有可标注的样本：先加载数据再跑预标注')
      return
    }
    const [from, to] = deps.range()
    if (to < from) {
      deps.say('当前样本没有帧范围，无法预标注')
      return
    }

    running.value = true
    lastError.value = ''
    lastResult.value = null
    progress.value = 0
    received.value = { frames: 0, objects: 0 }
    controller = new AbortController()
    activeProvider = provider
    const objects: ModelObject[] = []
    deps.say(`${sourceLabel}：正在推理第 ${from}–${to} 帧…`)

    try {
      for await (const chunk of provider.run(
        {
          sampleId: doc.sampleId,
          frameRange: [from, to],
          sensors: ['lidar'],
          hints: { scoreThreshold: policy.value.minConfidence },
        },
        controller.signal,
      )) {
        received.value = {
          frames: received.value.frames + 1,
          objects: received.value.objects + chunk.objects.length,
        }
        progress.value = chunk.progress
        lastModel.value = `${chunk.model.id} ${chunk.model.version}`.trim()
        for (const o of chunk.objects) objects.push({ ...o, frame: chunk.frame, model: { ...chunk.model } })
        if (received.value.frames % 5 === 0) {
          deps.say(`${sourceLabel}：${Math.round(chunk.progress * 100)}%（已收 ${received.value.objects} 个框）`)
        }
      }
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError'
      running.value = false
      controller = null
      activeProvider = null
      if (aborted) {
        // 中断时**不合并**：半批结果的轨迹会是断头路，比没有更难收拾
        deps.say(`预标注已取消：收到 ${received.value.objects} 个框但未合并（半批轨迹会造成断头，宁可不要）`)
      } else {
        lastError.value = (err as Error)?.message ?? String(err)
        deps.say(`预标注失败：${lastError.value}`)
      }
      return
    }

    running.value = false
    controller = null
    activeProvider = null
    progress.value = 1

    const proposals = linkProposals(objects, { classMustMatch: policy.value.classMustMatch })
    const plan = buildMergeCommand(doc, proposals, policy.value, (used) => deps.nextTrackId(used))
    if (plan.command) deps.applyEdit(plan.command)
    lastResult.value = plan.result
    refresh()

    const r = plan.result
    const parts: string[] = []
    if (r.created.length) parts.push(`新增 ${r.created.length} 条待复核轨迹`)
    if (r.updated.length) parts.push(`更新 ${r.updated.length} 条`)
    if (r.conflicts.length) parts.push(`冲突 ${r.conflicts.length} 处（已保留人工框）`)
    if (r.skipped) parts.push(`跳过 ${r.skipped} 个框（低置信 / 已有标注 / 冲突帧）`)

    // 顺序：先开面板（它自己有文案），再用合并摘要覆盖。
    // 反过来的话，用户只看到"队列里有 N 条"，看不到这次到底新增/冲突了多少 ——
    // 而后者才是"要不要现在复核"的判断依据
    const hasQueue = reviewRows.value.length > 0
    if (hasQueue) openReview()
    const tail = hasQueue
      ? `；${reviewStats.value.tracks} 条待裁决（A 接受 / X 拒绝 / Tab 下一处）`
      : ''
    deps.say(parts.length
      ? `预标注完成：${received.value.objects} 个框 → ${proposals.length} 条提案，${parts.join('，')}（Ctrl+Z 可整批退回）${tail}`
      : '预标注完成：没有可合入的框（全部被策略跳过）')
  }

  async function runMock(): Promise<void> {
    await runProvider(mockProvider(), '演示模型')
  }

  async function runHttp(url: string): Promise<void> {
    await runProvider(createHttpProvider({ url }), '推理服务')
  }

  /**
   * 导入离线结果。文件读失败/格式不对都在这里兜住 ——
   * 让调用方（菜单）只负责选文件，不必再写一层 try/catch。
   */
  async function importFile(file: File): Promise<void> {
    try {
      const text = await file.text()
      const payload = JSON.parse(text)
      const provider = createFileProvider(payload, { name: file.name })
      await runProvider(provider, `离线结果 ${file.name}`)
    } catch (err) {
      lastError.value = (err as Error)?.message ?? String(err)
      deps.say(`导入预标注失败：${lastError.value}`)
    }
  }

  function cancel(): void {
    controller?.abort()
    if (!running.value) deps.say('当前没有正在跑的预标注')
  }

  // ---- 复核 ----

  function rowIds(all: boolean): string[] {
    if (all) return reviewRows.value.map((r) => r.trackId)
    return selectedTrackId.value ? [selectedTrackId.value] : []
  }

  function decide(decision: 'accepted' | 'rejected', all: boolean, frame?: number): void {
    const doc = deps.doc()
    if (!doc) return
    const ids = rowIds(all)
    if (!ids.length) {
      deps.say('复核队列里没有可裁决的对象')
      return
    }
    const cmd = buildReviewCommandFor(doc, ids, decision, frame)
    if (!cmd) {
      deps.say('这些对象已经裁决过了')
      refresh()
      return
    }
    deps.applyEdit(cmd)
    refresh()
    const verb = decision === 'accepted' ? '已接受' : '已拒绝'
    deps.say(`${verb} ${ids.length} 条（${cmd.meta.label}）· 剩余 ${reviewStats.value.tracks} 条待裁决`)
  }

  const acceptSelected = () => decide('accepted', false)
  const rejectSelected = () => decide('rejected', false)
  const acceptAll = () => decide('accepted', true)
  const rejectAll = () => decide('rejected', true)

  /** 单行裁决（复核面板里每行的按钮）：不改变当前选中，只裁这一条 */
  function decideRow(id: string, decision: 'accepted' | 'rejected'): void {
    const doc = deps.doc()
    if (!doc) return
    const cmd = buildReviewCommandFor(doc, [id], decision)
    if (!cmd) {
      refresh()
      return
    }
    deps.applyEdit(cmd)
    refresh()
    deps.say(`${decision === 'accepted' ? '已接受' : '已拒绝'} #${id} · 剩余 ${reviewStats.value.tracks} 条待裁决`)
  }

  /** 接受当前帧上的待复核对象（Shift+A 的语义） */
  function acceptInFrame(): void {
    const frame = deps.currentFrame()
    const doc = deps.doc()
    if (!doc) return
    const ids = reviewRows.value.filter((r) => r.frames.includes(frame)).map((r) => r.trackId)
    if (!ids.length) {
      deps.say(`第 ${frame} 帧没有待复核的模型框`)
      return
    }
    const cmd = buildReviewCommandFor(doc, ids, 'accepted', frame)
    if (!cmd) return
    deps.applyEdit(cmd)
    refresh()
    deps.say(`第 ${frame} 帧已接受 ${ids.length} 条模型框 · 剩余 ${reviewStats.value.tracks} 条待裁决`)
  }

  function selectRow(id: string): void {
    selectedTrackId.value = id
    const row = reviewRows.value.find((r) => r.trackId === id)
    if (row) deps.gotoFrame(row.frames[0])
    deps.selectTrack(id)
  }

  /** 跳到下一处待裁决（Tab）。队列按"冲突优先、低置信在前"排序，天然是处理顺序 */
  function nextPending(): void {
    if (!reviewRows.value.length) {
      deps.say('没有待裁决的对象')
      return
    }
    const i = reviewRows.value.findIndex((r) => r.trackId === selectedTrackId.value)
    const next = reviewRows.value[(i + 1) % reviewRows.value.length]
    selectRow(next.trackId)
  }

  function firstPending(): void {
    const row = reviewRows.value[0]
    if (row) selectRow(row.trackId)
  }

  /**
   * 复核模式下的快捷键。
   *
   * 【为什么只在面板打开时生效】`A` 平时是"沿 +y 平移"、`Tab` 是"切换选中"。
   * 只在复核模式抢这两个键，等于把冲突面压到 0：关了面板，键位与以前完全一样。
   * 返回 true 表示已消费，调用方不要再走常规处理。
   */
  function handleKey(e: KeyboardEvent): boolean {
    if (!reviewOpen.value) return false
    if (e.ctrlKey || e.metaKey || e.altKey) return false
    const key = e.key.toLowerCase()
    if (key === 'a' && e.shiftKey) { acceptInFrame(); return true }
    if (key === 'a') { acceptSelected(); return true }
    if (key === 'x') { rejectSelected(); return true }
    if (key === 'tab') { e.preventDefault(); nextPending(); return true }
    if (key === 'escape') { closeReview(); return true }
    return false
  }

  function setStrategy(next: MergeStrategy): void {
    policy.value = { ...policy.value, strategy: next }
    deps.say(`合并策略：${STRATEGY_LABEL[next]}`)
  }

  function setMinConfidence(next: number): void {
    policy.value = { ...policy.value, minConfidence: Math.min(0.99, Math.max(0, next)) }
  }

  function setPolicy(patch: Partial<MergePolicy>): void {
    policy.value = { ...policy.value, ...patch }
  }

  return {
    reviewOpen, reviewRows, reviewStats, selectedTrackId, policy, running, progress, lastError, lastModel, lastResult, received,
    activeProviderId: () => activeProvider?.id ?? '',
    openReview, closeReview, refresh,
    runMock, runHttp, importFile, cancel,
    acceptSelected, rejectSelected, acceptAll, rejectAll, acceptInFrame, decideRow,
    selectRow, nextPending, firstPending, handleKey,
    setStrategy, setMinConfidence, setPolicy, strategyLabel,
  }
}

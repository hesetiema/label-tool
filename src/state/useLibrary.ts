/**
 * ============================================================
 * 样本列表 —— 本地落盘文档的浏览与删除
 * ============================================================
 *
 * 这一层只做四件事：读列表、判定能不能删、删、删完收尾。
 * 所有"该不该删"的判断都在 `domain/store/library.ts`（纯函数，可单测），
 * 这里只负责把它接到存储与界面之间。
 *
 * 【为什么单独一个 composable 而不是塞进 useStudio】
 *   useStudio 已经 600 行，且职责是"装配 + 生命周期"。样本列表是**低频、
 *   独立、可以整体卸载**的功能（弹层关掉就不需要任何状态）。
 *   单独成文件之后，这段代码的依赖是显式声明的四条，而不是整个 core。
 */
import { ref } from 'vue'
import { studioStore } from '../adapters/studioStore'
import { formatBytes } from '../adapters/studioGc'
import { clearDraftPointer, loadDraftPointer } from '../core/io/session'
import {
  decorateLibrary, judgeRemove, librarySummary, type LibraryEntry, type LibraryRow,
} from '../domain/store/library'

export interface LibraryDeps {
  /** 当前正在编辑的 sampleId（可能为空：还没保存过） */
  currentSampleId: () => string
  /** 别的标签页正持有该样本租约时返回对方 id，否则 null */
  heldByOtherTab: (sampleId: string) => string | null
  /**
   * 删除成功后的收尾（清指针 + 清扫）。返回一句可拼进状态栏的补充说明，
   * 例如「已回收 1.2MB 缓存」；没有可回收的就返回空串。
   *
   * 失败不该让删除本身显示为失败 —— 文档已经没了，只是空间晚点才释放。
   */
  afterRemove: (sampleId: string) => Promise<string>
  /** 状态栏文案 */
  say: (msg: string) => void
}

/** 二次确认的有效期：过了就退回普通按钮，避免用户隔很久回来误点 */
const CONFIRM_TTL = 6000

export function useLibrary(deps: LibraryDeps) {
  const open = ref(false)
  const rows = ref<LibraryRow[]>([])
  const loading = ref(false)
  const error = ref('')
  const usage = ref<{ used: number; quota: number } | null>(null)
  /** 已点过一次删除、正等二次确认的样本 */
  const pendingId = ref('')
  /** 正在删的那个（删除要跨 IndexedDB 事务，期间禁用整行） */
  const busyId = ref('')
  let confirmTimer: number | undefined

  const summary = () => librarySummary(rows.value)

  function clearPending() {
    pendingId.value = ''
    if (confirmTimer) window.clearTimeout(confirmTimer)
    confirmTimer = undefined
  }

  async function refresh(): Promise<void> {
    const store = studioStore()
    if (!store) {
      error.value = '当前环境没有本地存储，样本列表不可用'
      rows.value = []
      return
    }
    loading.value = true
    error.value = ''
    try {
      const [list, est] = await Promise.all([
        store.documents.listSamples(),
        store.blobs.usage().catch(() => null),
      ])
      rows.value = decorateLibrary(list as LibraryEntry[], {
        now: Date.now(),
        currentSampleId: deps.currentSampleId(),
      })
      usage.value = est
    } catch (err) {
      error.value = `读取样本列表失败：${(err as Error).message}`
      rows.value = []
    } finally {
      loading.value = false
      clearPending()
    }
  }

  async function openList(): Promise<void> {
    open.value = true
    await refresh()
  }

  function closeList(): void {
    open.value = false
    clearPending()
    error.value = ''
  }

  /**
   * 第一次点删除：只进入"待确认"。
   *
   * 这一步同时做判定 —— 不能删的样本不该先让用户点确认再告诉他不行。
   * 判定用的 `heldBy` 是**当下**查的，不是打开列表时查的：
   * 列表可能开了几分钟，另一个标签页中途打开这个样本是常事。
   */
  function requestRemove(row: LibraryRow): boolean {
    const verdict = judgeRemove(row, {
      currentSampleId: deps.currentSampleId(),
      heldBy: deps.heldByOtherTab(row.sampleId),
    })
    if (!verdict.ok) {
      error.value = verdict.reason
      clearPending()
      return false
    }
    error.value = ''
    pendingId.value = row.sampleId
    if (confirmTimer) window.clearTimeout(confirmTimer)
    confirmTimer = window.setTimeout(() => { pendingId.value = '' }, CONFIRM_TTL)
    return true
  }

  function cancelRemove(): void {
    clearPending()
  }

  /**
   * 真的删。
   *
   * 【顺序】先删文档，再收尾（清指针 + 清扫）。
   *   反过来的话，清扫可能先跑完、文档还在，于是这一轮什么都没收到；
   *   下一次清扫才会收 —— 用户看到的是"删了但空间没变"。
   *
   * 【为什么删完要重新查一次指针】只有指针指向被删样本时才需要摘指针。
   *   不查就摘，会把当前这份（没删的）草稿恢复入口一起弄丢。
   */
  async function confirmRemove(sampleId: string): Promise<boolean> {
    if (busyId.value) return false
    const store = studioStore()
    if (!store) {
      error.value = '当前环境没有本地存储'
      return false
    }
    const row = rows.value.find((r) => r.sampleId === sampleId)
    if (!row) return false
    // 二次判定：等待确认的这几秒里对方可能开了这个样本
    const verdict = judgeRemove(row, {
      currentSampleId: deps.currentSampleId(),
      heldBy: deps.heldByOtherTab(sampleId),
    })
    if (!verdict.ok) {
      error.value = verdict.reason
      clearPending()
      return false
    }

    busyId.value = sampleId
    error.value = ''
    try {
      await store.documents.remove(sampleId)

      let pointerHit = false
      try {
        const pointer = await loadDraftPointer()
        pointerHit = !!pointer && pointer.sampleId === sampleId
        if (pointerHit) await clearDraftPointer()
      } catch { /* 指针读不到不影响删除本身 */ }

      let note = ''
      try {
        note = await deps.afterRemove(sampleId)
      } catch (err) {
        // 收尾失败（清扫出错等）不该让用户以为没删掉
        console.warn('[library] 删除后的收尾失败', err)
      }
      rows.value = rows.value.filter((r) => r.sampleId !== sampleId)
      clearPending()
      deps.say(
        `已删除样本 ${sampleId}${pointerHit ? '（草稿指针已解除）' : ''}`
        + (note ? `，${note}` : '，相关缓存会在下次清扫时释放'),
      )
      await refresh()
      return true
    } catch (err) {
      error.value = `删除失败：${(err as Error).message}`
      return false
    } finally {
      busyId.value = ''
    }
  }

  return {
    open, rows, loading, error, usage, pendingId, busyId,
    summary,
    openList, closeList, refresh,
    requestRemove, cancelRemove, confirmRemove,
    /** 给模板用的字节格式化 */
    formatBytes,
  }
}

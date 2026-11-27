/**
 * ============================================================
 * 样本列表 —— 落盘文档的账本（纯函数）
 * ============================================================
 *
 * 【为什么要有这个文件】
 *   `documents` 里每个数据集一份文档，**没有上限**（方案 21.6 明确不自动 prune：
 *   文档是标注真值，不是缓存）。但"不自动删"不等于"不能删" ——
 *   用户需要一条出口：看看本地都存了些什么，然后把确实不要的删掉。
 *
 * 【为什么判定放在 domain】
 *   "哪个样本不能删"是业务规则，不是界面细节。放在这里的好处是
 *   Node 里能直接测：当前样本不能删、别人正在写的不能删 —— 这两条如果只写在
 *   组件里，改一次界面就可能悄悄失效。
 *
 * 【为什么不做"按最久未用自动淘汰"】
 *   同 21.6：淘汰策略要回答"三个月前的样本该不该还有标注"，
 *   这是产品决策。这里只提供"用户自己按删除"。
 */

/** 文档头里对用户有意义的那部分（与 ports/documentStore 的 summary 结构兼容） */
export interface LibraryEntry {
  sampleId: string
  sceneId: string
  updatedAt: number
  version?: number
  /** 帧范围（闭区间）；旧文档可能没有 */
  range?: [number, number]
  /** 有哪些任务段 */
  tasks?: string[]
}

export interface LibraryRow extends LibraryEntry {
  /** 相对时间文案，如「3 分钟前」 */
  ageText: string
  /** 精确时间，hover 时看 */
  atText: string
  /** 是不是当前正在编辑的这份 */
  isCurrent: boolean
  /** 任务段的显示名 */
  taskLabels: string[]
  /** 帧数（range 推导；单帧为 1） */
  frameCount: number
}

const TASK_LABEL: Record<string, string> = {
  boxes: '框',
  semantic: '语义',
  occupancy: '占据',
  flow: '光流',
  lane: '车道',
  vla: 'VLA',
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 相对时间。
 *
 * 【为什么未来时间要当"刚刚"】
 *   时间戳来自本机时钟，用户改过系统时间、或跨时区同步过文件都会出现"未来"。
 *   显示成「-3 分钟前」比显示「刚刚」更让人困惑，也无法据此判断新旧。
 */
export function describeAge(now: number, at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '未知'
  const diff = now - at
  if (diff < MINUTE) return '刚刚'
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`
  if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`
  const d = new Date(at)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

export function formatStamp(at: number): string {
  if (!Number.isFinite(at) || at <= 0) return '—'
  const d = new Date(at)
  return (
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  )
}

export function taskLabel(task: string): string {
  return TASK_LABEL[task] ?? task
}

export type RemoveCode = 'ok' | 'current' | 'locked'

export interface RemoveVerdict {
  ok: boolean
  code: RemoveCode
  reason: string
}

/**
 * 能不能删这个样本。
 *
 * 两条否决，理由不同：
 *   - `current`：正在编辑的这份。删了等于把用户眼前的画布变成孤儿 ——
 *     下一次自动保存会把它重新写回来，用户会以为"删了又出现"。
 *     真要扔掉当前这份，走「清除本地草稿」（那条路会一起清帧缓存）。
 *   - `locked`：另一个标签页正持有它的租约。它下一次保存会把文档头重建，
 *     于是"删掉了"变成"过一会儿又回来了"；而且此时删会让对端静默丢写。
 *
 * 【为什么不提供"强制删除"】
 *   两个否决理由都会导致"删了又回来"这种无法解释的现象。
 *   与其给一个需要解释后果的强制按钮，不如让用户先切换/接管再删。
 */
export function judgeRemove(
  entry: Pick<LibraryEntry, 'sampleId'>,
  ctx: { currentSampleId?: string; heldBy?: string | null },
): RemoveVerdict {
  if (ctx.currentSampleId && entry.sampleId === ctx.currentSampleId) {
    return {
      ok: false,
      code: 'current',
      reason: '这是当前正在编辑的样本：先切到别的数据集，或用「清除本地草稿」',
    }
  }
  if (ctx.heldBy) {
    return {
      ok: false,
      code: 'locked',
      reason: `另一个标签页（${ctx.heldBy}）正在编辑这个样本，先在那里关闭或在这里接管`,
    }
  }
  return { ok: true, code: 'ok', reason: '' }
}

/**
 * 整理成界面直接用的一行行。
 *
 * 排序按最近保存降序 —— 用户打开列表的目的几乎都是"找旧的删掉"或
 * "确认刚才存上了"，两个诉求都要求最新的在最上面。
 */
export function decorateLibrary(
  entries: LibraryEntry[],
  opts: { now: number; currentSampleId?: string },
): LibraryRow[] {
  return entries
    .filter((e) => !!e.sampleId)
    .map((e) => {
      const range = e.range
      const frameCount =
        range && Number.isFinite(range[0]) && Number.isFinite(range[1])
          ? Math.max(1, Math.round(range[1] - range[0]) + 1)
          : 1
      return {
        ...e,
        ageText: describeAge(opts.now, e.updatedAt),
        atText: formatStamp(e.updatedAt),
        isCurrent: !!opts.currentSampleId && e.sampleId === opts.currentSampleId,
        taskLabels: (e.tasks ?? []).map(taskLabel),
        frameCount,
      }
    })
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** 一行摘要，给状态栏/菜单用：`共 3 份 · 12 帧` 这种 */
export function librarySummary(rows: LibraryRow[]): { total: number; frames: number } {
  return {
    total: rows.length,
    frames: rows.reduce((n, r) => n + r.frameCount, 0),
  }
}

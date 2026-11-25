/**
 * ============================================================
 * Blob 引用 —— 谁还在用这些二进制
 * ============================================================
 *
 * 【为什么需要这个文件】
 *   P3 的大载荷（占据 RLE、逐点光流、语义标签）不进命令体，
 *   只在命令和文档里留一个 `payload/<hash>` 的键。
 *   一旦历史条目被淘汰（超过 500 步、新分支清空 redo），
 *   那些 blob 就再也没人引用 —— 不回收的话 IndexedDB 会被历史垃圾撑满。
 *
 * 【为什么是"扫描"而不是"计数器自增"】
 *   纯计数器的经典 bug 是重复 retain 一次、release 两次，计数变负或漏减，
 *   而这种偏差只在删错数据时才暴露出来。所以这里的约定是：
 *     - 删除前一律用 `liveRefs()` **重算**当前引用集合（最多 500 条命令，μs 级）；
 *     - `BlobRefCounter` 只用来做增量通知（哪个键刚掉到 0）与开发期校验。
 *   即"计数负责通知，扫描负责判断"。多花的那点 CPU 买的是"不会误删"。
 *
 * 【只扫大载荷，不扫轨迹】
 *   `createTrack` / `mergeTracks` 里带着整条轨迹（可能上千个关键帧），
 *   对它做深度遍历是纯浪费 —— boxes 任务没有任何 blob 引用。
 *   所以按命令类型白名单：只有 `setTaskPayload` 与 `batch` 会产生引用。
 */

import type { CommandData } from '../model/command'
import type { SampleDocument, TaskKey } from '../model/document'

/** 大载荷的键前缀。键本身就是引用，不再包一层对象 */
export const PAYLOAD_PREFIX = 'payload/'

export function isPayloadRef(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(PAYLOAD_PREFIX)
}

/** 非 boxes 任务才可能挂 blob；boxes 走 Track，不进 BlobStore */
const PAYLOAD_TASKS: TaskKey[] = ['semantic', 'occupancy', 'flow', 'lane', 'vla']

/**
 * 深度收集对象图里的 payload 引用。
 * `budget` 存在的意义：将来某个任务载荷变成"十万个 {ref, frame}"时，
 * 这里不能把主线程扫死 —— 超过预算直接停，宁可少回收，不可卡住。
 */
export function collectRefsDeep(
  root: unknown,
  out: Set<string> = new Set(),
  budget = { left: 20_000 },
): Set<string> {
  const walk = (value: unknown): void => {
    if (budget.left <= 0) return
    budget.left -= 1

    if (typeof value === 'string') {
      if (isPayloadRef(value)) out.add(value)
      return
    }
    if (value === null || typeof value !== 'object') return

    // TypedArray / ArrayBuffer：光流与点云数据的本体，里面不可能有引用串
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return

    if (Array.isArray(value)) {
      for (const item of value) walk(item)
      return
    }
    if (value instanceof Map) {
      for (const [k, v] of value) { walk(k); walk(v) }
      return
    }
    if (value instanceof Set) {
      for (const v of value) walk(v)
      return
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      walk((value as Record<string, unknown>)[key])
    }
  }
  walk(root)
  return out
}

/**
 * 一条命令持有的 blob 引用（撤销与重做都需要它，所以 before 侧也要算）。
 *
 * `beforeRef` / `afterRef` 与 `before` / `after` 里的引用取并集：
 * 构造命令时若忘了把 ref 嵌进 payload 描述对象，并集仍然能保证不被误删 ——
 * 这类 bug 一旦发生就是"撤销后画面变空"，不能靠 review 保证。
 */
export function commandBlobRefs(data: CommandData): string[] {
  switch (data.type) {
    case 'setTaskPayload': {
      const out = collectRefsDeep(data.before)
      collectRefsDeep(data.after, out)
      if (isPayloadRef(data.beforeRef)) out.add(data.beforeRef)
      if (isPayloadRef(data.afterRef)) out.add(data.afterRef)
      return [...out]
    }
    case 'batch': {
      const out = new Set<string>()
      for (const child of data.commands) {
        for (const ref of commandBlobRefs(child)) out.add(ref)
      }
      return [...out]
    }
    default:
      // 几何/类别/生命周期命令只动 Track，不持有 blob
      return []
  }
}

/**
 * 文档当前直接引用的 blob。
 * 这些引用不受历史影响：历史清空、条目淘汰都不能让它们被回收，
 * 否则"撤销栈满了以后保存的文档自己指向一个不存在的 blob"。
 */
export function documentBlobRefs(doc: SampleDocument): Set<string> {
  const out = new Set<string>()
  const tasks = doc.tasks as Record<string, unknown>
  for (const task of PAYLOAD_TASKS) {
    const payload = tasks[task]
    if (payload === undefined) continue
    collectRefsDeep(payload, out)
  }
  return out
}

/**
 * 增量引用计数：只做"掉到 0 的通知"，不参与最终决策。
 *
 * 为什么仍然保留它：如果每次编辑都去重算全量引用集合，那么 500 步历史
 * 在每次拖拽合并时都要扫一遍。计数器把"是否可能有人释放了"这个判断降到 O(1)，
 * 真正的删除动作再回到扫描结果上确认。
 */
export class BlobRefCounter {
  private counts = new Map<string, number>()

  /** 返回真正从 0 变 1 的键（可用于"这个 blob 刚被接管"的日志） */
  retain(refs: Iterable<string>): string[] {
    const added: string[] = []
    for (const ref of refs) {
      const next = (this.counts.get(ref) ?? 0) + 1
      if (next === 1) added.push(ref)
      this.counts.set(ref, next)
    }
    return added
  }

  /** 返回掉到 0 的键 —— 候选回收对象，调用方仍须用 liveRefs 复核 */
  release(refs: Iterable<string>): string[] {
    const freed: string[] = []
    for (const ref of refs) {
      const cur = this.counts.get(ref) ?? 0
      if (cur <= 0) continue
      if (cur === 1) {
        this.counts.delete(ref)
        freed.push(ref)
      } else {
        this.counts.set(ref, cur - 1)
      }
    }
    return freed
  }

  count(ref: string): number {
    return this.counts.get(ref) ?? 0
  }

  held(): Set<string> {
    return new Set(this.counts.keys())
  }

  get size(): number {
    return this.counts.size
  }

  /**
   * 与"从命令集合重算"的结果比对，返回差异描述。
   * 开发期与测试里调用：计数器漂移是静默 bug，必须有一条能主动发现它的路径。
   */
  verify(commands: Iterable<CommandData>): string[] {
    const truth = new Map<string, number>()
    for (const cmd of commands) {
      for (const ref of commandBlobRefs(cmd)) truth.set(ref, (truth.get(ref) ?? 0) + 1)
    }
    const problems: string[] = []
    for (const [ref, n] of truth) {
      const mine = this.counts.get(ref) ?? 0
      if (mine !== n) problems.push(`${ref}: 计数 ${mine}，重算 ${n}`)
    }
    for (const [ref, n] of this.counts) {
      if (!truth.has(ref)) problems.push(`${ref}: 计数 ${n}，重算 0（幽灵引用）`)
    }
    return problems
  }
}

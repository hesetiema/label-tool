/**
 * ============================================================
 * 撤销重做 —— 命令模式（Command Pattern）
 * ============================================================
 *
 * 【面试要点】编辑器类工具必问"怎么实现 undo/redo"，这道题的标准答案就是命令模式：
 *   把每一次用户操作封装成一个"命令"对象，命令自带 do 与 undo 所需的信息，
 *   用两个栈（撤销栈 / 重做栈）记录操作历史。
 *
 * 【本实现的设计取舍】
 *   有两派做法：
 *   (a) 差量命令：每个操作写自己的逆操作（移动框 → 反向移动）。省内存，但每个字段都要写逆逻辑，易漏。
 *   (b) 状态快照：每次操作前/后各存一份完整状态，undo 就是切回 before。逻辑极简、绝不会漏，
 *       代价是内存占用大。
 *
 *   标注工具的"状态"只是一堆小框（几十到几千个，每个 5 个数字），快照非常便宜，
 *   所以这里选 (b)，但用命令对象的接口把它包起来 —— 面试时既讲得出模式，又保证了正确性。
 *
 * 【连续操作的合并（mergeKey）】
 *   拖动 yaw 滑杆会触发几十次 input 事件，若每次都记一条历史，Ctrl+Z 要按几十次才能退回。
 *   解决：给命令一个 mergeKey，相同 key 且在时间窗口内的连续操作合并成一条（只更新 after）。
 */
export interface HistoryCommand<T> {
  /** 操作名，用于 UI 显示"撤销：移动框" */
  label: string
  /** 操作前状态 */
  before: T
  /** 操作后状态 */
  after: T
  /** 连续操作合并键，如 'yaw:3' 表示 3 号框的朝向调整 */
  mergeKey?: string
  /** 记录时间，用于判断是否在合并窗口内 */
  timestamp: number
}

export class HistoryStack<T> {
  private undoStack: HistoryCommand<T>[] = []
  private redoStack: HistoryCommand<T>[] = []
  /** 历史栈上限，防止长会话内存膨胀 */
  private readonly limit: number
  /** 连续操作合并窗口（毫秒） */
  private readonly mergeWindowMs: number
  /** 判断两状态是否相等；默认用 JSON 序列化比较（对 Box3D[] 这类纯数据足够） */
  private readonly isEqual: (a: T, b: T) => boolean

  constructor(
    options: {
      limit?: number
      mergeWindowMs?: number
      isEqual?: (a: T, b: T) => boolean
    } = {},
  ) {
    this.limit = options.limit ?? 100
    this.mergeWindowMs = options.mergeWindowMs ?? 700
    this.isEqual = options.isEqual ?? ((a, b) => JSON.stringify(a) === JSON.stringify(b))
  }

  /**
   * 提交一次状态变更。
   * 调用方应在修改状态前保存 before，修改后调用 commit(before, after)。
   */
  commit(before: T, after: T, label: string, mergeKey?: string): void {
    // 没有实际变化就不记录（比如按 W 但框已到边界）
    if (this.isEqual(before, after)) return

    const now = Date.now()
    const top = this.undoStack[this.undoStack.length - 1]

    // 连续同类操作合并：只更新栈顶命令的 after，不新增条目
    if (mergeKey && top && top.mergeKey === mergeKey && now - top.timestamp < this.mergeWindowMs) {
      top.after = after
      top.timestamp = now
      this.redoStack = [] // 新操作使重做链失效
      return
    }

    this.undoStack.push({ label, before, after, mergeKey, timestamp: now })
    if (this.undoStack.length > this.limit) this.undoStack.shift()
    // 经典细节：产生新操作后，重做栈必须清空（否则 redo 会跳到旧的分支）
    this.redoStack = []
  }

  /** 撤销：返回应恢复到的状态；无可撤销时返回 null */
  undo(): T | null {
    const cmd = this.undoStack.pop()
    if (!cmd) return null
    this.redoStack.push(cmd)
    return cmd.before
  }

  /** 重做：返回应恢复到的状态；无可重做时返回 null */
  redo(): T | null {
    const cmd = this.redoStack.pop()
    if (!cmd) return null
    this.undoStack.push(cmd)
    return cmd.after
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0
  }
  /** 供 UI 显示下一个撤销/重做的操作名 */
  get undoLabel(): string {
    return this.undoStack[this.undoStack.length - 1]?.label ?? ''
  }
  get redoLabel(): string {
    return this.redoStack[this.redoStack.length - 1]?.label ?? ''
  }
  get undoCount(): number {
    return this.undoStack.length
  }

  /** 加载新文件 / 切换数据集时清空历史（不同数据集间不能互相撤销） */
  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }
}

/**
 * 深拷贝框数组 —— 快照必须拷贝，否则 before/after 指向同一对象会一起变。
 * 用 JSON 序列化而非 structuredClone：Box3D 是纯数据对象，JSON 方式兼容性更好
 * （structuredClone 在部分旧版 WebView / headless 环境不可用）。
 */
export function cloneBoxes<T>(boxes: T[]): T[] {
  return boxes.map((b) => JSON.parse(JSON.stringify(b)) as T)
}

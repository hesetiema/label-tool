/**
 * ============================================================
 * 双队列调度 —— 让"当前帧"插到"预取帧"前面
 * ============================================================
 *
 * 【为什么需要它】
 *   回放时每 600ms 切一帧、每帧解析约 200ms，同时 `prefetch` 还会顺手把
 *   前后帧塞进同一条 worker 队列。单队列 FIFO 下，用户点第 30 帧时，
 *   队列里可能已经排着预取的第 12、13、14 帧 —— 当前帧要等它们全部解析完。
 *   屏幕上表现为"点了没反应，过一秒突然跳三帧"。
 *
 * 【为什么高优先级可以饿死低优先级】
 *   低优先级只有两个来源：预取（纯预热）和后台补缓存（失败了下次再补）。
 *   它们晚一点没有任何后果；而当前帧晚 200ms 用户就会重复点击。
 *   所以这里**不做**配额/老化，严格高优先 —— 简单、可预测，
 *   真要防饿死，正确做法是预取侧限流，而不是让调度器猜。
 *
 * 【为什么同级必须 FIFO】
 *   连续翻帧时用户点 10、11、12，期望的是按点击顺序出结果。
 *   若同级用栈，第 12 帧先到、第 10 帧后到，画面会来回跳。
 */
export type JobPriority = 'high' | 'low'

export class PriorityQueue<T> {
  private readonly high: T[] = []
  private readonly low: T[] = []

  push(item: T, priority: JobPriority = 'high'): void {
    ;(priority === 'high' ? this.high : this.low).push(item)
  }

  /** 高优先级取空后才轮到低优先级；同级按入队顺序 */
  shift(): T | undefined {
    return this.high.length ? this.high.shift() : this.low.shift()
  }

  get size(): number {
    return this.high.length + this.low.length
  }

  get highSize(): number {
    return this.high.length
  }

  get lowSize(): number {
    return this.low.length
  }

  /** 清空并返回剩余项（失败/释放时用来统一 reject，避免调用方永远挂着） */
  clear(): T[] {
    const rest = [...this.high, ...this.low]
    this.high.length = 0
    this.low.length = 0
    return rest
  }
}

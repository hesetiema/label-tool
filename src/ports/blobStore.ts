/**
 * 端口：BlobStore
 *
 * 只描述"我需要按键存取二进制、并且能枚举/批量删"，不描述底层是
 * IndexedDB、OPFS 还是 S3。
 *
 * 【键的两种用法】
 *   1. 大载荷走内容寻址：`payload/<sha-256 前 12 字节>`。
 *      同一份占据帧被存两次不会重复占空间，命令引用键即可撤销。
 *   2. 帧点云走位置寻址：`frames/<dataset>/<frame>`（见 `adapters/blobKeys.ts`）。
 *      帧点云导入后不再变化，算哈希是纯开销，位置键更适合按数据集批量清理。
 *
 * 【为什么需要 list 与 deleteMany】
 *   没有枚举就只能"记得自己写过哪些键"，而键分布在一年的会话里。
 *   垃圾回收的唯一可靠做法是**扫描现状**再决定删谁；
 *   一次事务删一批也比逐键 N 次事务快一个数量级。
 */
export interface BlobMeta {
  key: string
  bytes: number
  savedAt: number
  /**
   * 最后一次被读出的时间。
   *
   * 【为什么必须由读路径回写】`savedAt` 是"写进来的时间"，对帧缓存来说等于
   * "第一次解码它的时间"——用户回看旧帧不会改动它。只按 savedAt 淘汰，
   * 淘汰的是"最早看过的"，而不是"最久没看的"，结果恰好删掉封面帧和开头。
   *
   * 【为什么可能缺失】v2 及更早写下的记录没有这条元数据，
   * 实现方应退回 `savedAt`，让老数据也能参与淘汰而不是永远躲过一劫。
   */
  lastUsedAt?: number
  /**
   * 被读出的次数（LFU 判据）。没有记录时为 0。
   *
   * 【为什么和 lastUsedAt 分开】两者回答的不是一个问题：
   * 时间答"多久没看了"，次数答"总共看了几回"。
   * 只看时间会淘汰"很久前反复看过的重要帧"，只看次数会淘汰"刚打开的新帧"。
   * 默认的混合策略同时用两者（见 `domain/store/frameBudget.ts`）。
   */
  hits?: number
}

export interface BlobStore {
  put(key: string, buf: ArrayBuffer): Promise<void>
  get(key: string): Promise<ArrayBuffer>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>

  /** 按前缀批量删除，返回删除条数。数据集替换 / 历史回收用 */
  deletePrefix(prefix: string): Promise<number>

  /**
   * 枚举（可按前缀过滤）。垃圾回收的输入。
   * 只返回元信息，不把 buffer 读进内存 —— 枚举几万条记录时这点很关键。
   */
  list(prefix?: string): Promise<BlobMeta[]>

  /** 一次事务删除一批键，返回提交的键数（不存在的键也计入） */
  deleteMany(keys: string[]): Promise<number>

  /**
   * 记一次"这些键被读了"：刷新最后使用时间**并**把命中次数 +1。
   *
   * 【为什么是批量】切帧是高频动作（回放 10Hz）。调用方会合并几百毫秒内的
   * 读取再调一次，实现方只需保证"一次事务写完"，不要逐键开事务。
   * 键不存在时跳过（缓存可能刚被清扫掉），不报错 —— 这是后台统计，不是业务写入。
   *
   * 【为什么一次调用 = 一次命中】调用方已经把"同一个读取会话"合并过了
   * （`frameCloudStore` 里 60 秒内不重复记），所以这里数的是"回看的次数"，
   * 不是"渲染了多少帧"。实现方不要按调用次数之外的维度再折算。
   */
  touchMany(keys: string[], at?: number): Promise<number>

  usage(): Promise<{ used: number; quota: number }>
}

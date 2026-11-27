/**
 * ============================================================
 * 帧缓存淘汰计划 —— 跨数据集 / 按时间或频次（纯函数）
 * ============================================================
 *
 * 【要解决什么】
 *   `blobGc` 对帧缓存的判据是"数据集还用不用"：一个数据集只要还活着，
 *   它的帧就整段保留。这在"配额快满、但当前数据集本身就有 500 帧"时没用 ——
 *   清扫完一条都没删，用量还是 95%。
 *   这里补的是第二阶段：**活着的帧里挑一部分淘汰**，直到腾出足够的字节。
 *
 * 【第九批把它从"当前数据集内部"扩成"全局"】
 *   原来的候选池只有当前数据集，于是出现两种腾不出来：本端数据集只有 30MB，
 *   而库里还压着另一个标签页的 2GB；或者本端是恢复型会话（缓存是唯一副本，
 *   一帧都不能删），于是只能眼睁睁看着 95% 的用量。
 *   现在候选池是**所有可重解码的数据集**，跨数据集统一排序 —— 谁最久没用就删谁，
 *   而不是"先把自己的删完再说"。可淘汰集合仍由调用方给（见 `FrameEvictionInput`），
 *   这个文件不判断"删了能不能回来"。
 *
 * 【为什么必须是真的 lastUsedAt，不能拿 savedAt 凑】
 *   `savedAt` 是"这一帧被写入缓存的时间"，也就是**第一次解码它的时间**。
 *   用户回看第 3 帧不会重写它。于是按 savedAt 淘汰 = 按"最早看的先淘汰"，
 *   而最早看的那几帧往往正是封面帧和开头 —— 恰恰是最常回看的帧。
 *   要按"最久未用"就必须在**读取时**记时间（见 frameCloudStore.noteFrameUsed）。
 *
 * 【为什么按帧聚合，不按记录】
 *   一帧最多三条记录（positions / :colors / :labels）。
 *   逐条淘汰会留下 `:colors` 孤儿：没有 positions 的帧读不出来，
 *   却还占着几百 KB。所以先分组，整组进整组出。
 *
 * 【为什么淘汰量按字节算而不是按条数】
 *   一帧有颜色的 20 万点 ≈ 3.6MB，一帧只有坐标的 ≈ 2.4MB，差一倍。
 *   按条数淘汰会让"实际回收量"在数据集之间大幅波动，
 *   配额压力下需要的是确定的字节数。
 */

/**
 * 淘汰排序策略。
 *
 * - `lru`    最久未被读的优先。适合"顺着帧往下看"的标注习惯，行为最好预测。
 * - `lfu`    被读次数最少的优先。保护反复回看的重点帧，但会牺牲"很久没看却很重要"的帧。
 * - `hybrid` 先淘汰"只读过一次"的那批（按 LRU），不够再按 LRU 淘汰其余。
 *
 * 【为什么默认 hybrid 而不是 lru】
 *   纯 LRU 在回放/来回拖动时会反复淘汰同一批"刚好滑出窗口"的帧：
 *   看了 → 淘汰 → 再看 → 重解 → 再淘汰。而只读过一次的帧再被回看的概率最低，
 *   把它们排在最前面，等于用同样的回收量换更少的重解码。
 *   hybrid 在没有命中数据时（hits 全为 0）与 LRU **完全等价**，所以升级不改变老行为。
 */
export type EvictionPolicy = 'lru' | 'lfu' | 'hybrid'

export const EVICTION_POLICIES: readonly EvictionPolicy[] = ['lru', 'lfu', 'hybrid']

export const DEFAULT_EVICTION_POLICY: EvictionPolicy = 'hybrid'

/** 状态栏与审计里的人话；三处显示必须用同一份文案，否则同一个策略在不同地方叫不同名字 */
export const EVICTION_POLICY_LABEL: Record<EvictionPolicy, string> = {
  lru: '最久未用',
  lfu: '最少使用',
  hybrid: '混合（一次性帧先淘汰）',
}

export function isEvictionPolicy(value: unknown): value is EvictionPolicy {
  return value === 'lru' || value === 'lfu' || value === 'hybrid'
}

/**
 * 一条帧记录（对应 BlobStore 里的一个键）。
 *
 * 【为什么归属由调用方传入，而不是在这里解析键】
 *   键的格式属于适配层（`adapters/blobKeys.ts`），domain 不允许依赖它。
 *   调用方（`blobGc`）已经有分类结果，顺手带过来即可 ——
 *   这样键规范再改一次，这个文件一行都不用动。
 */
export interface FrameBlobRef {
  key: string
  datasetKey: string
  frame: number
  bytes: number
  /** 最后被读出的时间；0 表示从没读过（老记录由调用方用 savedAt 兜底） */
  lastUsedAt?: number
  /**
   * 被读出的次数（LFU 判据）。缺失或 0 表示"只写过、没被读过"。
   *
   * 【口径】不是"每次读都 +1"，而是"每个读取会话 +1"：
   * 采集端 60 秒内对同一帧只记一次（见 `frameCloudStore.TOUCH_MIN_GAP_MS`）。
   * 否则 10Hz 回放看 10 秒就能把一帧刷到 100 次，频次彻底失真成"停留时长"。
   */
  hits?: number
}

/** 一帧的全部记录 */
export interface FrameGroup {
  datasetKey: string
  frame: number
  keys: string[]
  bytes: number
  /** 组内最晚使用时间：任一记录被读过，这帧就算用过 */
  lastUsedAt: number
  /** 组内最大命中次数（只有 positions 那条记录会被记，取最大即可） */
  hits: number
}

export interface FrameEvictionInput {
  /** 仍会被保留的帧记录（已经被 GC 判过"数据集活着"） */
  entries: FrameBlobRef[]
  /**
   * 需要腾出的字节数（不是最终水位）。
   *
   * 【为什么给"腾出多少"而不是"降到多少"】配额是 `navigator.storage.estimate()`
   * 给的 origin 总量（含文档、旧草稿、审计等），而这里能数的只有 blob 的字节。
   * 两个口径混在一起算水位必然错位：要么该腾的时候不腾，要么把帧全删了还"没达标"。
   * 调用方用 `used - quota × 目标比例` 算出差额，这里只负责凑够这么多字节。
   */
  reclaimBytes: number
  /**
   * 允许淘汰的数据集。不在这个集合里的数据集一帧都不动。
   *
   * 【全局淘汰靠的就是这个集合变宽】调用方把"本端可重解码的"与"对端自报可重解码的"
   * 都放进来，就得到跨数据集的统一排序。判定层不需要知道数据集是谁的。
   */
  evictableDatasetKeys: Iterable<string>
  /**
   * 绝对不能动的键（当前帧、封面帧、对端的当前帧……）。
   * 只要组里有一个键落在这里，整组保护 —— 淘汰 positions 却留下 :colors
   * 与淘汰 :colors 却留下 positions 都是坏结果。
   */
  protectKeys?: Iterable<string>
  /** 排序策略；默认 `hybrid`（无命中数据时等价 LRU） */
  policy?: EvictionPolicy
}

export interface FrameEvictionPlan {
  groups: FrameGroup[]
  keys: string[]
  bytes: number
  /** 因为被 protectKeys 命中而整组跳过的帧数（诊断用） */
  protectedFrames: number
  /** 可淘汰的帧总数（含未选中） */
  candidates: number
  /**
   * 本次计划实际动了哪几个数据集。
   *
   * 【为什么单独给】跨数据集淘汰之后，"删了 3 帧"这句话已经不够了 ——
   * 用户需要知道删的是自己正在看的，还是另一个标签页的。审计与状态栏都靠它。
   */
  datasets: string[]
  /**
   * 计划腾出的字节仍不足时的缺口（0 = 够了）。
   *
   * 【为什么要暴露"不够"】以前不够就是静默返回，调用方以为清完了，
   * 于是下次保存又弹一次"接近上限"，用户永远等不到一句"腾不出来，请导出后清理"。
   */
  shortfall: number
  policy: EvictionPolicy
}

/** 按 dataset+frame 聚合，lastUsedAt 取组内最大值，hits 取组内最大值 */
export function groupFrames(entries: FrameBlobRef[]): FrameGroup[] {
  const map = new Map<string, FrameGroup>()
  for (const entry of entries) {
    // 没有归属信息的记录（旧键 `ds#frame` 反解不出数据集）不参与淘汰：
    // 判不准归属时宁可留着，等它变成"数据集已死"那一路被整段清掉
    if (!entry.datasetKey || !Number.isFinite(entry.frame)) continue
    const id = `${entry.datasetKey}\u0000${entry.frame}`
    const used = entry.lastUsedAt ?? 0
    const hits = entry.hits ?? 0
    const group = map.get(id)
    if (group) {
      group.keys.push(entry.key)
      group.bytes += entry.bytes
      if (used > group.lastUsedAt) group.lastUsedAt = used
      if (hits > group.hits) group.hits = hits
    } else {
      map.set(id, {
        datasetKey: entry.datasetKey,
        frame: entry.frame,
        keys: [entry.key],
        bytes: entry.bytes,
        lastUsedAt: used,
        hits,
      })
    }
  }
  return [...map.values()]
}

/**
 * hybrid 的分桶：只被读过 0~1 次的帧属于"一次性帧"。
 *
 * 阈值取 1 而不是 0：第一次读往往就是"打开时顺手看了一眼"，
 * 和从没读过在信息量上几乎没差别；真正区分出来的是"回来过"。
 */
function tierOf(group: FrameGroup): number {
  return group.hits <= 1 ? 0 : 1
}

/** 排序最后一级：dataset+frame 升序，保证同样输入永远得到同样的计划（测试与审计依赖它） */
function byTie(a: FrameGroup, b: FrameGroup): number {
  if (a.datasetKey !== b.datasetKey) return a.datasetKey < b.datasetKey ? -1 : 1
  return a.frame - b.frame
}

function comparatorFor(policy: EvictionPolicy): (a: FrameGroup, b: FrameGroup) => number {
  if (policy === 'lfu') {
    return (a, b) => a.hits - b.hits || a.lastUsedAt - b.lastUsedAt || byTie(a, b)
  }
  if (policy === 'hybrid') {
    return (a, b) => tierOf(a) - tierOf(b) || a.lastUsedAt - b.lastUsedAt || a.hits - b.hits || byTie(a, b)
  }
  return (a, b) => a.lastUsedAt - b.lastUsedAt || byTie(a, b)
}

/**
 * 算出该淘汰哪些帧。
 *
 * 排序：按 `policy` 升序（越靠前越先淘汰）；同时间戳按 dataset+frame 升序。
 *
 * 【为什么在最旧的一批里"整段淘汰"而不是只淘汰到勉强够】
 *   差几百 KB 时淘汰半帧没有意义（一帧是原子的），
 *   多淘汰一帧的代价只是"下次切回去重解 200ms"。
 */
export function planFrameEviction(input: FrameEvictionInput): FrameEvictionPlan {
  const policy = input.policy ?? DEFAULT_EVICTION_POLICY
  const need = Math.max(0, input.reclaimBytes)
  const empty: FrameEvictionPlan = {
    groups: [],
    keys: [],
    bytes: 0,
    protectedFrames: 0,
    candidates: 0,
    datasets: [],
    shortfall: 0,
    policy,
  }
  if (need <= 0) return empty

  const evictable = new Set(input.evictableDatasetKeys)
  if (!evictable.size) return { ...empty, shortfall: need }
  const protect = new Set(input.protectKeys ?? [])

  const all = groupFrames(input.entries)
  const pool: FrameGroup[] = []
  let protectedFrames = 0
  for (const group of all) {
    if (!evictable.has(group.datasetKey)) continue
    if (protect.size && group.keys.some((k) => protect.has(k))) {
      protectedFrames++
      continue
    }
    pool.push(group)
  }
  if (!pool.length) return { ...empty, protectedFrames, shortfall: need }

  pool.sort(comparatorFor(policy))

  const chosen: FrameGroup[] = []
  let bytes = 0
  for (const group of pool) {
    if (bytes >= need) break
    chosen.push(group)
    bytes += group.bytes
  }

  return {
    groups: chosen,
    keys: chosen.flatMap((g) => g.keys),
    bytes,
    protectedFrames,
    candidates: pool.length,
    datasets: [...new Set(chosen.map((g) => g.datasetKey))].sort(),
    shortfall: Math.max(0, need - bytes),
    policy,
  }
}

/**
 * 保护键：当前帧及其邻域。
 *
 * 【为什么是"邻域"而不是只有当前帧】
 *   切帧是有方向的：用户点了下一帧，下一帧马上要被读；回放时前后各一帧
 *   都在预取队列里。只保护当前帧的话，清扫可能刚好把用户下一眼要看的那帧
 *   淘汰掉，然后立刻重新解码 —— 淘汰变成纯粹的负收益。
 */
export function neighborhoodKeys(
  datasetKey: string,
  frame: number,
  build: (datasetKey: string, frame: number) => string[],
  radius = 2,
): string[] {
  const keys: string[] = []
  for (let d = -radius; d <= radius; d++) {
    const f = frame + d
    if (f < 0) continue
    keys.push(...build(datasetKey, f))
  }
  return keys
}

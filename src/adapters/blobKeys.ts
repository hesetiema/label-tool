/**
 * ============================================================
 * Blob 键规范 —— 让"这段字节属于谁"可判定
 * ============================================================
 *
 * 【为什么要给键加命名空间】
 *   P0 时键是 `${datasetKey}#${frame}`，而 datasetKey 自己就带 `#`
 *   （`local#000970.pcd#50`）。垃圾回收想问"这条 blob 属于哪个数据集"，
 *   答案在字符串里是**有歧义**的 —— 从右往左数第一个 `#` 也可能属于文件名。
 *   所以新写入统一改成：
 *
 *     payload/<hash>                       任务大载荷（内容寻址）
 *     frames/<encodeURIComponent(ds)>/<n>  第 n 帧点云
 *     frames/<...>/<n>:colors              第 n 帧颜色
 *     frames/<...>/<n>:labels              第 n 帧语义标签
 *
 *   `encodeURIComponent` 会把 `#`、`/`、`%` 全部转义，所以分隔符不再有歧义。
 *
 * 【旧键怎么办】
 *   已经写进用户库里的 `ds#frame` 不能假装不存在（那是别人正在用的草稿缓存）。
 *   读取走"新键 → 旧键"两级回退；清理时把旧前缀一起删。
 *   GC 对旧键的判定是保守的：只要能匹配上任何**存活数据集**的 `ds#` 前缀就保留，
 *   匹配不上才当垃圾 —— 判不准的时候留几个字节，比删掉用户的点云好。
 */

import { PAYLOAD_PREFIX } from '../domain/store/blobRefs'

export const ZONE_PAYLOAD = PAYLOAD_PREFIX
export const ZONE_FRAMES = 'frames/'

export type FrameBlobPart = 'positions' | 'colors' | 'labels'

const PART_SUFFIX: Record<Exclude<FrameBlobPart, 'positions'>, string> = {
  colors: ':colors',
  labels: ':labels',
}

/** 某个数据集帧缓存的键前缀（GC 与批量删除按它切段） */
export function frameZonePrefix(datasetKey: string): string {
  return `${ZONE_FRAMES}${encodeURIComponent(datasetKey)}/`
}

export function frameBlobKey(datasetKey: string, frame: number, part: FrameBlobPart = 'positions'): string {
  const base = `${frameZonePrefix(datasetKey)}${frame}`
  return part === 'positions' ? base : `${base}${PART_SUFFIX[part]}`
}

/** 旧键位（P0 写下的）：仅在读取回退与清理时使用 */
export function legacyFrameBlobKey(datasetKey: string, frame: number): string {
  return `${datasetKey}#${frame}`
}

export function legacyFramePrefix(datasetKey: string): string {
  return `${datasetKey}#`
}

export interface FrameBlobKeyParts {
  datasetKey: string
  frame: number
  part: FrameBlobPart
}

/** 解析新键；不是帧缓存键返回 null（payload 键、旧键都会返回 null） */
export function parseFrameBlobKey(key: string): FrameBlobKeyParts | null {
  if (!key.startsWith(ZONE_FRAMES)) return null
  const rest = key.slice(ZONE_FRAMES.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const encoded = rest.slice(0, slash)
  const tail = rest.slice(slash + 1)
  const match = /^(\d+)(?::(colors|labels))?$/.exec(tail)
  if (!match) return null
  let datasetKey: string
  try {
    datasetKey = decodeURIComponent(encoded)
  } catch {
    return null
  }
  return {
    datasetKey,
    frame: Number(match[1]),
    part: (match[2] as FrameBlobPart | undefined) ?? 'positions',
  }
}

export type BlobZone = 'payload' | 'frames' | 'legacy' | 'unknown'

/** 旧键的形状：`...<#><数字>[:colors|:labels]`。只用于分类，不用于反解数据集 */
const LEGACY_SHAPE = /#\d+(?::(colors|labels))?$/

export function classifyBlobKey(key: string): { zone: BlobZone; datasetKey?: string } {
  if (key.startsWith(ZONE_PAYLOAD)) return { zone: 'payload' }
  const parsed = parseFrameBlobKey(key)
  if (parsed) return { zone: 'frames', datasetKey: parsed.datasetKey }
  if (LEGACY_SHAPE.test(key)) return { zone: 'legacy' }
  return { zone: 'unknown' }
}

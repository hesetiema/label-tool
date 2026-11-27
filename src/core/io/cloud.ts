/**
 * ============================================================
 * 点云容器格式分发 —— 一个入口认三种文件
 * ============================================================
 *
 * 导入路径只需要拿到 `ArrayBuffer`，不必知道自己拿到的是 PCD、PLY 还是
 * Velodyne `.bin`：
 *
 *   parseCloudBuffer(buffer, { name: '000970.pcd' })
 *
 * 判定顺序（**内容优先于扩展名**）：
 *   1. 开头 3 字节是 `ply` → PLY（有魔数，最可靠）
 *   2. 头 1KB 里能找到 PCD 的 `FIELDS`/`DATA` 行 → PCD
 *      （PCD 头是文本，可能以大写的 `# .PCD v0.7` 注释开头，所以不能只看第 1 行）
 *   3. 扩展名 / MIME 只在前两条都失败时作参考
 *   4. 最后的兜底是 `.bin`（裸 float32）—— 它没有魔数，只能靠字节数约束猜步长，
 *      而 `parseVelodyneBin` 会在字节数不整除时报错，所以不会静默读错
 *
 * 为什么不在扩展名上做死判断：用户手里的文件经常被改过名
 * （`000970.pcd` 其实是 KITTI 的 `.bin`），内容判定能救这一类。
 */
import { parsePCD } from './pcd'
import { parseVelodyneBin } from './bin'
import { parsePLY } from './ply'
import type { PointCloud } from '../types'

export type CloudFormat = 'pcd' | 'ply' | 'bin'

const decoder = new TextDecoder('utf-8')

/** 按扩展名猜格式（仅供参考，最终以内容为准） */
export function cloudFormatOfName(name: string | undefined): CloudFormat | null {
  if (!name) return null
  const m = /\.([a-z0-9]+)$/i.exec(name)
  const ext = m?.[1]?.toLowerCase()
  if (ext === 'pcd') return 'pcd'
  if (ext === 'ply') return 'ply'
  if (ext === 'bin') return 'bin'
  return null
}

/** 只读前 1KB 的头部采样，用来做魔数/文本头判定 */
function headerSample(bytes: Uint8Array): string {
  return decoder.decode(bytes.subarray(0, Math.min(bytes.length, 1024)))
}

/** 判断这是不是 PCD：文本头里必须同时出现 FIELDS 与 DATA 两行 */
export function looksLikePcd(bytes: Uint8Array): boolean {
  const head = headerSample(bytes)
  return /^FIELDS\s/im.test(head) && /^DATA\s/im.test(head)
}

/** 判断这是不是 PLY：开头必须是 `ply` 这个魔数（后跟换行） */
export function looksLikePly(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false
  return bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79 && bytes[3] === 0x0a
}

/**
 * 判定格式。`name` 只在内容判定失败时参与。
 * @throws 三种格式都不像时抛出（避免把任意二进制文件当点云读出一堆乱点）
 */
export function detectCloudFormat(buffer: ArrayBuffer, name?: string): CloudFormat {
  const bytes = new Uint8Array(buffer)
  if (looksLikePly(bytes)) return 'ply'
  if (looksLikePcd(bytes)) return 'pcd'
  const byName = cloudFormatOfName(name)
  if (byName === 'bin') return 'bin'
  // 没有魔数、扩展名也不认识：最后再试一次「字节数像不像 float32 点云」，
  // 像就按 .bin 读，不像就报错 —— 不要猜
  if (buffer.byteLength > 0 && buffer.byteLength % 4 === 0) return 'bin'
  throw new Error('无法识别的点云格式：只支持 .pcd / .ply / KITTI .bin')
}

/**
 * 解析任意支持的点云格式。
 * @param opts.name 文件名（仅用于辅助判定，不参与解析逻辑）
 * @param opts.format 已知格式时直接指定，跳过内容嗅探
 */
export function parseCloudBuffer(buffer: ArrayBuffer, opts: { name?: string; format?: CloudFormat } = {}): PointCloud {
  if (buffer.byteLength === 0) throw new Error('文件是空的')
  const format = opts.format ?? detectCloudFormat(buffer, opts.name)
  switch (format) {
    case 'ply':
      return parsePLY(buffer)
    case 'bin':
      return parseVelodyneBin(buffer)
    default:
      return parsePCD(buffer)
  }
}

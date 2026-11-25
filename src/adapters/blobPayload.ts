/**
 * ============================================================
 * 大载荷存取 —— 内容寻址
 * ============================================================
 *
 * 占据一帧 60KB、一次 ROI 编辑改十几帧，这些字节不能进命令体，
 * 只能把 `payload/<hash>` 放进命令与文档。这里负责"写进去拿到键、按下标读回来"。
 *
 * 【为什么用内容哈希而不是自增 id】
 *   - 同一帧被两个样本引用时只存一份（P3 的跨样本占据缓存会碰到）；
 *   - 撤销 = 切回旧引用，天然幂等；
 *   - 重放历史时不会因为"id 变了下标"而读到别人的数据。
 *
 * 【诚实边界】
 *   这是**本地**去重，不是全局内容寻址存储：
 *   - 哈希只取 SHA-256 前 12 字节（96 bit），碰撞概率对本机几十万条载荷可以忽略；
 *   - 没有 `crypto.subtle` 的环境（老 Safari / 非安全上下文）退化为 64 位混合哈希，
 *     只保证"同一环境内一致"，不保证跨设备稳定 —— 引用本来也不跨设备同步。
 */

import { PAYLOAD_PREFIX } from '../domain/store/blobRefs'
import type { BlobStore } from '../ports/blobStore'

export type DigestMode = 'auto' | 'subtle' | 'fnv1a'

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * 64 位兜底哈希：FNV-1a 与 murmur 尾部混合各算一半。
 * 不用 BigInt 是为了在 60KB 的载荷上也能跑进 1ms。
 */
export function fnv1a64(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5
  let h2 = 0x9e3779b9 ^ bytes.length
  for (let i = 0; i < bytes.length; i++) {
    h1 ^= bytes[i]
    h1 = Math.imul(h1, 0x01000193) >>> 0
    h2 = (h2 + bytes[i]) >>> 0
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x85ebca6b) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export async function payloadRefOf(buf: ArrayBuffer, mode: DigestMode = 'auto'): Promise<string> {
  const bytes = new Uint8Array(buf)
  const subtle = typeof crypto !== 'undefined' ? crypto.subtle : undefined
  if (mode !== 'fnv1a' && subtle) {
    // 12 字节 = 96 bit，碰撞概率远低于"用户手滑写坏一帧"的概率
    const digest = await subtle.digest('SHA-256', buf)
    return PAYLOAD_PREFIX + toHex(new Uint8Array(digest).subarray(0, 12))
  }
  return PAYLOAD_PREFIX + fnv1a64(bytes)
}

/**
 * 写入一份大载荷，返回键。已存在则直接返回（去重），不会重写字节。
 * `deduped` 通过返回值无法区分，需要审计时用 `has` 自己判一次。
 */
export async function putPayload(
  blobs: BlobStore,
  buf: ArrayBuffer,
  opts: { mode?: DigestMode } = {},
): Promise<string> {
  const ref = await payloadRefOf(buf, opts.mode ?? 'auto')
  if (await blobs.has(ref)) return ref
  await blobs.put(ref, buf)
  return ref
}

export async function getPayload(blobs: BlobStore, ref: string): Promise<ArrayBuffer> {
  if (!ref.startsWith(PAYLOAD_PREFIX)) {
    // 明确报错而不是"读了个空"：把帧键当载荷键传进来是调用方的 bug
    throw new Error(`不是载荷引用：${ref}`)
  }
  return blobs.get(ref)
}

export async function hasPayload(blobs: BlobStore, ref: string): Promise<boolean> {
  return ref.startsWith(PAYLOAD_PREFIX) && blobs.has(ref)
}

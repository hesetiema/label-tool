/**
 * ============================================================
 * 大载荷任务的命令构造
 * ============================================================
 *
 * 【为什么单独一个文件】
 *   `setTaskPayload` 的 before/after 是**描述对象**（规格 + 帧引用表），
 *   真正的字节在 BlobStore。构造这种命令有三个容易漏的点：
 *     1. 忘了把帧引用嵌进描述对象 → GC 只靠 beforeRef 兜，容易漏；
 *     2. 忘了深拷贝 → 编辑后描述对象被就地改，redo 拿到的"旧快照"是新的；
 *     3. 主载荷引用取错 → 审计里看不出"这步改的是哪一帧"。
 *   收在一个构造函数里，三处只写一遍。
 *
 * 【为什么 before 也要存】
 *   撤销 = 切回旧引用。旧引用指向的 blob 还在（命令持有它），
 *   所以撤销不需要重新编码，也不会因为"编码算法改了"而撤销出不同结果。
 */
import type { Command } from '../model/command'
import { makeCommand } from '../model/command'
import type { TaskKey } from '../model/document'
import { isPayloadRef } from '../store/blobRefs'

/**
 * 描述对象里的"主引用"。审计与日志用它说"这一步动的是哪一帧"，
 * GC 不依赖它（GC 深度扫整个描述对象），所以取不到就是 null，不报错。
 */
export function primaryPayloadRef(task: TaskKey, payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (task === 'occupancy') {
    const frames = p.frames
    if (Array.isArray(frames) && frames.length) {
      const first = frames[0] as { ref?: unknown }
      if (isPayloadRef(first?.ref)) return first.ref
    }
    return null
  }
  if (task === 'semantic') return isPayloadRef(p.pointLabelsRef) ? p.pointLabelsRef : null
  if (task === 'flow') return isPayloadRef(p.pointFlowRef) ? p.pointFlowRef : null
  return null
}

/** 描述对象的深拷贝。JSON 足够：它们只含数字/字符串/数组/普通对象 */
function cloneDescriptor<T>(value: T | null | undefined): T | null {
  if (value === null || value === undefined) return null
  return JSON.parse(JSON.stringify(value)) as T
}

export function buildTaskPayloadCommand(opts: {
  task: TaskKey
  before: unknown | null
  after: unknown | null
  label: string
  actor?: string
}): Command {
  const before = cloneDescriptor(opts.before)
  const after = cloneDescriptor(opts.after)
  return makeCommand({
    type: 'setTaskPayload',
    task: opts.task,
    before,
    after,
    beforeRef: primaryPayloadRef(opts.task, before),
    afterRef: primaryPayloadRef(opts.task, after),
  }, { label: opts.label, ...(opts.actor ? { actor: opts.actor } : {}) })
}

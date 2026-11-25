/**
 * 适配器：HTTP 预标注（NDJSON 流）
 *
 * 协议（与推理服务约定，尽量小）：
 *   POST <url>   Content-Type: application/json
 *   body  = PreAnnotateRequest
 *   200   = NDJSON，每行一个 PreAnnotateChunk（允许 `data:` 前缀，兼容 SSE 网关）
 *   其它  = 文本错误体，取前 200 字进异常信息
 *
 * 【为什么用 NDJSON 而不是等一个完整 JSON】
 *   分钟级任务必须有增量反馈；完整 JSON 意味着服务端要攒住全部结果，
 *   客户端在最后一帧之前什么都看不到 —— 进度条只能靠"假动画"。
 *   NDJSON 同时也是最容易中转的格式（nginx、BFF、日志系统都当它普通文本流）。
 *
 * 【为什么注入 fetchImpl】
 *   测试不该起真服务器；线上又可能需要带 cookie/拦截器的 fetch。
 *   注入一个函数比 mock 全局 fetch 干净得多。
 */
import type {
  PreAnnotationProvider, PreAnnotateChunk, PreAnnotateRequest, ProviderCapabilities,
} from '../../ports/preAnnotation'
import { abortError, isAborted } from '../../ports/preAnnotation'
import { parseChunkLine } from './parse'

export interface HttpProviderOptions {
  url: string
  headers?: Record<string, string>
  /** 默认 globalThis.fetch；测试可注入假实现 */
  fetchImpl?: typeof fetch
  model?: { id: string; version: string }
  capabilities?: Partial<ProviderCapabilities>
  /** 单行上限，防止对端吐超长行把内存打爆。默认 4MB */
  maxLineBytes?: number
}

export function createHttpProvider(opts: HttpProviderOptions): PreAnnotationProvider {
  const model = opts.model ?? { id: 'remote', version: 'unknown' }
  const maxLine = opts.maxLineBytes ?? 4 * 1024 * 1024

  return {
    id: 'http',
    label: '推理服务',
    capabilities(): ProviderCapabilities {
      return {
        tasks: ['boxes'],
        classes: null,
        maxFramesPerRequest: 200,
        supportsStreaming: true,
        requiresImages: false,
        ...opts.capabilities,
      }
    },

    async *run(req: PreAnnotateRequest, signal?: AbortSignal): AsyncGenerator<PreAnnotateChunk> {
      if (isAborted(signal)) throw abortError()
      const doFetch = opts.fetchImpl ?? globalThis.fetch
      if (!doFetch) throw new Error('当前环境没有 fetch，无法调用推理服务')

      const res = await doFetch(opts.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(opts.headers ?? {}) },
        body: JSON.stringify(req),
        signal,
      })

      if (!res.ok) {
        // 错误体可能很长（HTML 错误页），截断后再进异常信息
        const body = await res.text().catch(() => '')
        throw new Error(`推理服务返回 ${res.status}${body ? `：${body.slice(0, 200)}` : ''}`)
      }
      if (!res.body) throw new Error('推理服务没有返回流式响应体')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      try {
        for (;;) {
          if (isAborted(signal)) {
            await reader.cancel().catch(() => {})
            throw abortError()
          }
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          if (buf.length > maxLine) {
            await reader.cancel().catch(() => {})
            throw new Error('推理服务返回了超长行，已中断（协议应为每行一个 JSON）')
          }
          let idx = buf.indexOf('\n')
          while (idx >= 0) {
            const line = buf.slice(0, idx)
            buf = buf.slice(idx + 1)
            const chunk = parseChunkLine(line, model)
            if (chunk) yield chunk
            idx = buf.indexOf('\n')
          }
        }
        const tail = buf + decoder.decode()
        const chunk = parseChunkLine(tail, model)
        if (chunk) yield chunk
      } finally {
        reader.releaseLock?.()
      }
    },
  }
}

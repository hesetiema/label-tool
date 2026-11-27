/**
 * 八个测试文件共用的断言夹具。
 *
 * 这些用例原来的写法是：自己维护 `passed/failed` 两个计数器，逐条
 * `console.log` 打勾或打叉，最后 `process.exit(1)` 交退出码 —— 由 esbuild
 * 打成单文件后 `node` 跑（见 package.json 里的旧脚本）。
 *
 * 迁到 Vitest 之后保留「顺序执行、失败不中断、把每条失败攒起来最后一起看」
 * 的语义（调试时比"第一条就 abort"更有用），只把汇总交给一次真实断言：
 * 这样既拿到了 Vitest 的 reporter、diff、watch 和 v8 覆盖率，又不用把
 * 1000 多条断言逐条改写成 `expect`。
 *
 * 想让某条断言直接中止用例，用 `check.strict` 或直接写 `expect` —— 两者
 * 可以混用，Vitest 的 `expect` 与这里的计数器互不干扰。
 */
import { expect } from 'vitest'

export interface Checker {
  /** 记一条断言；`cond` 为假时把 `name`（和可选的 `detail`）攒进失败列表 */
  check(name: string, cond: boolean, detail?: unknown): void
  /** 在所有 check 跑完之后调用：有失败就让当前用例失败，并打印汇总 */
  finish(): void
}

export function createChecker(): Checker {
  let passed = 0
  const failures: string[] = []

  return {
    check(name, cond, detail) {
      if (cond) {
        passed++
        return
      }
      const extra = detail === undefined || detail === '' ? '' : `  → ${String(detail)}`
      failures.push(`${name}${extra}`)
      // 失败当时就打一行：Vitest 会把它并进用例输出，定位比最后统一打更直观
      console.error(`  ✗ ${name}${extra}`)
    },
    finish() {
      const summary = `${passed} 通过, ${failures.length} 失败`
      console.log(`\n===== ${summary} =====`)
      // 用 toEqual([]) 而不是把失败拼成字符串：Vitest 会对数组逐项 diff
      expect(failures, summary).toEqual([])
    },
  }
}

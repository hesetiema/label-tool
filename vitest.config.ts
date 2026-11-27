import { fileURLToPath, URL } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

/**
 * 测试配置。
 *
 * 和 `vite.config.ts` 分开是有意的：那份配置管的是"怎么打包上线"（base、分包、
 * 产物目录），这份管的是"怎么在 Node 里跑断言"。两者都改一个文件的话，调构建
 * 容易顺手改坏测试环境（比如有人把 `base` 改成 CDN，测试跟着换解析根）。
 *
 * 环境选 `node` 而不是 jsdom/happy-dom：九支用例验证的是 core / domain /
 * adapters 的纯逻辑，不碰 DOM。真正需要 DOM、WebGL、IndexedDB 的走查在
 * `scripts/browser/*.mjs`，用真实浏览器跑（见 `pnpm test:browser`）——
 * 用 jsdom 假装一个 IndexedDB 只会测出"假实现对不对"。
 */
export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // 用例都在 tests/ 下，统一 *.test.ts；harness.ts 是被它们 import 的夹具
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 单个文件里连着跑几百条断言，默认 5s 不够（懒加载用例还要等 setTimeout）
    testTimeout: 20_000,
    // 用例之间共享一个模块缓存即可：它们各自建自己的假 store，没有全局状态
    isolate: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        // 只有一张类型表，没有可执行分支
        'src/core/types.ts',
      ],
      /**
       * 阈值是"棘轮"，不是"目标"：定在当前水位略低一点，只允许往上走。
       *
       * 为什么不是 80：Node 侧用例覆盖的是 core / domain / adapters 的纯逻辑
       * （core 93%、domain 86%、ports 100%），而 state / components / viewer
       * 这三个目录需要 DOM、WebGL 和真实的用户输入，它们在
       * `scripts/browser/*.mjs` 里由真实浏览器走查 —— 那部分不产生这里的
       * 覆盖率数字。把全局阈值写成 80 只会逼着大家排除目录，反而失去意义。
       *
       * 实测水位（2026-11，1051 条断言）：语句 52.9 / 分支 47.3 / 函数 54.6 / 行 54.3。
       * 提高任何一项之前，先看 `pnpm test:coverage` 的分目录明细。
       */
      thresholds: {
        statements: 52,
        branches: 46,
        functions: 54,
        lines: 54,
      },
    },
  },
})

import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import prettier from 'eslint-config-prettier'
import globals from 'globals'

/**
 * ESLint 扁平配置（flat config，ESLint 9/10 的默认形态）。
 *
 * 取舍说明：
 *  - 只开 `recommended`，不开 `recommendedTypeChecked`。类型感知规则要跑完整
 *    的 TypeScript 程序，107 个 .ts 全量 lint 会从 3 秒变成 40 秒以上；类型
 *    正确性交给 `pnpm typecheck`（vue-tsc，strict 全开），两者职责不重叠。
 *  - 格式规则全部交给 Prettier（最后一项 `prettier` 关掉所有冲突规则）。
 *    ESLint 只回答"这样写有没有 bug"，不回答"缩进几个空格"。
 *  - `--max-warnings 0`（见 package.json）：warning 也是失败，避免
 *    "反正能过"的告警一攒几百条。
 */
export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'public/**',
      'docs/**',
      '.workbuddy/**',
      // 测试打包中间产物（旧流程留下的，仍在 .gitignore 里）
      'tests/.*.bundle.mjs',
      'scripts/**/*.py',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],

  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // 单文件组件名（Stage.vue / TopBar.vue）本来就该短；应用不是组件库，
      // 这个规则是为"防和原生标签撞名"设计的，这里没有那个风险
      'vue/multi-word-component-names': 'off',
      // props 的默认值由 TS 的可选属性 + 调用方保证，Vue 的 default 在这里只会重复一遍
      'vue/require-default-prop': 'off',
      // 模板属性顺序是纯排版问题，Prettier 不管，ESLint 管了只会让"把 v-model 写前面
      // 更好读"这种取舍变成 12 条 warning；helper 是 --max-warnings 0，一条都不能有
      'vue/attributes-order': 'off',
      // 未使用变量：允许 `_` 前缀显式表达"我知道它没用"
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // 空 catch 在本项目里是刻意的降级（IndexedDB 关了、广播通道没了），
      // 但必须写注释说明为什么可以吞 —— 有注释的块 ESLint 默认就放过
      'no-empty': ['error', { allowEmptyCatch: false }],
      // 生产代码里 console.log 只该是临时调试，随代码一起删；
      // info 留给"后台发生的事"（GC 回收了多少、预标注落盘失败），这类信息
      // 在控制台是可以保留的，也是排障时唯一能看到的线索
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
    },
  },

  {
    // Vue 单文件组件用 vue-eslint-parser 解析，<script lang="ts"> 交给 TS 解析器
    files: ['**/*.vue'],
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 2022,
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
      },
    },
  },

  {
    // 测试与脚本跑在 Node 里，console 是它们的输出通道
    files: ['tests/**/*.ts', 'scripts/**/*.mjs', '*.config.ts', '*.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      'no-console': 'off',
      // 测试里要造坏数据、要 `as any` 绕类型，这条规则只会逼人写更长的等价物
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  {
    files: ['scripts/browser/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },

  prettier,
)

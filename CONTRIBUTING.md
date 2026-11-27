# 贡献指南

这份文档写给**想改这个仓库的人**（包括几个月后的自己）。目标只有一个：让你在 5 分钟内知道
「改哪里、怎么验、什么不能碰」。

> 这是一个学习项目，不是生产平台。**能读懂、能验证**比「功能多」重要；如果一条改动
> 说不清怎么验证，就先别合。

---

## 1. 环境

| 要求 | 说明 |
|---|---|
| Node.js | `>= 20`（`package.json` 的 `engines`）；CI 用 22 |
| pnpm | **10.28.0**，走 corepack：`corepack enable` 之后 `pnpm -v` 应显示 10.x。系统里另装的 pnpm 9 与 `packageManager` 不一致，容易生成两套 lockfile 行为 |
| 浏览器 | 任意支持 WebGL2 的现代浏览器；`test:browser` 额外需要本机 Edge（不下载 Playwright 浏览器） |

```bash
corepack enable
pnpm install
pnpm dev            # http://127.0.0.1:5173
```

Windows 上如果 `pnpm <script>` 报 `EPERM ... spawnSync`，多半是安全软件拦了管道；
用 `pnpm exec <bin>` 或 `node node_modules/.bin/<bin>` 绕开即可（CI 上没有这个问题）。

---

## 2. 提交前必跑：`pnpm verify`

```bash
pnpm verify   # lint + format:check + typecheck + check:layers + test + build + size
```

它按「便宜的先跑」排列，任何一步失败都会立刻停。**不要只跑 `pnpm test` 就提交**：
`vitest` 不检查模板里的 Vue 表达式、不做类型检查、也不管打包体积。

### 命令对照

| 命令 | 作用 | 什么时候用 |
|---|---|---|
| `pnpm dev` | 开发服务器 | 改 UI |
| `pnpm lint` | ESLint 10 flat config，`--max-warnings 0` | 改完代码 |
| `pnpm format` | Prettier 3 全仓写盘（`format:check` 只检查） | 提交前 |
| `pnpm typecheck` | `vue-tsc --noEmit`（连 `.vue` 模板一起查） | 改了类型或 props |
| `pnpm check:layers` | 分层约束的机器校验（见第 3 节） | 改了 import 关系 |
| `pnpm test` | 分层校验 + 1056 项断言 + 覆盖率阈值 | 改完逻辑 |
| `pnpm test -- <name>` | 只跑一支（`core` / `domain` / `p0` / `p2` / `p3` / `studio` / `task` / `vla` / `cloud-io`） | 迭代单支用例 |
| `pnpm test:browser` | 13 支真实浏览器用例（IndexedDB / WebGL / 跨标签页 / 点云着色） | 改了持久化、懒加载、时间线、跨标签页、任务面板、着色与格式解析 |
| `pnpm build` | `typecheck` + `vite build` | 改完 UI / 依赖 |
| `pnpm size` | `size-limit` 体积预算（主包 160 kB / three 140 kB / css 12 kB，gzip） | 加了依赖或大模块 |

`test:browser` 要另开一个终端：

```bash
corepack pnpm dev --port 5199 --strictPort   # 终端 A
corepack pnpm test:browser                   # 终端 B
# 已起在别的端口/地址：APP_URL=http://127.0.0.1:5173/ pnpm test:browser
```

---

## 3. 分层约束（会被 CI 拦下）

```
core     纯数据与纯函数（不 import vue / three / domain）
domain   纯 TS 内核（不 import 任何 UI：无 .vue、无 state、无 viewer）
ports    接口定义（不依赖实现）
adapters / state / components / viewer   允许向下依赖
```

- 校验脚本：`scripts/check-layers.mjs`（`pnpm check:layers`）。
- **`core` 不认识类别表、不认识 IndexedDB、不认识 DOM**。需要「按类别取色」这类能力时，
  把数据从上层传进来（例如 `colorize.ts` 只处理 `intensity` / `height`，`semantic` 交给调用方）。
- 想加新能力时先问：它是纯计算（core）、业务流程（domain）、外部世界（adapters）、
  还是界面状态（state）？放错层会让测试变难，而测试是这个项目唯一的正确性保证。

---

## 4. 加功能的典型路径

**新点云格式**（例如 `.las`）：

1. `src/core/io/las.ts` 写解析器，输出 `PointCloud`（参考 `ply.ts` / `bin.ts`）；
2. 在 `src/core/io/cloud.ts` 的 `detectCloudFormat` / `parseCloudBuffer` 里登记嗅探与分发；
3. `src/domain/model/scene.ts` 的 `codec` 联合类型加一项；
4. `src/components/TopBar.vue` 的文件输入 `accept` 加扩展名；
5. `tests/cloud-io.test.ts` 补断言（含「坏文件报错文案」），`scripts/browser/color.mjs` 里补一次真拖入。

**新任务类型**：`src/domain/model/task.ts` 的 `TaskKey` + `TaskAdapter` 注册表；
面板在 `src/components/panels/`；别忘了 `crossTask.ts` 的一致性规则。

**新界面能力**：状态放 `src/state/useXxx.ts` 并接到 `useStudio.ts` 的返回值上，
组件里 `inject(StudioKey)` 解构。**别在组件里自己创建全局状态**。

---

## 5. 测试约定

- 断言器是 `tests/harness.ts` 的 `createChecker()`：

  ```ts
  const { check, finish } = createChecker()
  check('说明', cond, cond ? '' : '失败时的现场')
  it('……全部断言通过', () => {
    finish()
  })
  ```

- 断言是**顺序执行、失败不中断**（这正是它从 8 支自研脚本迁过来时保留的语义：
  一次跑完能看到全部失败，而不是只看第一条）。`finish()` 用 `expect(failures).toEqual([])` 收尾，
  所以失败会带上逐条 diff。
- 断言名写**行为**不写实现（「同名 JSON 配到对应帧」而不是「labels.find 返回非空」）。
- 断言 `Float32Array` 里的值要带误差（`Math.abs(a - b) < 1e-6`）；`===` 比 float 字面量必红。
- 覆盖率是棘轮：**只许上调**。提高之前先看 `pnpm test:coverage` 的分目录明细，
  别把 `src/state` / `src/viewer` 拉进 include 去凑数 —— 那两层归 `test:browser`。
- **不要**为了过覆盖率去测 `src/state`、`src/viewer` —— 那两层需要真实 DOM/WebGL，归 `test:browser`。

浏览器用例（`scripts/browser/*.mjs`）：

- 每支自己 `check` 收集结果，末尾打印 `===== N 通过, M 失败 =====` 并以退出码表态；
- 选择器**别绑在 `accept`、文案这类会变的东西上**，用 `data-role="…"`；
- 涉及后台定时器的用例先 `waitForTimeout` 等它落定，别跟产品里的 `setTimeout` 抢先后（`gc.mjs` 踩过）。

---

## 6. 为什么 `build` 不能省

Prettier 会把过长的属性折行。Vue 模板里**多语句**的事件处理器（`@click="a = 1; b()"`）
被折成两行后，编译期会被当成一个表达式解析而失败：

```
[vite:vue] Error parsing JavaScript expression: Unexpected token, expected ","
```

`eslint` 与 `vue-tsc` 都**不报**这个错，只有 `vite build` 会炸。所以：

- 多语句处理器写成具名函数（`ToolRail.vue` 的 `pickSelect()` / `pickDraw()` / `toggleOrtho()` 就是为此改的）；
- 改了 `.vue` 就顺手跑一次 `pnpm build`。

---

## 7. 提交信息

`.gitmessage` 里的类型前缀：`feat` / `fix` / `refactor` / `perf` / `test` / `docs` / `chore` / `ci`。

```
fix(pcd): 头部声明点数按实际数据量钳制

坏文件声明 1e9 点会让 Float32Array 直接申请 12GB。
现在按 (byteLength - offset) / pointStep 夹紧，并跳过非有限坐标。
```

- 一条提交只做一件事；纯格式化（Prettier 全仓）单独一条提交，别和数据改动混在一起。
- 破坏导出格式的改动要在 `CHANGELOG.md` 里写「不兼容」。

---

## 8. 不要提交什么

- `dist/`、`coverage/`、`node_modules/`、`*.tsbuildinfo`（`.gitignore` 已覆盖）；
- 真实客户数据、`datasets/`、`.bin` / `.pcd` 大文件（示例数据在 `public/data/`，已有第三方声明）；
- 调试用的 `console.log`（`info`/`warn`/`error` 允许，其余会被 lint 拦）；
- 你自己的 `.vscode/` / `.idea/` / `.workbuddy/` 配置（已 gitignore，但注意别强加）。

---

## 9. PR 检查清单

- [ ] `pnpm verify` 全绿
- [ ] 改了交互/持久化时，`pnpm test:browser` 全绿
- [ ] 新增行为有断言；修 bug 的提交能说清「原来错在哪、断言怎么兜住」
- [ ] 没有为了过测试改断言（断言是契约，不是装饰）
- [ ] 没破坏分层（`pnpm check:layers`）
- [ ] 体积没有超预算（`pnpm size`）；真需要加依赖时在 PR 里说明理由
- [ ] 新功能的「不做/做不到」写进文档，而不是留在脑子里
- [ ] 中文文档与代码同步（`docs/` 与 `README.md` 都被读者当契约）

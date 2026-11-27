# ⑫ 现状评审：与社区成熟工具的差距，以及优化清单

> 评审对象：`label-tool@0.1.0`（本机一次性全量取证，2026-11）。
> 文中所有数字都是实测值，不是估计：断言数来自 `pnpm test`，体积来自 `vite build` + `size-limit`，
> 覆盖率来自 `vitest --coverage`。§8 的「已落地」条目都附了验证命令。
>
> 这份文档和 01–11 的关系：01–11 讲「怎么做的」，这里讲「还差什么、差在哪、值不值得补」。
> 写它的直接动机是回答一个问题 —— **这个项目和 CVAT / Supervisely / Segments.ai 这类工具比，
> 到底差在哪一层**。答案不是「功能少」，而是「能力层不弱、产品层和工程层差得远」。

---

## 0. 对照基准与取舍

| 对照对象 | 为什么选它 |
|---|---|
| **CVAT**（cvat.ai / cvat-ai/cvat） | 开源标注的事实标准。3D 点云 cuboid、投影视图、语义分割、QC（GT job / honeypot / consensus）都有，是「功能完整性」的标尺 |
| **Supervisely** | 3D 工具箱最细的一个：Cuboid / Smart Tool / Point Cloud Pen / Measure Distance，多相机与 sensor fusion 是产品级能力 |
| **Segments.ai** | 把「数据集 → 样本 → 标签 → 版本化 release → Python SDK/REST」这条链做成产品的样本，是「平台化」的标尺 |
| **SUSTechPOINTS** | 本项目的交互原型来源（学术开源）。它证明 3D 框标注的核心交互不需要大框架，也说明学术工具在工程侧的普遍短板 |

对照维度只取**「一个标注工具能否被真实团队用起来」**的判断标准（数据能进来、标得动、
标得对、存得下、查得到、改得动、多人协作、可持续维护），不比功能条目数量 —— 比数量这个项目其实不虚，
比「每一层都闭合」差得远。

---

## 1. 十维对照表

| # | 维度 | 本项目 | 社区成熟工具 | 差距性质 |
|---|---|---|---|---|
| 1 | 3D 框标注 | 三视图 + 3D 视口、两步画框、手柄编辑、自动拟合、PCA 朝向、锁定/隐藏/排序 | 同等，且有快捷键方案、吸附、智能框选（Supervisely Smart Tool） | 体验细节 |
| 2 | 点云格式 | PCD（ascii/binary）、XYZ、KITTI/DAIR-V2X/nuScenes/Waymo/SUSTech 适配 | PCD/PLY/LAS/LAZ/BIN、rosbag 直读、COPC 流式 | **能力缺口** |
| 3 | 语义/实例分割 | 逐点语义（SemanticKITTI 34 类，learning_map，高低 16 位） | 同等 + 画笔/套索/超像素/模型预分割 | 编辑工具少 |
| 4 | 时序 4D | Track/关键帧、跨帧传播、插值、遮挡三态、Kalman + Hungarian、时序质检 | CVAT 有 track 但跟踪弱；Supervisely 有 video tracking | **这张牌本项目更强** |
| 5 | 多任务 | 框/语义/占据/光流/lane/VLA 六类注册表，占据与光流有真值派生 + 一致性校验 | 多数工具只有框 + 分割；VLA 这类几乎没有 | **本项目更前沿** |
| 6 | 预标注 | 3 个 provider（mock/http/file）+ 复核闸门 + IoU 关联 | 普遍接真实模型服务（CenterPoint、SAM、自研推理集群） | 缺真服务 |
| 7 | 存储 | 单机：IndexedDB + 内容寻址 blob + 引用计数 GC + 跨标签页租约 | 服务端对象存储 + 元数据库 + 版本化 | **架构缺口** |
| 8 | 质量与流程 | IoU/kappa/F1/漏误标/健康分**指标齐全**，但没有抽检→打回→返修的流程闭环 | CVAT QC（GT/honeypot/consensus）、Segments 的 labelset + review 状态机 | **流程缺口** |
| 9 | 权限与协作 | 无（单机 + 同机多标签页租约） | 组织/角色/任务分配/审计日志 | **架构缺口** |
| 10 | 工程基建 | lint / format / typecheck / 1056 断言 / 覆盖率棘轮 / bundle 预算 / 依赖自动化 / CI（本轮补齐） | 同类 | 追平（但 e2e 未进 CI） |

一句话总结这张表：**第 4、5 行是这个项目真正稀缺的部分**（4D 真值内核 + 多任务一致性），
第 2、7、8、9 行是「工具 → 平台」的四道坎，第 1、3 行是打磨，第 10 行本轮已补齐。

---

## 2. 问题域 A：数据进出（最影响「能不能用」）

### A1 格式生态窄

`src/domain/model/scene.ts` 里点云的 codec 只有三种：

```ts
codec: 'pcd-bin' | 'pcd-ascii' | 'xyz-f32'
```

现实里团队手上的数据是 `.bin`（KITTI velodyne 裸 float32）、`.ply`、`.las/.laz`（测绘）、`.bag`
（ROS）。前三者都是「读一个字节数组 + 一个 stride」的活，成本远低于已经做完的 4D 内核，
**这是投入产出比最高的一块缺口**。`.bag` 才需要真解码器（要不要做值得单独讨论）。

另外 `binary_compressed` 直接抛错：

```ts
throw new Error('binary_compressed 编码暂未支持，请用 PCL 转存为 ascii 或 binary')
```

这个错至少在错误信息里给了出路，可接受；但它意味着 PCL 默认保存的某些数据集打不开。

> **现状（P1 第一批已改）**：新增 `src/core/io/bin.ts`（KITTI Velodyne `.bin`，按字节数猜 3/4 个
> float，优先 4）与 `src/core/io/ply.ts`（PLY ascii + `binary_little_endian`，属性按**名字**查偏移，
> 所以 `x red y green z blue` 这种乱序也读得对），再由 `src/core/io/cloud.ts` 统一嗅探分发
> （PLY 靠魔数、PCD 靠 `FIELDS`+`DATA` 行、`.bin` 靠扩展名兜底），worker / 主线程 / 本地文件三处
> 共用 `parseCloudBuffer`。`.las/.laz/.bag` 仍未做（见 §10 取舍）。
> 代码位置：`src/core/io/cloud.ts` 的 `detectCloudFormat` / `parseCloudBuffer`。

### A2 intensity 读进来就丢

`src/core/types.ts` 的 `PointCloud` 只有位置、颜色、语义、实例：

```ts
export interface PointCloud {
  positions: Float32Array
  count: number
  colors?: Uint8Array
  labels?: SemanticLabels
  instances?: Uint32Array
  semanticClasses?: SemanticClassDef[]
}
```

PCD 里的 `intensity` 在解析时被跳过。**后果**:不能按强度/高度着色 —— 而「按高度着色」是激光点云
标注里最常用的一眼判断深度的手段（CVAT、Supervisely、SUSTechPOINTS 全有）。
补一个可选的 `intensity?: Float32Array` + 一个 `pointColorBy: 'height' | 'intensity'` 分支，
是几十行的活。

> **现状（P1 第一批已改）**：`PointCloud` 加了 `intensity?: Float32Array`，PCD（字段名
> `intensity` / `reflectance` / `i`）、PLY（同族别名）与 `.bin`（stride 4）三条链路都填充它；
> `src/core/geometry/colorize.ts` 提供 `scalarRange`（2%~98% 分位裁剪，避免离群点压平色带）+
> `rampColor`（turbo / viridis）+ `heightsOf`（取 z，本项目 z-up），3D 视口与三视图共用同一份
> 判定，右侧「点云」段多了「强度」（无 intensity 的数据不显示）与「高度」两个按钮。

### A3 类别是字符串，不是 schema

`Box3D` 的类别是名字字符串，属性是自由字典：

```ts
label: string
attributes?: Record<string, string | number | boolean>
```

没有「标注规范」这一层：类别清单没有版本、没有必填属性、没有取值域、没有「这个类别不允许有 yaw」这类约束。
真实外包作业里，**规范漂移是返工的第一大来源**（同一个「卡车」有人写 `truck` 有人写 `卡车`）。
社区做法是 label schema（Segments 的 labelset、CVAT 的 label 配置）与导出时校验。

### A4 ASCII PCD 的解析路径

`src/core/io/pcd.ts` 的 ascii 分支把整个数据段一次性 `body.split(/\s+/)` 成 token 数组。
100 万点 = 400 万 token ≈ 数百 MB 瞬时字符串对象，再逐个 `Number()`。
这次 P0 已经补了「头部声明点数 vs 实际数据量」的校验与 NaN 过滤（见 §8-⑦），
但「全量 token 化」本身还在 —— 大 ascii 文件会明显卡顿甚至 OOM。逐行流式解析是正解。

---

## 3. 问题域 B：渲染与性能

这一节是「同一个数据集在别人机器上不卡、在我这卡」的那类问题。

### B1 正交视图每次滚轮全量重扫点云

`src/components/OrthoView.vue` 的点云层是 CPU 逐点写像素：

```ts
const img = ctx.createImageData(w, h)
for (let i = 0; i < props.cloud.count; i++) { /* 逐点算屏幕坐标并写像素 */ }
```

而 `onWheel` → `zoomAround` 会把 `cloudDirty = true` 并立刻 `redraw()`。
**每个滚轮 tick 都重扫全部点**。67k 点（示例数据）无感，100 万点会掉到个位数帧率。
平移做了优化（拖动期间只位移位图，松手才重建），缩放没有 —— 因为缩放的缩放是「非整数重采样」，
直接位图缩放会糊。可用方案：缩放时先位图近似（糊一帧），停手 150ms 后再精确重建。

### B2 3D 视口每框 4 个对象，且全部 `depthTest: false`

`src/viewer/PointCloudViewer.ts` 每个框建四份东西：线框 `LineSegments`、半透面 `Mesh(BoxGeometry)`、
朝向线、**一张 256×64 的 CanvasTexture 标签 Sprite**。N 个框 ≈ 4N 个 draw call + N 张纹理。
更关键的是线框/朝向/标签都设了 `depthTest: false`：

```ts
material.depthTest = false
```

好处是「框永远看得见」，代价是**遮挡关系不可读** —— 远处的框会画在近处框和点云之上。
社区工具（CVAT、Supervisely）默认是「被点云遮住的框仍可见但淡化」，而不是关掉深度测试。
正确做法是两套材质：选中/悬停的框提到最前，未选中的保持深度测试。

### B3 悬停拾取是 O(N) 且大量临时对象

`pickBox()` 每个框 `new THREE.Raycaster()`、`new THREE.Vector3()` ×3、`new THREE.Box3`、`ray.clone()`。
45ms 节流（`useStudio.ts`）挡住了最坏情况，但框多时仍然是 GC 压力。复用实例即可，改动很小。

### B4 缺失的健壮性兜底

- **没有 `webglcontextlost` / `webglcontextrestored` 监听**。全项目零匹配。
  GPU 驱动崩溃 / 显存被别的标签页吃掉时，canvas 会永久黑屏且没有任何提示，用户只能刷新（丢草稿）。
  这是「必做」级别的兜底，几十行：失联时禁用渲染循环 + 显示「图形上下文丢失，点击恢复」。
- **`new THREE.WebGLRenderer()` 没有 try/catch**。老机器 / 关闭硬件加速 / 远程桌面下会直接抛错，
  白屏。应该捕获后给出「本工具需要 WebGL2，请在浏览器设置里开启硬件加速」。
- **`requestAnimationFrame` 主循环永不停止**（`useStudio.ts` 里的 `animate()`），
  也没有 `document.hidden` 判断。后台标签页仍然每帧执行 `controls.update()` 与脏检查。

> **现状（P1 第一批已改前两条）**：`PointCloudViewer` 现在监听
> `webglcontextlost` / `webglcontextrestored`，失联时 `preventDefault()` 并置 `contextLost`
> 让 `render()` 直接返回（不 preventDefault 浏览器根本不会尝试恢复），恢复后重建点云与所有框、
> 相机不动；`new WebGLRenderer` 包了 try/catch，失败时 `viewerUnavailable` 落成一条可读提示
> 顶在视口上（三视图与标注不受影响），不再让整个 `onMounted` 中断白屏。
> **仍然没做**：主循环的 `document.hidden` 暂停（收益小、容易引入「回来不刷新」的怪状态）。

### B5 构建体积

实测（`vite build`）：

| 产物 | 原始 | gzip | brotli |
|---|---|---|---|
| `index-*.js`（主包） | 413.88 kB | 144.55 kB | 117.47 kB |
| `three-*.js` | 481.83 kB | 120.41 kB | 99.17 kB |
| `index-*.css` | 41.92 kB | 7.62 kB | 6.81 kB |
| `index.html` | 3.86 kB | 1.79 kB | — |

（P1 第一批新增 `.ply` / `.bin` 解析与标量着色后，主包 brotli 从 114.56 → 117.47 kB，
仍低于 160 kB 预算。）

已有 `manualChunks` 把 three/vue 拆出去（长期缓存友好），**但没有 code-splitting**：
帮助弹窗、时间线、占据/光流/VLA 面板这些低频界面都在主包里。首屏 JS 总量 ≈ 930 kB 未压缩。
本轮补了骨架屏（`index.html` 内联，见 §8-⑧）与 `size-limit` 预算，但没有做动态导入 ——
那是 P1 的活（把 VLA / 占据 / 相机运镜三块 `defineAsyncComponent` 掉，主包能再小 20–30%）。

---

## 4. 问题域 C：交互与可用性

### C1 只有鼠标

`OrthoView.vue` 的事件全是 `mousedown/mousemove/mouseup/wheel`。没有 Pointer Events，
没有 `touch`/`pen`，没有 pointer capture（鼠标拖出画布外靠 window 监听兜住，但触摸没有等价物）。
笔记本触屏 / 数位板 / 平板上不可用。改成 Pointer Events 是机械替换，但**要同时补
`setPointerCapture`、双指缩放、长按右键菜单**，工作量不小。

### C2 快捷键没有仲裁表

监听器分散在四处、全挂在 window 上：`useAnnotation.onKeyDown`、`onResizeShortcut`、
`onReviewKey`（capture）、`SampleList.vue`、`ReviewQueue.vue` 各自再注册一份。
没有优先级、没有「谁消费了」的统一出口。本轮只补了守卫（§8-⑤）与 Esc 的
`stopPropagation`（§8-⑥），**没有做注册表**。社区做法是集中式
`registerShortcut(key, handler, { scope, priority })`，同一套还能自动生成帮助弹窗里的表格
（现在帮助文案是手写常量，和代码是两份，天然会漂）。

### C3 无 i18n、无无障碍

- 文案全中文硬编码在模板与脚本里，无 i18n 库、无语言切换。对学习项目可接受，
  但「导出给别人用」时是第一道墙。
- 全项目无 `aria-*` / `role=` / `tabindex`。纯 canvas 交互本身也难做无障碍，
  但面板、按钮、对话框至少应该有语义标签与键盘可达性。

### C4 任务类型有洞

`TaskKey` 有六类，但 `lane` 的编辑器是空的：

```ts
export const laneAdapter: TaskAdapter<LaneTaskData> = {
  key: 'lane',
  label: '车道线',
  editor: '',      // ← 空字符串：注册表里有这个任务，但没有编辑界面
```

`src/domain/qa/crossTask.ts` 里自己也写了「lane 任务此刻只有"能不能存能取"的实现」。
也就是注册表里挂着一个**有数据模型、有校验、没有编辑界面**的任务 —— 这比没有更容易误导人。
要么补一个车道线编辑器（折线 + 三次样条，工作量中等），要么在 UI 上明确标「实验性 / 无编辑器」。

### C5 已知的体验欠账（README 自认）

- 多选后批量移动（现在只能逐个拖）
- 跨帧框选复制（现在只能整帧复制）

---

## 5. 问题域 D：健壮性清单

| # | 症状 | 触发条件 | 状态 |
|---|---|---|---|
| 1 | 后台标签页被抢走编辑权 | 浏览器把 `setInterval` 节流到 > 6s，租约心跳超时 | **已修**（§8-④） |
| 2 | 输入法打字把工具切了 | 拼音组词阶段 `key` 是候选字符 | **已修**（§8-⑤） |
| 3 | 画错的框只能画完再撤销 | 无中途放弃入口 | **已修**（§8-⑥） |
| 4 | 坏 PCD 触发巨额分配 / 全 NaN 点云 | 头部 `POINTS` 与实际不符 | **已修**（§8-⑦） |
| 5 | GPU 上下文丢失后永久黑屏 | 驱动崩溃、显存压力 | 未修（B4） |
| 6 | 老机器白屏无提示 | 无 WebGL2 / 关硬件加速 | 未修（B4） |
| 7 | 10 MB 以上 ascii PCD 卡顿 | `split(/\s+/)` 全量 token 化 | 未修（A4） |
| 8 | 文档与实现漂移 | docs/04、05 成文于「BEV 双视口」时期 | 部分（README 已注明适用范围） |

> 这次评审还额外踩到一个**工具链盲区**（记录在此，因为它解释了 §8-① 为什么必须把
> `build` 放进 CI）：`prettier --write` 会把过长的模板属性折行，而折行后的裸语句
> （`@click="tool = 'select'` 换行 `selectBox(null)"`）被 Vue 编译器当成单个表达式解析，
> **编译期直接失败**——但 `eslint` 与 `vue-tsc` 都不报错，只有 `vite build` 才炸。
> 已把这类处理器改成具名函数（`ToolRail.vue`）并在注释里写明原因。

---

## 6. 问题域 E：工程基建（本轮主要战场）

改之前的状态，逐项都是「社区工具都有、这里没有」：

| 项 | 改之前 | 社区基线 | 本轮 |
|---|---|---|---|
| Lint | 无 ESLint，无任何代码风格约束 | 有 | ✅ ESLint 10 flat（TS + Vue + Prettier 三层） |
| 格式化 | 无 | 有 | ✅ Prettier 3（129 文件一次性格式化） |
| 测试框架 | 8 支自研 `check()` 脚本 + esbuild 手打包 | Vitest/Jest | ✅ Vitest 5 + v8 覆盖率 |
| 覆盖率 | 无 | 有阈值 | ✅ 棘轮阈值（语句 51 / 分支 45 / 函数 53 / 行 53） |
| CI | install → typecheck → test → build | + lint + coverage + 体积 | ✅ 7 步，含 bundle 预算与覆盖率产物 |
| 依赖更新 | 无 | Dependabot/Renovate | ✅ Dependabot（npm + actions，分组） |
| 体积预算 | 无 | size-limit 类 | ✅ 三条 gzip 预算 |
| 社区文件 | 只有 README/LICENSE | CONTRIBUTING/CHANGELOG/issue 模板 | ✅（见 §8-⑩） |
| 浏览器用例进 CI | 不进（`test:browser` 要手动起 dev server） | Playwright in CI | ❌ 留 P1 |

**仍然缺的一块是 e2e**：`scripts/browser/` 下 13 支用例（`gc` `load` `color` `timeline` `docfirst`
`collide` `crosstab` `library` `lru` `evict` `p2` `task` `vla`，共 363 项断言）覆盖的正是单测覆盖不到的
IndexedDB / WebGL / 文件选择 / 跨标签页协作，但它们**不在 CI 里**，因为
「要真实 IndexedDB + WebGL + 文件选择，每次十几秒到几分钟」，而且刻意不把 Playwright 列为依赖
（复用本机 Edge）。这是个合理的取舍，但长期应该拆成 `pnpm test:browser:ci` 一组核心用例进 CI。

> **为什么 P1 第一批仍然没把 e2e 塞进 CI**（不是懒）：`scripts/browser/_pw.mjs` 用
> `channel: 'msedge'` 复用系统 Edge，而 `ubuntu-latest` 上没有 Edge；`_pw.mjs` 的三级解析
> （项目依赖 → `PLAYWRIGHT_PATH` → npx 缓存）在 CI 里要靠最后一级，装什么、落在哪个路径
> 都不可预知。**本机无法验证 GitHub Actions 跑出来的结果**，与其交一个「看着绿其实没跑」
> 的 workflow，不如把理由写清楚留在本地手跑。

> 本轮把它们全跑了一遍，抓到一个**偶发失败**：`gc` 用例的第 6 步手动清扫断言
> `released > 0`，而挂载后 1500ms 的启动清扫判的是同一批垃圾 —— 谁先跑谁收，
> 快机器上启动清扫先收完，手动清扫如实报 0，断言就红了。**测试写法问题，不是产品 bug**，
> 但正好说明「e2e 进 CI 之前必须先把这类时序假设去掉」。改法是：等启动清扫落定，
> 再注入一条新的死数据集帧键，让手动清扫只可能收它一条。

---

## 7. 问题域 F：架构与可维护性

### F1 `useStudio` 是上帝门面

995 行，返回值把九个命名空间全部 spread 平铺：

```ts
return { ...core, ...annotation, ...dataset, ...sequence, ...quality, ...camera, ...library, ...preAnnotation, ...tasks, ...vla }
```

所有组件 `inject(StudioKey)` 之后随便解构 —— 依赖关系完全隐式，改一个字段名要靠 `vue-tsc` 兜。
P1 应该按「视图需要什么」切几个 context（`StudioDocContext` / `StudioUiContext` / `StudioTaskContext`）。

### F2 两套撤销栈并存

老 `core/history.ts` 的 `HistoryStack<Box3D[]>`（整帧快照，limit 100）与新
`domain/store/commandHistory.ts` 的 `CommandHistory`（命令差异，limit 500 + 审计环 2000）
同时存在，`mutate()` 里按「有没有 store」分叉，注释自称「双写期」：

```ts
// 有 store：beginEdit → fn → diffAfter → exec → materialize
// 无 store：history.commit(cloneBoxes(boxes.value), ...)
```

这是**已知技术债**，不是设计意图。收尾条件是「store 在所有启动路径下都存在」，然后把旧栈删掉。

### F3 每次编辑 3–4 次整帧物化

`mutate()` 一次编辑要走 `beginEdit` → `diffAfter` → `exec` → `materialize` → `refreshFrameBoxes`。
单帧几十个框时无感；1080 帧全选批量操作时是主要成本。P1 可做增量物化（只写 diff 影响的 track）。

### F4 文档漂移

docs/04、05 写于「BEV 双视口」时期，现在是「单 3D 视口 + 三个独立 2D canvas 正交视图」。
README 里已注明「仅原理部分适用」，但文档读者不会先读 README。**修文档比写文档更容易被跳过，
所以要么改，要么在文件头明确写「本文已过时」**。

---

## 8. 已落地（本轮 P0，逐条附证据）

> 全部未提交前的对照：`git diff --stat` 覆盖 130+ 文件（其中 129 个是 Prettier 纯格式）。

| # | 问题 | 做法 | 证据 |
|---|---|---|---|
| ① | 无 lint / format | ESLint 10 flat + Prettier 3；规则只开「会出真 bug」的那批（`vue/no-dupe-keys` 抓到一个真 bug，见下） | `pnpm lint` EXIT=0（`--max-warnings 0`） |
| ② | 自研断言框架 | 8 支 checker → `tests/*.test.ts` + `tests/harness.ts`（保留「顺序执行、失败不中断」语义，不重写 1005 条断言） | `vitest run`：8 files / 8 tests 通过，断言数不变 |
| ③ | 无覆盖率 | `@vitest/coverage-v8` + 棘轮阈值 | 语句 52.13 / 分支 46.55 / 函数 54.09 / 行 54.21 |
| ④ | 后台标签页丢编辑权 | `visibilitychange` + `pageshow` 时立即补心跳 / 重新抢租约 | tabBus 单测仍绿 |
| ⑤ | 输入法 / 弹窗抢快捷键 | `shouldIgnoreShortcut()`：`INPUT/TEXTAREA/SELECT` + `isContentEditable` + `isComposing`/`keyCode 229` + `[data-modal]` | `pnpm typecheck` / `lint` 通过 |
| ⑥ | Esc 不能取消绘制 | `OrthoView.cancelDrag()`：拖拽/缩放/旋转时把起始快照再提交一次（父级按 id 覆盖 = 回滚） | 同上 |
| ⑦ | 坏 PCD 巨额分配 | 头部声明点数按实际数据量钳制 + NaN 跳过 + 收紧数组长度；顺手修了 ascii+rgb 颜色恒为 0 的老 bug | pcd 相关断言绿 |
| ⑧ | 首屏白屏 | `index.html` 内联骨架屏（不依赖任何 JS/CSS，`prefers-reduced-motion` 关动画） | 构建产物 `index.html` 3.86 kB |
| ⑨ | 无体积预算 | `size-limit` 三条：主包 160 kB / three 140 kB / css 12 kB（gzip） | 实测 114.56 / 99.17 / 6.72 kB（brotli） |
| ⑩ | 无社区文件 | `CONTRIBUTING.md`、`CHANGELOG.md`、`.github/ISSUE_TEMPLATE/*`、`.gitignore` 加 `coverage/` | 见仓库根目录 |

**① 抓到的一个真 bug**：`OrthoView.vue` 里局部变量 `hoverId` 与同名 prop 冲突，
模板里会静默遮蔽 prop（悬停高亮时灵时不灵）。这类问题任何测试都测不到，只有 lint 规则能抓。

**⑦ 顺带修的一个真 bug**：ascii 编码 + 带 rgb 字段的 PCD，颜色分支从来没有被填充过
（binary 分支有、ascii 分支漏了），所以彩色点云在 ascii 文件里恒为纯色。

### 8b. 已落地（P1 第一批，2026-11 追加）

| # | 项 | 做法 | 证据 |
|---|---|---|---|
| ⑪ | WebGL 上下文丢失 | `webglcontextlost` 里 `preventDefault()` + `contextLost` 短路渲染；`restored` 后重建点云与所有框，相机不动 | 代码在 `PointCloudViewer.onContextLost/onContextRestored` |
| ⑫ | WebGL 初始化失败白屏 | `new WebGLRenderer` 包 try/catch → `viewerUnavailable` + 视口上的可读提示，三视图继续可用 | `Stage.vue` 的 `.viewport-fallback` |
| ⑬ | 格式只有 PCD | 新增 `.ply`（ascii + binary_little_endian，属性按名字查偏移）与 KITTI `.bin`（stride 3/4 自动判定）；`src/core/io/cloud.ts` 统一嗅探分发 | `tests/cloud-io.test.ts` 51 条断言；浏览器 `color.mjs` 真拖一个 `.ply` 进页面 |
| ⑭ | intensity 读完即丢 | `PointCloud.intensity` + PCD/PLY/.bin 三链路填充 + `colorize.ts`（2%~98% 分位裁剪、turbo/viridis、取 z 作高度） | 3D 与三视图同步支持 `intensity` / `height` |
| ⑮ | 部署产物没经过预算 | `deploy.yml` 删除，CI 改成 verify → build（含 `pnpm size` + 上传 `dist`）→ deploy 复用同一份产物 | `.github/workflows/ci.yml` 三段 job |
| ⑯ | 测试选择器绑在 accept 上 | 文件输入加 `data-role="cloud-input"`，用例不再依赖 `accept` 的值 | 13 支浏览器用例全绿 |

本轮回归数字：`pnpm lint` / `format:check` / `typecheck` EXIT=0；`vitest` **9 files / 9 tests，
1056 条断言**（净增 51）；覆盖率 53.0 / 47.4 / 54.7 / 54.4（阈值同步上调到 52/46/54/54）；
`vite build` 5.98s；`size-limit` 117.47 / 99.17 / 6.81 kB brotli；浏览器用例 **13 支 363 项**。

---

## 9. 路线图（P0 与 P1 第一批已完成，以下是剩余项）

### P1：把「工具」补成「能交付的工具」

| 状态 | 项 | 说明 |
|---|---|---|
| ✅ | **WebGL 上下文丢失与降级**（B4） | 见 §8b-⑪⑫ |
| ✅ | **`intensity` + 按高度/强度着色**（A2） | 见 §8b-⑭ |
| ✅ | **`.bin` / `.ply` 解码**（A1） | 见 §8b-⑬ |
| ⬜ | **Pointer Events 迁移**（C1） | 要同时补 `setPointerCapture`、双指缩放、长按右键菜单；触碰交互主流程，单独一轮做 |
| ⬜ | **e2e 核心用例进 CI**（§6） | 卡在「CI 上没有 Edge、本机验证不了 Actions」，理由见 §6 引用块 |
| ⬜ | **主包动态导入**（B5） | VLA / 占据 / 相机三块 `defineAsyncComponent`，预期主包再小 20–30% |
| ⬜ | **快捷键注册表**（C2） | 顺带自动生成帮助表格，消灭「帮助文案与代码两份」 |
| ⬜ | **删掉旧撤销栈**（F2） | 前提是「store 在所有启动路径下都存在」，要先补一个内存 store 顶替 `history` 的兜底分支 |
| ⬜ | **正交视图重绘节流**（B1） | 每 wheel tick 全量重扫 + `deep` watch 无 rAF 合并；改法明确（分层缓存 + `requestAnimationFrame` 合帧），但要先有 100 万点的 profile 数据 |

### P2：把「能交付的工具」补成「平台」

9. **label schema + 导出校验**（A3）
10. **存储后端化**：ports 层已经留好了（`dataSource` / `documentStore` / `blobStore` / `preAnnotation`），
    缺的是 HTTP 实现 + 服务端；这是 README 里「阶段 3」的全部内容
11. **质检流程闭环**：抽检 → 原因码打回 → 返修 → 通过率（指标已齐，缺状态机与 UI）
12. **权限与审计**（服务端前置）
13. **lane 编辑器**（C4）—— 折线 + 样条
14. **真实预标注服务**（第 6 维）—— 现在三个 provider 里 http 那个是通用的，缺的是具体模型契约

---

## 10. 明确「不做」的取舍

写在这里是为了避免下次评审再提一遍：

| 取舍 | 理由 |
|---|---|
| 不做后端、不做多用户 | 定位是学习项目；ports 层已经把替换点留出来，文档写清楚比假装做了更诚实 |
| 保留整帧快照撤销（旧栈暂存） | 框是小对象，快照比差量命令省心；等序列级操作进历史再换 |
| 正交视图用 CPU 逐点画，不开三个 WebGL 视口 | 三份 BufferGeometry 的显存/上传成本高于一次 ImageData；LOD 已在导入侧做（体素下采样） |
| 不引入 UI 组件库 | 界面元素总量可控，引入组件的体积与定制成本高于收益 |
| 不把 Playwright 列为依赖 | 复用本机 Edge，避免 200MB 浏览器下载；代价是 e2e 只能在本地跑（见 §6） |
| 不做 `.las/.laz` 与 ROS `.bag` | 前者要 LASzip，后者要整套 ROS 反序列化 —— 都不是「读字节数组 + stride」，与 `.ply`/`.bin` 不是一个量级的活 |

---

## 11. 已知的不确定性（别把下面的结论当成实测）

1. **性能结论是静态分析 + 复杂度推断**，没有在 100 万点的真机上做 profile（本机示例数据 67k 点）。
   B1/B2/B3 的「会卡」是按代码路径与对象数量推出来的，方向可靠，具体倍数未知。
2. **正交视图的逐点重建成本**受 `ImageData` 写入与 `putImageData` 的浏览器实现影响较大，
   不同 GPU/浏览器差异可能有数倍。
3. **覆盖率数字只代表 `core` / `domain` / `ports`**：`src/state`、`src/components`、`src/viewer`
   在 vitest 里近乎 0%，因为需要真实 DOM/WebGL。分目录实测 core 93.15% / domain 85.98% /
   ports 100% / adapters 50.18%。**不要用全局 52% 去判断「测得好不好」**。

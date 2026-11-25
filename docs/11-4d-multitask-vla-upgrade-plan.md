# ⑪ 从「画框工具」到「4D 多任务数据生产与验证基础设施」

> 本文是**改造技术方案**，不是已完成功能的说明。写作依据是 `docs/ref.md`（BEVFormer / UniAD / VLA 对标注平台的反向要求）与当前仓库的真实代码。
>
> 约束：**本轮不改代码**。文中每条"现状"判断都给出 `文件:行`，可以直接打开核对；每条改造都给出模块边界、数据结构、接口签名、文件清单与验收标准，供后续按阶段落地。
>
> 基线：写作时 `pnpm test` 227 项全过；当前 887 项全过、`pnpm build` 通过（落地进度与偏差见第 16–26 章，每章都写明"哪些做了、哪些没做、为什么"）。

**怎么读**

| 你的目的 | 直接看 |
|---|---|
| 判断"要不要这么改" | 第 0 章（结论、优先级、明确不做的事） |
| 核对"现状真是这样吗" | 2.2 的 20 条事实表（每条带 `文件:行`） |
| 评审数据模型 | 第 4 章（Track / Document / Command / Issue） |
| 安排开发计划 | 第 5 章（P0–P7）+ 第 10 章（排期） |
| 看算法实现 | 第 6 章（插值 / 占据 / 光流 / 合并 / 规则确定性） |
| 评估风险与回归 | 第 8、9、11 章 |
| 看已经落地了多少 | 第 16–26 章（P0 地基 → P1 内核 → 持久化 → 缓存回收 → P2 预标注 → P3 多任务） |
| 对照 ref.md 有没有漏 | 第 13 章 |

---

## 0. 结论先行

### 0.1 一句话判断

当前项目已经具备**单机 4D 标注的雏形**（跨帧同 id、轨迹插值、时序质检、遮挡三态），但它的"时间"是**约定**而不是**模型**：`Box3D` 里没有时间，`frames[i].boxes` 是唯一真值，跨帧操作不可撤销，任何新任务类型（Occupancy / 光流 / VLA）都要在 `FrameData` 上再挂一个平行数组。这个结构支撑不了 ref.md 要求的"多任务一致关联"。

因此改造顺序必须是：**先把时间和身份做成数据模型的一等公民，再把任务类型做成可注册的插件，最后才是预标注、衍生真值、VLA 和闭环**。反过来做（先加 Occupancy 面板、先接 VLA）会在 6 个月内产生三套互不兼容的真值。

### 0.2 工作流划分与 ref.md 的对应关系

| 工作流 | ref.md 的原始要求 | 当前差距 | 交付物 | 估算 |
|---|---|---|---|---|
| **P0 数据与文档地基** | （隐含前提）PB 级数据、版本可回溯 | 点云内联在内存、单草稿无版本、80MB 上限 | `DataRef` + `BlobStore` + 文档 v2 + 分层校验 | 2 人周 |
| **P1 4D 内核** | 优先级 1：底层数据结构先行的 4D/时序支持 | `id` 是字符串约定，历史按帧快照且切帧清空 | `TrackStore` + 可逆命令 + 关键帧插值 + 轨迹时间线 | 4 人周 |
| **P2 预标注接入** | 优先级 2：自动预标注接口标准化 | 只有 PCA 拟合，无模型消费端 | `PreAnnotationProvider` 端口 + 三种适配器 + 复核状态机 | 3 人周 |
| **P3 多任务与衍生** | 优先级 3：多任务一致性、从轨迹衍生 Occ/Flow | 只有框 + 逐点语义，两套真值互不关联 | `TaskRegistry` + Occupancy/Flow 衍生 + 跨任务一致性规则 | 6 人周 |
| **P4 VLA 对齐** | 优先级 4：语言—动作对齐标注与校验 | 完全没有时间轴上的语言与动作 | 指令段 + 动作通道 + 对齐校验 + 曲线编辑器 | 4 人周 |
| **P5 规则引擎** | "QA 应作为可配置规则引擎嵌入流水线" | `evaluateTemporal` 四条硬编码规则 + 一次性两版对比 | `QaRule` 注册表 + profile + 增量执行 + 41 条规则 | 2 人周 |
| **P6 闭环与难例** | 优先级 5：难例挖掘与规划相关性评估 | 只有单帧 IoU/kappa，无样本级排序 | 样本指标库 + 规划代理指标 + 难度分 + 回流包 | 3 人周 |
| **P7 协作/服务端（可选）** | 组织级协作、审计、任务流转 | 无后端、无权限、无任务状态机 | `DocumentStore` HTTP 适配器 + 乐观锁 + 审计流 | 4–6 人周 |

**P0–P6 合计约 24 人周**（1 人约 6 个月；2 人并行约 3 个月）。P7 依是否要多人协作决定，本文只做接口预留，不做实现承诺。

### 0.3 三条明确不做的事

1. **不自研 3D 检测/占据模型**。平台定位是 ref.md 说的"预标注模型的消费端"，不是模型方。我们只定义协议、合并不确定性、做人工复核。
2. **不做 PB 级存储**。浏览器端做的是"千帧级、GB 级"的本地闭环；PB 级通过 `DataSource` 端口外接对象存储，不在本期实现。
3. **不做逐格人工绘制 Occupancy**。AutoOcc 一类管线已经证明自动生成可行，人工只做**抽检、ROI 修正、一致性裁决**。

---

## 1. 参考文档的能力拆解

ref.md 的四个小节对应四种能力跃迁，落到工程上其实是六个可交付能力：

```
ref.md 论述                         工程能力                              本文落点
────────────────────────────────────────────────────────────────────────────────
BEVFormer 的 4D 标注           →   时间是一等公民：Track/Observation      P1
UniAD 的多任务联合优化          →   任务可注册、真值可关联                 P3
"轨迹注解自动衍生 OccFlow"      →   衍生管线 + 血缘（provenance）           P3
VLA 的视觉—语言—动作三元组      →   三条时间线对齐 + 专用校验               P4
预标注成为主线                  →   Provider 协议 + 合并策略 + 复核队列     P2
Kognic 的 90+ 项质量检查        →   规则引擎 + 原因码 + 可配置阈值          P5
"标注—训练—评测—回流"闭环       →   样本指标 + 难度分 + 回流包              P6
```

一句需要提前说清的话：**ref.md 描述的是工业平台的能力集合，不是单个前端仓库的改造清单**。本文把其中能在"浏览器 + 可选轻后端"范围内自洽实现的部分拆出来，剩下的用端口（interface）留出接入位，避免为了"看起来完整"而写一堆无法验证的假实现。

---

## 2. 现状盘点（每条都可核对）

### 2.1 现有分层与数据流

```
┌──────────────────────────────────────────────────────────────────────┐
│ components/    TopBar · ToolRail · Stage · OrthoView · RightPanel     │
│                CameraView · panels/*                                  │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ provide/inject（StudioKey）
┌───────────────────────────▼──────────────────────────────────────────┐
│ state/         useStudio（装配 + 自动保存 + URL 路由）                 │
│                studioCore（boxes/frames/历史/viewer 同步）             │
│                useAnnotation · useDataset · useSequence                │
│                useQuality · useCameraDirector                          │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ 纯函数调用
┌───────────────────────────▼──────────────────────────────────────────┐
│ core/          types · history · sample · semantics                   │
│                io/{pcd,label,session,calibration,formats/*}            │
│                geometry/{box,downsample}                              │
│                sequence/{sequence,temporalQA,tracker}                  │
│                quality/quality · camera/cameraTrajectory                │
└───────────────────────────┬──────────────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────────────┐
│ viewer/        PointCloudViewer（单个 WebGL 场景 + 按需渲染）          │
│                canvasPrimitives（正交视图复用）                        │
└──────────────────────────────────────────────────────────────────────┘
```

分层本身是对的（`core` 不依赖 Vue/Three），这也是本次改造最大的资产：**新增能力应该尽量落在 `domain`（复用 `core` 的算法），而不是继续往 `studioCore` 里堆字段**。

### 2.2 关键事实核对表

| # | 事实 | 代码位置 | 对改造的影响 |
|---|---|---|---|
| 1 | 标注对象的唯一真值是"每帧一个 `boxes` 数组" | `core/sequence/sequence.ts:24-28` | 时间维度靠"在数组里的下标"表达，无法表达跨帧身份与生命周期 |
| 2 | `Box3D.id` 是字符串，跨帧同 id 全靠约定 | `core/types.ts:40-52` | 没有类型级约束，重命名/合并/拆分轨迹都没有操作语义 |
| 3 | `visibility` 已存在且被质检使用（遮挡三态） | `core/types.ts:38`、`sequence/temporalQA.ts:105-109` | 已具备"观测状态"的最小雏形，可直接升级为 `ObservationState` |
| 4 | 当前帧是"工作副本"，切换帧时手工写回 | `state/useSequence.ts:50-53` | 任何新增标注类型都必须重复一次写回，漏一处就丢数据 |
| 5 | 当前帧写回逻辑有 **9 处副本**：`useSequence` 6 处 + `useAnnotation` 2 处 + `useStudio` 1 处 | `useSequence.ts:50/84/132/172/203/219`、`useAnnotation.ts:323/417`、`useStudio.ts:69` | 每加一种标注类型就多 9 次"漏改就丢数据"的机会 |
| 6 | 历史是"整帧 `Box3D[]` 快照"，上限 100 步 | `studioCore.ts:130`、`core/history.ts:60-79` | 内存 O(帧内框数)，跨帧操作无法用一份快照表达 |
| 7 | 切帧会清空历史 | `useSequence.ts:57` | 跨帧编辑无法撤销；用户实际感受是"改错了只能重来" |
| 8 | 插值 / 传播直接调 `resetHistory()`；遮挡演示经 `gotoFrame` 间接触发 | `useSequence.ts:136`、`useSequence.ts:185`、`useSequence.ts:235` | 4D 操作没有任何回退能力，与"精修"定位矛盾 |
| 9 | 持久化是单个 IndexedDB key，schema 版本 1 | `core/io/session.ts:38-49`、`98-124` | 没有多文档、没有版本、没有迁移链 |
| 10 | 超过 80MB 直接跳过自动保存 | `state/useStudio.ts:91-95` | 按 150k 点/帧、2.1MB/帧算，约 38 帧就触顶，与 4D 场景冲突 |
| 11 | 单帧质检 = 拿扰动副本和当前标注比 IoU/kappa | `state/useQuality.ts:48-59`、`quality/quality.ts:356` | 是"算法演示"，不是"流程质检"（没有规则、没有原因码） |
| 12 | 时序质检 = 4 条固定阈值规则 | `sequence/temporalQA.ts:78-82` | 阈值写死在函数签名默认值里，无法按项目/类别配置 |
| 13 | 关联算法（Hungarian + Kalman）已实现，但只用于演示 | `sequence/tracker.ts:57`、`190`、`347`；`useQuality.ts:74-94` | 算法可复用为"预标注合并"与"轨迹修复"，不需要重写 |
| 14 | 格式适配器统一以 `Box3D[]` 为出口 | `io/formats/types.ts:52-61` | 加 Occupancy/VLA 时无法复用这套嗅探-解析框架 |
| 15 | 预标注没有任何模型接口，只有 PCA 传统拟合 | `useAnnotation.ts:206-240`、`geometry/box.ts:136` | 需要从零定义 Provider 协议 |
| 16 | 逐点语义 + 跨帧实例 id 已全链路保留 | `semantics.ts:196-234`、`core/types.ts:110-117` | 这是 Occupancy 与"语义—框关联"的现成桥梁 |
| 17 | 渲染是单场景 + 签名缓存 + 脏标记 | `viewer/PointCloudViewer.ts:291-376`、`692-699` | 新增占据/光流层可以沿用同一套增量策略 |
| 18 | 启动路径只有 URL 参数与本地草稿 | `state/useStudio.ts:208-227` | 没有数据集列表、任务上下文的概念 |
| 19 | 测试是 headless 的纯 core 断言，227 项 | `package.json:21-22`、`tests/core-check.ts` | 新模块必须继续走这条路，否则回归成本失控 |
| 20 | 点云对象直接内联在 `FrameData` 里 | `sequence.ts:24-28`、`state/useDataset.ts:164-191` | 500 帧 × 15 万点 ≈ 1GB，必须改引用 + 懒加载 |

### 2.3 五个结构性瓶颈

**瓶颈 A：时间不是模型，是数组下标。**
`FrameData { index, cloud, boxes }` 能表达"这一帧有哪些框"，但表达不了"这个目标从第 12 帧进入、第 30 帧被遮挡、第 34 帧重新出现、第 40 帧离开"。这些信息现在被压缩成"某些帧的数组里恰好有同 id 的框"，一旦要问"这条轨迹的关键帧是哪几帧""哪些帧是插值来的""谁改的"，就只能靠遍历 + 猜。ref.md 要求的 4D 标注、Occupancy 衍生、VLA 对齐，全部需要这个信息。

**瓶颈 B：真值与视图耦合。**
`boxes` 既是真值又是"当前帧渲染输入"，于是同一件事在 9 个地方各写了一遍（事实 5）。每加一种标注类型就多一份"写回责任"，这是典型的数据所有权不清。改造后 `boxes` 必须降级为**当前帧的物化视图（materialized view）**，不再是可写的真值。

**瓶颈 C：历史不可跨帧、不可审计。**
快照式历史（事实 6）在单帧内很好用，但跨帧操作（插值 300 帧、传播到 50 帧）没有"一次快照"的边界；切帧清空（事实 7）更是直接放弃了跨帧撤销。而 ref.md 的闭环要求"标注多版本、回滚、审计日志"，这三件事的共同前提是**操作流（command stream）**，不是状态快照。

**瓶颈 D：数据在内存里。**
`FrameData.cloud` 直接持有 `Float32Array`，`useDataset.importFiles` 一次性解析所有帧（`useDataset.ts:164-191`）。按 15 万点/帧、xyz+label 约 14B/点计算，**单帧 2.1MB，500 帧约 1.05GB**，浏览器必然崩。这不是"优化问题"，是"能否处理一段真实序列"的存亡问题。

**瓶颈 E：任务类型硬编码。**
`Box3D` 出现在渲染、拾取、质检、导入导出、相机投影、草稿等所有环节。Occupancy 与 VLA 的结构与 `Box3D` 完全不同（稠密体素 / 文本 + 通道），继续用"再挂一个数组"的方式扩展，会让 `syncViewer`、`buildSnapshot`、`doExportAll` 变成巨型 switch。

---

## 3. 目标架构

### 3.1 分层：domain 内核 + 端口 + 适配器

```
app/            Vue 组件（只负责渲染与事件，不含业务规则）
  ↑
state/          composables：把 domain 的操作暴露成响应式状态
  ↑
domain/         纯 TypeScript，无 Vue / 无 Three / 无 DOM
  model/        Track · Observation · SampleDocument · QaIssue
  ops/          createTrack · updateKeyframe · interpolate · merge · split
  derive/       track → occupancy · track → flow · track → planning actors
  qa/           QaRule 注册表 · 执行器 · profile
  metrics/      IoU · kappa · 难度分 · 规划代理
  ↑                         ↑
ports/          接口        core/  算法库（被 domain 复用，不含业务状态）
  ↑                         geometry · io 解析 · semantics · calibration · formats
adapters/       实现
  local-file · indexeddb · http · mock
```

`domain` 可以依赖 `core`（例如复用 `bevIoU`、`hungarian`、`parsePCD`），但 `core` **不能**反向依赖 `domain`。端口只描述"我需要什么数据"，不描述"数据长什么样"——数据结构在 `domain/model`，避免端口层被某一种实现绑架。

依赖方向严格单向：`app → state → domain → ports`，`adapters` 只被 `state` 组装。`domain` 不允许 import `vue` / `three` / `components`。

**这条规则要有机器校验**，否则三个月后必然破防。方案：`scripts/check-layers.mjs`（约 60 行，扫 `import` 路径前缀），挂到 `pnpm test` 前面。不引入 ESLint 是为了不给这个轻量仓库增加构建负担。

### 3.2 目录规划

```
src/
├── domain/
│   ├── model/
│   │   ├── ids.ts              TrackId / SampleId / ClassId 的分配与校验
│   │   ├── track.ts            Track · Keyframe · ObservationState · 不变量
│   │   ├── document.ts         SampleDocument · TaskPayloads · DocMeta
│   │   ├── command.ts          CommandData 联合类型 + 应用/回滚注册表
│   │   └── issue.ts            QaIssue · 原因码 · 严重度
│   ├── store/
│   │   ├── trackStore.ts       真值容器（非响应式，版本号驱动 UI）
│   │   ├── materialize.ts      track + frame → Box3D（兼容现有渲染）
│   │   ├── frameCache.ts       LRU 帧窗口（按字节预算，P0）
│   │   └── commandHistory.ts   可逆命令栈 + 审计日志
│   ├── ops/
│   │   ├── trackOps.ts         建/删/改/合并/拆分/换类
│   │   ├── interpolate.ts      关键帧插值（CV + 最短弧 + 尺寸恒定）
│   │   ├── smooth.ts           RTS 平滑（可选）
│   │   └── mergePreLabel.ts    预标注合并（复用 hungarian）
│   ├── derive/
│   │   ├── occupancy.ts        box carving + 地面估计 + RLE 编解码
│   │   ├── flow.ts             刚体光流 + 自车运动估计
│   │   └── planningProxy.ts    IDM + TTC + 敏感度
│   ├── qa/
│   │   ├── registry.ts         规则注册与 profile 解析
│   │   ├── runner.ts           全量/增量执行 + worker 协议
│   │   └── rules/              geo · trk · sen · cov · xt · vla（按组）
│   ├── metrics/
│   │   ├── perception.ts       复用 quality.ts 的 IoU/kappa
│   │   ├── difficulty.ts       难度分
│   │   └── sampleIndex.ts      样本级指标聚合
│   └── vla/
│       ├── alignment.ts        指令段 ↔ 动作通道对齐与评分
│       └── actionCurve.ts      控制量重采样/去抖
├── ports/
│   ├── dataSource.ts
│   ├── blobStore.ts
│   ├── documentStore.ts
│   └── inferenceClient.ts
├── adapters/
│   ├── localFileSource.ts
│   ├── indexedDbStore.ts       schema v2 + v1 迁移
│   ├── httpInference.ts
│   └── mockProvider.ts         演示与测试用（确定性）
└── workers/
    ├── parse.worker.ts         PCD 解析 / 下采样
    ├── derive.worker.ts        Occupancy / Flow 生成
    └── qa.worker.ts            规则批量执行
```

### 3.3 与现有代码的关系：保留 / 改造 / 新增

| 动作 | 模块 | 说明 |
|---|---|---|
| **保留不动** | `core/geometry/*`、`io/pcd.ts`、`io/calibration.ts`、`io/semantics.ts`、`camera/*`、`viewer/canvasPrimitives` | 算法正确且有测试锁定，不要为了"重构"而重构 |
| **包一层** | `core/quality/*`、`sequence/tracker.ts` | 改为 domain 的纯函数依赖，不改内部实现 |
| **改造** | `core/types.ts`、`core/history.ts`、`io/session.ts`、`state/studioCore.ts`、`useSequence`、`useAnnotation`、`useStudio` | 真值源与历史模型替换 |
| **扩展** | `viewer/PointCloudViewer.ts` | 增加 `setOccupancyLayer` / `setFlowLayer` / 来源样式 |
| **新增** | `domain/*`、`ports/*`、`adapters/*`、`workers/*`、对应面板 | 见 3.2 |

关键取舍：**不改渲染器的框渲染路径**。`viewer.setBoxes(boxes, ...)` 的签名保留，输入由 `materializeFrame()` 产出，`Box3D` 继续作为"投影视图类型"存在。这样 P1 可以独立上线，不必同时改 730 行的渲染器。

---

## 4. 数据模型设计

这一节是整个方案的地基。模型定错，后面全是补丁。

### 4.1 场景、传感器、帧引用、数据引用

先定义两个被反复引用的基础类型。`BoxGeometry` 是 `Box3D` 去掉 `id/label/visibility` 之后的**纯几何部分**，这样关键帧不必携带"身份"与"任务"字段，避免同一份几何在不同层被写两遍：

```ts
// domain/model/geometry.ts
export interface Vec3 { x: number; y: number; z: number }

/** 与现有 Box3D 的 position/scale/yaw 完全同构，可直接互转 */
export interface BoxGeometry {
  position: Vec3
  scale: Vec3      // x=长 y=宽 z=高
  yaw: number      // 绕 z，弧度
}

/** 自车位姿：位置 + 欧拉角（弧度）。旋转顺序固定为 Z→Y→X，写进约定 */
export interface Pose {
  position: Vec3
  rotation: { x: number; y: number; z: number }
}
```

```ts
// domain/model/ids.ts
export type SampleId = string      // `${sceneId}#${startFrame}-${endFrame}`
export type TrackId = string       // 数字字符串，兼容 SUSTechPOINTS obj_id
export type ClassId = string       // 'Car' | 'Pedestrian' | ...

// domain/model/scene.ts
export interface SensorSpec {
  id: string                       // 'lidar_top' | 'cam_front'
  kind: 'lidar' | 'camera' | 'radar'
  /** 相对自车坐标系的静态外参；动态标定走 Calibration 版本号 */
  extrinsic?: { rotation: number[]; translation: Vec3 }
  intrinsic?: number[]
  distortion?: number[]
}

export interface SceneMeta {
  id: string
  name: string
  sensors: SensorSpec[]
  /** 名义帧率；每帧仍以 ts 为准，避免 10Hz/20Hz 混采时错位 */
  nominalHz: number
  calibrationVersion: string
}

export type DataRef =
  | { kind: 'inline'; cloud: PointCloud }                       // 演示/小数据
  | { kind: 'blob'; key: string; bytes: number; codec: 'pcd-bin' | 'pcd-ascii' | 'xyz-f32' }
  | { kind: 'remote'; url: string; range?: [number, number]; etag?: string }
```

```ts
// domain/model/frame.ts
export interface FrameRef {
  index: number
  /** 绝对时间戳（秒）。没有它就没有速度，也无法和 VLA 动作对齐 */
  ts: number
  data: Record<string, DataRef>    // sensorId → 数据引用
  /** 自车位姿（世界系）。可选：缺失时由 estimateEgoMotion 估计 */
  ego?: Pose
  /** 各传感器标定版本，允许逐帧切换（在线标定场景） */
  calibVersion?: string
}
```

三条设计理由：

1. **`ts` 必须独立于 `index`**。当前代码用固定 `dt = 0.5`（`temporalQA.ts:82`）算速度，真实数据是 10Hz/20Hz 混采、还会丢帧。速度阈值、VLA 动作对齐、TTC 全部依赖真实时间。
2. **`DataRef` 而不是 `PointCloud`**。这是把 1GB 内存压到几百 MB 的唯一办法；`kind: 'inline'` 保证演示场景零改动。
3. **`ego` 可选**。没有位姿就用地面点估计（见 6.4），但不能假装有。

### 4.2 Track：目标的一生

```ts
// domain/model/track.ts
export type Visibility = 'visible' | 'occluded' | 'predicted' | 'outside'

export interface SourceTag {
  /** manual=人工；model:xxx@ver=模型；interp=插值；derived=衍生；import=导入 */
  kind: 'manual' | 'model' | 'interp' | 'derived' | 'import'
  model?: { id: string; version: string; confidence?: number }
  /** 来自哪次操作的命令 id，用于审计与"谁改的"追溯 */
  commandId?: string
}

export interface Keyframe<G = BoxGeometry> {
  frame: number
  geometry: G
  source: SourceTag
  /** 人工确认过的关键帧不会被自动平滑覆盖 */
  locked?: boolean
}

export interface ObservationState {
  visibility: Visibility
  source: SourceTag
  review: 'none' | 'pending' | 'accepted' | 'rejected' | 'conflict'
  confidence?: number
  /** 遮挡原因：'truck' | 'building' | 'out_of_range'，用于统计与规则豁免 */
  occluder?: string
}

export interface Track<G = BoxGeometry> {
  id: TrackId
  classId: ClassId
  attributes: Record<string, string | number | boolean>
  /** 稀疏关键帧，按 frame 升序；至少 1 个 */
  keyframes: Keyframe<G>[]
  /** 只在"非默认状态"的帧上记录，默认 visible/manual/none，避免 500×200 的冗余 */
  states: Map<number, ObservationState>
  lifecycle: {
    first: number
    last: number
    state: 'active' | 'occluded' | 'dead'
  }
}
```

**不变量（必须在 `trackStore` 里断言，并写进测试）**

| 编号 | 不变量 | 违反后果 |
|---|---|---|
| T1 | `keyframes` 非空、frame 严格递增、无重复 | 物化时插值区间失效 |
| T2 | `keyframes` 落在 `[lifecycle.first, lifecycle.last]` 内 | 轨迹时间范围撒谎 |
| T3 | `states` 的 key 不落在关键帧上（关键帧即视为已确认观测） | 同一帧两个状态来源冲突 |
| T4 | `id` 在 Scene 内唯一，且不与历史 id 复用 | 串 ID 无法被发现 |
| T5 | `classId` 必须在类别表中 | 渲染/统计时 undefined |

**为什么关键帧稀疏、状态稀疏**：500 帧 × 200 目标的完整矩阵是 10 万个对象，每个对象 8 个字段，JSON 化后几十 MB。稀疏表示下，一段 500 帧、20 条轨迹的典型样本只有几百个关键帧，草稿体积从 MB 降到几十 KB。这也是 `states` 用 `Map` 而非数组的原因。

**`Map` 的序列化契约（不写清必然踩坑）**：`states: Map<number, ObservationState>` 在三个边界上不能直接过：
- `JSON.stringify` 会丢成 `{}`；
- `structuredClone`（IndexedDB、Worker）能保留 `Map`，但 `cloneBoxes` 用的 JSON 深拷贝（`core/history.ts:116-118`）会丢；
- Vue devtools 里看着是 Map，落库后读回是普通对象。

统一规定：**持久化与跨线程一律转 `Array<[number, ObservationState]>`**，读写边界各一个 `encodeStates/decodeStates`；`SampleDocument` 的内存态才用 `Map`。这条写进第 12 节开发约定。

### 4.3 SampleDocument：一个样本上的所有任务

```ts
// domain/model/document.ts
export type TaskKey = 'boxes' | 'semantic' | 'occupancy' | 'flow' | 'lane' | 'vla'

export interface SampleDocument {
  schema: 2
  sampleId: SampleId
  sceneId: string
  range: [number, number]
  tasks: {
    boxes: { tracks: Track[] }
    semantic?: SemanticTaskData       // 逐点类别 + 实例映射
    occupancy?: OccupancyTaskData     // 稀疏体素 + grid Spec
    flow?: FlowTaskData               // 自车变换 + 可选逐点流
    lane?: LaneTaskData               // 车道线（本期只留模型）
    vla?: VlaTaskData                 // 指令段 + 动作通道
  }
  meta: DocMeta
}

export interface DocMeta {
  /** 单调递增，每次提交 +1 */
  version: number
  /** 提交时基于的版本；服务端冲突检测用 */
  baseVersion: number
  updatedAt: number
  updatedBy: string
  /** 每个任务的子文档哈希，支持"只锁 VLA 任务"这类细粒度并发 */
  hashes: Partial<Record<TaskKey, string>>
  /** 规则 profile 版本，保证"同一份报告可复现" */
  qaProfileVersion?: string
}
```

**为什么把多任务放在一个文档里**：ref.md 的核心诉求是"同一数据样本上维护多种任务标注的一致关联"。如果 Occupancy 和 boxes 分属两个文件，一致性校验就退化成"跨文件对齐"，需要额外的事务与版本协商，而这个项目没有后端事务能力。放在一个文档里，一致性规则可以在一次读取内完成，命令也能原子地同时改两个任务。

代价是**写放大**：改一个框会重写整个文档。缓解手段是 `hashes` + 任务级脏标记 + IndexedDB 分 store 存储（一个 task 一条记录，meta 单独一条），逻辑上是一个文档，物理上是分段存储。

### 4.4 Command：可逆、可审计、可重放

```ts
// domain/model/command.ts
export type CommandData =
  | { type: 'createTrack'; track: Track }
  | { type: 'deleteTracks'; tracks: Track[] }
  | { type: 'setKeyframe'; trackId: TrackId; frame: number; before: BoxGeometry | null; after: BoxGeometry | null }
  | { type: 'setObservation'; trackId: TrackId; frame: number; before: ObservationState | null; after: ObservationState | null }
  | { type: 'setClass'; trackId: TrackId; before: ClassId; after: ClassId }
  | { type: 'insertFrames'; trackId: TrackId; frames: Array<{ frame: number; geometry: BoxGeometry }> }
  | { type: 'mergeTracks'; keep: TrackId; absorb: TrackId[] }
  | { type: 'splitTrack'; source: TrackId; atFrame: number; newId: TrackId }
  /** 大任务载荷（占据/光流）不进命令体，只存 BlobStore 引用，撤销 = 换回旧引用 */
  | { type: 'setTaskPayload'; task: TaskKey; beforeRef: string | null; afterRef: string; patch?: unknown }

export interface CommandMeta {
  id: string
  label: string          // UI 文案："插值补全 12 条轨迹"
  at: number
  actor: string
  /** 合并键：拖拽连续事件合成一步 */
  coalesceKey?: string
  /** 受影响范围，供增量渲染与增量质检 */
  affects: { frames: number[]; tracks: TrackId[]; tasks: TaskKey[] }
}

export type Command = CommandData & { meta: CommandMeta }

export function applyCommand(doc: SampleDocument, cmd: Command): void
export function revertCommand(doc: SampleDocument, cmd: Command): void
```

**关键决策：命令是数据，不是闭包。**
闭包式命令（`{ do, undo }`）写起来最省事，但不可序列化、不可重放、不可跨端同步、审计日志里只剩一句 label。改成"数据 + 注册表"后，`interpolate` 这条命令能完整记录"给哪 12 条轨迹补了哪 37 帧"，回滚时逐条删除；同时它天然就是审计日志的一条记录。

**大载荷按引用存**：占据一帧 60KB、一次 ROI 编辑可能改十几帧，如果把 `before/after` 内联进命令，500 步历史能吃掉几百 MB。所以 `setTaskPayload` 只存 `BlobStore` 的内容哈希（`afterRef`），撤销就是切回 `beforeRef`。代价是要管理引用计数：历史条目被淘汰（`limit` 或新分支）时，未被其他条目引用的 blob 要异步回收，否则 IndexedDB 会被历史垃圾撑满。这条在 P3 实现时必须先写回收，再开 ROI 编辑。

**`coalesceKey` 保留现有语义**：`history.ts:68-73` 的合并窗口逻辑直接搬过来，用户拖 yaw 滑杆仍然只产生一步撤销。

### 4.5 QaIssue：统一问题模型与原因码

```ts
// domain/model/issue.ts
export type QaSeverity = 'info' | 'warn' | 'error' | 'blocker'

export interface QaIssue {
  /** 机器可读原因码，例如 'TRK_GAP'、'XT_OCC_BOX_CONTAINMENT' */
  code: string
  ruleId: string
  severity: QaSeverity
  scope: 'frame' | 'track' | 'sequence' | 'crossTask' | 'task'
  /** 定位：一个 issue 可能涉及多个目标/帧（如跨任务冲突） */
  targets: Array<{ frame?: number; trackId?: TrackId; task?: TaskKey }>
  /** 实测值与阈值，报告里可直接画分布 */
  value?: number
  threshold?: number
  message: string
  /** 给标注员看的修复建议，而不是"检查失败" */
  fixHint?: string
  /** 是否可一键修复（如"删除重复框"），决定 UI 是否出按钮 */
  autoFix?: { command: Command }
}
```

现有 `TemporalIssue`（`temporalQA.ts:29-41`）只有 `type/severity/objId/frame/detail/value`，没有 code、没有 task、没有修复建议、没有多目标。**P1 的第一件事就是把 `TemporalIssue` 映射成 `QaIssue`**，旧字段保留在适配函数里，避免一次性改 UI。

### 4.6 兼容层：`Box3D` 降级为投影视图

```ts
// domain/store/materialize.ts
export interface Box3DView extends Box3D {
  trackId: TrackId
  /** 该帧的观测状态，渲染虚线/标签用 */
  frame: number
  sourceKind: SourceTag['kind']
}

export function materializeTrack(track: Track, frame: number, ctx: FrameContext): Box3DView | null
export function materializeFrame(doc: SampleDocument, frame: number, ctx: FrameContext): Box3DView[]
```

字段映射：

| `Box3D` 字段 | 来源 | 说明 |
|---|---|---|
| `id` | `track.id` | 保持不变，`obj_id` 兼容性零成本 |
| `label` | `track.classId` | 类别是轨迹级属性，不能逐帧不同 |
| `position` / `scale` / `yaw` | 关键帧或插值结果 | 物化时计算 |
| `visibility` | `states.get(f).visibility` 或默认 `visible` | 已有字段，语义升级 |
| `attributes` | `track.attributes` + 帧级覆盖 | 保留扩展位 |
| `trackId`（新增可选） | `track.id` | 让新代码能区分"投影视图"与"真值" |

**这套兼容层的价值**：`viewer.setBoxes`（`PointCloudViewer.ts:291`）、`OrthoView` 的 props（`OrthoView.vue:23-48`）、`quality.ts`、`formats/*` 全部不用改。P1 的改动集中在 `studioCore` 与 `useSequence`，回归面可控。

---

## 5. 分阶段实施方案

治理原则：**每个阶段都能独立发布、独立回滚**。用 URL 参数做功能开关（`?tasks=box,occ&doc=v2`），未完成的能力不进主路径。

阶段依赖（箭头 = 必须先完成）：

```
P0 数据地基
   │
   ▼
P1 4D 内核 ──────────────┬──────────────┬──────────────┐
   │                     │              │              │
   ▼                     ▼              ▼              ▼
P2 预标注              P3 多任务      P4 VLA        P5 规则引擎
   │                     │              │              │
   └──────────┬──────────┴──────────────┘              │
              ▼                                        │
          P6 闭环 ◀────────────────────────────────────┘
              │
              ▼
          P7 协作（可选，只需 P0/P1）
```

关键路径是 `P0 → P1 → P3 → P6`。P2/P4/P5 都可以在 P1 之后并行插入；**唯一不能并行的是 P1**，因为所有能力都要读同一套 Track/Command 模型。

### 5.0 P0 数据与文档地基（2 人周）

**目标**：把"内存里装一段序列"改成"按需读一帧"，把"一个草稿"改成"带版本的文档"。

**为什么必须第一个做**：P1 的 `TrackStore` 一旦接上，序列规模会从 5 帧涨到几百帧；如果还在 `FrameData` 里内联点云，第一次真实数据测试就会 OOM，届时又要回头改数据层，等于把 P1 的工作推翻一半。

#### 5.0.1 实施步骤

1. **抽 `BlobStore` 端口**，IndexedDB 实现分两个 store：`blobs`（`ArrayBuffer`，key 为内容哈希）与 `docs`（文档分段）。
2. **抽 `DataSource` 端口**，先实现 `localFileSource`（File API，支持一次选多个 PCD）与 `demoSource`（包装现有 `sample.ts` / `generateDemoSequence`）。
3. **引入帧窗口缓存** `FrameCache`：LRU，容量按字节而不是条数（默认 256MB），命中返回同一个 `PointCloud` 引用，未命中触发 `DataSource.frame(i)`。
4. **文档 schema v2**：`meta` / `boxes` / 其余任务各一条记录；`DB_VERSION` 从 1 升到 2，写 `migrateV1ToV2()`。
5. **迁移逻辑**：v1 的 `SessionSnapshot`（`session.ts:38-49`）是"全量帧 + 单 boxes"，迁移为 v2 的"单文档 + tracks"。必须写一个反向导出（v2 → v1 的单帧 JSON），保证老用户能拿回数据。
6. **配额与失败处理**：`navigator.storage.estimate()` 低于 15% 时提示；写入失败抛 `E_QUOTA`，UI 引导手动导出。替换现在"80MB 直接跳过"的硬阈值（`useStudio.ts:91`）。

#### 5.0.2 接口签名

```ts
// ports/blobStore.ts
export interface BlobStore {
  put(key: string, buf: ArrayBuffer): Promise<void>
  get(key: string): Promise<ArrayBuffer>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
  usage(): Promise<{ used: number; quota: number }>
}

// ports/dataSource.ts
export interface SampleSummary {
  sampleId: SampleId
  sceneId: string
  name: string
  frameRange: [number, number]
  sensorKinds: Array<'lidar' | 'camera' | 'radar'>
  bytes?: number
}

export interface FramePayload {
  ref: FrameRef
  /** 已解码的点云；解码在 worker 完成，主线程只接收 transferable */
  cloud: PointCloud
}

export interface SampleHandle {
  meta(): SceneMeta
  frame(i: number): Promise<FramePayload>          // 懒加载单帧
  calibrations(): Promise<Record<string, Calibration>>
  egoPose?(i: number): Promise<Pose | null>
  close(): void
}

export interface DataSource {
  readonly id: string
  listSamples(): Promise<SampleSummary[]>
  openSample(sampleId: string): Promise<SampleHandle>
}
```

#### 5.0.3 文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/ports/blobStore.ts` / `dataSource.ts` / `documentStore.ts` | 新增 | 三个端口，无实现 |
| `src/adapters/indexedDbStore.ts` | 新增 | 替代 `core/io/session.ts` 的读写职责 |
| `src/adapters/localFileSource.ts` | 新增 | 多选 PCD 按文件名自然排序（复用 `useDataset.ts:151-154` 的逻辑） |
| `src/domain/store/frameCache.ts` | 新增 | LRU + 字节预算 |
| `src/core/io/session.ts` | 改造 | 保留 v1 结构用于迁移，标注 `@deprecated` |
| `src/state/useDataset.ts` | 改造 | 从"一次性解析全部帧"改为"打开 SampleHandle + 缓存" |
| `src/state/useStudio.ts` | 改造 | 自动保存改为"提交文档 + 存 blob"两段式 |

#### 5.0.4 验收

- 打开 500 帧序列，`performance.memory` 常驻增量 < 300MB（含 GPU 缓冲与运行时开销），切帧 P95 < 120ms；CPU 侧点云/真值预算按 7.2 的 50MB 卡。
- 断网可用（纯本地）。
- v1 草稿能自动迁移，迁移后导出与迁移前逐字段一致（用现有 4 个真实数据文件做对照）。
- 断点：`pnpm test` 227 项仍全过，新增 `frameCache` / 迁移 20 项。

---

### 5.1 P1 4D 内核（4 人周）

**目标**：把"时间"和"身份"从约定升级为模型；跨帧编辑可撤销；提供轨迹级编辑界面。

这是全案最关键的一段。完成标准不是"功能变多"，而是**后续所有能力都不再需要碰 `frames[i].boxes`**。

#### 5.1.1 真值容器

```ts
// domain/store/trackStore.ts
export class TrackStore {
  constructor(doc: SampleDocument)

  /** 增删改都走命令，返回新版本号 */
  exec(cmd: Command): number
  undo(): Command | null
  redo(): Command | null
  get version(): number

  getTrack(id: TrackId): Track | undefined
  tracksInFrame(frame: number): Track[]
  /** 供渲染：只物化当前帧 + 前后各 1 帧（预取） */
  materialize(frame: number): Box3DView[]
  /** 供导出/质检：全量物化，按帧流式产出，避免一次性大数组 */
  *materializeAll(): Generator<{ frame: number; boxes: Box3DView[] }>
}
```

**响应式策略**：`TrackStore` 本身**不做深层响应式**。Vue 的 `ref` 会递归代理 `Track[]`、`Map`、`Float32Array`，10 万级对象下首屏就要几百毫秒，且每次读都走 Proxy。改为：

```ts
const docVersion = ref(0)                       // 只暴露一个版本号
const store = shallowRef<TrackStore>(...)       // 浅引用
const frameBoxes = computed(() => store.value.materialize(currentFrame.value))
```

`docVersion` 变化驱动 `frameBoxes` 重算与 `syncViewer()`。这与现有"签名缓存 + `requestRender`"的渲染策略（`PointCloudViewer.ts:276-285`、`studioCore.ts:250-255`）天然兼容。

#### 5.1.2 历史：从快照换命令

改造点对照：

| 现状 | 改造后 |
|---|---|
| `new HistoryStack<Box3D[]>({ limit: 100 })`（`studioCore.ts:130`） | `new CommandHistory({ limit: 500 })`，命令只存差异 |
| `mutate(label, fn, mergeKey)` 前后各克隆一次全帧框（`studioCore.ts:368-376`） | `mutate` 保留签名，内部开启 `EditSession`，只记录受影响轨迹的关键帧差异 |
| 切帧 `resetHistory({...})`（`useSequence.ts:57`） | **不再清空**；历史是文档级的，跨帧连续 |
| 插值/传播调 `resetHistory()`（`useSequence.ts:136/185`） | 各产出一条命令，可 `Ctrl+Z` 整段回退 |

```ts
// domain/store/commandHistory.ts
export interface AuditEntry {
  commandId: string
  type: Command['type']
  label: string
  actor: string
  at: number
  affects: Command['meta']['affects']
  /** 变更摘要，用于审计列表展示："新增 37 个框 / 12 条轨迹" */
  summary: string
}

export class CommandHistory {
  exec(cmd: Command): void
  undo(): Command | null
  redo(): Command | null
  get undoLabel(): string
  get redoLabel(): string
  /** 导出审计流；P7 直接作为服务端提交体 */
  auditLog(): AuditEntry[]
  /** 从审计流重建（重放），用于崩溃恢复与"回到某一版" */
  replay(entries: AuditEntry[], doc: SampleDocument): void
}
```

`mutate` 的兼容实现（双写期的真实写法：老代码继续改 `boxes.value`，由会话对比出差异）：

```ts
// state/studioCore.ts（改造后，双写期）
function mutate(label: string, fn: () => void, coalesceKey?: string) {
  // 1) 记录"当前帧所有框"的 before 快照（只快照当前帧，仍然很便宜）
  const session = store.beginEdit(currentFrame.value)
  // 2) 老代码不动：继续 boxes.value.push / 改字段
  fn()
  // 3) 把变化翻译成命令：新增 → createTrack；几何变 → setKeyframe；
  //    消失 → deleteTracks；visibility 变 → setObservation
  const cmd = session.diffAfter(cloneBoxes(boxes.value), label, coalesceKey)
  if (cmd) store.exec(cmd)
  docVersion.value++
  syncViewer()
  markDirty()
}
```

双写期结束后（P1 第三阶段），`mutate` 换成真正的"命令优先"版本：先构造 `CommandData`，`exec` 后由 store 物化出 `boxes`，不再有 `diffAfter`。这样迁移是渐进的，而不是一次性换心。

**代价与边界**：`diffAfter` 需要区分"几何被改"和"对象被替换"，否则会把拖动误判成删除+新建。实现上用 `trackId` 而非对象引用做匹配（`Box3DView.trackId` 就是为此加的），并在 diff 时对比 geometry 的 7 个数（`x/y/z` + `l/w/h` + `yaw`）判断是否真的变了。

#### 5.1.3 编辑语义：关键帧、插值、传播、拆分、合并

这是 4D 标注与单帧标注的真正分界。当前代码只有"整框替换/增量平移"两种传播（`sequence.ts:137-177`）和线性插值（`sequence.ts:42-59`），缺少轨迹级操作。

| 操作 | 语义 | 命令 | UI 入口 |
|---|---|---|---|
| 建立轨迹 | 首帧画框 → 自动创建 Track（1 个关键帧） | `createTrack` | `N` 画框（保留现有） |
| 追加关键帧 | 在某帧调整后，把该帧升为关键帧 | `setKeyframe` | `K`（新增） |
| 插值补全 | 两个关键帧之间按运动模型补帧，标 `source:interp` | `insertFrames` | 现有「轨迹插值」按钮改造 |
| 跨帧传播 | 平移/尺寸/朝向增量应用到指定范围 | `insertFrames` + `setKeyframe` | 现有「应用到其他帧」 |
| 轨迹拆分 | 目标在第 f 帧后 ID 变了（换车/驶离再进入） | `splitTrack` | 轨迹面板右键 |
| 轨迹合并 | 两段其实是同一目标（串 ID 修复） | `mergeTracks` | 多选两条轨迹 → 合并 |
| 生命周期调整 | 标记进入/离开视野的帧 | `setObservation` | 轨迹两端拖拽 |
| 遮挡标注 | 某帧标 occluded / predicted | `setObservation` | 现有 `toggleSelectedVisibility` |

**插值算法规格（替换现有 `lerpBox`）**

```ts
// domain/ops/interpolate.ts
export interface InterpolateOptions {
  /** 'linear' | 'hermite'（默认，用相邻关键帧估速度） */
  mode: 'linear' | 'hermite'
  /** 尺寸策略：'constant'（车辆刚体，默认）| 'lerp'（行人/非刚体可开） */
  size: 'constant' | 'lerp'
  /** 单段最大插值帧数，超过则拆段并要求人工确认 */
  maxSpan: number          // 默认 15
  /** 端点超出关键帧范围时用 predicted 续接的最大帧数 */
  maxCoast: number         // 默认 3
}
```

数学：

- 位置用三次 Hermite：给定 `p0, p1` 与端点速度 `v0, v1`（由前后关键帧差分估计，边界为 0），
  `p(t) = h00 p0 + h10 m0 + h01 p1 + h11 m1`，其中 `m = v · Δf`。
- 朝向走最短弧的 Hermite：先把 `Δyaw` 规范到 `(-π, π]`，再对**展开后的角序列**插值，最后取模。现有 `lerpAngle`（`sequence.ts:34-39`）已经处理了绕圈问题，Hermite 版必须复用同一规范化。
- 尺寸用 `constant`：取两关键帧尺寸的逐轴中位数，避免插出"变形的车"。这一点与现有 `lerpBox`（逐轴线性插值）不同，**是行为变更，必须写进测试并告知**。
- 可见性：段内标 `visible`，但 `source.kind = 'interp'`；超出最后一个关键帧的续接帧标 `predicted`。
- 插值帧进入 `states` 时 `review: 'none'`，**默认不参与位置精度评估**（沿用 `temporalQA.ts:105-109` 对 predicted/occluded 的豁免思路）。

**为什么 `maxSpan` 是 15**：一段 2 秒（20Hz 下 40 帧）的纯插值如果没有任何人工确认，误差不可控。超过 15 帧就拆成两段并要求补一个关键帧，这是把"插值"和"猜"分开的工程手段。

#### 5.1.4 轨迹时间线 UI

新增 `components/Timeline.vue`（约 300 行），放在 Stage 下方可折叠：

```
┌──────────────────────────────────────────────────────────────┐
│ [◀][▶] 帧 128/500   ├────●───────────────●────────┤ 1.2x    │
│ Car #17    ██████████░░░░░░░░████████████████████           │
│ Car #23         ████████████████████████████                 │
│ Ped #41  ████████████████░░░█████                            │
│                     ↑ 当前帧    ░ 插值/预测   █ 人工关键帧    │
└──────────────────────────────────────────────────────────────┘
```

交互规格：

- 横轴是帧，纵轴是轨迹（按首次出现排序，支持按类别过滤）。
- 关键帧画实心点，插值段画半透明，`predicted` 画虚线，`occluded` 画斜纹。
- 点击轨迹 → 选中并跳到该轨迹首个关键帧；拖拽轨迹两端 → 改 `lifecycle`。
- 双击轨迹中段 → 在该帧创建关键帧（进入编辑该帧）。
- 时间线缩放与主视口帧导航解耦（复用 docs/10 的双时间线思路，但这里是"数据帧 vs 轨迹跨度"，不是镜头时间）。

#### 5.1.5 文件清单

| 文件 | 动作 | 风险 |
|---|---|---|
| `src/domain/model/track.ts` / `document.ts` / `command.ts` / `issue.ts` | 新增 | 低（纯类型） |
| `src/domain/store/trackStore.ts` / `commandHistory.ts` / `materialize.ts` | 新增 | 中（核心） |
| `src/domain/ops/trackOps.ts` / `interpolate.ts` | 新增 | 中 |
| `src/core/history.ts` | 保留但降级 | 仅 `cloneBoxes` 继续被复用 |
| `src/state/studioCore.ts` | 改造 | **高**：`boxes` 从真值改为 computed 视图，所有写入点要改 |
| `src/state/useSequence.ts` | 改造 | 高：`gotoFrame` 去掉写回；插值/传播改为命令 |
| `src/state/useAnnotation.ts` | 改造 | 高：建框/拖拽/删除全部走命令 |
| `src/components/Timeline.vue` | 新增 | 低 |
| `src/components/panels/SequencePanel.vue` | 改造 | 低 |

**高风险点的具体化解**：`boxes` 目前是 `ref<Box3D[]>`，全仓库有 58 处 `boxes.value` 读写。改造时保留这个 ref，但语义变成"当前帧物化缓存"，并加一个 `assertNotDirectWrite` 的开发期检查：在 `mutate` 之外对 `boxes.value` 赋值时 `console.warn`（仅 dev 构建）。这样迁移期能快速定位漏改点，而不是靠随机测。

#### 5.1.6 验收

- 500 帧 × 200 轨迹的文档，首屏物化 < 60ms，切帧 < 120ms。
- 插值 300 帧后 `Ctrl+Z` 一次完全回退，且 `redo` 能恢复。
- 切帧 100 次后历史仍可回退到第 1 帧的操作（跨帧历史）。
- 轨迹合并/拆分后，导出 JSON 的 `obj_id` 语义正确（合并保留 keep 的 id，拆分产生新 id）。
- 现有 227 项 + 新增 ≥ 40 项（插值、不变量、命令回滚）全绿。

---

### 5.2 P2 预标注接入（3 人周）

**目标**：平台成为预标注模型的"消费端"和人工精修的"汇聚点"。

#### 5.2.1 Provider 协议

```ts
// ports/inferenceClient.ts
export interface ProviderCapabilities {
  tasks: TaskKey[]
  classes: ClassId[]
  maxFramesPerRequest: number
  supportsStreaming: boolean
  /** 是否需要相机图像（BEVFormer 类需要，纯点云模型不需要） */
  requiresImages: boolean
}

export interface PreAnnotateRequest {
  sampleId: SampleId
  frameRange: [number, number]
  sensors: string[]
  /** 模型提示：置信度阈值、类别白名单、ROI */
  hints?: { scoreThreshold?: number; classes?: ClassId[]; roi?: BoxGeometry }
}

export interface PreObject {
  classId: ClassId
  geometry: BoxGeometry
  confidence: number
  /** 模型内部 id（可选）：跨帧一致时可直接建轨迹 */
  modelTrackId?: string
  attributes?: Record<string, string | number>
}

export interface PreAnnotateChunk {
  frame: number
  objects: PreObject[]
  progress: number             // 0..1
  model: { id: string; version: string; runtimeMs?: number }
}

export interface PreAnnotationProvider {
  id: string
  label: string
  capabilities(): ProviderCapabilities
  run(req: PreAnnotateRequest, signal?: AbortSignal): AsyncGenerator<PreAnnotateChunk>
}
```

三个必备实现：

| 实现 | 用途 | 说明 |
|---|---|---|
| `mockProvider` | 演示 / 测试 / 无模型环境 | 确定性：用种子 + 真实点云做 box carving 拟合，产出带噪声的框；保证测试可复现 |
| `httpProvider` | 接真实推理服务 | `POST /v1/preannotate`，NDJSON 流式返回 chunk；支持 `AbortSignal`；错误码映射 |
| `fileProvider` | 离线结果导入 | 读取已有 KITTI/nuScenes 结果作为"模型输出"，用于回放与评测 |

**为什么用 `AsyncGenerator` 而不是 Promise**：500 帧推理是分钟级任务，必须有进度、可中断、可逐帧消费。`AsyncGenerator` 天然支持 `for await` + `break` 取消，比事件回调好测试。

**跨域与部署**：浏览器直连推理服务会遇到 CORS 与鉴权。方案：
1. 开发期用 Vite `server.proxy` 转发；
2. 生产期同域部署 BFF（P7 的一部分）；
3. 提供"文件模式"作为无网络兜底。

#### 5.2.2 合并策略

```ts
// domain/ops/mergePreLabel.ts
export interface MergePolicy {
  /** append=全部作为待复核；fill-gaps=只补空缺帧；replace-track=按轨迹整体替换；class-vote=多模型投票 */
  strategy: 'append' | 'fill-gaps' | 'replace-track' | 'class-vote'
  iouThreshold: number          // 默认 0.5
  classMustMatch: boolean       // 默认 true
  minConfidence: number         // 默认 0.3
  /** 人工标注优先级：命中人工关键帧时永不覆盖 */
  protectManual: boolean        // 默认 true
}

export interface MergeResult {
  created: TrackId[]
  updated: TrackId[]
  conflicts: Array<{ frame: number; manual: BoxGeometry; model: PreObject; iou: number }>
  skipped: number
}
```

合并算法（复用现有 Hungarian，不重写）：

1. 对每个 chunk 帧，取该帧已有人工框 `manual` 与模型框 `model`。
2. 构造代价矩阵：`cost = 1 - IoU`，类别不一致直接 `BIG`（复用 `tracker.ts:66-91` 的超大值语义）。
3. `hungarian(cost)` 得到一一匹配（`tracker.ts:57`）。
4. 匹配上且 `protectManual` → 记为 `conflict`，不覆盖，生成 `XT_MANUAL_MODEL_CONFLICT` 问题。
5. 未匹配的模型框 → 若 `strategy='fill-gaps'` 且该帧有任意人工框则跳过，否则创建 `Track`，`review: 'pending'`。

**血缘必须落库**：模型产生的每个关键帧带 `source: { kind:'model', model:{id,version,confidence} }`。这不只是"好看"——P6 的难度分要用"人工改了多少模型框"作为特征，没有血缘就算不出来。

#### 5.2.3 复核状态机与 UI

```
pending ──accept──▶ accepted ──edit──▶ accepted(人工修改)
   │                    │
   ├──reject──▶ rejected│
   │                    │
   └──conflict──▶ conflict ──choose A/B──▶ accepted
```

- 渲染：`pending` 灰色虚线 + 置信度角标；`accepted` 正常；`rejected` 隐藏（可开关）；`conflict` 红黄双框 + 角标。
- 快捷键（复用 `onKeyDown` 的 key 分发，`useAnnotation.ts:491`）：`A` 接受、`X` 拒绝、`Tab` 下一个待复核、`Shift+A` 全部接受当前帧。
- 复核队列面板：按置信度升序（低置信优先），支持"只看 conflict"。

#### 5.2.4 验收

- mock provider 在 5 帧演示序列上产出 ≥ 20 个框，置信度与 IO 噪音固定种子可复现。
- 接受/拒绝/冲突裁决全部可撤销。
- 导出默认只含 `accepted`；`?export=pending` 可导出全部（培训/调试用）。
- 中断推理后已完成帧的标注保留，不出现半帧脏数据。

---

### 5.3 P3 多任务与衍生真值（6 人周）

**目标**：从"一个框任务"扩展到"框 + 语义 + 占据 + 光流 + 车道线"，并且这些真值之间能互相校验、能互相衍生。

#### 5.3.1 TaskRegistry：任务即插件

```ts
// domain/model/task.ts
export interface TaskAdapter<P = unknown> {
  key: TaskKey
  label: string
  /** 数据校验：加载/导入时调用，返回问题而不是抛异常 */
  validate(payload: P, doc: SampleDocument): QaIssue[]
  /** 该任务的编辑器组件名（app 层映射到具体 .vue） */
  editor: string
  /** 从其他任务衍生；无衍生能力返回 null */
  deriveFrom?(doc: SampleDocument): P | null
  /** 导出为外部格式；无导出返回 null */
  serialize?(payload: P, doc: SampleDocument): ArrayBuffer | string
  /** 该任务的体积估算，供配额与懒加载决策 */
  estimateBytes(payload: P): number
}

export const registry = new Map<TaskKey, TaskAdapter>()
```

**为什么用注册表而不是 switch**：`useStudio.buildSnapshot`（`useStudio.ts:67-83`）这类地方已经是硬编码字段列表，每加一个任务就要改一次。注册表让"加任务 = 加一个文件 + 注册一行"，且 `validate/deriveFrom/serialize` 有统一入口，规则引擎也能按任务遍历。

#### 5.3.2 Occupancy：消费 + 抽检 + 一致性，而不是逐格画

**表示选型**

| 方案 | 单帧体积 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| 稠密 `Uint8Array`（200×200×16） | 640KB | 实现最简单 | 500 帧 320MB；大量零值 | 仅作内存中间态 |
| 稠密位图（bitset） | 80KB | 体积可接受 | 类别信息丢失 | 单类占据课时可用 |
| 稀疏索引 + 类别 | ≈160KB（5% 占用） | 保留类别 | 随机访问慢 | **推荐落盘格式** |
| RLE（按线性索引） | 30–80KB | 压缩率高、顺序解压快 | 随机改一格代价高 | **推荐传输/存储** |
| Octree | 20–60KB | 多分辨率 | 实现复杂，收益在本项目不明显 | 不做 |

规格（可配置，不硬编码）：`resolution = 0.4m`，`range = x/y ∈ [-40, 40], z ∈ [-1, 5.4]`，即 `200 × 200 × 16`。这与 Occ3D 一类公开约定常用的 `200 × 200 × 16 @ 0.4m` 对齐（具体数据集以自身配置为准），便于后续对接；但代码里一切从 `OccupancyGridSpec` 读，不写死。

```ts
// domain/derive/occupancy.ts
export interface OccupancyGridSpec {
  origin: [number, number, number]
  size: [number, number, number]        // 体素个数
  resolution: number
  classIds: ClassId[]                   // 占用类别表；free/unknown 不在此表，"未列出"即非占用
}

export interface OccupancyFrame {
  frame: number
  specId: string
  /** 线性索引（x-major），升序 */
  occupied: Uint32Array
  /** 与 occupied 等长，值为 classIds 下标 */
  labels: Uint8Array
  source: SourceTag
}

export function voxelToIndex(spec: OccupancyGridSpec, ix: number, iy: number, iz: number): number
export function worldToIndex(spec: OccupancyGridSpec, p: Vec3): number   // 越界返回 -1
export function indexToVoxel(spec: OccupancyGridSpec, i: number): { ix: number; iy: number; iz: number }
export function carveFromTracks(
  tracks: Track[], frame: number, spec: OccupancyGridSpec,
  opts: { mode: 'box-only' | 'box+ground'; ground?: GroundField },
): OccupancyFrame
export function encodeOccRle(frame: OccupancyFrame): ArrayBuffer
export function decodeOccRle(buf: ArrayBuffer): OccupancyFrame
export function occStats(frame: OccupancyFrame, spec: OccupancyGridSpec): { occupiedRatio: number; perClass: Record<string, number> }
```

**生成流程（box-only 快路径，目标 < 100ms/帧）**

1. 取该帧所有 `visible` 轨迹的 OBB。
2. 对每个 OBB，计算其 AABB 覆盖的体素范围，逐体素中心做 OBB 内含测试（用 `pointInBoxBev` 的思路扩展到 3D：逆旋转 + 三轴半宽比较，`geometry/box.ts:160-165`）。
3. 命中即写入 `occupied`，类别写该轨迹的 `classId` 索引。
4. 冲突（两个框覆盖同一体素）：按"体积小的优先 / 置信度高的优先 / 类别优先级表"裁决，并记一条 `XT_OCC_OVERLAP` 待复核。

**地面与自由空间（box+ground 模式）**

- 地面估计：BEV 网格（1m）内取点的 z 的低分位数（如 5%）作为地面高度，做 3×3 中值滤波去噪。输出 `GroundField { cell, height }`。
- 框底面之下的体素标 free；地面上方但无任何点与框覆盖的体素标 `unknown`（**不能标 free**，这是 Occ 标注最常见的错误）。
- 射线雕刻（DDA）只用于 ROI 精修：从传感器原点向每个点做 Amanatides-Woo 体素遍历，途经体素标 free。150k 点 × 平均 60 体素 ≈ 900 万次写入，必须放 worker 且只在用户点"精修当前 ROI"时触发，不进默认路径。

**渲染**：新增 `viewer.setOccupancyLayer(frame, spec, opts)`，用 `InstancedMesh`（每个体素一个 1×1×1 的 box，实例化缩放），只渲染 `occupied` 体素，按类别着色，支持"只显示 z ∈ [0, 2m]"切片。10 万实例在集显上约 8–15ms/帧，可接受；超过 15 万时退化为点云（每个体素中心一个点）。

#### 5.3.3 光流 / 场景流：能算的算，不能算的不假装

| 点类型 | 流从哪来 | 精度 | 是否落盘 |
|---|---|---|---|
| 轨迹框内的点 | 刚体变换：`p' = R(Δyaw)(p - c) + c + Δc` | 取决于框精度，通常 < 0.05m | **不落盘**，导出时按需生成 |
| 静态背景点 | 自车运动补偿 | 取决于位姿估计，RANSAC 后 < 0.1m | 只落盘自车变换（`dx, dy, dyaw` + `rmse`，4 个数/帧） |
| 其他（动态非目标点） | 无法可靠估计 | — | 标 `unknown`，不参与训练 |

```ts
// domain/derive/flow.ts
export function rigidFlow(
  points: Float32Array, indices: number[],
  from: BoxGeometry, to: BoxGeometry,
  out: Float32Array, offset: number,
): void

export interface EgoMotion { dx: number; dy: number; dyaw: number; inliers: number; rmse: number }
export function estimateEgoMotion(
  a: { cloud: PointCloud; groundMask?: Uint8Array },
  b: { cloud: PointCloud },
  opts?: { maxIter?: number; tolerance?: number },
): EgoMotion
```

**自车运动估计算法**（无位姿时的兜底）：取两帧都落在"地面带"（z 的低 20% 分位附近）的点，投影到 BEV，做 2D 刚体配准：

1. 随机采样 3 对点 → SVD 求 `(R, t)`；
2. 统计内点（残差 < 0.15m）；
3. 迭代 100 次取内点最多的一组，最后用全部内点重解一次。

在没有 IMU/轮速的情况下，这个估计对"平移 + 小角度偏航"够用；急转弯或坡道会退化，所以输出 `rmse`，超过 0.2m 时 UI 提示"自车运动不可靠，光流仅参考"。

#### 5.3.4 跨任务一致性：把"关联"变成可检查的约束

| 编号 | 约束 | 规则码 | 判定 |
|---|---|---|---|
| I1 | 可见框体内的占据率 ≥ 90% | `XT_OCC_BOX_CONTAINMENT` | 框内 `occupied` 体素数 / 框覆盖体素总数 |
| I2 | 框内体素类别 = 框类别（或允许的父类） | `XT_OCC_CLASS_MISMATCH` | 逐体素比对，容差 10% |
| I3 | 语义实例 id ↔ 轨迹 id 有映射 | `XT_SEM_INSTANCE_UNMAPPED` | 实例点数 > 50 且无对应轨迹 |
| I4 | 框内点光流 ≈ 刚体预测 | `XT_FLOW_RIGID_ERROR` | 平均误差 > 0.05m |
| I5 | 车道线落在可行驶区域内 | `XT_LANE_OFFROAD` | 采样点是否在 `road` 语义/占据内 |
| I6 | VLA 指令覆盖全帧且不重叠 | `VLA_INSTRUCTION_GAP/OVERLAP` | 区间运算 |

**I1 的阈值为什么是 90%**：box carving 生成的占格天然满足 100%，但从外部导入的 Occ（如人工修正过）不会。90% 是"允许少量体素因分辨率/标定误差缺失"的经验值，可配置。这个规则的价值在于：**它是唯一能自动发现"框和占据对不上"的手段**，而人工逐格比对不可能。

#### 5.3.5 UI

- 右侧新增「任务」页：勾选当前样本启用的任务、显示各任务完成度与问题数。
- 主视口新增图层开关：点云 / 框 / 占据 / 光流箭头（抽样显示，避免 15 万箭头）。
- 占据编辑限定为 ROI 笔刷：选取 ROI → 只在该 ROI 内允许"补/删/改类"，且每次修改生成一条 `setTaskPayload` 命令（可撤销）。
- 光流用"抽样箭头 + 颜色映射"两档：全量箭头只给 2% 采样。

#### 5.3.6 验收

- 5 帧演示序列生成占据：每帧 < 100ms，RLE 后 < 80KB，解码回写与原始逐体素一致。
- I1/I2 规则在人为删掉 30% 体素后能报出正确对象与帧。
- 光流：给演示序列的匀速目标计算刚体流，误差 < 1e-3（解析解应几乎精确）。
- 导出：占据二进制 + spec JSON，附一个 `scripts/occ2npz.py`（Python，非前端依赖）供训练侧转换。

---

### 5.4 P4 VLA 语言—动作对齐（4 人周）

**目标**：让一条自然语言指令与逐帧控制信号在同一时间轴上可标、可看、可校验。

#### 5.4.1 数据模型

```ts
// domain/model/vla.ts
export interface InstructionSegment {
  id: string
  text: string
  lang: 'zh' | 'en'
  startFrame: number
  endFrame: number          // 闭区间
  source: SourceTag
  /** 人工确认后才算数；LLM 分段默认 false */
  confirmed: boolean
  tags?: string[]           // 'turn-left' | 'lane-change' | 'stop' ...
}

export type ChannelName = 'steer' | 'throttle' | 'brake' | 'speed'

export interface ActionChannel {
  name: ChannelName
  unit: 'norm' | 'rad' | 'm/s' | 'm/s2'
  /** 逐帧采样，长度 = endFrame - startFrame + 1 */
  values: Float32Array
  startFrame: number
  /** 原始采样率；重采样到帧率后写回 values */
  sourceHz: number
}

export interface AlignmentLink {
  instructionId: string
  /** 该指令实际对应的动作区间，允许与文本区间有偏移 */
  actionRange: [number, number]
  /** 对齐质量 0..1，用于排序复核 */
  score?: number
}

export interface VlaTaskData {
  instructions: InstructionSegment[]
  channels: ActionChannel[]
  /** 可选：专家轨迹/航点，供规划代理指标使用 */
  waypoints?: Float32Array
  alignment: AlignmentLink[]
}
```

**为什么 `values` 是 `Float32Array` 而不是 `number[]`**：20Hz × 60 秒 × 4 通道 = 4800 个数，数组完全可以；但一段 10 分钟的高速场景是 4.8 万，且绘图要逐帧索引。TypedArray 在内存与遍历上都更合适，也与项目现有"点云用 TypedArray"的取舍一致（`types.ts:110-117`）。

**时间基准**：所有 `startFrame/endFrame` 都基于样本帧号，不基于秒。秒只在导出与指标计算时由 `FrameRef.ts` 换算 —— 这一条必须写进开发约定，否则会出现"用 index × 0.1 当时间"的隐性错误。

#### 5.4.2 三条时间线

复用 docs/10 的"双时间线解耦"思想，但这里是三条：

```
数据帧    |1|2|3|4|5|6|7|8|9|...|300|
指令段    |——"沿左侧车道行驶"——|——"前方路口左转"——|
动作通道   ⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋⟋  (steer/throttle/brake)
                ↑ 当前帧游标（三线共享）
```

- 拖动指令段两端 = 改 `startFrame/endFrame`，生成命令。
- 动作曲线用 Canvas 绘制（4 通道分色，共享 x 轴），当前帧处画竖线；支持框选一段做"重采样/去抖"。
- 点击指令段 → 主视口跳到该段首帧，同时高亮动作区间。

#### 5.4.3 对齐校验规则（VLA 专属，P5 执行）

| 规则码 | 检查 | 判定 | 严重度 |
|---|---|---|---|
| `VLA_INSTRUCTION_GAP` | 存在无指令覆盖的帧 | 区间并集 ≠ 全范围 | warn |
| `VLA_INSTRUCTION_OVERLAP` | 两条指令区间重叠 | 区间交集 > 0 | error |
| `VLA_TEXT_EMPTY` | 空文本 / 纯标点 | trim 后长度 < 2 | error |
| `VLA_TEXT_DUP` | 相邻指令文本完全相同 | 归一化后相等 | warn |
| `VLA_ACTION_SIGN` | "左转"但 steer 持续为正（或"右转"为负） | 区间内均值符号与期望相反且 abs > 0.1 | error |
| `VLA_ACTION_LAG` | 动作起始滞后指令起始 | `(onsetFrame - startFrame) / fps > 0.5` | warn |
| `VLA_ACTION_SMOOTH` | 控制量抖动 | jerk 的 95 分位 > 阈值 | warn |
| `VLA_CHANNEL_LENGTH` | 通道长度与帧范围不符 | 长度 ≠ 帧数 | blocker |
| `VLA_WAYPOINT_COUNT` | 航点与时长不匹配 | 数量 < 时长 × 最小密度 | warn |

`VLA_ACTION_SIGN` 是 ref.md 所说"指令—动作对齐需要专门自动化校验规则"的最小可用实现：它不需要理解语言，只需要一张"指令标签 → 期望动作符号"的映射表（左转 → steer < 0，右转 → steer > 0，停车 → brake > 0.3 且 speed → 0）。这张表是**项目配置**，不是模型。

#### 5.4.4 数据来源与"不要假装"

- **导入**：支持 JSONL，一行一个样本：
  `{"sample_id":"...","instructions":[{"text":"...","start_frame":0,"end_frame":45}],"actions":{"steer":[...],"throttle":[...]}}`
- **合成**：`generateVlaDemo()` 基于演示序列生成 20 条指令 + 4 通道平滑曲线，用于打通链路与演示。
- **LLM 辅助分段**：可选，产出 `source.kind='model'` 且 `confirmed=false`，必须人工逐条确认才能导出。**不把 LLM 生成当标注**。

#### 5.4.5 验收

- 5 分钟合成片段（300 帧）能加载、编辑指令段、绘动作曲线，帧游标与三线同步。
- 5.4.3 的 9 条规则能在人为注入错误后全部报出，且不误报干净数据（P4 先做成 `validateVla()` 数据校验器，P5 再接入统一引擎）。
- 导出 JSONL 能被一个独立的 Python 校验脚本读回，字段与长度自洽。

---

### 5.5 P5 质量规则引擎（2 人周，可与 P2 并行）

**目标**：把 QC 从"标注完成后跑一次"变成"流水线内可配置的规则层"。

#### 5.5.1 接口

```ts
// domain/qa/registry.ts
export interface QaRule {
  id: string
  code: string
  name: string
  severity: QaSeverity
  scope: 'frame' | 'track' | 'sequence' | 'crossTask' | 'task'
  /** 只在这些任务存在时执行，避免"没有 Occ 却跑 Occ 规则" */
  requires: TaskKey[]
  /** 参数默认值，profile 可覆盖 */
  defaults: Record<string, number | boolean | string>
  /** 声明依赖，供增量执行判断 */
  dependsOn: { tracks?: boolean; frames?: number[]; tasks?: TaskKey[] }
  evaluate(ctx: QaContext): QaIssue[]
}

export interface QaContext {
  doc: SampleDocument
  /** 只读访问器，避免规则直接改数据 */
  frames: { count: number; ts(i: number): number; cloud(i: number): PointCloud | null }
  /** 当前生效参数（defaults + profile 覆盖 + 项目覆盖） */
  params: Record<string, number | boolean | string>
  /** 局部物化结果缓存，多条规则共享，避免重复 materialize */
  boxes(frame: number): Box3DView[]
  tracks(): Track[]
}
```

```ts
// domain/qa/runner.ts
export interface QaProfile {
  version: string
  /** 规则 id → 参数覆盖 / 是否启用 / 严重度覆盖 */
  rules: Record<string, { enabled?: boolean; severity?: QaSeverity; params?: Record<string, unknown> }>
}

export interface QaRunOptions {
  profile: QaProfile
  /** 增量：只跑与这些帧/轨迹相关的规则 */
  dirty?: { frames?: number[]; tracks?: TrackId[] }
  signal?: AbortSignal
}

export function runQa(doc: SampleDocument, opts: QaRunOptions): AsyncGenerator<QaIssue[], void, void>
export function summarize(issues: QaIssue[]): QaSummary
```

**执行模型**

| 层级 | 复杂度 | 何时跑 | 例子 |
|---|---|---|---|
| frame | O(框数) | 每次编辑当前帧（同步，< 20ms） | `GEO_EMPTY_BOX`、`SEN_PROJECT_OUT_OF_IMAGE` |
| track | O(轨迹帧数) | 编辑后 debounce 300ms | `TRK_SPEED_JUMP`、`TRK_SIZE_INSTABILITY` |
| sequence | O(轨迹数 × 帧数) | 手动/保存前 | `COV_DENSITY_DROP`、`TRK_OUT_OF_BOUNDS` |
| crossTask | O(体素数) | 手动/导出前 | `XT_OCC_BOX_CONTAINMENT` |
| task | O(任务数据量) | 任务内编辑后 | `VLA_ACTION_SIGN` |

**增量执行**：命令的 `affects` 已经给出受影响的帧与轨迹，规则 runner 只跑 `dependsOn` 命中或 scope 为 `sequence` 且被标脏的规则。500 帧场景下，单次编辑的增量检查目标 < 50ms。

**Worker 化**：`workers/qa.worker.ts` 接收 `{ docSnapshot, profile, dirty }`，回传 issue 批次。注意：`SampleDocument` 含 `Uint32Array`/`Map`，结构化克隆可以传，但 `Map` 会丢原型——传之前转成 `[k, v][]` 数组，或在 worker 内重建。这个细节必须先写进契约，否则会出现"worker 里 states 全是 undefined"的诡异 bug。

#### 5.5.2 规则清单（首批 41 条）

**几何 GEO（9）**

| code | 检查 | 严重度 | 关键参数 |
|---|---|---|---|
| `GEO_SIZE_OUT_OF_RANGE` | 尺寸超出类别先验区间 | warn | 每类 min/max |
| `GEO_GROUND_PENETRATION` | 框底低于地面 | warn | 容差 0.1m |
| `GEO_FLOATING` | 框底离地 > 0.5m 且下方无支撑点 | warn | 0.5m |
| `GEO_EMPTY_BOX` | 框内有效点 < 5 | error | 5 |
| `GEO_YAW_FLIP` | 车辆类朝向与长轴差 > 60° | warn | 60° |
| `GEO_DUPLICATE_OVERLAP` | 同类 IoU > 0.8 且中心距 < 0.5m | error | 0.8 / 0.5m |
| `GEO_ASPECT_ANOMALY` | 长宽比超出类别先验 | info | 每类区间 |
| `GEO_POINT_RATIO_LOW` | 框内点占框选区域比例 < 40% | warn | 0.4 |
| `GEO_HEIGHT_MISMATCH` | 框高与点云 z 跨度差 > 30% | warn | 0.3 |

**轨迹 TRK（11）**

| code | 检查 | 严重度 | 关键参数 |
|---|---|---|---|
| `TRK_ID_SWITCH` | 相邻帧位移 > 阈值（现有规则） | error | 12m |
| `TRK_SPEED_JUMP` | 速度突变（现有规则） | warn | 8m/s |
| `TRK_JITTER` | 方向反转（现有规则） | warn | 2.0rad |
| `TRK_GAP` | 中间帧缺失（现有规则） | warn | — |
| `TRK_ACCEL_BOUND` | 加速度超限 | warn | 8m/s² |
| `TRK_YAW_RATE_BOUND` | 角速度超限 | warn | 1.5rad/s |
| `TRK_SIZE_INSTABILITY` | 尺寸跨帧抖动 > 15% | warn | 0.15 |
| `TRK_SINGLE_FRAME` | 轨迹只有 1 帧 | info | — |
| `TRK_OUT_OF_BOUNDS` | 离开 ROI 后仍延续 > 5 帧 | warn | 5 |
| `TRK_INTERP_OVER_REACH` | 插值跨度 > 15 帧未确认 | warn | 15 |
| `TRK_OCCLUSION_UNMARKED` | 轨迹中断但未标 occluded | warn | — |

**传感器 SEN（3）**

| code | 检查 | 严重度 | 关键参数 |
|---|---|---|---|
| `SEN_PROJECT_OUT_OF_IMAGE` | 可见框投影完全在图像外 | warn | — |
| `SEN_PROJECT_TOO_SMALL` | 投影面积 < 阈值（远距离豁免） | info | 12px² |
| `SEN_OCCLUSION_CONFLICT` | 标 visible 但投影区被前景遮挡 > 80% | warn | 0.8 |

**覆盖度 COV（4）**

| code | 检查 | 严重度 |
|---|---|---|
| `COV_EMPTY_FRAME` | 连续空帧 > 10 | warn |
| `COV_CLASS_IMBALANCE` | 某类占比偏离基线 > 3σ | info |
| `COV_DENSITY_DROP` | 相邻帧框数骤降 > 50% | warn |
| `COV_ROI_UNDERLABELED` | ROI 内有稠密点但无框 | warn |

**跨任务 XT（7）**

| code | 检查 | 严重度 |
|---|---|---|
| `XT_OCC_BOX_CONTAINMENT` | 可见框体素占用率 < 90% | error |
| `XT_OCC_CLASS_MISMATCH` | 框内体素类别不一致 | warn |
| `XT_OCC_ISOLATED` | 孤立占据体素（6 邻域无邻居） | info |
| `XT_FLOW_RIGID_ERROR` | 框内光流与刚体预测误差 > 0.05m | warn |
| `XT_SEM_INSTANCE_UNMAPPED` | 语义实例无对应轨迹 | info |
| `XT_LANE_OFFROAD` | 车道线落在非可行驶区 | error |
| `XT_OCC_OVERLAP` | 两个框争夺同一体素，需人工裁决 | info |

**VLA（7）**：见 5.4.3 的 9 条中选 7 条进首批（`GAP/OVERLAP/TEXT_EMPTY/ACTION_SIGN/ACTION_LAG/ACTION_SMOOTH/CHANNEL_LENGTH`）。

合计 41 条。ref.md 提到 Kognic 有 90+ 项，这里首批 41 条不是"缩水"，而是**每条都能被 227 项测试体系验证**；规则数量可以在 profile 里扩，但无用例覆盖的规则只会制造噪音。

#### 5.5.3 报告与原因码

```ts
export interface QaSummary {
  total: number
  bySeverity: Record<QaSeverity, number>
  byCode: Record<string, number>
  /** 健康分：blocker 扣 30、error 扣 12、warn 扣 4、info 扣 1，下限 0 */
  score: number
  /** 返修原因码直方图，供"打回带原因码" */
  reasonCodes: Array<{ code: string; count: number; sampleTargets: string[] }>
}
```

打分公式沿用现有"error 扣 15 / warn 扣 6"的思路（`temporalQA.ts:176-177`），但分级更细。**健康分只用于排序，不用于验收判定**——验收看 blocker/error 是否为 0，避免"分数 85 但有一个致命错误"被放过。

#### 5.5.4 验收

- 现有 4 条时序规则迁移后，在 `injectTemporalDefects`（`temporalQA.ts:192`）注入的数据上输出与旧实现一致（数量与帧号逐个对齐，用快照测试锁定）。
- profile 能按类别覆盖阈值（如 Pedestrian 的 `maxStep` 用 5m 而不是 12m）。
- 增量检查在 200 轨迹 × 500 帧上 < 50ms。

---

### 5.6 P6 闭环与难例挖掘（3 人周）

**目标**：让标注平台从"成本中心"变成"模型迭代的决策节点"——至少在本地方向上做到"哪些样本最值得先标"。

#### 5.6.1 样本指标

```ts
// domain/metrics/sampleIndex.ts
export interface SampleMetrics {
  sampleId: SampleId
  frames: number
  tracks: number
  /** 感知层：与"可信版本"比（人工复核版 / 上一版模型） */
  perception: { meanIoU: number; recall: number; precision: number; kappa: number }
  temporal: { score: number; issues: number; idSwitch: number; gaps: number }
  qa: { score: number; blockers: number; errors: number; warns: number }
  /** 模型与人工的差异度，需要 P2 的血缘 */
  modelDisagreement: { editedRatio: number; rejectedRatio: number; meanConfidence: number }
  /** 场景统计 */
  scene: { actors: number; rareClassRatio: number; night?: boolean; rain?: boolean }
  planning?: PlanningProxyResult
  computedAt: number
}
```

**`modelDisagreement` 的三个指标怎么来**：

- `editedRatio` = 被人工改过几何的模型关键帧数 / 模型产生关键帧数；
- `rejectedRatio` = `review='rejected'` 的模型框 / 模型框总数；
- `meanConfidence` = 模型置信度均值。
这三个数直接来自 P2 的 `source` 与 `review`，这就是"血缘不只是好看"的兑现。

#### 5.6.2 规划代理指标（必须明确是代理）

```ts
// domain/derive/planningProxy.ts
export interface EgoState { position: Vec3; yaw: number; speed: number; size: Vec3 }

export interface ActorFuture {
  trackId: TrackId
  /** 未来轨迹采样，frame 升序；来自 Track 关键帧的物化结果 */
  poses: Array<{ frame: number; position: Vec3; yaw: number }>
}

export interface PlanningProxyInput {
  ego: EgoState                       // 位置、速度、朝向、尺寸
  actors: ActorFuture[]               // 来自轨迹的未来 3s 轨迹
  horizonS: number                    // 默认 3
  dt: number                          // 默认 0.1
  /** 可选：专家轨迹（来自 VLA waypoints 或数据集 ego future） */
  expert?: Float32Array
}

export interface PlanningProxyResult {
  /** 最小碰撞时间（秒），无风险为 null */
  minTTC: number | null
  /** 0..1，越大越危险 */
  collisionRisk: number
  /** 舒适度：加速度/ jerk 超限比例，0..1 */
  comfort: number
  /** 与专家轨迹的横向/纵向偏差（米），无专家轨迹时为 undefined */
  deviation?: number
  /** 每个目标对风险的边际贡献，用于"这条标注为什么重要" */
  sensitivity: Array<{ trackId: TrackId; deltaRisk: number }>
}
```

实现分三步，刻意保持"薄"：

1. **自车规划**：IDM 纵向 + 纯跟踪横向。
   `a = a_max [1 - (v/v0)^δ - (s*/s)^2]`，`s* = s0 + vT + vΔv / (2√(a_max·b))`。
   参数取城市工况（`v0=15m/s, T=1.5s, a_max=2.5, b=3.0, s0=2.0`），全部可配。
2. **风险计算**：对每个 actor 的未来轨迹与自车未来轨迹做逐时刻圆/矩形包络相交检测，`TTC = 首次相交时刻`；`collisionRisk = 1 - minTTC/horizon`（截断到 0..1）；整段无相交时 `minTTC = null`、`collisionRisk = 0`（不是 1，否则空场景会被判为最危险）。
3. **敏感度**：对每个 actor 的框做 ±0.2m / ±5° 扰动，重算 `collisionRisk`，取 `|Δ|` 排序。这就是 ref.md 说的"标注对规划决策的支撑程度"的可计算代理——**如果挪 20cm 就让风险从 0.1 跳到 0.6，这条标注就是关键标注**。

**诚实边界（必须写进 UI 与报告）**：这不是真实规划器，不能用来评价规划算法。它只回答"在当前几何与运动假设下，哪些目标的标注误差会改变风险排序"。把它当 benchmark 是误用。

#### 5.6.3 难度分

```ts
// domain/metrics/difficulty.ts
export interface DifficultyConfig {
  weights: { disagreement: number; qa: number; actors: number; rare: number; sensitivity: number }
  caps: { actors: number; qaDensity: number }   // 归一化上限
}
export function scoreDifficulty(m: SampleMetrics, cfg: DifficultyConfig): {
  total: number                                  // 0..100
  parts: Record<keyof DifficultyConfig['weights'], number>
  reasons: string[]                              // 人类可读："模型改动 62% · 密集目标 34 个"
}
```

归一化：`norm(x) = min(1, x / cap)`。默认权重 `0.3 / 0.25 / 0.15 / 0.1 / 0.2`，加起来为 1。理由：模型分歧与质检问题是最直接的"模型短板"信号；目标数量与稀有类别是场景难度；敏感度是"对规划的影响"。权重可配，但必须能在报告里看到分项，避免变成黑箱。

#### 5.6.4 回流包

```
reflow-2026-11-24T08-00.zip
├── manifest.json        { version, createdAt, profile, criteria, sampleCount }
├── samples.jsonl        一行一个 { sampleId, score, parts, reasons, metrics }
└── tasks/
    └── <sampleId>.json  { reasonCodes, issueIds, requestedFrames, assignee? }
```

导入侧：读到 `samples.jsonl` 后在数据集列表里生成一个"回流队列"虚拟数据集，按分数排序，点进去直接定位到 `requestedFrames`。这样闭环在单机内成立；P7 接后端时，这个包就是任务创建请求体。

#### 5.6.5 验收

- 对 100 个样本（可用生成数据 + 演示序列扩充）算指标并排序，前 20 名与人工挑选的"难例"重合率 ≥ 60%（人工挑选作为基准，允许主观性）。
- 敏感度计算：单样本 50 目标 × 40 次扰动 < 2s。
- 回流包能被自身导入，且 issue 定位到帧/目标。

---

### 5.7 P7 协作与服务端（可选，4–6 人周）

只在"确实要多人协作"时启动。本文只定接口，避免过度设计。

| 能力 | 接口 | 实现要点 |
|---|---|---|
| 文档读写 | `DocumentStore.load/save(sampleId, doc, baseVersion)` | 乐观锁：版本不匹配返回 409 + 双方 diff |
| 冲突仲裁 | `diffDocuments(a, b): CommandData[]` | 因为命令是数据，diff 可以退化为"命令流合并"；同目标几何冲突交人工 |
| 审计 | `AuditEntry[]` 追加写 | 不可变日志，按 sampleId + 时间索引 |
| 任务流转 | `TaskState = 'pending'\|'labeling'\|'review'\|'rework'\|'done'` | 状态机 + 原因码（来自 `QaSummary.reasonCodes`） |
| 权限 | `Role = 'annotator'\|'reviewer'\|'admin'` | 最小实现：操作白名单，不做 RBAC 框架 |

**乐观锁的具体规则**（README 第 4.2 节已有思路，这里落细）：

1. 提交携带 `baseVersion`；
2. 服务端若 `baseVersion !== current.version`，拒绝并返回从 `baseVersion` 到当前的所有命令；
3. 客户端重放这些命令到本地文档，重新计算差异；
4. 若无同目标同帧的几何冲突，自动合并并重试一次；否则进入"冲突裁决"界面（左右两版叠加显示）。

---

## 6. 关键算法与实现细节

这一节是给实现者看的，不是概览。

### 6.1 轨迹插值：从线性到运动模型

现有 `lerpBox`（`sequence.ts:42-59`）逐字段线性插值，有三个问题：位置在转弯时切角、朝向在长间隔下会"甩头"、尺寸会插出中间值（车"变胖变瘦"）。

```ts
// domain/ops/interpolate.ts
export function hermite(p0: number, p1: number, m0: number, m1: number, t: number): number {
  const t2 = t * t, t3 = t2 * t
  const h00 = 2 * t3 - 3 * t2 + 1
  const h10 = t3 - 2 * t2 + t
  const h01 = -2 * t3 + 3 * t2
  const h11 = t3 - t2
  return h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1
}

/** 端点速度：用前后相邻关键帧的中心差分，单位 米/帧；无邻居则为 0 */
function endpointVelocity(track: Track, i: number): Vec3 {
  const prev = track.keyframes[i - 1]
  const next = track.keyframes[i + 1]
  if (!prev || !next) return { x: 0, y: 0, z: 0 }
  const df = next.frame - prev.frame
  return {
    x: (next.geometry.position.x - prev.geometry.position.x) / df,
    y: (next.geometry.position.y - prev.geometry.position.y) / df,
    z: (next.geometry.position.z - prev.geometry.position.z) / df,
  }
}

/** 端点角速度：弧度/帧；相邻两段都先规范化到 (-π, π]，避免跨 ±π 产生假角速度 */
function endpointYawRate(track: Track, i: number): number {
  const prev = track.keyframes[i - 1]
  const next = track.keyframes[i + 1]
  if (!prev || !next) return 0
  const df = next.frame - prev.frame
  return normalizeAngle(next.geometry.yaw - prev.geometry.yaw) / df
}

export function interpolateSegment(
  track: Track, i: number, b: Keyframe, frame: number, opts: InterpolateOptions,
): BoxGeometry {
  const a = track.keyframes[i]            // 左关键帧
  const span = b.frame - a.frame
  const t = (frame - a.frame) / span
  const pA = a.geometry.position
  const pB = b.geometry.position
  const vA = endpointVelocity(track, i)
  const vB = endpointVelocity(track, i + 1)
  const wA = endpointYawRate(track, i)       // 弧度/帧，差分前先 normalizeAngle
  const wB = endpointYawRate(track, i + 1)
  // 注意：m 必须是"每段跨度内的位移量"，所以速度乘以 span
  const x = hermite(pA.x, pB.x, vA.x * span, vB.x * span, t)
  const y = hermite(pA.y, pB.y, vA.y * span, vB.y * span, t)
  // z 若噪声大（地面抖动），可退化为线性：pA.z + (pB.z - pA.z) * t
  const z = hermite(pA.z, pB.z, vA.z * span, vB.z * span, t)
  const yaw = hermiteAngle(a.geometry.yaw, b.geometry.yaw, wA * span, wB * span, t)
  const scale = opts.size === 'constant' ? medianScale(a, b) : lerpScale(a, b, t)
  return { position: { x, y, z }, scale, yaw }
}
```

`hermiteAngle` 的关键：先把 `b.yaw - a.yaw` 规范到 `(-π, π]` 得到 `delta`，把右端点写成 `a.yaw + delta`（**展开到连续角域**），再在展开后的角域上做 Hermite，最后只在输出时按需归一化。这样既不会在 ±π 边界绕远路，也不会因为 `t→1` 的浮点误差跳到另一侧。角速度端点同样用相邻关键帧的**规范化差分**估计（每段差值都先过一遍 `(-π, π]`），否则跨 ±π 的相邻帧会算出 6.28 rad/帧的假角速度。现有 `lerpAngle`（`sequence.ts:34-39`）的 while 规范化就是同一套逻辑，抽成 `normalizeAngle` 复用，禁止另写一份。

### 6.2 RTS 平滑（可选，只作用于非关键帧）

对每条轨迹的 `(t, x)` 序列做前向 Kalman（状态 `[p, v]`，`q=0.5`，`r=1.0`）再后向平滑：

```
前向：x̂ₜ|ₜ, Pₜ|ₜ
后向：Cₜ = Pₜ|ₜ Fᵀ Pₜ₊₁|ₜ⁻¹
      x̂ₜ|N = x̂ₜ|ₜ + Cₜ (x̂ₜ₊₁|N - x̂ₜ₊₁|ₜ)
```

约束：`keyframe.locked === true` 的帧作为硬观测（`r` 极小），平滑后位置偏移 > 0.3m 时放弃该轨迹的平滑并提示（说明标注本身抖动过大，应先修标注）。

### 6.3 占据生成：为什么不做全量射线雕刻

| 方案 | 150k 点耗时 | 正确性 | 结论 |
|---|---|---|---|
| 只做框填充 | 20–60ms | 目标内正确，背景全 unknown | 默认 |
| 框 + 地面带 | 80–120ms | 地面自由、目标占据、其余 unknown | 默认增强 |
| 全量 DDA 射线雕刻 | 2–5s | 自由空间最准 | 仅 ROI 精修 |
| 学习模型（AutoOcc 类） | 推理 200ms+ | 最准 | 交给 Provider，不在端内实现 |

**"unknown 不能当 free"** 是 Occ 标注的第一原则：把未观测区域标成自由，训练出的模型会以为墙后是空的。UI 里 free / occupied / unknown 必须是三种颜色，且默认只显示 occupied。

### 6.4 刚体光流的精确形式

对框内点 `p`，目标从 `(c, R)` 变到 `(c', R')`：

```
p' = R' R⁻¹ (p - c) + c'
flow = p' - p
```

当只绕 z 旋转时，`R' R⁻¹ = Rz(Δyaw)`，展开即：

```
dx = cosΔ·(px-cx) - sinΔ·(py-cy) + cx' - px
dy = sinΔ·(px-cx) + cosΔ·(py-cy) + cy' - py
dz = cz' - cz
```

这是解析解，不是近似。测试里可以直接验证：给定一个匀速旋转的目标，误差应 < 1e-5。

### 6.5 预标注合并的代价矩阵细节

```ts
const BIG = 1e9
const cost = manual.map((m) =>
  models.map((p) => {
    if (policy.classMustMatch && m.label !== p.classId) return BIG
    // PreObject 只有 BoxGeometry，先转成 Box3D 再算 IoU（quality.ts:172 需要 label）
    const iou = boxIoU3D(m, toBox3D(p))        // 复用 quality.ts:172
    if (iou < policy.iouThreshold) return BIG
    return 1 - iou
  }),
)
const assignments = hungarian(cost)            // 复用 tracker.ts:57
```

三个坑：

1. `hungarian` 内部会把 `BIG` 当"不可用边"过滤（`tracker.ts:85`、`145`），所以传 `1e9` 是契约，不要传 `Infinity`（`maxCost` 计算会变 `Infinity`，势能失效）。
2. 代价必须是"越小越好"，而 Hungarian 实现内部转成了"收益越大越好"，不要在外面再取反。
3. 空矩阵要分两种短路：某帧**没有人工框**时 `cost` 本身是 `[]`；**没有模型框**时每一行是 `[]`。前者 `hungarian([])` 返回 `[]`，后者会在内部读 `cost[0].length` 前就需要判断；两种都在调用处先 `if (!manual.length || !models.length) return`。

### 6.6 规则引擎的确定性

规则里**禁止**：`Date.now()`、`Math.random()`、读 `localStorage`、依赖对象遍历顺序。
必须由 `QaContext` 注入 `now` 与 `ts(i)`。原因：P6 的难度分与回流包需要"同一文档同一 profile 产出同一报告"，否则快照测试无从写起，线上也无法复现用户看到的问题。

---

## 7. 性能与内存预算

### 7.1 目标场景

| 维度 | 演示 | 单序列（目标） | 压力 |
|---|---|---|---|
| 帧数 | 5 | 500 | 2000 |
| 每帧点数 | 6k–67k | 150k | 300k |
| 轨迹数/帧 | 6–24 | 100 | 300 |
| 任务数 | 1–2 | 3（框/语义/占据） | 5 |

### 7.2 预算表（500 帧 × 150k 点 × 100 轨迹 × 3 任务）

| 项 | 计算 | 结论 |
|---|---|---|
| 单帧点云（xyz f32 + label u16） | 150k × 14B | 2.1MB |
| 全量点云（禁止） | 500 × 2.1MB | **1.05GB → 不可行** |
| 帧窗口（5 帧） | 5 × 2.1MB | 10.5MB |
| 轨迹真值（稀疏） | 100 轨迹 × 平均 8 关键帧 × ~150B | ~120KB |
| 观测状态 | 500 × 100 × 20% × 40B | ~400KB |
| 占据（RLE） | 500 × ~60KB | ~30MB（按需加载） |
| 光流 | 不落盘 | 0 |
| VLA（300 帧 × 4 通道） | 1200 × 4B | ~5KB |
| 文档元数据 | — | < 1MB |
| **CPU 侧常驻合计** | 窗口 + 真值 + 元数据 | **< 50MB**（不含按需占据与 GPU 缓冲） |

对比现状：同样一段序列需要 1.05GB 常驻，必然崩溃。这就是 P0 必须前置的量化理由。

### 7.3 交互延迟目标

| 操作 | 目标 | 手段 |
|---|---|---|
| 切帧 | P95 < 120ms | 帧窗口预取 ±1 帧；worker 解析 |
| 拖动框 | 60fps（< 16ms/帧） | 现有签名缓存 + 只改矩阵，不重建几何 |
| 单帧规则 | < 20ms | 同步执行，对象池复用 |
| 增量规则 | < 50ms | 只跑脏轨迹 |
| 占据生成 | < 120ms/帧 | worker + box-only 快路径 |
| 占据渲染 | < 15ms | InstancedMesh + 只画 occupied |
| 全量导出 | 500 帧 < 5s | 流式序列化 + `Blob` 分片 |

### 7.4 现状性能基线（可复现）

`docs/07-engineering-p0.md:141-144` 的实测：100 万点 → 体素 50.1 万（1355ms）→ 距离 LOD 27.1 万（36ms），总压缩 3.7×，内存 −73%。这段数据说明**下采样是有效但昂贵的**，所以 P0 必须把它挪进 worker，否则首帧解析会冻结主线程 1.4 秒。

---

## 8. 文件级改造清单与迁移风险

### 8.1 清单

| 文件 | 阶段 | 动作 | 风险 | 回归手段 |
|---|---|---|---|---|
| `core/types.ts` | P1 | 给 `Box3D` 加可选 `trackId`/`sourceKind`；其余不动 | 低 | 227 项 |
| `core/history.ts` | P1 | 保留 `cloneBoxes`；`HistoryStack` 标记 deprecated | 低 | 新命令测试 |
| `core/io/session.ts` | P0 | 降级为 v1 迁移器 | 中 | 迁移对照测试 |
| `core/sequence/sequence.ts` | P1 | `FrameData` 保留用于导入/演示；插值函数移到 domain | 中 | 插值对照 |
| `core/sequence/temporalQA.ts` | P5 | 规则迁到 `qa/rules/trk.ts`，旧函数保留为适配器 | 中 | 快照测试 |
| `state/studioCore.ts` | P1 | 真值源替换；`mutate` 兼容 | **高** | 手工清单 + dev 警告 |
| `state/useAnnotation.ts` | P1 | 建/改/删走命令 | **高** | 同上 |
| `state/useSequence.ts` | P1 | 去掉写回；插值/传播走命令 | **高** | 同上 |
| `state/useDataset.ts` | P0 | 懒加载 + DataSource | 中 | 真实数据对照 |
| `state/useStudio.ts` | P0/P1 | 保存分两段；`boxes` 由 computed 提供 | 中 | 断网/刷新测试 |
| `viewer/PointCloudViewer.ts` | P3 | 加占据/光流图层 | 中 | 视觉对照 + FPS |
| `components/RightPanel.vue` | P2/P3 | 新增「任务」「复核」页 | 低 | — |
| `components/Timeline.vue` | P1 | 新增 | 低 | — |
| `components/panels/*` | 各阶段 | 按任务加面板 | 低 | — |

### 8.2 迁移策略：双写期

P1 上线时，真值在 `TrackStore`，但 `frames[i].boxes` 仍保留为**物化缓存**，避免一次性改 30+ 处读取点：

```
写入：命令 → TrackStore → materialize → frames[i].boxes（缓存）→ boxes（当前帧）
读取：现有代码继续读 boxes / frames[i].boxes
```

三个阶段：

1. **只读切换**（1 周）：`boxes` 由 store 物化，写入仍走旧 `mutate`，但内部转成命令。目的是验证"物化结果与旧数据逐字段一致"。
2. **写路径切换**（1 周）：所有编辑走命令；`frames[i].boxes` 只写不读（除导出外）。
3. **移除缓存**（0.5 周）：导出改为 `materializeAll()`，`frames[i].boxes` 删除。

每个阶段都能独立发布；阶段 1 的验收是"打开任意数据集，物化后导出与改造前 diff 为空"。

### 8.3 数据结构迁移

```ts
// core/io/session.ts 保留的迁移入口
const toGeometry = (b: Box3D): BoxGeometry => ({
  position: { ...b.position },
  scale: { ...b.scale },
  yaw: b.yaw,
})

export function migrateV1(snapshot: SessionSnapshot): SampleDocument {
  const tracks: Track[] = []
  const seen = new Map<string, Track>()

  // v1 有两种形态：多帧序列（frames 非空）与单帧数据集（只有 cloud + boxes）。
  // 单帧也必须迁移，否则"打开旧草稿什么都没有"。
  const frameList = snapshot.frames.length
    ? snapshot.frames.map((f) => ({ index: f.index, boxes: f.boxes }))
    : [{ index: 0, boxes: snapshot.boxes }]

  frameList.forEach((f) => {
    for (const b of f.boxes) {
      let t = seen.get(b.id)
      if (!t) {
        t = {
          id: b.id, classId: b.label, attributes: b.attributes ?? {},
          keyframes: [], states: new Map(),
          lifecycle: { first: f.index, last: f.index, state: 'active' },
        }
        seen.set(b.id, t)
        tracks.push(t)
      }
      t.keyframes.push({ frame: f.index, geometry: toGeometry(b), source: { kind: 'manual' } })
      t.lifecycle.last = Math.max(t.lifecycle.last, f.index)
      if (b.visibility && b.visibility !== 'visible') {
        t.states.set(f.index, { visibility: b.visibility, source: { kind: 'manual' }, review: 'none' })
      }
    }
  })
  // 防御：v1 的 frames 不保证按 index 升序，而 T1 要求 keyframes 严格递增
  for (const t of tracks) t.keyframes.sort((a, b) => a.frame - b.frame)

  const last = frameList[frameList.length - 1].index
  return {
    schema: 2,
    sampleId: `imported#0-${last}`,
    sceneId: 'imported',
    range: [0, last],
    tasks: { boxes: { tracks } },
    meta: {
      version: 1, baseVersion: 0, updatedAt: snapshot.savedAt,
      updatedBy: 'migration', hashes: {},
    },
  }
}
```

注意：v1 的每一帧框都会变成关键帧（因为没有"哪些帧是插值"的信息）。迁移后应跑一次 `TRK_INTERP_OVER_REACH` 之外的启发式压缩：**若某帧的框与前后帧线性插值误差 < 1cm，则降级为非关键帧**。这一步能把迁移后的关键帧数量降一个数量级，代价是可接受的（误差在容差内）。

---

## 9. 测试与验收

### 9.1 测试金字塔

| 层 | 工具 | 覆盖 | 数量目标 |
|---|---|---|---|
| 纯算法单测 | 现有 `tests/core-check.ts` + esbuild | domain 全部纯函数 | 227 → 500+ |
| 快照测试 | 同一脚本内 JSON 对比 | 规则输出、物化结果、导出格式 | 30 组 |
| 契约测试 | 手写 fixture | Provider 协议、导出格式、v1 迁移 | 15 组 |
| 性能门禁 | `performance.now()` 断言（宽松） | 切帧、单帧规则、RLE 编解码 | 8 项 |
| 手工清单 | 浏览器 | 交互、视觉、跨浏览器 | 每阶段 20 条 |

**为什么不引入 Vitest/Playwright**：项目当前零测试框架依赖，`pnpm test:core` 用 esbuild 打包后 node 执行，启动 < 1s。在 500 项以内这个方案完全够用，且对贡献者友好。等引入真正的浏览器 E2E 需求（如拖拽手柄的像素级回归）再评估 Playwright。

### 9.2 必测的 12 类性质

1. **物化幂等**：`materialize(doc, f)` 连续调用两次结果相同。
2. **命令回滚**：任意 `apply → revert` 后文档深比较相等（含 `Map`）。
3. **插值端点**：`t=0` / `t=1` 精确落在关键帧上。
4. **角度跨界**：`a.yaw=3.13, b.yaw=-3.13` 的插值走短弧（总变化 0.02rad）。
5. **RLE 往返**：`decode(encode(x)) === x`（逐体素）。
6. **占据确定性**：同输入同输出，不依赖遍历顺序。
7. **合并守恒**：`created + updated + conflicts + skipped === 模型框总数`。
8. **I1 单调性**：删掉更多体素，`XT_OCC_BOX_CONTAINMENT` 的问题数不减。
9. **规则无副作用**：跑两遍规则，文档哈希不变。
10. **导入导出往返**：SUSTech/KITTI 格式 `parse(serialize(x))` 在容差内相等（现有能力不能退化）。
11. **迁移无损**：v1 快照 → v2 → 导出单帧 JSON，与 v1 直接导出 diff 为空。
12. **帧窗口不泄漏**：连续切 1000 帧，`FrameCache` 占用不超过预算上限。

### 9.3 阶段门禁（Go / No-Go）

| 阶段 | 门禁 |
|---|---|
| P0 | 500 帧常驻 < 400MB；v1 迁移无损；227 项绿 |
| P1 | 跨帧操作可撤销；切帧不清历史；227 + 40 项绿；手工清单通过 |
| P2 | mock provider 可复现；复核可撤销；导出过滤正确 |
| P3 | 占据 RLE 往返；I1/I2 能报错；光流解析解误差 < 1e-3 |
| P4 | 9 条 VLA 规则注入后全报；导出 JSONL 可回读 |
| P5 | 旧 4 条规则行为一致；profile 覆盖生效；增量 < 50ms |
| P6 | 100 样本排序产出；回流包可导入；敏感度 < 2s |

任一阶段门禁不过，**不进入下一阶段**。这是控制"范围蔓延"的唯一有效手段。

---

## 10. 排期与人力

假设：1 名熟悉本仓库的前端（能读 `core` 与 Three.js），无专职后端。

| 阶段 | 人周 | 依赖 | 可并行 |
|---|---|---|---|
| P0 | 2 | — | — |
| P1 | 4 | P0 | — |
| P2 | 3 | P1（需 Track/命令） | 与 P5 并行 |
| P3 | 6 | P1 | P3 内部 Occ 与 Flow 可并行 |
| P4 | 4 | P1（时间轴） | 与 P3 并行（若两人） |
| P5 | 2 | P1 | 与 P2/P3 并行 |
| P6 | 3 | P2/P3/P5（需要血缘、指标、规则） | — |
| P7 | 4–6 | P0/P1 | 视需求 |

单线程顺序：2 + 4 + 3 + 6 + 4 + 2 + 3 = **24 人周**。
两人（1 前端 + 1 算法/数据）：关键路径 P0 → P1 → P3 → P6 ≈ 15 周，P2/P4/P5 由第二人并行插入。

**排期上最容易被低估的是 P3**。Occupancy 的体素化本身两天能写完，剩下四周全在"渲染性能、ROI 编辑、跨任务规则、导出对接"——这些才是它值 6 人周的原因。

### 10.1 裁剪方案（资源不足时怎么砍）

全量 24 人周对个人项目不现实，以下是三种可交付的裁剪组合。原则：**可以砍任务类型，不能砍 P1**。

| 预算 | 做哪些 | 交付价值 | 明确不做 |
|---|---|---|---|
| **2 周** | P1 的 5.1.1–5.1.4（TrackStore + 命令 + 关键帧 + 时间线），跳过 P0 数据层 | 跨帧编辑可撤销、轨迹级操作；序列上限约 50 帧 | 预标注、多任务、规则引擎 |
| **1 个月** | P1 + P5 框架（旧 4 条规则迁移 + 新增 10 条几何/轨迹规则） | 4D 编辑 + 可配置质检，能报出真实问题 | Occupancy、VLA、闭环 |
| **3 个月** | P0 + P1 + P2 + P5 | 懒加载 + 4D 内核 + 预标注复核 + 规则引擎，对应 ref.md 优先级 1/2 与 QA 要求 | P3/P4/P6 全部 |

**不要选的组合**：先做 P3（Occupancy）而跳过 P0/P1。它在演示里最好看，但没有 Track 真值与懒加载，500 帧就崩，而且框与占据的一致性规则无从落地——三个月后必然返工，这是本方案里最确定的一条经验判断。

---

## 11. 风险登记表

| 编号 | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | `boxes` 改造漏点导致丢数据 | 高 | 高 | 双写期三阶段 + dev 期直接写入告警 + 物化 diff 验收 |
| R2 | 插值帧被当成 ground truth 训练 | 中 | 高 | `source.kind='interp'` + 导出默认过滤 + 规则 `TRK_INTERP_OVER_REACH` |
| R3 | Occupancy 工作量失控 | 高 | 中 | 明确"消费+抽检"定位；逐格编辑只给 ROI；不做 Octree |
| R4 | 没有真实 VLA 数据，链路空转 | 高 | 中 | 合成数据 + JSONL 导入 + 明确"只验证链路，不验证规模" |
| R5 | 浏览器内存/配额打满 | 中 | 高 | 帧窗口 + 分段存储 + 配额预检 + 手动导出兜底 |
| R6 | 规则数量膨胀但无用例 | 中 | 中 | 每条规则必须有正例/反例 fixture 才能合入 |
| R7 | 规划代理指标被误读为真实规划评测 | 中 | 高 | 命名带 `proxy`，UI/报告固定免责声明，不进入对外指标 |
| R8 | 预标注服务不可用导致功能形同虚设 | 中 | 中 | 文件模式 + mock 模式保证离线可用 |
| R9 | 多任务文档写放大导致保存卡顿 | 中 | 中 | 任务分段存储 + 脏任务合并 + 防抖 1.2s（沿用现有策略） |
| R10 | 阶段并行导致接口漂移 | 中 | 中 | domain 接口先冻结一版，变更需在文档里记 ADR |

---

## 12. 开发约定（避免实现期扯皮）

1. **单位**：长度米、角度弧度、时间秒（仅 `FrameRef.ts` 与导出层做换算）、像素只出现在 UI 层。
2. **ID**：`TrackId` 为数字字符串，单调分配，**永不复用**；`CommandId` 用 `<timestamp>-<counter>`；`SampleId` 为 `<sceneId>#<start>-<end>`。
3. **时间**：领域层禁止 `Date.now()`；需要时间的地方从 `QaContext.now` 或命令 `meta.at` 取。
4. **不可变**：命令的 `before/after` 必须是深拷贝；`TrackStore` 内部写时复制（改轨迹时替换对象，不改原对象），否则撤销会拿到被污染的引用。
5. **错误**：domain 抛 `DomainError { code, message, detail }`，UI 统一映射为状态栏文案；禁止 `throw new Error('失败')`。
6. **Feature flag**：`?tasks=box,occ,vla&doc=v2`；未启用的任务不加载代码（动态 import），避免包体膨胀。
7. **命名**：规则码 `AREA_WHAT`；命令类型 camelCase；接口用 `Port` 后缀；适配器用 `Adapter` 后缀。
8. **注释**：延续现有风格——解释"为什么"，不解释"是什么"；每个算法文件头部写"诚实边界"。
9. **二进制与容器边界**：`TypedArray` 只在内存与 Worker transfer 中使用；落盘、导出、`JSON.stringify` 前必须转成可逆的普通结构（`{ bufferKey }` 或 base64）。`Map` 一律走 `encodeStates/decodeStates`，不依赖 `JSON.stringify` 的隐式行为。
10. **数值容差**：几何比较用 `1e-6`，点云/体素用 `1e-3`，指标比较用 `1e-4`；禁止用 `===` 比较浮点，测试里统一用 `close(a, b, tol)`（现有 `tests/core-check.ts` 已有该工具）。

---

## 13. 与 ref.md 的逐条对照

| ref.md 的要求 | 本文落点 | 兑现方式 |
|---|---|---|
| 多帧时序上的目标轨迹、跨帧实例 ID 关联 | 4.2 / P1 | `Track.keyframes` + `lifecycle` |
| 检测—跟踪—轨迹优化链路 | P1 / P2 | 关键帧 + 插值 + 平滑 + 预标注模型 track |
| 同时管理 3D 框、未来轨迹、Occupancy、光流 | 4.3 / P3 | `SampleDocument.tasks` |
| 从轨迹注解自动衍生 OccFlow | 5.3.2 / 5.3.3 | `carveFromTracks` / `rigidFlow` |
| 多任务标注的一致关联 | 5.3.4 | I1–I6 约束 + 规则码 |
| VLA：语言指令、逐帧动作、指令—动作对齐 | 4.3 / P4 | `InstructionSegment` / `ActionChannel` / `AlignmentLink` |
| 预标注作为一等公民、灵活接入不同模型 | 5.2.1 | `PreAnnotationProvider` + 三种适配器 |
| 人工界面聚焦修正、补全、对齐 | P1/P2 | 关键帧编辑 + 复核队列 + 轨迹时间线 |
| 消费并抽检自动生成的 Occupancy | 5.3.2 | 导入 + 抽检 + I1/I2 校验 |
| 标注—训练—评测—难例回流闭环 | P6 | 指标库 + 难度分 + 回流包 |
| QA 作为可配置规则引擎嵌入流水线 | P5 | `QaRule` + profile + 增量执行 |
| 90+ 项自动化检查 | 5.5.2 | 首批 41 条，可扩展到 90+，每条带 fixture |
| 为"指令—轨迹对齐"设专门校验 | 5.4.3 | 9 条 VLA 规则，含符号一致性 |
| 底座：4D/时序数据结构先行 | P1 | 全案第一优先，先于任何任务扩展 |
| 平台成为预标注"消费端"而非自建模型 | 0.3 / P2 | 明确不做模型 |

---

## 14. 决策记录（ADR 摘要）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | `Box3D` 保留为投影视图，不删除 | 全局替换为 `Track` | 渲染/正交/质检/格式/标定等十余个模块依赖它；删除等于重写 |
| D2 | 多任务放在一个 `SampleDocument` | 每任务一个文件 | 一致性校验需要单次读取；本地无事务 |
| D3 | 命令是数据而非闭包 | `{do, undo}` 闭包 | 可序列化、可重放、可审计、可跨端 |
| D4 | 关键帧稀疏 + 状态稀疏 | 全帧稠密数组 | 10 万级对象下 JSON 体积差 100 倍 |
| D5 | Occupancy 稀疏索引 + RLE 落盘 | 稠密 `Uint8Array` | 500 帧从 320MB 降到 30MB |
| D6 | 光流按需生成、不落盘 | 逐帧预计算存储 | 150k×3×4B = 1.8MB/帧，且刚体流是解析解 |
| D7 | 规则首批 41 条而非 90 条 | 对齐 Kognic 数量 | 无用例覆盖的规则只产生噪音 |
| D8 | 规划指标命名为 proxy | 直接叫"规划评测" | 避免误导；它不是真实规划器 |
| D9 | 保留 `tests/core-check.ts` 体系 | 引入 Vitest | 零依赖、启动快、贡献门槛低；500 项以内够用 |
| D10 | P7 只留接口不实现 | 直接做后端 | 无协作需求时是纯负债 |

---

## 15. 下一步（不改代码的前提下可做的事）

1. **评审本文**：重点确认 0.2 的优先级与 0.3 的"不做"，这两处一旦有分歧，后面全要改。
2. **冻结 domain 接口**：把第 4 节的类型与第 5 节的接口签名抄成 `src/domain/model/*.ts` 的空实现（只有类型、没有逻辑），让 `pnpm typecheck` 先通过。这一步不改变任何运行时行为，但能让后续 PR 有共同语言。
3. **准备 3 个 fixture**：一段 50 帧真实序列、一份带预标注结果的 JSON、一份 VLA JSONL。没有 fixture 的阶段不要开工。
4. **补 README 索引**：实现落地后再把本文加入第 3 节学习路线（现在加会让人误以为已实现）。


---

## 16. 实现进度（第一批：P0 数据地基 + P1 4D 内核）

> 本节是落地记录，与前面的设计对照阅读。**改动集中在新增的 `src/domain`，以及 `state/` 的写回逻辑；
> 渲染器、正交视图、质检、格式解析一行未改。**

### 16.1 已实现文件

| 文件 | 职责 |
|---|---|
| `src/domain/model/geometry.ts` | `Vec3` / `BoxGeometry` / `Pose`、最短弧角度、容差比较、Hermite 基函数 |
| `src/domain/model/ids.ts` | `SampleId` / `TrackId` / `ClassId`，数字 id 分配（不复用被删号） |
| `src/domain/model/track.ts` | `Track` / `Keyframe` / `ObservationState`、关键帧二分查找、生命周期、不变量 T1–T3、端点速度 |
| `src/domain/model/document.ts` | `SampleDocument`（schema 2）、`DocMeta`、各任务载荷的最小形状 |
| `src/domain/model/command.ts` | `CommandData` 联合类型、affects 自动推导、审计摘要 |
| `src/domain/model/issue.ts` | `QaIssue` + `TemporalIssue → QaIssue` 适配（P5 的输入契约） |
| `src/domain/model/scene.ts` | `SceneMeta` / `SensorSpec` / `DataRef` / `FrameRef`（`ts` 独立于 `index`） |
| `src/domain/store/applyCommand.ts` | `applyCommand` / `revertCommand` 一一对照；写入前一律 clone |
| `src/domain/store/commandHistory.ts` | 文档级撤销栈（limit 500）、coalesce 合并、审计流 |
| `src/domain/store/editSession.ts` | 编辑前后按 `trackId` diff，把老代码的 `Box3D` 改动翻译成命令 |
| `src/domain/store/trackStore.ts` | 真值容器：exec / undo / redo / materialize / materializeAll / 审计 |
| `src/domain/store/materialize.ts` | `Track + frame → Box3DView`，`Box3D` 降级为投影视图 |
| `src/domain/store/frameCache.ts` | 按字节预算的 LRU（默认 256MB，命中返回同一引用） |
| `src/domain/ops/interpolate.ts` | Hermite / 线性插值、尺寸恒定、补帧规划、coasting |
| `src/domain/ops/trackOps.ts` | 建/删/改/插值/传播/复制/合并/拆分/遮挡标记的命令构造 |
| `src/domain/io/legacyDocument.ts` | v1（整帧 `Box3D[]`）→ v2 文档；反向导出逐帧框 |
| `src/ports/*.ts` | `BlobStore` / `DataSource` / `DocumentStore` 三个端口（无实现） |
| `src/components/Timeline.vue` | 轨迹时间线：跨度条 + 关键帧刻度 + 当前帧指针 + 拆分/合并/补帧入口 |
| `scripts/check-layers.mjs` | 分层机器校验（domain 不得依赖 vue/three/UI，core 不得依赖 domain） |
| `tests/domain-check.ts` | 119 项内核断言 |
| `tests/studio-check.ts` | 40 项状态层集成断言（装载 → 编辑 → 撤销 → 切帧） |

### 16.2 接入方式（双写期）

`state/studioCore.ts` 保留 `boxes: ref<Box3D[]>`，但语义降级为**当前帧物化视图**：

```ts
mutate(label, fn, mergeKey):
  session = store.beginEdit(currentFrame)   // 快照当前帧
  fn()                                      // 老代码继续改 boxes.value
  cmd = session.diffAfter(boxes.value, …)   // 差异 → 命令
  store.exec(cmd)
  boxes.value = store.materialize(frame)    // 用真值覆盖视图
  refreshFrameBoxes([frame])                // 同步 frames 镜像（质检/导出用）
```

因此 30+ 个编辑调用点（拖拽、方向键、属性面板、粘贴、拟合……）**一行未改**，但全部获得：
跨帧历史、一次撤销、可审计、可重放。

`frames[i].boxes` 仍是质检 / 导出 / 轨迹叠加的输入，由 `refreshFrameBoxes` 同步；
`gotoFrame` 不再"写回 + 读回"，而是直接从真值物化。

### 16.3 与设计不一致的 5 处（都有原因）

| 设计 | 实现 | 原因 |
|---|---|---|
| 物化默认 Hermite | 默认 `mode: 'exact'`（只出关键帧），`linear`/`hermite` 为显式选项 | 物化若自动补间，用户点「轨迹插值」时画面不变，"补帧"失去反馈；且默认精确与旧行为逐帧一致 |
| Hermite 端点速度"边界为 0" | 首关键帧用**单侧差分** | 取 0 会让每个关键帧都 ease-in；只有首末两帧时会把直线插成 smoothstep，位置误差可达跨度 12% |
| `maxSpan` 超过则拆段并要求确认 | 照插但计入 `stats.longSpans`，状态栏提示补关键帧 | "点了没反应"比"插完提示"更难用；确认动作 = 看一眼 + Ctrl+Z |
| 不变量 T3：states 的 key 不落在关键帧上 | 允许 `source.kind === 'interp'` 的关键帧带 `predicted` 状态 | 这是"几何是算的、可见性是标的"的自洽组合，用于 coasting |
| `CommandData` 只有单条 createTrack/setKeyframe | 增加 `batch`；`insertFrames.entries` 可带 `state`；`mergeTracks`/`splitTrack` 自带 before/after 快照 | 多选拖拽会同时产生多类变化；合并/拆分不可逆除非命令自带快照 |

### 16.4 验收现状

- `pnpm test`：**386 项全过**（227 旧 + 119 domain + 40 studio），`check:layers` 通过。
- `pnpm build`：通过（`vue-tsc` 严格模式 + Vite 产物）。
- 时间线：5 帧演示序列可见 6 条轨迹、关键帧刻度、当前帧黄线；点击跳帧、双击补关键帧、
  拆分/合并/插值按钮均走命令，可撤销。
- 单帧数据集（`loadDemo` / 真实 PCD / 语义演示）迁移为 `range [0,0]` 的文档，编辑与撤销不受影响。

### 16.5 尚未做的（按优先级）

1. **P0**：已完成第二批（文档存储 v2 / 本地文件数据源 / 解析 worker / 帧加载器），见第 17 节。
2. **P1 剩余**：已完成（RTS 平滑、时间线拖拽两端改生命周期、轨迹右键菜单、`materializeAll` 流式导出接线），见第 19 节。
3. **P0 剩余**：blob 垃圾回收已完成（第 18 节）；解析优先级队列已完成（19.2）；**doc-first 恢复**已完成（第 20 节）。
4. **P2 起**：预标注 Provider、Occupancy/Flow、VLA、规则引擎、闭环指标，均未开始。

### 16.6 复现命令

```bash
pnpm test          # 分层校验 + 227 + 119 + 40
pnpm test:domain   # 只跑内核
pnpm test:studio   # 只跑状态层集成
pnpm dev           # ?data=sequence 看时间线；?data=qa 看质检
```

---

## 17. 实现进度（第二批：P0 数据地基）

> 第一批（P1 4D 内核）见第 16 节。这一批只解决一件事：
> **让"500 帧真实数据"能打开、能切帧、能刷新后接着标。**
> 渲染器、正交视图、质检、格式解析仍然一行未改。

### 17.1 新增与改动

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/core/io/idb.ts` | 新增 | 全项目唯一建库入口；`DB_VERSION` 1→2，补建 `documents` / `docTasks` / `blobs` |
| `src/core/io/session.ts` | 改造 | 改用公共建库层；快照增加 `datasetKey`、`StoredFrame.lazy` |
| `src/ports/blobStore.ts` | 扩展 | 增加 `deletePrefix`（数据集清理与后续 GC 需要） |
| `src/adapters/indexedDbStore.ts` | 新增 | `DocumentStore` + `BlobStore` 实现；文档按任务分段；`encodeDocument` / `decodeDocument` / `migrateLegacySnapshot` 为纯函数 |
| `src/adapters/localFileSource.ts` | 新增 | `DataSource` 实现：文件自然排序、同名 JSON 配对、按帧解码 |
| `src/adapters/pcdParser.ts` | 新增 | worker 池（上限 `min(4, hw-1)`）；Node/CSP 下自动退回主线程 |
| `src/workers/parse.worker.ts` | 新增 | PCD 解析；输出 TypedArray 用 transferable 零拷贝移交 |
| `src/adapters/frameLoader.ts` | 新增 | `SampleHandle` + `FrameCache`：并发折叠、命中同引用、预取、按字节淘汰 |
| `src/adapters/frameCloudStore.ts` | 新增 | 逐帧点云落盘/回读；把"已缓存帧"包装成 `SampleHandle` 供恢复后懒读 |
| `src/adapters/studioStore.ts` | 新增 | IndexedDB 存储单例（延迟创建，Node 下返回 null） |
| `src/state/studioCore.ts` | 改造 | 增加 `frameLoader` / `datasetKey` / `loadFrameCloud` / `isFrameLazy` |
| `src/state/useDataset.ts` | 改造 | 导入按规模分两条路；恢复支持 `lazy` 帧 |
| `src/state/useSequence.ts` | 改造 | `gotoFrame` 支持异步解码 + 令牌防竞态 |
| `src/state/useStudio.ts` | 改造 | 快照按预算丢点云、v2 文档双写、配额预警、清草稿时清 blob |
| `tests/studio-check.ts` | 扩展 | 增加 7 项懒加载切帧断言（清空 → 回填 → 令牌防竞态） |
| `tests/p0-check.ts` | 新增 | 41 项适配层断言 |

### 17.2 数据流

导入（大数据集）：

```
选文件
  ├─ 标注 JSON 全量解析（几十 KB/帧）→ frames[i].boxes（4D 能力依赖它）
  └─ 点云：只解码首帧 → frames[0].cloud
        其余 frames[i] = { cloud: 空, lazy: true }
              │
   切到第 i 帧 ──┴─→ gotoFrame：cloud=null（先清，避免错配）
                      → core.loadFrameCloud(i)
                        → FrameLoader.get(i)
                          → 命中缓存？直接返回
                          → 未命中：worker 解析 → 写 LRU → 异步写 IndexedDB blob
                        → 令牌校验：用户已点走则丢弃结果
```

恢复：

```
loadSession(v1 快照)
  ├─ frames[i].lazy / 空点云 → 占位 + lazy
  └─ 若 snapshot.datasetKey 存在 → createCachedCloudHandle(datasetKey)
       → FrameLoader 同一套调度，切帧时从 IndexedDB 回读
  → rebuildDocument()：标注永远来自快照，不依赖点云
```

### 17.3 关键决策与偏差

| 设计 | 实现 | 原因 |
|---|---|---|
| blob key 用内容哈希 | `datasetKey#frame`（数据集键 + 帧号） | 1.8MB buffer 的哈希要 3–5ms，而帧点云导入后不再变，去重收益接近零。等 P3 的占据/光流出现"同一载荷被多样本引用"再引入内容哈希 |
| `frame(i)` 同时懒加载点云与标注 | 标注全量、点云懒加载 | 时间线、插值、时序质检都要**全部帧的框**才能建完整轨迹；只懒点云不影响任何 4D 能力。反之若懒标注，第一次打开时间线就是空的 |
| v2 文档取代 v1 快照 | 双写：v2 文档存真值，v1 快照仍负责恢复 | 数据安全优先。doc-first 恢复要求"点云可寻址"（要么全量落盘，要么重导入源文件），留到 blob GC 一起做；现在 v2 文档是"标注永不丢"的附加保障（**第五批已切到 doc-first**，见第 20 节） |
| 快照超 80MB 直接跳过保存 | 先按 80MB 预算丢已解码帧的点云，保留 `lazy` 标记 | 丢弃是安全的：解码时已逐帧写入 blob store，恢复时能按需回读；旧的"直接跳过"会让用户完全不知道发生了什么 |
| 恢复时另写一套懒加载 | 复用 `FrameLoader` + `SampleHandle` | 两套懒加载必然出现"导入路径修了、恢复路径没修"。把"从 IndexedDB 读"也做成数据源，切帧路径只有一条 |
| `BlobStore` 只有五个方法 | 增加 `deletePrefix` | 数据集替换/清理要删几百个键，逐 key 删要求调用方记住所有帧号；存储层一次前缀删除更可靠 |

### 17.4 验收

- `pnpm test`：**434 项全过**（227 核心 + 119 domain + 47 studio + 41 P0），`check:layers` 通过。
  其中 studio 新增 7 项懒加载切帧断言：先清空、回填、只解码一次、迟到结果丢弃。
- `pnpm build`：通过；产物含独立 `parse.worker-*.js`（3.1KB），说明 worker 被正确拆包。
- 阈值：`>20 帧` 或 `>120MB` 走懒加载；LRU 预算 256MB；快照点云预算 80MB。
- 浏览器手测清单（Node 测不到的部分）：
  1. 选 50 个 PCD → 首帧立即出现，状态栏提示"按需解码"；切到第 2 帧有短暂"正在解码"。
  2. 连续快速点 5 个不同帧 → 最终画面与帧号一致（令牌生效），无"点云与框错位"。
  3. 刷新页面 → 恢复草稿，当前帧点云直接出现；未看过的帧提示"点云未缓存"。
  4. 标注框、轨迹时间线、时序质检在懒加载数据集上与 5 帧演示完全一致。
  5. 导出全部帧 → 逐帧框数与界面一致（`documentToFrameBoxes` 不依赖点云）。
  6. DevTools → Application → IndexedDB：`documents` 每样本 1 条，`docTasks` 按任务分段，`blobs` 按帧。

### 17.5 还没做

1. **blob 垃圾回收**：已完成第三批（引用计数 + 标记清扫），见第 18 节。
2. **doc-first 恢复**：已完成（第 20 节）——标注读 v2 文档，点云读帧缓存，快照只留封面帧 + 当前帧。
3. **解析优先级**：已完成（`jobQueue` 双队列，当前帧 high / 预取 low），见 19.2。
4. **demoSource**：方案里的 `demoSource` 未单独抽出，演示场景仍直接走 `sample.ts`（零外部依赖，收益低）。

---

## 18. 实现进度（第三批：blob 垃圾回收与引用计数）

> 第 17.5 节把"blob GC"列为未做，并写明"P3 的历史快照会引用 blob，
> 必须先做回收再开 ROI 编辑"。这一批补的就是这件事。
> **先有回收，再开 ROI 编辑** —— 顺序不能反，否则第一次编辑占据就会开始堆垃圾。

### 18.1 两类垃圾，两套判据

| 键 | 谁产生的 | 判据 | 为什么不能共用一套判据 |
|---|---|---|---|
| `payload/<hash>` | 大载荷（占据 RLE / 光流 / 逐点标签） | 还有没有命令或文档引用它 | 内容寻址会导致多条命令指向同一个键，**一次释放通知不代表没人用** |
| `frames/<ds>/<n>` | 懒加载帧点云 | 这个数据集还用不用 | 帧缓存不被任何命令引用；它的生命周期是"草稿是否指向这个数据集" |

如果把两者混在一起用"引用计数"管理，帧点云会因为"没有命令引用它"而在第一次回收时被清空。

### 18.2 新增与改动

| 文件 | 动作 | 职责 |
|---|---|---|
| `src/domain/store/blobRefs.ts` | 新增 | `commandBlobRefs` / `documentBlobRefs` / `collectRefsDeep` / `BlobRefCounter` |
| `src/domain/model/command.ts` | 扩展 | `setTaskPayload` 命令（before/after 描述对象 + 主载荷引用） |
| `src/domain/store/applyCommand.ts` | 扩展 | `setTaskPayload` 的正向/逆向，`boxes` 运行期防御 |
| `src/domain/store/commandHistory.ts` | 扩展 | `onCommandDropped`（超限淘汰 / 新分支清 redo / clear）、`commands()` |
| `src/domain/store/trackStore.ts` | 扩展 | `liveBlobRefs()`、`onCommandDropped()` 订阅 |
| `src/ports/blobStore.ts` | 扩展 | `list(prefix)`、`deleteMany(keys)`、`BlobMeta` |
| `src/ports/documentStore.ts` | 扩展 | `listBlobRefs()`（不做完整解码的载荷引用枚举） |
| `src/adapters/blobKeys.ts` | 新增 | 键规范与反解：`payload/`、`frames/<enc>/<n>[:colors|:labels]`、旧键分类 |
| `src/adapters/blobGc.ts` | 新增 | `planBlobGc`（纯函数）、`sweepBlobs`（清扫）、`BlobReclaimer`（增量回收） |
| `src/adapters/blobPayload.ts` | 新增 | 内容寻址写入：SHA-256 前 12 字节；无 `crypto.subtle` 退回 64 位混合哈希 |
| `src/adapters/studioGc.ts` | 新增 | 工作台级清扫：内存引用 + 落盘引用 + 草稿指针三源合一 |
| `src/core/io/session.ts` | 扩展 | 草稿指针 `draft-meta`（与快照同事务写），`clearSession` 一起清 |
| `src/adapters/frameCloudStore.ts` | 改造 | 新键写入、旧键读取回退、清理时两个前缀都删 |
| `src/adapters/indexedDbStore.ts` | 改造 | 实现 `list` / `deleteMany` / `listBlobRefs`；`remove()` 不再按前缀删 blob |
| `src/state/useStudio.ts` | 扩展 | 装配回收器、三处触发、`runBlobGc()` 暴露给控制台 |
| `tests/p3-check.ts` | 新增 | 70 项断言（键规范 / 引用抽取 / 计数 / 丢弃信号 / 计划 / 清扫 / 回收器 / 去重） |

### 18.3 引用计数：计数负责通知，扫描负责判断

```ts
// 命令被永久丢弃（不是 undo/redo，那只是换栈）
new CommandHistory({
  onCommandDropped: (cmd) => emit(commandBlobRefs(cmd)),
})

// 回收前现算存活集，绝不相信"刚才有人说没人用了"
flush() {
  const live = this.opts.liveRefs()          // TrackStore.liveBlobRefs()
  const dead = pending.filter((r) => !live.has(r))
  await blobs.deleteMany(dead)
}
```

三个必须现算的理由，都在测试里钉住了：

1. **撤销后还能重做** —— 命令离开 undoStack 进入 redoStack，引用仍然活着；
2. **内容寻址会复用** —— 两份相同的占据帧是同一个键，一份被淘汰不代表另一份不要；
3. **文档直引** —— 文档里的 `pointFlowRef` 不受历史影响，历史清空也不能删。

`BlobRefCounter` 仍然存在，但只用于"掉到 0 的通知"和开发期校验（`verify()` 会把增量结果与重算结果对比）。
这是刻意的：**纯计数器漂移是静默 bug，只有在删错数据时才暴露**；而 500 条命令全量扫描是 μs 级，不值得为省这点 CPU 冒误删的险。

### 18.4 帧缓存的键为什么要改

旧键 `local#000970.pcd#50#3` 里，`datasetKey` 自己带 `#`，**无法反解**"这段字节属于哪个数据集"。
GC 的第一件事就是回答这个问题，所以新写入改成：

```
frames/local%23000970.pcd%2350/3          # encodeURIComponent 转义 # 与 /
frames/local%23000970.pcd%2350/3:colors
payload/9f2c1ab34d5e6f7081920a3b          # SHA-256 前 12 字节
```

兼容策略：

| 场景 | 做法 |
|---|---|
| 读 | 先试新键，`has` 失败再试旧键（旧缓存仍然能打开） |
| 清理当前数据集 | `frames/<enc>/` 与 `<ds>#` 两个前缀都删 |
| GC 判定旧键 | 前缀匹配存活数据集；匹不上才删（判不准就留） |
| 未知命名空间 | 默认保留，`dropUnknown` 显式开启才清 |

### 18.5 触发时机：只在"指针明确"之后清扫

| 时机 | 调用 | 原因 |
|---|---|---|
| 启动装载/恢复完成 1.5s 后 | `runBlobGc()` | 此时才知道"当前数据集"与"草稿指向的数据集"；开机清扫同时兜住"上次异常退出留下的垃圾" |
| 自动保存后发现 `datasetKey` 变了 | `runBlobGc()` | 指针刚指向新数据集，旧数据集的帧缓存**到这一刻**才真正变成垃圾 |
| 清除草稿 | `clearSession` + `clearDatasetClouds` + `runBlobGc()` | 草稿没了，别处遗留的 blob 一并收掉 |
| 历史条目被淘汰 / 新分支清 redo / clear | `BlobReclaimer.noteDropped` | 编辑过程中实时回收大载荷，800ms 合并窗口 |
| 手动 | `studio.runBlobGc()`（控制台/将来的"清理缓存"按钮） | 排障与用户主动释放空间 |

**为什么不在导入新数据集时立刻删旧的**：导入 B 之后，v1 草稿可能仍然指向 A（下一次自动保存才改写）。
立刻删 A 会让"刷新页面"恢复到 A 时点云全空。所以切换时不动，等指针落地。

**为什么不每次自动保存都扫**：全量 `cursor` 遍历在几百帧的库上要几十毫秒，每 1.2 秒跑一次会拖慢编辑。
只在"数据集变了"这一种情况扫。

### 18.6 必须知道的边界

| 边界 | 现状 | 影响 |
|---|---|---|
| 历史不持久化 | 刷新后内存引用为空，靠 `documents.listBlobRefs()` 兜底 | 只被历史引用、没写进文档的载荷会被回收；这是正确的（历史已经没了，重做不可能） |
| 回收器在卸载时可能来不及 flush | `dispose()` 丢弃 pending | 遗留键由下一次 `sweep` 收走，不会永久泄漏 |
| `documents.remove()` 不删 blob | 只删文档与任务段 | 删完文档后应由调用方跑一次 `runBlobGc`；存储层按猜测的前缀删 blob 是 P0 的错误假设 |
| v2 文档整体 `save()` 会覆盖 head 的任务清单 | 目前只写 boxes | **开 ROI 编辑之前必须改成 merge-save 或统一走 `saveTask`**，否则占据任务会从 head 里消失 |
| ~~没有跨标签页协调~~ | 已解决：租约 + 引用广播 + Web Locks，见第 21 节 | 同一样本只有一个标签页能写；清扫前会汇总对端引用 |

### 18.7 验收

- `pnpm test`：**505 项全过**（227 核心 + 119 domain + 47 studio + 42 P0 + 70 P3），`check:layers` 通过。
- `pnpm build`：通过。
- P3 断言覆盖的关键反例：撤销后仍存活、内容寻址复用时不误删、文档直引不受历史影响、
  旧键按前缀保留/孤儿删除、未知命名空间默认保留、`dryRun` 不写库、批量删除分事务。
- 浏览器手测清单（Node 测不到 IndexedDB 游标与配额）：
  1. 导入 50 帧 → 翻 10 帧 → 关闭标签页 → 重开：草稿恢复，看过的帧直接显示。
  2. 再导入另一组文件 → 等自动保存完成 → DevTools → IndexedDB → `blobs`：
     旧数据集的 `frames/...` 前缀消失，新数据集的还在，`payload/` 数量不变。
  3. 打开控制台执行 `studio.runBlobGc()`，状态栏应给出"已回收 X MB"或"已是最简"。
  4. 手动写一个 `payload/` 载荷并 `exec` 一条 `setTaskPayload`，连续编辑 501 步让最早那条被淘汰：
     对应 blob 应在 1 秒内从 `blobs` 消失（其余引用它的载荷仍在）。
  5. 清除草稿后 `blobs` 应为空（除未知命名空间）。

#### 18.7.1 Edge 自动手测结果（2026-11-25）

`src/App.vue` 在 `import.meta.env.DEV` 下把工作台挂到 `window.studio`（生产构建不挂），
`runBlobGc` 改为 **返回清扫报告** 并支持 `dryRun`，于是上面 5 条里有 4 条可以用脚本代替手点。

```js
// 浏览器控制台
await studio.runBlobGc()                  // 真扫，返回 { scanned, released, removeBytes, verdicts, byReason }
await studio.runBlobGc({ dryRun: true })  // 只出计划，状态栏显示"预演：可回收 X（N 条）"
studio.store.value.liveBlobRefs()         // 当前存活的载荷引用
```

用 Playwright 驱动本机 Edge（`channel: 'msedge'`，headless + SwiftShader）跑了两组，共 **37 项断言全过**：

| 组 | 覆盖 | 结果 |
|---|---|---|
| A 控制台入口 + 判定矩阵（22 项） | `window.studio` 可调用、空库返回报告、状态栏反馈、手工造 8 条 blob（活/死数据集、死载荷、旧键活/孤儿、未知命名空间）后 `dryRun` 不落删、真扫删 4 条 3500B、判定理由正确、重复清扫幂等、刷新后启动清扫不误删 | 22/22 |
| B 端到端懒加载（15 项） | 21 个 PCD 触发懒加载（20 帧 `lazy`）、键为 `local#000001.pcd#21`、帧键转义成 `frames/local%23...%2321/0`、翻帧按需解码即落盘、GC 不误删当前数据集、自动保存后刷新恢复 21 帧且首帧真实点云、恢复后第 2 帧从 IndexedDB 回读、切数据集后旧 `frames/` 前缀清零 | 15/15 |

两条**未能**脚本化、仍需真机手点：

- 清单 4（`setTaskPayload` 500 步淘汰）：需要构造占据载荷并驱动 501 次命令，属于 P2 场景，
  等 Occupancy 落地后随功能一起验；当前由 `p3-check.ts` 的"撤销/复用/文档直引"三项在 Node 侧兜住。
- 配额预警（`usage()/quota > 85%`）：`navigator.storage.estimate()` 在自动化环境里恒返回宽松配额，
  只能靠真机塞满或 DevTools 限配额验证。

### 18.8 还没做

1. ~~**merge-save**~~：已完成，见 19.1。
2. ~~**跨标签页引用协调**~~：已完成，见第 21 节。
3. ~~**配额自适应**~~：已做"先自救再提示"（保存后超 85% 先扫一遍，仍超才提示），见 21.5；
   "按最久未用淘汰"仍未做 —— `frames/` 键不带访问时间，要做得先给帧缓存加 LRU 元数据。
4. ~~**回收审计**~~：已完成，见 21.4。
5. ~~**手测脚本未入库**~~：已完成，见 20.7。


---

## 19. 实现进度（第四批：合并保存 / 解析优先级 / 流式导出 / RTS 平滑 / 时间线交互）

这一批把 P0 的存储尾巴和 P1 的剩余项一起做完了。共同点：都是"数据正确性 + 交互手感"，
不需要新模型，也不改数据结构 —— 但每一项都卡着后面 P2/P3 的开工条件。

### 19.1 合并保存（merge-save）

| 改动 | 文件 | 说明 |
|---|---|---|
| `mergeDocHead(existing, next)` | `adapters/indexedDbStore.ts` | 纯函数：`tasks` 取并集（按 `ALL_TASKS` 定序），`meta/range/sceneId` 以新文档为准，未知任务键保留 |
| `save()` 改为读头 → 合并 → 同事务写回 | 同上 | 自动保存只带 boxes，不再把 occupancy/flow 从 head 里抹掉 |
| `saveTask()` 校验头存在 | 同上 | 无头时 `tx.abort()` 并抛错：写进去的段永远读不出来，属于调用顺序错误 |
| 新增 `removeTask(sampleId, task)` | `ports/documentStore.ts` + 适配器 | 合并语义下 save 只能"多写"，删必须显式来一趟：清 `docTasks` + 摘 head 登记 |

**为什么未知任务键要保留**：老客户端读到新版本写的 `vla-2` 段时，不该在下次保存时把它从
head 里抹掉。宁可让新段暂时读不出来，也不能替用户丢数据。

**验收**：Node 侧 7 项（并集 / 顺序 / 文档级属性 / 未知段 / 无旧头），Edge 侧 4 项
（真事务里 save → saveTask → save 后 occupancy 仍在；`removeTask` 后消失；无头写段报错）。

### 19.2 解析优先级双队列

- 新增 `adapters/jobQueue.ts` 的 `PriorityQueue<T>`：高优先级严格优先，同级 FIFO。
- `pcdParser` 从"轮询投递"改成"空闲 worker 表 + 队列泵"：`pump()` 在 worker 空闲时才取任务。
- `ports/dataSource.ts` 增加 `ParsePriority` / `FrameRequestOptions`，`SampleHandle.frame(i, opts)` 透传。
- `frameLoader.get()` 走 `high`、`prefetch()` 走 `low`：用户点第 30 帧时，排队的预取帧让路。
- `pcdParserInfo()` 增加 `queued` / `queuedByPriority`，状态栏排障能看出积压。

**诚实边界**：优先级只在入队时生效，已占用 worker 的解码不会被打断（worker 没有中断点，
强杀重建的代价大于等 200ms）；同一帧的并发请求仍折叠成同一个 Promise，不做优先级升级。
**允许高优先级饿死低优先级**：低优先级只有预取，晚一点没有后果。

### 19.3 流式序列导出

`adapters/sequenceExport.ts`：

```ts
serializeSequenceChunks(store, { materialize, framesPerChunk })  // Generator<string>
sequenceBlob(store, opts)                                        // 浏览器下载用
```

对比旧的 `serializeSequence`：不再先构造 500×200 的对象数组、再 `JSON.stringify` 出
一个几十 MB 的字符串，而是 `materializeAll()` 逐帧产出 → 每 8 帧拼一块 → 直接进 Blob。
峰值少了两次全量拷贝，chunk 之间互不引用，GC 能边写边收。

出口有两个，语义不同，不是替代关系：

| 菜单项 | 数据源 | 用途 |
|---|---|---|
| 整段序列 JSON | `frames` 镜像 | 与屏幕一致，只含翻到过的帧 |
| 整段序列 JSON（插值补帧） | `materializeAll(mode: 'linear')` | 按 `document.range` 全范围补帧，训练用 |
| 整段序列 JSON（RTS 平滑） | `materializeAll(paths)` | 同上，且中间帧位置经过后向平滑 |

### 19.4 RTS 平滑

`domain/ops/smooth.ts`：1 维常速度模型（`F=[[1,1],[0,1]]`，`H=[1,0]`，
`Q=q·[[1/4,1/2],[1/2,1]]`，`q=0.5`、`r=1.0`）前向滤波 + 后向平滑，
x/y 各跑一遍；状态是 `[位置, 速度]`，两维都回传（只回传位置等价于带泄漏低通，拐弯会滞后）。

三个实现上的取舍：

1. **哪些关键帧不许动**：`locked === true` 或 `source.kind === 'manual'` 的帧取 `r=1e-4`
   硬观测，平滑后强写回原值；模型/导入帧（`model` / `import`）按普通观测处理，允许被挪几厘米。
   不这么分的话，跟踪器导出的逐帧框（±5cm 呼吸感）会被全部锁死，平滑收益接近零。
2. **超过 0.3m 就整条放弃**：部分平滑会给出"看起来顺、位置错"的轨迹，不如让用户去修标注。
3. **只平滑位置**：朝向是角度，线性 Kalman 会把 179° 和 -179° 平均成 0°（车头原地掉头）。

结果通过 `MaterializeOptions.paths` 注入，物化只在**关键帧之间**替换位置，
尺寸/朝向仍走插值；这些帧的 `sourceKind` 标 `derived`，与 `interp` 区分。

实测（21 帧、逐帧 ±6cm 横向噪声）：横向 RMS 0.0415 → 0.0056（-86%），
二阶差分 0.162 → 0.0018（-99%），最大位移 0.061m。

### 19.5 时间线：拖两端改生命周期 + 右键菜单

- 新命令 `setLifecycle`（before/after 只存 `{first,last,state}`）+ `buildSetLifecycleCommand`
  （夹取 `first<=last`、不越出文档范围；**不删**范围外关键帧 —— 拖短再拖回来应原样恢复）。
- 拖拽期间只在组件内改预览值，松手才 `exec` 一条命令：否则一次拖拽灌进几十条历史，
  Ctrl+Z 会变成退格键。
- 拖拽结束浏览器补发的 click 会被吞掉（`suppressClickUntil`）：拖生命周期不该顺带跳帧。
- 关键帧刻度 `z-index: 1`、把手 `z-index: 2`：末帧刻度正好压在右把手上，不调层级就点不到。
- 右键菜单：补关键帧 / 拆分 / 起点终点设为该帧 / 锁定 / 隐藏 / 删除。

### 19.6 验收

- `pnpm test`：**549 项全过**（227 核心 + 139 domain + 47 studio + 66 P0 + 70 P3），分层校验通过。
- `pnpm build`：通过。
- Edge 自动手测（Playwright + 本机 Edge，headless/SwiftShader）：
  - 新用例 14 项全过（合并保存 4、拖拽 4、右键菜单 3、导出 2、无 console 报错）；
  - 回归此前两组 37 项（GC 判定矩阵 22 + 端到端懒加载 15）仍全过。
- Node 侧新增断言：合并保存 7、优先级 9、流式导出 8、RTS 平滑 12、生命周期 8。

### 19.7 还没做

1. ~~**doc-first 恢复**~~：已完成，见第 20 节。
2. ~~**跨标签页引用协调**~~：已完成，见第 21 节。
3. ~~**配额自适应**~~：已做"先自救再提示"，见 21.5（LRU 淘汰仍未做）。
4. ~~**回收审计**~~：已完成，见 21.4。
5. **RTS 只在导出里**：物化路径已支持 `paths`，但视图里还没开关 —— 等 P2 有真实抖动数据再决定是否常驻。
6. **手测脚本未入库**：需要把 `playwright` 加进 devDependencies 才能变成回归项。
7. ~~**P2 起全部未开始**~~：P2 预标注的**消费端**已完成（Provider 协议 + 三种适配器 +
   合并策略 + 复核队列 + 导出闸门），见第 25 节；缺的是真实模型服务。
   P3 起仍未开始：Occupancy/Flow、VLA、规则引擎、闭环指标。

---

## 20. 实现进度（第五批：doc-first 恢复 + 点云外置）

这一批把 19.7 的第 1 条做完了，并且顺手修掉一个只有在 doc-first 下才会致命的问题：
**文档主键撞号**。做完之后，"刷新一下半小时的活没了"在多数路径上已经不成立 ——
不只是标注不丢，连"拖短的生命周期"这种 v1 快照表达不了的信息也不丢。

### 20.1 为什么必须切 doc-first

v1 快照存的是 `frames[i].boxes: Box3D[]`，它是**物化结果**，不是真值。迁移回 v2 文档时
`buildDocumentFromFrames()` 只能从"逐帧框"反推轨迹，以下信息在往返中丢失：

| 信息 | v1 快照 | v2 文档 | 丢失后果 |
|---|---|---|---|
| 生命周期 `lifecycle` | 只有框，没有 range | 有 | 拖短过的轨迹刷新后自动变长 |
| 稀疏 `states`（occluded/outside） | 只保留在当帧框上 | 按帧存 | 非关键帧的可见性丢失 |
| 复核状态 `review` | 无 | 有 | 复核进度归零（P2 会踩） |
| 关键帧 `source`（import/manual/model） | 全部退化成 import | 有 | RTS 平滑的"硬观测"判据失效 |
| 轨迹属性 `attributes` | 只在框上 | 轨迹级 | 恒等属性每帧复制一份 |

所以恢复顺序改成：**读草稿指针 → 读 v2 文档 → 装 TrackStore**，v1 快照只负责帧布局与点云。

### 20.2 恢复链路

```
loadDraftPointer()  ──► pointer.sampleId ──► documents.load(sampleId)
        │                                            │
        └──► loadSession() ──► 帧布局 + 点云 ────────┴──► planDocumentRestore()
                                                              │
                                          ok ────────────────┴──► installDocument(doc)
                                          range-mismatch ─────────► 回退 v1 restore()
```

- `domain/store/restorePlan.ts`：纯函数，输入文档 + 快照提示，输出
  `{ layout, current, cloudFrames, lazyFrames, totalBoxes, singleFrame }`。
  所有"拼装判断"都在这里，Node 侧可完整断言（12 项）。
- `studioCore.installDocument(doc)`：**不迁移**，直接 `new TrackStore(doc)` + 物化当前帧。
  与 `rebuildDocument()` 的区别就是"原样装载" vs "从逐帧框聚合"。
- 快照的 `sampleId` 与指针的 `sampleId` 必须一致，否则直接放弃文档（两个来源已经指错）。

**回退判据（唯一的）**：快照里有帧落在文档 `range` 之外。这几乎只发生在
"同帧数的另一个数据集污染了同一条文档记录"时 —— 宁可少恢复生命周期，
也不能把 A 的框安到 B 的帧上。

### 20.3 点云外置（`cloudMode: 'spill'`）

懒加载数据集的每一帧在解码时就已写进 blob store，所以快照没必要再存一份。

| 模式 | 触发条件 | 快照里存什么 |
|---|---|---|
| `spill` | 有数据集键，且**每个解码帧都确认落盘** | 仅第 0 帧 + 当前帧的点云，其余帧 `lazy: true` |
| `inline` | 演示数据 / 单帧导入 / 有帧落盘失败 | 全部已解码帧（受 80MB 预算） |

`canSpillClouds()` 的判据是"能不能回读"这个事实，不是"有没有 datasetKey"：
`decodedFrames` 在解码时记账，`persistedFrames` 在 `saveFrameCloud` 的 `.then` 里记账，
只要有一个解码帧没进 `persistedFrames`（配额满 / 超 200MB 预算 / 写失败），整体退回内联。

**为什么必须留封面帧 + 当前帧**：首屏要有画面；当前帧是用户关标签页时正在看的那一帧，
恢复后空掉等于"回来找不到刚才的位置"。代价是 2 帧点云（≈5MB），换 21 帧全量内联的 50MB。

实测（21 帧 × 2.4MB）：快照从 ~50MB 降到 ~4.8MB，且不再触发"超过 80MB 跳过自动保存"。

### 20.4 顺带修掉的撞号问题（重要）

`sampleId = sceneId#start-end`，而 `rebuildDocument()` 里的 `sceneId` 原本写死 `'workspace'`。
两个帧数相同的数据集会算出**同一个主键**：导入 B 会覆盖 A 的文档；更糟的是 doc-first 恢复
信任文档，撞号时会把 A 的标注装到 B 的点云上 —— 这种错不报错，只会让人标错车。

修法：`sceneIdentity()` 取数据集键（`local#000001.pcd#21`），没有键时退回
`workspace:<显示名>`。副作用是每个数据集各留一份文档（几十 KB），
`documents` 里因此会出现多条记录 —— 这是特性不是 bug：重新导入同一批文件能接着标。

### 20.5 验收

- `pnpm test`：**564 项全过**（227 核心 + 139 domain + 47 studio + 81 P0 + 70 P3），分层校验通过。
- `pnpm build`：通过。
- Edge 自动手测（Playwright + 本机 Edge，headless/SwiftShader）：
  - 新用例 **27 项**（doc-first）：`cloudMode=spill`、快照只承担 2 帧、指针带 sampleId、
    刷新后生命周期 2–15 与关键帧数原样保留、未内联帧如实提示未缓存、预取帧回读成功、
    二次编辑仍存住、**只剩文档（快照被删）时按 range 展开 21 帧并从帧缓存回读**、
    清草稿后文档与快照一起消失、刷新不再复活标注。
  - 撞号用例 **7 项**：两个 21 帧数据集 → sampleId 不同、两份文档并存、
    重开恢复的是最后那个（生命周期 5–12 而非 2–15）。
  - 回归：GC 判定矩阵 **24 项**（其中"刷新后不误删"改写为更真实的
    "恢复草稿后启动清扫保住帧缓存"，因为带 `?data=` 刷新会切走数据集，旧写法本身是脆的）、
    端到端懒加载 **15 项**、时间线/导出 **14 项**。
- Node 侧新增断言：恢复计划 15 项（多帧/单帧/超集/无快照/区间不符）。

### 20.6 还没做

1. **文档清理**：每个数据集各留一份文档，没有上限也没有"最久未用"淘汰。
   现在明确**不做**自动 prune（理由是文档是标注真值，不是缓存），只清帧缓存与死载荷 ——
   见 21.6 的取舍说明。手动出口已补上：菜单「本地样本列表…」，见第 22 节。
2. ~~**跨标签页引用协调**~~：已完成，见第 21 节。
3. ~~**配额自适应**~~：已做"先自救再提示"，见 21.5（LRU 淘汰仍未做）。
4. ~~**回收审计**~~：已完成，见 21.4。
5. **RTS 只在导出里**：物化路径已支持 `paths`，视图里还没开关 —— 等 P2 有真实抖动数据再定。
6. ~~**手测脚本未入库**~~：已收进 `scripts/browser/`（6 支，`pnpm test:browser`），
   见 20.7。没有把 playwright 加进依赖，改成运行时三级解析。
7. ~~**P2 起全部未开始**~~：P2 预标注的**消费端**已完成（Provider 协议 + 三种适配器 +
   合并策略 + 复核队列 + 导出闸门），见第 25 节；缺的是真实模型服务。
   P3 起仍未开始：Occupancy/Flow、VLA、规则引擎、闭环指标。

### 20.7 手测脚本入库

6 支 Playwright 用例收在 `scripts/browser/`：

| 文件 | 覆盖 | 断言数 |
|---|---|---|
| `gc.mjs` | 控制台入口、`dryRun`、四类判定、切数据集回收、恢复后启动清扫 | 25 |
| `load.mjs` | 21 帧懒加载导入、逐帧落盘、刷新恢复、未解码帧提示 | 15 |
| `timeline.mjs` | 拖两端改生命周期、右键菜单、merge-save、三个导出入口 | 14 |
| `docfirst.mjs` | `cloudMode=spill`、生命周期保真、只剩文档、清草稿 | 27 |
| `collide.mjs` | 两个同帧数数据集不撞号 | 7 |
| `crosstab.mjs` | 两个真标签页：租约只读、接管、引用广播、回收审计、刷新不自杀 | 28 |

`run.mjs` 顺序跑完并汇总；`pnpm test:browser` 是它的别名。

三个设计决定：

1. **不加 playwright 依赖**：它只服务"手跑一遍"，不该让每次 `pnpm install` 都等浏览器。
   `_pw.mjs` 按「项目依赖 → `PLAYWRIGHT_PATH` → `npx` 缓存」三级解析，失败时打印三种解决办法。
2. **用本机 Edge**（`channel: 'msedge'`）：手测要验的就是真实浏览器的 IndexedDB 与配额行为，
   下载一个 Chromium 反而偏离目标；headless 下 WebGL 走 SwiftShader，逻辑够跑。
3. **每支用例先清库**：早期版本不清，第二遍跑就会因为上次残留的键把计数断言全打翻 ——
   这类"跑第二遍才挂"的测试比没有测试更浪费时间。

同时修掉了两处测试自身的时序依赖（不是产品 bug）：

- "刷新后启动清扫不误删"原本假设「自动保存(1.2s) 一定早于启动清扫(1.5s)」，机器一忙顺序就翻。
  改成"恢复草稿后再手动清扫"验同一件事，启动清扫由另一条用例单独覆盖。
- 注入快照/指针后直接导航，会被 `beforeunload` 里的 `persistNow` 异步覆盖回去
  （导航不等 Promise）。改成"先等页面存干净，再注入"。

---

## 21. 实现进度（第六批：跨标签页协调 / 回收审计 / 配额自救）

这一批做的是**"同一个用户开两个标签页"**这个最常见、也最容易静默丢数据的场景。
它不是协作编辑（P7 才有），而是"别让两份客户端把对方的数据当成垃圾"。

### 21.1 三个互踩点

| 位置 | 怎么踩 | 后果 | 对策 |
|---|---|---|---|
| 文档写入 | 两边各持一份 `TrackStore`，自动保存都是整段 boxes 覆盖 | 后保存的把另一边的框**静默抹掉** | 样本租约：同一样本只允许一个标签页写 |
| blob 清扫 | A 只看得到自己的引用集 + 落盘文档 + 草稿指针 | B 刚写进 IndexedDB、还没进文档的载荷，在 A 眼里是垃圾 | 清扫前广播汇总对端引用 |
| 帧缓存 | A 判定"数据集没人用了"（草稿指针指向别处） | B 正开着这个数据集，缓存被清空 | 同上，对端的数据集一起保护 |

前两项会**丢数据**，第三项会丢"不用重选文件"的便利。三项共同点是：
**判断依据只存在于对端进程的内存里**，本端无论怎么扫都看不到。

### 21.2 租约：同一样本只能有一个写者

`adapters/tabBus.ts` 实现，判据是纯函数 `domain/store/tabLease.ts` 的 `judgeLease()`。

- 记录：`localStorage['lt:lease:<sampleId>'] = { tabId, at }`，心跳 2s 续期，TTL 6s。
- 判定：没有记录 / 过期 / 记录是坏的 → `free`；记录是自己 → `mine`；别人的新鲜记录 → `held`。
- 抢占：`claim()` 写完等一个回合（默认 45ms）再读一遍，被覆盖就让位。
- 释放：`pagehide` + 卸载时主动删记录，另一个标签页不用等 TTL。
- 接管：状态栏点「只读 · 接管」→ `takeover()` 强写租约 + 广播 `lease:lost`，原持有者转只读。

**为什么用 localStorage 而不是 BroadcastChannel 存租约**：租约必须跨"标签页崩溃"存活。
广播只存在于活着的进程之间；一个标签页被 OOM 杀掉时不会发任何消息，
它的租约只能靠 TTL 过期 —— 这需要一个持久记录。

**为什么租约存在 sessionStorage 里的 tabId 上**：`sessionStorage` 是**每个标签页一份**、
且刷新后仍在。如果每次加载都生成新 id，刷新后会被"6 秒前的自己"判成只读 ——
用户看到的现象是"按一下 F5，工具就不能编辑了"。这条在 21.8 有专门用例（`刷新后仍可写`）。

**只读形态挡在哪**：`studioCore.mutate()` / `undoState()` / `redoState()` 三个入口
（所有编辑都经过它们），加上 `persistNow()` 的入口闸。
只挡 UI 不挡保存是不够的：装载与恢复都会把 `saveState` 标脏，
自动保存照常触发 —— 不在写入口拦住，只读标签页一打开就会覆盖对方的文档。

**为什么不做"两边都写、冲突时合并"**：文档是分段覆盖写的，两份内存状态没有共同祖先
可参照；三方合并在标注场景里会产出"框复活""轨迹重复"这类更难解释的结果。
单写者 + 显式接管，是唯一能保证"不会静默丢框"的做法。

### 21.3 清扫前汇总对端引用

```
collectPeerRefs(320ms)  →  广播 refs:req
                        ←  各标签页回 refs:res { sampleId, datasetKey, payloadRefs }
                        →  合并成"必须保护"的集合，再枚举库
```

- **顺序不能反**：先问再枚举。反过来的话，对端可能在"我们枚举完"与"我们删除"之间写一条载荷。
- **固定等 320ms，不等"所有已知标签页回完"**：对端可能正在解析点云；少等一个对端的代价是
  "少保护一条引用"，而拖慢保存路径的清扫是用户能感觉到的。
- `gcBlobStore` / `runStoreGc` 的 `peerPayloadRefs` / `peerDatasetKeys` 是可选参数，
  Node 单测与不支持广播的环境走同一条代码路径。
- 报告新增 `peerProtected`：**因为对端在用而免于删除的条数**。
  这个数字比"回收了多少"更能说明协调有没有生效 —— 两个标签页都开着却恒为 0，
  就该怀疑广播没通。

`navigator.locks`（Web Locks）把两个标签页的清扫串行化。
不串行也不会删错（判定幂等），但两边会互相看到对方的中间状态；
不支持时直接跑，只影响效率。

### 21.4 回收审计

`adapters/gcAudit.ts`：一次清扫一条记录，`localStorage['lt:gc-audit']` 环形 30 条。

| 字段 | 用途 |
|---|---|
| `at` / `tabId` | 什么时候、哪个标签页删的（同一个人开两个页时能分清） |
| `trigger` | `startup` / `dataset-change` / `clear-draft` / `manual` / `quota` |
| `dryRun` | 预演也记 —— 否则"预演过但没删"和"根本没跑"分不清 |
| `scanned` / `released` / `removeBytes` | 扫了多少、删了多少、多少字节 |
| `byReason` | 按判定理由的分布（`dead-payload` 居多说明是清理，`evicted-dataset` 居多说明换过数据集） |
| `peers` / `keptByPeers` | 当时有几个对端、其中多少条是靠对端保下来的 |

```js
studio.gcAudit()          // { entries, summary }：summary 有 totalBytes 与按标签页归集
studio.clearGcAuditLog()  // 清空
```

**为什么放 localStorage 不进 IndexedDB**：审计只服务排障，不能因为写审计失败影响回收；
一条几百字节、30 条远不到配额。代价是清浏览器数据会一起带走 ——
那种情况下缓存也没了，审计跟着没是合理的。

### 21.5 配额：先自救再提示

`persistNow()` 保存完发现 `usage/quota > 85%` 时，现在的顺序是：

1. 先跑一次 `runBlobGc({ trigger: 'quota' })`（旧数据集帧缓存、死载荷本来就不该占着）；
2. 再看一次用量：仍然 >85% 才提示用户"建议导出后清理旧草稿"；
3. 降下来了就报"已自动回收 X MB"。

**为什么提示不能是第一反应**：旧实现直接报"接近上限"，用户除了焦虑没有下一步 ——
而绝大多数情况下，能收的垃圾还没收。

### 21.6 明确不做：自动删文档

`documents` 里每个数据集一份头 + 若干任务段，现在是**无上限**的。
上一轮把它列为待办（`prune({ keep: 20 })`），这一轮明确**不做**，理由是：

- 文档是**标注真值**，不是可重建的缓存。帧缓存删了可以重新解码，文档删了框就没了。
- 淘汰策略要回答"三个月前的样本该不该还有标注"，这是产品决策不是存储策略。
- 自动删带来的收益（几十 KB/样本）远小于一次误删的代价。

真正需要时该做的是"样本列表 + 手动删除"，而不是后台静默 prune ——
这一条已在第七批实现（第 22 节）。所以配额压力只由帧缓存与载荷承担，
这两类都可以从源文件重建。

### 21.7 必须知道的边界

| 边界 | 现状 | 影响 |
|---|---|---|
| 租约不是强一致 | localStorage 没有 CAS，"写后校验"只能收窄竞态 | 同一毫秒内两个标签页打开同一样本，仍可能都以为自己在写；概率极低，后果是丢一次自动保存 |
| 复制标签页会连 sessionStorage 一起复制 | 两个标签页拿到同一个 tabId，互相认为"是我" | 这种操作下退化为改造前的行为（谁都能写）；最后写入者胜 |
| 只读页仍能装载新数据 | 导入文件/导入标注不走 `mutate` | 装载会产生新的 sampleId 并重新申请租约；旧样本的改动会被丢弃。这是"显式换数据"动作，与"编辑当前样本"不同 |
| 只读页也会参与清扫 | 它的引用集仍然有效（文档在内存里） | 安全，但它的情报比写者旧；对端引用会补上这部分 |
| 原持有者关闭后不自动抢回写权 | 租约过期/释放后，另一个标签页仍是只读 | 需要用户点一次「接管」。自动抢回会在"用户只是关了个标签页"时产生意外的写入，宁可多一次点击 |
| 广播在后台标签页可能延迟 | 浏览器会节流定时器，但 BroadcastChannel 消息不节流 | 引用汇总仍可靠；心跳可能延迟，靠 6s TTL 兜底 |
| `peerProtected` 只统计"本端不认识"的键 | 双方都认识的引用不计入 | 它是协调生效的信号，不是"对端救了多少 MB"的精确账 |

### 21.8 验收

- `pnpm test`：**607 项全过**（227 核心 + 139 domain + 47 studio + 81 P0 + 113 P3），分层校验通过。
  P3 新增 43 项：租约判定 7（含"时间戳在未来不当作过期"）、引用合并 13
  （6 项纯合并 + 7 项清扫集成，含"无对端时同样的键会被回收"这个反例基线）、
  TabBus 协议 15（两份假 storage + 真 BroadcastChannel 在同一进程里握手）、审计环 8。
- `pnpm build`：通过。
- `pnpm test:browser`：**116 项全过**（gc 25 / load 15 / timeline 14 / docfirst 27 / collide 7 / crosstab 28），
  连跑两遍一致。新增 `crosstab.mjs` 用两个真标签页验：
  1. A 拿到租约、B 恢复同一份样本后转只读（保存状态 `readonly`、状态栏出 chip）；
  2. 只读时 `mutate` 不生效、`persistNow` 被跳过并说明原因；
  3. 广播能报到对方的 sampleId、presence 能看到对方；
  4. B 接管后 A 立刻收到通知转只读；
  5. 清扫报告带对端数、审计记下触发点与标签页、`dryRun` 也入审计；
  6. **B 刷新后仍可写**（sessionStorage 里的 tabId 延续，不会被自己的旧租约锁住）。

### 21.9 还没做

1. ~~**帧缓存 LRU 淘汰**~~：已完成，见第 23 节（DB 升到 v3，独立 `blobUsage` 存使用时间）。
2. ~~**样本列表 / 手动删文档**~~：已完成，见第 22 节。
3. **协作编辑（P7）**：租约解决的是"别互相破坏"，不是"两个人同时标同一个样本"。
   后者需要命令级的 OT/CRDT，属于 P7。
4. **RTS 视图开关**：仍在导出里，等 P2 有真实抖动数据再定。
5. **P2 消费端已完成**（见第 25 节）；P3 起未开始：Occupancy/Flow、VLA、规则引擎、闭环指标。

---

## 22. 实现进度（第七批：本地样本列表与手动删除）

21.6 说"不做自动 prune"，理由是文档是标注真值、不是可重建的缓存。
但"不自动删"必须配一条**手动出口** —— 否则 `documents` 只进不出，
用户除了清浏览器数据没有别的办法。这一批就是补这条出口。

### 22.1 三段分工

| 层 | 文件 | 职责 |
|---|---|---|
| domain | `domain/store/library.ts` | 相对时间文案、删除判定（`judgeRemove`）、排序与装饰。纯函数，Node 可测 |
| state | `state/useLibrary.ts` | 读列表、二次确认状态机、删除与收尾。依赖显式注入四条 |
| 存储 | `ports/documentStore.ts` + `adapters/indexedDbStore.ts` | `listSamples` 多返回 `range` / `tasks`；`remove` 早已存在 |
| 界面 | `components/SampleList.vue` | 弹层列表，二次确认按钮 |

**为什么判定在 domain**："哪个样本不能删"是业务规则，不是界面细节。
只写在组件里的话，改一次布局就可能悄悄失效；放纯函数里能一条条断言。

**为什么单独一个 composable**：useStudio 已经 600 行，职责是"装配 + 生命周期"。
样本列表是低频、独立、可整体卸载的功能（弹层关掉就不需要任何状态），
依赖只有四条，不值得进 core。

### 22.2 两条否决

```ts
judgeRemove(row, { currentSampleId, heldBy }) → { ok, code: 'ok'|'current'|'locked', reason }
```

| code | 场景 | 为什么否决 | 用户该怎么做 |
|---|---|---|---|
| `current` | 正在编辑的这份 | 删了画布就成孤儿，**下一次自动保存会把它重新写回来** —— 用户看到的是"删了又出现" | 切到别的数据集，或用菜单里的「清除当前样本草稿」 |
| `locked` | 另一个标签页持有它的租约 | 对端下一次保存会重建文档头，同样是"删了又回来"；且对端会静默丢写 | 在那边关掉，或在这里点「接管」再删 |

**为什么不给"强制删除"**：两个否决理由导致的都是"删了又回来"这种无法解释的现象。
与其给一个需要解释后果的按钮，不如让用户先切换/接管 —— 多一步，但没有谜团。

**为什么 `heldBy` 在点删除时才查**：列表可能开了几分钟，
中途另一个标签页打开这个样本是常事。打开列表时查一次的话，
"看起来能删"会一直持续到点下去的那一刻。

### 22.3 删除的顺序（顺序错了会有两种假象）

```
1. documents.remove(sampleId)        文档头 + 所有任务段（按 `<id>::` 前缀游标）
2. loadDraftPointer()                指针指着它才摘
3. runBlobGc({ manual: true })       立刻扫一遍
4. 重新 listSamples()                列表来自库，不来自内存
```

- **先删再扫**：反过来的话，清扫先跑完、文档还在，这一轮什么都收不到，
  下一次清扫才会收 —— 用户看到"删了但空间没变"。
- **指针要查过再摘**：无脑调 `clearSession()` 会把**当前这份没删的**草稿一起清掉。
  所以新加了 `clearDraftPointer()`：只摘指针、留快照，下次启动拿不到 sampleId
  就退回按快照自身的数据集恢复。
- **最后重新读库**：列表如果只从内存数组删一行，就测不出"删除是否真的落盘"。
  重新读一次顺便也能发现并发下的意外变化。

### 22.4 只删文档，不删帧缓存

`remove` 只清 `documents` + `docTasks`。`blobs` 里的 `frames/<ds>/<n>` 属于**数据集**，
不属于某份文档；`payload/<hash>` 可能被多个样本共用（内容寻址）。
删文档让引用消失，第 3 步的清扫自然会收走没人要的部分。

在存储层按"以为的前缀"删 blob 是 P0 遗留的错误假设（当时键还是 `sampleId#frame`），
现在键的含义由 `adapters/blobKeys.ts` 统一判定，删除不能绕过它。

### 22.5 必须知道的边界

| 边界 | 现状 | 影响 |
|---|---|---|
| 删除不进撤销栈 | 命令历史只覆盖框的编辑 | 删错了只能重新标。这也是二次确认存在的原因 |
| 列表不自动刷新 | 打开时读一次，手动点 ⟳ 再读 | 另一个标签页新增/删除的样本不会自己出现。好处是列表不会在点击途中跳动 |
| 连续删多个 = 连续清扫 | 每次删都等一次 320ms 的广播汇总 | 删 5 个约 1.6s。换成"攒一批再扫"会让"删了空间没变"回来，暂不做 |
| 只读标签页也能删 | 删除不走 `mutate` | 它删的是**库里的文档**，与"当前画布能不能编辑"无关；当前样本本身删不掉，所以不会互相破坏 |
| 任务段字节数不展示 | 只统计全局 `usage` | 逐样本算字节要遍历上千关键帧，代价大于收益 |
| 旧文档缺 range/tasks | 端口声明为可选 | 展示层按单帧、无任务段兜底，不阻断删除 |

### 22.6 验收

- `pnpm test`：**628 项全过**（227 核心 + 160 domain + 47 状态层 + 81 P0 + 113 P3），分层校验通过。
  domain 新增 21 项：时间文案 8（含"未来时间当刚刚"）、装饰与排序 7（含缺 range 兜底）、
  删除判定 5（含"当前判定优先于租约判定"）、任务名映射 1。
- `pnpm build`：通过。
- `pnpm test:browser`：**146 项全过**（gc 25 / load 15 / timeline 14 / docfirst 27 / collide 7 /
  crosstab 28 / library 30），连跑两遍一致。新增 `library.mjs` 验：
  1. 直写 IndexedDB 造两份"旧文档"（3 天前带占据段、40 天前），列表能读出帧范围、任务段、相对时间；
  2. 当前样本拒绝进入删除确认，且不留下待确认态；
  3. 二次确认：第一次只标记、取消不改变列表、确认后文档头与任务段**都从库里消失**；
  4. 另一个标签页 `claim()` 该样本后拒绝删除并指出持有者，`release()` 后可以删；
  5. 新标签页看到的列表是删除后的真值（证明删的是库不是内存）。

---

## 23. 实现进度（第八批：帧缓存 LRU 淘汰）

21.9 的第 1 条拖到最后，是因为它不像前面几项"补个判断"就完了：
它要改数据库 schema、改读路径、还要回答一个容易做错的问题 —— **删了还能不能回来**。

### 23.1 为什么现在才做

前两阶段的判据是**二值**的：数据集活着就整段留，死了就整段删。
问题出在"活着但太大"：一个 500 帧的数据集本身就超过配额，
清扫完一条都没删，用量还是 95%，于是每次保存都弹"接近上限"。

真正需要的是第三种判据：**同一个数据集的内部，谁最久没被看**。
但要做这件事，先得有两个前提，缺一个就会做成错的：

| 前提 | 不满足会怎样 | 本批怎么解决 |
|---|---|---|
| 知道"最后一次被读"是什么时候 | 只能拿 `savedAt` 凑，等于"最早写入的先淘汰" | DB v3 加 `blobUsage`，读路径回写 |
| 知道"删了能不能重新解码" | 删掉恢复型会话的帧 = 永久丢失用户数据 | `SampleHandle.reloadable`，默认 false |

### 23.2 `savedAt` 为什么不能凑合

`savedAt` 是**写入缓存的时间**，对帧缓存来说就是"第一次解码它的时间"。
用户回看第 3 帧不会重写这一帧的 blob（帧点云导入后不再变化，重写纯属浪费）。

所以按 `savedAt` 排序淘汰，淘汰的是"最早看过的"，而那往往是封面帧和开头的几帧 ——
恰恰是最常回看的。这不是 LRU，是"最久以前导入的优先删"，效果可能正好相反。

### 23.3 使用时间怎么记

```
list()  →  blobs{savedAt} ⊕ blobUsage{at}  →  lastUsedAt = max(两者)
```

- **独立 store `blobUsage`**：IndexedDB 没有原地更新 —— 改 `blobs` 里一条记录必须先
  把整条读出来（1.8MB 的 ArrayBuffer）再写回。回放时每秒切一帧，这么写等于把
  主线程钉在序列化上。元数据单独存，刷新一次只写几十字节。
- **攒批 800ms**：同一批用一个时间戳。LRU 的精度按分钟就够，没必要为每帧记毫秒。
- **同一帧 60 秒内不重复记**：避免长时间回放时把库刷成写热点。
- **老记录退回 `savedAt`**：v2 及更早写的没有 `at`，用写入时间兜底，
  让升级前的缓存也能参与淘汰，而不是永远躲过一劫（永远躲过就等于永远不释放）。
- **删键时一起删元数据**：`delete` / `deleteMany` / `deletePrefix` 都在同一事务里
  清 `blobUsage`，否则库里会留下永远匹配不上任何 blob 的孤儿。

### 23.4 谁能被淘汰：`SampleHandle.reloadable`

这是本批唯一"错了会丢数据"的地方，所以特意做成**默认不可淘汰**：

| 句柄 | reloadable | 原因 |
|---|---|---|
| `LocalFileHandle`（用户导入的 PCD） | `true` | 背后是 File 对象，随时能重新读盘解析；删了只是下次切回来重解 200ms |
| `createCachedCloudHandle`（恢复草稿） | `false` | 源文件早就不在了，**缓存就是唯一副本**，删了永久丢 |

默认 `false` 的含义是：忘了声明的后果是"多占一点磁盘"，而不是"静默销毁数据"。
这类取舍里，默认值必须站在保守那一边。

### 23.5 保护邻域而不是只保护当前帧

```ts
neighborhoodKeys(datasetKey, currentFrame, build, radius = 2)
```

只保护当前帧是不够的：用户点"下一帧"时下一帧马上要被读，回放时前后各一帧都在预取队列里。
清扫刚好把下一眼要看的帧淘汰掉，然后立刻重新解码 —— 淘汰变成纯负收益。

半径 2 的代价是"每次最多留下 5 帧不淘汰"。5 帧 × 3.6MB = 18MB，
相对于触发阈值（85% 配额，通常 GB 级）可以忽略。

**组内任一键受保护则整组跳过**：淘汰 positions 却留下 `:colors`，
或反过来，都会留下读不出来的孤儿记录。帧是原子的。

### 23.6 预算用"腾出多少"而不是"降到多少"

```ts
runStoreGc({ budget: { reclaimBytes, evictableDatasetKeys, protectKeys } })
```

两个口径不一致：配额来自 `navigator.storage.estimate()`（整个 origin，含文档、
旧草稿、审计），而 `planBlobGc` 能数的只有 blob 字节。混在一起算水位必然错位 ——
要么该腾的时候不腾，要么把帧全删了还"没达标"。

所以调用方算差额（`used - quota × 0.7`），判定层只负责凑够这么多字节。
`dryRun` 与真实删除走同一段判定代码，预演看到的条数就是真跑会删的。

### 23.7 淘汰之后必须撤销记账

`canSpillClouds()` 的唯一依据是"解码过的帧都还在 blob 里"。淘汰之后它们不在了，
如果不撤销 `persistedFrames`，快照仍会写 `spill`（只留封面帧 + 当前帧），
恢复时那些帧读不出来 —— 用户看到"刷新后点云全空"，比慢严重得多。

所以淘汰后：

1. 把被淘汰的帧从 `persistedFrames` 移除；
2. **把字节数从 `persistedBytes` 里退回来** —— 那是个只增不减的计数器，
   不退的话"腾出了空间却再也不会落盘"（`PERSIST_BUDGET` 已卡在上限）；
3. 快照退回内联：大一点，但能完整恢复。这些帧下次被解码时 `onLoad` 会重新落盘。

第 2 条是本批自查时发现的：只做第 1 条的话，`canSpillClouds` 会正确变 false，
但落盘预算仍然耗尽，于是"空间腾出来了，却再也不写新帧"—— 用户看到的是
"清完缓存后切帧越来越慢"，且不会自愈。

### 23.8 审计怎么区分"清垃圾"与"动我在用的数据"

`byReason` 里已经有 `lru-evicted`，但看审计的人想知道的往往更直接。
`GcAuditEntry` 加了 `lruFrames` / `lruBytes`，`summary` 里汇总最近的淘汰帧数：

```js
studio.gcAudit()  // { entries, summary: { lruFrames, ... } }
```

一条 `trigger: 'quota'` 且 `lruFrames: 12` 的记录说明"这次是被配额逼的，
动了 12 帧在用的数据"；`lruFrames: 0` 则说明"只清了死数据"。

### 23.9 必须知道的边界

| 边界 | 现状 | 影响 |
|---|---|---|
| 只在 >85% 配额时触发 | 平时不淘汰活帧 | 平时删活帧是纯负收益（下次切回来要重解）；代价是"快到上限"时才开始腾 |
| 目标水位 70% | 一次腾出 15% 以上 | 只腾到 85% 的话，再标十帧又满，会持续抖动 |
| 可能反复淘汰同一批帧 | 淘汰 → 回看 → 重解 → 再落盘 → 又满 | 容量真的不够时的固有现象。缓解是目标水位与 60s 的 touch 间隔 |
| 只淘汰当前数据集 | 不同时动别的活数据集 | 别的活数据集只可能来自另一个标签页，它有自己的配额视角 |
| 逐条 `count()` 判断存在性 | `touchMany` 每个键一次请求 | 一次最多几帧（攒批后），代价可忽略；换成 `getAllKeys` 反而要读全库 |
| 升级到 v3 时若有别的标签页开着 | `onblocked` → 提示关闭其它窗口 | 已有处理；升级只在第一次打开新版本时发生 |
| 帧是原子的 | `need` 很小时仍淘汰整帧 | 宁愿多删一帧（重解 200ms），也不留半帧孤儿 |

### 23.10 验收

- `pnpm test`：**661 项全过**（227 核心 + 177 domain + 47 状态层 + 81 P0 + 129 P3），分层校验通过。
  - domain 新增 17 项：需要腾 0 字节不动、按 need 选够就停、淘汰最久未用、need 超总量全淘汰、
    不可淘汰数据集不动、按帧聚合求和、组内取最大使用时间、整帧进出、保护键整组跳过、
    全保护时为空、同时间戳稳定排序、缺 `lastUsedAt` 视为最旧、无归属记录被忽略、邻域生成与边界。
  - P3 新增 16 项：活数据集内部淘汰、保护帧不动、颜色随帧走、死数据集不占预算、
    `byReason` 记 6 条、`keepBytes`/`removeBytes`、need 很小时仍整帧、
    不可重解码一帧不删、`dryRun` 计划一致且不删、`touchMany` 改变淘汰顺序、touch 不存在的键不报错。
- `pnpm build`：通过。
- `pnpm test:browser`：**187 项全过**（gc 25 / load 15 / timeline 14 / docfirst 27 / collide 7 /
  crosstab 28 / library 30 / lru 41），连跑三遍一致。新增 `lru.mjs` 用真实 IndexedDB 造
  8 帧 ×（300KB 位置 + 100KB 颜色）+ 各自的使用时间，验：
  0. 建库版本为 3 且 `blobUsage` 存在（缺了这个 store，LRU 会静默退化成按写入时间淘汰）；
  1. 预演给出"淘汰 3、4 号"的计划，一条不删；
  2. 真跑后 3、4 号的位置与颜色**都**没了，0/1/2（当前帧邻域）与 5/6/7 完整保留；
  3. `blobUsage` 里的元数据跟着一起删（不留孤儿）；
  4. 状态栏说明"按最久未用淘汰 2 帧"，审计记下 `lruFrames` / `lruBytes`；
  5. 把当前帧移到 5，保护范围跟着挪，0 号立刻变成可淘汰；
  6. 候选池只数没被保护的帧（保护数与候选数分开统计）；
  7. 没有当前数据集时不进入 LRU 阶段；
  8. **生产预算路径**：把 `storage.estimate` 换成 95% 后不再传 `reclaimBytes`，
     走的是 `buildLruBudget()`（配额判定 → 算差额 → 淘汰），验自动进入 LRU、只动保护邻域之外的帧、
     审计记下帧数；
  9. 把 `framesReloadable` 关掉（等价于恢复草稿的缓存句柄），同样 95% 配额下**一帧不删**。
- 顺带把 6 支浏览器脚本里硬编码的 `indexedDB.open(name, 2)` 改成不指定版本 ——
  否则 DB 升到 v3 后这些脚本会直接 `VersionError`。

### 23.11 还没做

1. **跨数据集的全局 LRU**：现在只动当前数据集。两个标签页各开一个大数据集时，
   配额压力由各自判断，可能都腾不够。要做得先有一个跨标签页共享的配额视图。
   → 第九批已做，见 24 节。
2. **按访问频率（LFU）而不是仅时间**：反复回看的少数帧用 LRU 仍会被反复淘汰。
   需要每帧记命中次数，代价是元数据再大一倍。
   → 第九批已做，见 24 节。
3. **协作编辑（P7）、P3 起的功能**：见 21.9 / 22 节。

---

## 24. 实现进度（第九批：全局 LRU 与 LFU）

23.11 剩的两条其实是同一个问题的两面：**候选池太小**（只在自己数据集里挑）、
**尺子只有一把**（只按时间）。这一批把两件事一起做了 —— 它们共用同一份判定代码，
分开做会先写一遍"只按时间"的排序、再推倒重写成"带频次"的。

### 24.1 为什么"只动当前数据集"腾不出空间

第八批的候选池是 `[当前数据集]`，而且要求它能重新解码。三种典型场景都清不动：

| 场景 | 第八批的结果 | 实际需要的 |
|---|---|---|
| 本端开着 3 帧演示数据，库里压着另一个标签页的 2GB | 本端不可淘汰 → 直接不进淘汰阶段 | 去删对端那些"它能重解"的帧 |
| 本端是恢复型会话（缓存是唯一副本），对端是刚导入的文件 | 本端不可淘汰 → 同上 | 同上 |
| 两个标签页各开 500 帧 | 各自只清自己的，可能都差一点 | 统一排序，从最久没用的开始删 |

配额是**同一个 origin** 的，帧缓存也是**同一个库**，所以"我的 / 他的"这种划法在
存储层根本不存在 —— 它只是上一个批次的实现局限。全局淘汰要做的第一件事，
是把候选池从"我的数据集"换成"所有可重解码的数据集"。

### 24.2 全局候选池怎么来的

```ts
evictableDatasetKeys = { 本端当前数据集 if canEvictFrames() }
                     ∪ { 对端自报 evictable 的数据集 }
```

- 跨数据集**统一排序**（不是"先删自己的，不够再删别人的"）。因为尺子只有粒度没有归属，
  先删谁只看"最久没用"，跟键存在谁的名下无关。
- 数据集归属只影响**善后**：本端的帧直接把 `persistedFrames` 撤掉；
  对端的帧要广播通知它自己撤（见 24.3）。
- 保护键也变成两侧并集：本端的当前帧邻域 + 对端自报的邻域。**谁的数据集谁提供保护键**，
  本端不去猜对端正停在第几帧。

### 24.3 跨标签页协议：两句自报 + 一条反向通知

`refs:res` 的载荷加两个可选字段，收到 `frames:evicted` 时做一件事。

```
A: refs:req ─────────────────────────▶ B
A: ◀───────────── refs:res { datasetKey, evictable: true, protectKeys: [...] }
A: 淘汰 B 的 3、4 号帧
A: frames:evicted { datasetKey, frames: [{frame,bytes}], bytes } ──▶ B
B: persist 记账撤回 → 快照退回内联（不再写"只留封面帧"的乐观快照）
```

三处设计取舍：

| 决定 | 为什么 |
|---|---|
| `evictable` 缺省 = false | 判不准就不动。忘声明的后果是"少腾一些空间"，不是"删掉别人唯一的副本" |
| `protectKeys` 由对端给 | 保护范围是 `(datasetKey, 当前帧)` 的函数，当前帧只有对端知道；让本端猜等于两处维护同一套邻域规则 |
| 反向通知是**通知**不是请求 | 帧已经删了，让对方否决没有意义。对端只负责记账撤回 |
| 淘汰超过 200 帧时只发 `all: true` | 一条广播带上千个帧号会变成几百 KB 的消息；对端整份按"不在库里"处理，最坏是快照退回内联 |

`frames:evicted` 是这一批**唯一会让别的标签页改行为**的消息，所以它只做一件事：
`forgetPersistedFrames()` / `forgetAllPersistedFrames()`。不撤销的后果在第八批已经踩过 ——
`canSpillClouds()` 仍为 true，写出只留封面帧的快照，刷新后整片点云是空的。

### 24.4 同一个 `datasetKey`，为什么本端说不能删就不能删

两个标签页可能开着**同一个** `datasetKey`：A 是刚导入的 File（能重解），B 是恢复草稿的
缓存句柄（缓存是唯一副本）。若 B 采信 A 的 `evictable`，就会删掉自己唯一的副本。

所以组装预算时有一条硬规则：

```ts
for (const key of peer.evictableDatasetKeys) {
  if (key && key !== own) evictable.add(key)   // own 的资格只由本端句柄决定
}
```

这条规则还顺带解释了为什么 `reloadable` 是**句柄**属性而不是**数据集**属性：
"能不能重解码"取决于"谁拿着它、手里是什么"，不取决于键的名字。

### 24.5 LFU 的计数口径：60 秒一个会话

`blobUsage` 的记录从 `{ at }` 扩成 `{ at, hits }`，`touchMany` 每次把 `hits + 1`。

关键不在累加，而在**什么时候不累加**：`frameCloudStore` 已经有"同一帧 60 秒内不重复记"，
于是 `hits` 数的是"回看了几回"，而不是"停留了多久"。若按每次读取计数，
10Hz 回放看 10 秒就能把一帧刷到 100 次，LFU 会退化成"谁刚才回放得久谁重要"。

- **不需要 DB 升版本**：对象仓库没变，只是记录多了一个可选字段。老记录 `hits` 缺失按 0 处理，
  与"从没回看过"一致 —— 恰好也是应该优先淘汰的那批。
- **组内取 `max`**：一帧三条记录只有 positions 那条会被 touch，颜色与标签永远是 0。
- **`put` 不清零**：同一帧重新落盘时保留历史次数（它确实被看过）；
  被淘汰后再落盘则是新记录，从 0 开始。

### 24.6 三种策略，默认混合

| 策略 | 排序 | 适合 | 问题 |
|---|---|---|---|
| `lru` | `lastUsedAt` 升序 | 顺着帧往下看、来回拖动 | 回放时反复淘汰"刚滑出窗口"的那批帧：看了 → 淘汰 → 再看 → 重解 |
| `lfu` | `hits` 升序 → `lastUsedAt` | 少数重点帧被反复回看 | 会牺牲"很久没看但很重要"的帧 |
| `hybrid`（默认） | 先按"是否一次性帧"分桶（`hits ≤ 1` 在前），桶内按 `lastUsedAt` | 两者都要 | 语义比前两种复杂一点 |

默认选 `hybrid` 的理由：只读过一次的帧再被回看的概率最低，把它们排在最前面，
等于用同样的回收量换更少的重解码。而且**没有命中数据时它与 LRU 完全等价**
（全是桶 0），所以升级不改变老用户看到的行为 —— 这一点决定了它可以是默认值。

策略入口刻意**不放进界面**：这是存储策略，不是标注动作。入口是
`?evict=lru|lfu|hybrid`（本次会话覆盖）与 `studio.setEvictionPolicy()`（写 localStorage）。
摆在菜单里只会让用户以为需要关心它。

### 24.7 腾不够要如实说

以前 `planFrameEviction` 在候选不足时静默返回：调用方以为清干净了，用量还是 95%，
于是下次保存再弹一次"接近上限"，用户永远等不到一句结论。

`FrameEvictionPlan` 现在带 `shortfall`（需求 − 已腾字节），`datasets`（实际动了谁）。
状态栏据此说三种话：

- 够了：`已回收 1.2MB（12 条），配额淘汰 2 帧（800KB、跨 2 个数据集），策略混合（一次性帧先淘汰），切回会重新解码`
- 不够：`…，仍差 300MB，建议导出后清理旧草稿`
- 一帧都动不了：`可淘汰的帧不够，仍差 300MB` —— 而不是假装成功

### 24.8 审计怎么回答"删的是谁的"

`GcAuditEntry` 加三个字段：

| 字段 | 回答的问题 |
|---|---|
| `evictPolicy` | 这次是按时间、按频次还是混合排的 |
| `lruDatasets` | 动了几个数据集（>1 就是跨了标签页） |
| `shortfallBytes` | 这次没腾够多少 |

```js
studio.gcAudit().entries[0]
// { trigger:'quota', evictPolicy:'hybrid', lruFrames:4, lruDatasets:2, lruBytes:1.6e6 }
```

### 24.9 必须知道的边界

| 边界 | 现状 | 影响 |
|---|---|---|
| 只在 >85% 配额时触发 | 平时不淘汰活帧 | 平时删活帧是纯负收益；代价是"快到上限"时才开始腾 |
| 对端 `evictable` 靠自报 | 对端崩溃/关页时不响应 | 只是少一个候选数据集，不会误删（默认 false） |
| 通知可能丢（广播不通） | 对端记账不撤回 | 最坏是它写出一份乐观的 spill 快照；配额压力下这个风险与"完全不淘汰"相比仍划算 |
| `protectKeys` 上限 256 条/对端 | 正常 15 条 | 防协议出错把内存刷爆；截断后多保护不如少保护的危害小 |
| 独占数据集跨标签页仍各算各的 | 配额视图不共享 `estimate()` | 两边各自按 85% 判定，会重复进入淘汰阶段 —— 判定幂等，最多多删几帧 |
| 淘汰整帧 | `need` 很小时仍删一整帧 | 宁愿多删一帧（重解 200ms），也不留半帧孤儿 |
| 强制入口（`reclaimBytes`）也走门禁 | 仍需 `framesReloadable` | 手测要显式打开标志；好处是测的就是生产那条链，没有旁路 |

### 24.10 验收

- `pnpm test`：**702 项全过**（227 核心 + 197 domain + 47 状态层 + 81 P0 + 150 P3），分层校验通过。
  - domain 新增 20 项：默认策略、白名单、`isEvictionPolicy`、无命中时 hybrid ≡ LRU、策略回填、
    lfu 按次数（次数相同退回时间）、lru 在同样数据上的反例、hybrid 分桶与桶内 LRU、组内 hits 取最大、
    跨数据集统一排序、`datasets` 去重排序、只动可淘汰的那个、对端保护键、缺口计算四种边界。
  - P3 新增 21 项：只动对端数据集、对端颜色一起走、`datasets`、跨数据集排序与删除、
    对端保护键整组跳过、lfu/lru 在同数据上的不同结果、默认 hybrid、缺口 = 需求 − 已腾、
    `mergePeerProtection` 收集 evictable / 忽略无 datasetKey 的声明 / 保护键去重与 256 上限、touch 累加 hits。
- `pnpm build`：通过。
- `pnpm test:browser`：**226 项全过**（gc 25 / load 15 / timeline 14 / docfirst 27 / collide 7 /
  crosstab 28 / library 30 / lru 41 / evict 39）。新增 `evict.mjs` 开两个真标签页，覆盖：
  1. 对端未声明可淘汰时只动本端；声明后候选池 3 + 3 = 6；
  2. 两侧各自的当前帧邻域都被保护（各 3 帧），对端更旧所以先删对端；
  3. 真跑删掉对端帧后，对端状态栏出现"另一标签页回收"（证明反向广播到达并撤了记账）；
  4. 无关 `datasetKey` 的淘汰通知被忽略；
  5. 对端挪动当前帧后，它原先受保护的 0、1 号重新变成候选；
  6. 同样数据下 `lru` 删 1 号、`lfu` 删 0 号；策略写 localStorage、`?evict=lru` 只覆盖本次会话；
  7. 一次计划跨两个数据集，审计记 `lruDatasets: 2`。
- 顺带把 `lru.mjs` 的两处状态栏断言改成匹配新文案（"配额淘汰 … 策略 …"），
  并给它的强制入口补上 `framesReloadable = true` —— 否则它测的是一条生产里不存在的旁路。

### 24.11 还没做

1. **共享配额视图**：两个标签页仍各自调 `storage.estimate()`。真正的全局水位需要一个
   跨标签页的"谁在用多少"账本（或让 `estimate` 的读数带时间戳互相传播）。
   当前实现的现状是"重复进入淘汰阶段"，而判定幂等，代价只是可能多删几帧。
2. **按数据集整体淘汰**：现在永远是逐帧挑。当某个数据集整体都不重要时，
   整段删掉比逐帧挑更省事务（`deletePrefix` 一次搞定）。
3. **让用户看见策略**：目前只有 `?evict=` 与控制台入口。若真有人需要切换，
   再在"本地样本列表"旁边加一个下拉，而不是现在就加。
4. **协作编辑（P7）、P3 起的功能**：见 21.9 / 22 节。

---

## 25. 实现进度（第十批：P2 预标注接入）

P2 在方案里是"3 人周"的一整块：Provider 协议 + 三种适配器 + 合并策略 + 复核状态机。
这一批把**能闭环的部分**做完了：跑模型 → 合并 → 复核 → 导出闸门。
真模型（CenterPoint）与图像依赖模型（BEVFormer 类）留作下一批，原因见 25.1。

### 25.1 为什么先做复核，而不是先接真模型

真模型是**外部依赖**：显存、网络、版本漂移，任何一项都能让"今天跑不通"。
如果先接模型，复核流程会跟着模型一起漂 —— 改一次模型版本，合并与复核全要重测。

反过来先做"mock 产出的确定性框 + 完整复核链"，得到的是一个**与模型无关的验收基准**：

- 合并与复核的所有分支都能在 Node 里跑（`pnpm test:p2`，39 项，无浏览器无网络）；
- 真模型接进来时，只需要实现一个 `PreAnnotationProvider`，**不改合并、不改界面**；
- 用户现在就能用"离线结果导入"这条路，把别的工具跑出的结果拿进来复核。

这也是方案 5.2 里"文件模式作为无网络兜底"的真正价值：它不是降级方案，
而是**先把消费端做完**。

### 25.2 端口：为什么是 AsyncGenerator

```ts
run(req, signal?): AsyncGenerator<PreAnnotateChunk>
```

三件事一次解决：

| 需求 | Promise 下的做法 | AsyncGenerator 下的做法 |
|---|---|---|
| 进度 | 回调 / 轮询共享变量 | 每个 chunk 自带 `progress` |
| 中断 | 额外 `cancel()` + 状态机 | `signal.abort()`，实现方在帧间检查 |
| 逐帧消费 | 等全部结果再拆 | `for await` 里就地收 |

中断时**不合并半批结果**（见 25.11 边界表）：一批断头轨迹比没有更难收拾。

### 25.3 三个适配器

| 适配器 | 用途 | 关键点 |
|---|---|---|
| `mockProvider` | 演示 / 回归 / 无模型环境 | 固定种子的 mulberry32；样本 id 参与播种；`dropRate` 造漏检 |
| `httpProvider` | 接推理服务 | NDJSON 流；`fetchImpl` 可注入；非 2xx 带状态码；超长行保护 |
| `fileProvider` | 离线结果导入 | 认本项目导出格式、裸数组、SUSTechPOINTS `psr` 三种写法 |

mock 的两个刻意的设计：

- **样本 id 参与播种**：同一份种子在不同样本上产出不同框，否则两个样本的复核队列一模一样，手测会看串；
- **`withTrackIds: false` 可关**：没有 id 时才走 IoU 链，这条降级路径必须能被测到（`tests/p2-check.ts` 与 domain 都覆盖）。

### 25.4 身份关联：id 优先，IoU 兜底

```
有 modelTrackId  → 直接按 id 分组（模型内部已跟踪）
没有            → 与"还开着"的提案做 IoU 贪心匹配，跨帧阈值 0.25、允许断 2 帧
```

跨帧阈值比同帧合并（0.5）松，理由很具体：相邻两帧车只前进 0.5m、车长 4.5m，
IoU 本来就在 0.8 以上；掉到 0.25 通常意味着遮挡或漏检 ——
**这时拆成两条轨迹的代价，比连错一条大得多**（拆开会丢掉跨帧身份，P6 的难度分直接失真）。

与方案 5.2.2 的偏差：方案写"复用 tracker 的 Hungarian"，这里改成贪心。理由是候选集
通常 < 20、全局最优没有收益，而把 541 行含卡尔曼的 tracker 拖进 domain 的依赖图不划算。
判据（IoU + 类别一致）与方案一致。

### 25.5 四种合并策略

| 策略 | 行为 | 适合 |
|---|---|---|
| `append`（默认） | 不匹配任何已有轨迹，全部新建为待复核 | 第一次跑模型；最保守 |
| `fill-gaps` | 只填空帧（该帧一个框都没有才算空） | 人工标了关键帧、让模型补中间 |
| `replace-track` | 命中已有轨迹就整条替换几何 | 反复迭代模型、以模型为准 |
| `class-vote` | 按 IoU 加权投票改类别，几何不动 | 多模型校对人工类别 |

默认 `append` 的理由：它是**唯一不会改已有标注**的策略。合并一次能改几百帧，
默认值必须是"只加不改"，让用户在复核队列里逐条决定。

`class-vote` 与 `protectManual` 的关系值得单独说：默认 `protectManual: true` 时，
它对人工轨迹**只记冲突、不改类别**，于是"投票"看起来没生效 —— 这是刻意的，
人工类别不该被模型悄悄改写。要真正批量校对，得显式把保护关掉。

### 25.6 冲突：为什么不静默选一边

模型与人工在同帧给出不同框，是**最有价值的复核信号**：模型可能对（人漏了细节），
也可能错（把护栏认成车）。静默覆盖或静默忽略都等于把这个信号扔掉。

现在的处理：

1. 命中人工帧时**不覆盖**，几何原样保留；
2. 记进 `MergeResult.conflicts`（帧号、人工几何、模型框、IoU），进状态栏与审计；
3. 同一提案里**冲突帧之外的帧仍然收下** —— "人工标了首帧、模型补了后 30 帧"
   是最常见的场景，整条丢掉等于白跑。

边界：冲突的模型几何**没有落库**，所以界面上暂时无法做"A/B 二选一"。
要采信模型，走 `replace-track` + `protectManual: false` 重跑一次（见 25.11）。

### 25.7 复核状态机与键位

```
pending ──A──▶ accepted ──(人改几何)──▶ accepted + 该帧关键帧 source=manual
   │
   ├──X──▶ rejected（仍可见，灰色虚线；不进导出）
   └──冲突──▶ 人工帧 review=conflict（红，进队列最前）
```

键位：`A` 接受 / `X` 拒绝 / `Shift+A` 接受当前帧 / `Tab` 下一处 / `Esc` 关闭。

**只在复核面板打开时生效**。原因是 `A` 平时是"沿 +y 平移"、`Tab` 是"切换选中"；
只在复核模式抢这两个键，冲突面就是 0 —— 关掉面板，键位与以前完全一样。
实现上用捕获阶段监听 + `stopPropagation`，因为 `annotation.onKeyDown` 挂在同一节点的冒泡阶段。

### 25.8 导出闸门：判据是"谁给的"，不是"谁看过"

```ts
if (state.source.kind !== 'model') return true   // 人工帧永远可导出
return state.review === 'accepted'
```

这条判据的顺序很关键：如果按 `review` 一刀切，**将来任何给人工帧打标记的功能
（比如冲突提示）都会让标注悄悄从导出里消失**。

闸门放在物化层（`materialize(..., { acceptedOnly: true })`），三条导出路径
（单帧 / frames 镜像 / 流式全量）自动一致 —— 各自过滤必然漏一条，
而"画面上少一个框、导出里还留着"是最难查的一类问题。

### 25.9 一个真 bug：批量建轨会撞号

浏览器用例第一次跑就抓到了：一次合并建 4 条轨迹，4 条全拿到 `id = 1`。

原因不是随机，是契约错了：`buildMergeCommand` 的 `nextId()` 典型实现是
`TrackStore.nextTrackId()` —— 它扫**已落库**的轨迹。而命令要等 `exec` 之后才落库，
于是 4 次调用看到的是同一份文档，返回同一个号。

后果比"id 重复"严重得多：按 id 复核会一次裁决掉所有同 id 轨迹，撤销会串数据。

修法是把契约改成"把已占用集合交给分配器"：

```ts
nextId: (used: ReadonlySet<TrackId>) => TrackId
```

`used` 由 `buildMergeCommand` 自己维护（库里已有 ∪ 本次已分配）。
这条 bug 在 Node 测试里没暴露，因为 Node 的桩分配器是自增计数器 ——
**真实 store 的分配语义只能靠真界面验**，这也是浏览器用例必须存在的原因。

### 25.10 必须知道的边界

| 边界 | 现状 | 影响 |
|---|---|---|
| 冲突的模型几何不落库 | 只记 `MergeResult` | 无法在界面上 A/B 二选一；采信模型要重跑 |
| 中断不合并半批 | 收到多少都丢弃 | 用户会看到"跑了一半白跑"；换来不会有断头轨迹 |
| 拒绝的框仍然可见 | 灰色虚线，不隐藏 | 少一个"显示已拒绝"开关；好处是能反悔 |
| 复核不锁关键帧 | accepted 的帧 `locked` 仍为 false | 之后跑 RTS 平滑可能改动已接受的位置 |
| `class-vote` 缺省不改人工类别 | 只记冲突 | 想批量改类必须显式 `protectManual: false` |
| 合并只认确切关键帧 | 插值帧不参与匹配 | 与物化默认 `exact` 一致；开 `linear` 导出时匹配仍按关键帧 |
| 待复核帧也参与"跳下一处标注" | 未过滤 | 有队列时该入口可能停在待复核帧上（可接受） |
| 真模型未接 | 只有 mock / http / file | http 适配器已就绪，缺的是服务端与鉴权 |

### 25.11 验收

- `pnpm test`：**791 项全过**（227 核心 + 247 domain + 47 状态层 + 81 P0 + 39 P2 + 150 P3）。
  - domain 新增 50 项：BEV IoU 6（重合/分离/半重叠/旋转/退化/对称）、身份关联 6、
    四种策略 20（含冲突保留、protectManual 开关、class-vote 两种保护态）、
    复核 18（排序、统计、裁决、撤销、导出闸门、物化过滤）。
  - P2 新增 39 项：mock 确定性 / 中断 / 进度 / 关 id；http NDJSON / 错误码 / 预中断；
    file 三格式 / 范围过滤 / 坏文件 / 脏对象；以及"合入 → 闸门 → 接受 → 放行"整链。
- `pnpm build`：通过。
- `pnpm test:browser`：**254 项全过**（10 支）。新增 `p2.mjs` **28 项**：
  1. 清空起点后跑 mock → 4 条提案 / 4 条轨迹 / 队列自动打开；
  2. 画布上待复核为灰色（`0x9aa4b2`），导出闸门 0 放行；
  3. `A` 接受当前行、`X` 拒绝当前行，拒绝后仍不进导出；
  4. `Tab` 跳到下一条并把画面带过去；
  5. `Ctrl+Z` 把拒绝退回来（顺带验证"撤销后复核统计跟着刷新"）；
  6. 关掉面板后 `A` 回到平移语义（不再裁决）；
  7. 人工改过一帧后重跑 `replace-track` → 记冲突且保留人工几何；
  8. 离线 JSON 导入（`File` → 合并 → 模型身份可见）。

### 25.12 还没做

1. **真 CenterPoint / BEVFormer 接入**：`httpProvider` 已就绪，缺服务端、鉴权与 CORS 方案
   （开发期 Vite proxy，生产期 BFF，属于 P7）。
2. **冲突的 A/B 裁决**：需要把模型几何随冲突一起存下来（命令或文档里加一个临时槽位）。
3. **复核工作量统计**：现在只报"还剩几条"，没有"接受率 / 平均耗时"——P6 的难度分需要它。
4. **拒绝隐藏开关**：`rejected` 目前一直可见。
5. **复核后自动锁帧**：`accepted` 的关键帧应置 `locked`，免得后续平滑改动。
6. **P3 起**：Occupancy / Flow / VLA / 规则引擎 / 闭环，见 21.9。

---

## 26. 实现进度（第十一批：P3 多任务与衍生真值）

P3 在方案里是"6 人周"的一整块：任务注册表、占据、光流、跨任务一致性、UI。
这一批把**能形成闭环的主干**做完了：

```
框（人工/预标注）
   └─▶ 占据：box carving + 地面剪裁 ──▶ RLE ──▶ BlobStore ──▶ 渲染层 / 导出 / 校验
   └─▶ 光流：框内点刚体流 + 地面带自车运动 ──▶ 箭头层 / ego 落盘
   └─▶ 一致性：I1 框内占据率 / I2 框内类别 / I3 语义实例映射
```

VLA（P4）、规则引擎（P5）、车道线编辑不在这一批，原因分别写在 26.11 与 5.4/5.5。

### 26.1 任务注册表：加任务不再改五个地方

原来"加一个任务"要动的地方是散开的：`buildSnapshot` 的字段列表、导出、质检、
面板 tab、命令的 `affects`。每加一次漏一处的概率都不低。现在一份 `TaskAdapter` 契约：

| 字段 | 回答的问题 | 谁在用 |
|---|---|---|
| `validate(payload, doc)` | 这份载荷合规吗 | 任务面板的问题数、保存前的自检 |
| `deriveFrom(doc)` | 能不能从别的任务算出来 | 占据 / 光流（本期用状态层直连，接口留给 P5） |
| `serialize(payload, doc)` | 能不能导出成外部格式 | 占据 `.occ`（本期直连），其余待补 |
| `estimateBytes(payload)` | 多大、要不要懒加载 | 配额与"哪个任务在吃空间" |
| `progress(doc)` | 做了多少 | 任务面板的进度行 |

注册进 `createDefaultRegistry()` 的是 boxes / occupancy / flow / semantic / lane 五个。
**vla 故意不注册**：P4 之前它没有任何校验与编辑器，注册了只会在面板里多一个永远 0% 的行。

`validate` 返回 `QaIssue[]` 而不是抛异常 —— 导入别人的文档时，"占据帧号越界"
应该显示成一条问题让人决定，而不是整份文档打不开。

### 26.2 占据为什么是"派生 + 抽检"

人工逐格标 200×200×16 = 64 万体素不现实。可行的分工是：

- **框**（瓶颈在框质量）由人保证；
- **占据**由框 + 地面派生，人只做抽检与单格修正；
- 于是占据的误差与框的误差**同源**：框修好了重跑派生就一起好了，
  不会出现"框一套、占据另一套，各自错在不同地方"。

派生用 `sampleTrack(mode: 'linear')` 而不是 `exact`：只刻关键帧的话，
500 帧数据集里占据会只剩几十帧有内容，而中间帧的框几何是插值出来的、
本来就该参与派生。这一点与"物化默认 exact"的取舍相反，理由也相反：
物化要的是"画面上看到的必须是确认过的"，占据要的是"空间里确实有东西"。

### 26.3 只存 occupied：free / unknown 不进真值

`OccupancyFrame` 只有 `occupied + labels`，没有 free/unknown 位。
原因是两者的认识论地位不同：

- "这里有东西、是车"是**真值**，换个视角也成立；
- "这里没有东西"是**观测**，只对这台传感器、这个时刻成立。遮挡背后是空是墙，
  单帧点云答不了。

把 free 写进真值，下游几乎一定会把"没看见"当成"空的"来用 —— 这是占据标注
最常见也最难查的错误。所以空与未知交给读者按自己的口径解释。
射线雕刻（DDA）因此也不在主路径：它是 ROI 精修的临时产物，本期未实现。

### 26.4 冲突裁决：体积小的赢

两个框覆盖同一体素时按"体积小 → 置信度高 → 类别优先级 → id"裁决。
第一优先级是体积，而不是置信度：**大框通常是把旁边的东西裹进来了**
（SUV 的框吃掉半个行人），小框更可能是贴合的那个。置信度只在体积相同时才用得上，
因为模型给的置信度与框的几何质量并不总是一致。

裁决结果不是静默的：`overlapVoxels` 与去重后的 `overlapPairs` 一起返回，
生成时进状态栏（"N 个体素被多框覆盖"）。上限 32 对，防止一份坏数据刷屏。

### 26.5 地面只做一件事：剪底

`estimateGround` 在 1m 的 BEV 网格里取点云 z 的 5% 分位，再做 3×3 中值滤波，
只为一个目的服务：**剪掉框底面以下的体素**。框常画到地面下 10–20cm
（点云稀疏，看不见轮胎接地点），不剪每辆车都会在地里多一层"幽灵体素"。

低分位而不是最小值（最小值一定是噪点），中值滤波而不是均值（均值会被墙脚拉高）。
没有观测的格保持 NaN，**没有观测就不剪** —— 宁可多留一层，不要凭空造地面。

**第二件事被删掉了：沿地面铺一层 `ground` 类体素。**

第一版按方案原文实现了它，跑完演示场景一看截图就发现不对：

| 症状 | 数字 |
|---|---|
| 3D 画面发灰，看不出哪块是车 | 地面体素占满整个可视范围 |
| 统计里第一大类不是车 | `ground 9067` / 本帧共约 1.08 万格，车只有 1764 格 |
| 占据率失去信息量 | 84% 的"occupied"其实都是地面 |

问题不在实现，在口径：**占据训练里地面是 free**。把地面写成 `occupied`
等于告诉模型"路是不能走的地方"，"占用"这个标签本身就没意义了。地面高度
真正该服务的是两件事——剪底（已做）、以及将来的 free-space 补全（P5 再说）。

所以 `buildSpec()` 只把**标注类别**放进类别表，`carveFromTracks` 固定传
`groundClass: null`。`CarveOptions.groundClass` 这个接口**保留**：离线流水线
若有"地面也算 occupied"的特殊口径（比如只做障碍物检测的数据集）可以传，
但标注工具自身不改默认值。

这条修正记在这里而不是悄悄改掉，是因为它是**默认值的取向问题**：派生真值的
默认值应当按"训练怎么用"定，而不是按"能算出什么"定。能算出地面高度，
不代表该把地面标成障碍。

### 26.6 RLE 与 `.occ` 打包：为什么不是 npz

| 选择 | 理由 |
|---|---|
| 稀疏索引 + 类别的 RLE | 一帧 5 万占用体素、几百段连续区间时，逐格一对要 40 万字节，RLE 不到 4KB |
| 类别变了就断段 | 多花几段，换来"标签与索引等长且能顺序解压" |
| 一个文件 + JSON 头 | 浏览器不引第三方打包库；Python 侧读 JSON 头 + 切片就能进 numpy |
| `scripts/occ2npz.py` 放在脚本目录 | 训练侧格式转换是数据工程，不该进标注工具的构建链 |

`.occ` 的 header 里有每帧的 `offset/bytes`，所以解码不需要顺序扫描；
Python 脚本默认输出**CSR 风格**的稀疏张量（`indptr/indices/labels`），
`--dense` 才展开成 `[F, nx, ny, nz]`（500 帧 = 320MB，非必要不开）。
dense 时值写成"类别下标 + 1"，因为 0 要留给"未占用"，否则 Car（下标 0）会与空撞值。

### 26.7 光流：与方案的一处偏差，以及为什么

方案 5.3.3 写的是"随机采样 3 对点 → SVD 求 R,t"。这在**有对应关系**时成立，
而两帧点云之间没有对应关系 —— 先配对应再 RANSAC 就是 ICP，初值差时会收敛到
错的极小值，而且在浏览器里不可控、不可复现。

改成在地面带 BEV 占据上做**粗到细的刚体搜索**：

```
粗：dx,dy ∈ [-3,3] step 0.6 / dyaw ∈ [-0.2,0.2] step 0.05
细：在粗解附近 ±0.6m step 0.15 / ±0.05rad step 0.01
评分：变换后的源点有多少落进目标点 0.3m 内（3×3 网格邻域）
```

自车两帧间的位移本来就小，搜索空间有限；结果是确定性的，测试不需要固定随机种子。
代价是**搜索范围外的运动估不出来**（急转弯、掉头），所以返回值带 `inliers` 与 `rmse`，
`rmse > 0.2m` 时规则会提示"这帧的光流只能参考"（`TASK_FLOW_UNRELIABLE`）。

方向约定统一成"把 a 帧坐标映射到 b 帧"：`p_b ≈ R(dyaw)·p_a + (dx,dy)`。
`rigidFlow` / `applyEgoMotion` / `egoBetween` / 搜索评分全用这一个方向。
不统一定义的话，"这里正着转、那里反着转"是最容易埋进去、最难查的一类错。

箭头画的是**上一帧框内的观测点 → 刚体预测位置**。方向只能是这个：
拿当前帧的点算，刚体变换把它映射回它自己，箭头长度恒为 0。

### 26.8 跨任务一致性：本期只做三条，另外两条为什么不在

| 编号 | 规则 | 状态 |
|---|---|---|
| I1 | 框内占据率 ≥ 90% | ✅ `XT_OCC_BOX_CONTAINMENT` |
| I2 | 框内体素类别与框一致（容差 10%） | ✅ `XT_OCC_CLASS_MISMATCH` |
| I3 | 语义实例 → 轨迹映射不悬空 | ✅ `XT_SEM_INSTANCE_UNMAPPED` |
| I4 | 框内点光流 ≈ 刚体预测 | ⏳ 需要逐点光流，而光流按设计不落盘，只能在有当前帧点云时**运行时**检查 |
| I5 | 车道线落在可行驶区域内 | ⏳ 车道线本期只有"能存能取"，没有编辑与采样点拟合 |

I1 的 90% 不是拍脑袋：box carving 生成的占格天然 100%，不满足只可能来自外部导入、
人工局部修正、或分辨率/标定误差。它**是唯一能自动发现"框和占据整体错位"的手段** ——
人工逐格比对 64 万体素不可能。

两个防止"规则变成噪音"的阈值：

- `minCoveredVoxels = 8`：远处的行人只有 1–2 个体素，缺一个就是 50%，报出来只会淹没真问题；
- `maxPerRule = 200`：一份坏数据能刷出几万条，报告必须先看全局再看单条。

### 26.9 ROI 编辑：先做"光标一格"

三维笔刷要处理相机投影、穿模、拖拽轨迹，是另一个交互子系统。而最常见的两个问题 ——
"这辆车底下多了一层""那面墙缺了一角" —— 单格增删就够了：

```
鼠标移到点云上（状态栏有坐标）→ 选类别 → 补一格 / 删一格
```

每次修改生成一条 `setTaskPayload` 命令（描述对象整体替换，新帧写一个新 blob），
所以撤销 = 切回旧引用，不需要重新编码，也不会因为"编码算法改了"撤销出不同结果。

### 26.10 缓存按引用失效，不按 docVersion 全清

撤销/重做会换回**旧引用**。如果每次 `docVersion` 变化就清空已解码缓存，
大样本上每次撤销都要重读 IndexedDB（几百毫秒的卡顿）。所以维护 `帧号 → 引用` 的映射，
**引用变了才丢缓存**：撤销回旧引用时正好命中，改一格时旧内容立刻失效。

不这么做的后果很具体：撤销后画面显示的是"改过的那一版"，而导出已经是"改回来的一版"，
两边看起来都"对"，只有对比才发现不一致。

### 26.11 必须知道的边界

1. **占据不覆盖非关键帧之外的插值外推段**：`sampleTrack(linear)` 在首末关键帧之外
   返回 coasting 几何，那部分会参与派生 —— 也就是说"预测到第 20 帧"会被刻成占据。
   需要严格口径时按 `lifecycle` 裁剪帧范围再生成。
2. **遮挡轨迹默认不刻**：`includeOccluded` 为 false。理由同 26.3 —— 猜的位置不是真值。
3. **地面不进占据**：`CarveOptions.groundClass` 是留给离线特殊口径的接口，工具侧固定 null ——
   占据训练里地面是 free，标成 occupied 会让标签失去意义（见 26.5）。
4. **一次最多派生 200 帧 / 校验 24 帧**：浏览器主线程上再多人就等，分批点。
5. **一致性校验只覆盖"有占据的帧"**：没有占据的帧不产生 I1/I2（会明确说"还需要占据"）。
6. **ego 落盘的是估计值，不是位姿真值**：没有位姿的数据集本来就没有真值可落。
7. **ROI 编辑只支持单格增删**：批量笔刷、三维套索未做。
8. **任务面板不做"启用/停用任务"的持久化**：`optional` 只影响校验是否跳过。

### 26.12 验收

```
pnpm test:task      96 项（网格数学 / 派生 / 地面 / RLE / 光流 / 一致性 / 注册表 / 命令）
node scripts/browser/task.mjs   50 项（生成 / 渲染实例 / 撤销重做 / 单格编辑 / 切片 / I3 / ego / 箭头 / 导出 / 面板 / 清除）
pnpm test           887 项全过（227 核心 / 247 4D 内核 / 47 状态层 / 81 P0 / 39 P2 / 150 P3 回收 / 96 多任务）
pnpm test:browser   304 项全过（11 支）
pnpm build          通过
```

方案 5.3.6 的四条验收对应情况：

| 方案要求 | 现状 |
|---|---|
| 5 帧每帧 < 100ms | 实测约 58ms/帧（含地面估计、RLE 与 IndexedDB 落盘），浏览器用例断言 < 500ms/帧留余量 |
| RLE < 80KB、解码与原始逐体素一致 | 5 帧演示共 124,190 字节（约 24KB/帧）；RLE 往返逐字节断言 |
| I1/I2 在删掉 30% 体素后报出正确对象 | 单测覆盖（删 1/4 即报，指名轨迹与帧） |
| 刚体流误差 < 1e-3 | 解析解断言 1e-6 |
| 导出 .occ + spec + occ2npz.py | 全部落地 |

### 26.13 还没做

- **任务面板的"停用任务"与按任务锁定**：`DocMeta.hashes` 已经按任务分段，但还没有 UI。
- **占据的增量派生**：改一条轨迹会重算整帧。按脏轨迹做局部重算（只重刻受影响框的 AABB）
  是下一步最划算的性能优化。
- **I4 / I5 两条规则**：留到 P5 规则引擎，那时有统一的 rule registry 与 profile 版本。
- **车道线编辑**：`lane` 任务只有校验与存储，没有画线与拟合。
- **跨样本共享占据**：内容寻址已经让"同一帧被两个样本引用时只存一份"成立，
  但还没有"从另一个样本复制占据"的入口。
- **VLA（P4）**：指令段与动作通道的数据结构已在 `document.ts`，编辑与对齐未开始。

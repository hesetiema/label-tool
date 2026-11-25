# Point Cloud Label Studio

一个**面向学习的 3D 点云标注工具**：用 Vue 3 + TypeScript + Three.js 从零实现自动驾驶标注的核心闭环，参考 [SUSTechPOINTS](https://github.com/sustech-isus/SUSTechPOINTS) 的设计思想。

> 目标不是做一个生产级标注平台，而是**让你通过动手，真正搞懂这个领域**：点云怎么存、3D 框怎么表示、自动拟合怎么做、数据怎么和算法对接。

---

## 1. 快速开始

```bash
pnpm install
pnpm dev        # 打开 http://127.0.0.1:5173
```

打开后会**自动加载一个程序化生成的演示场景**（地面 + 车道线 + 车辆/行人点云），无需任何外部数据即可体验完整流程。

界面按 **CVAT 3D 的交互骨架**组织：顶部是数据集菜单与帧导航，左侧是图标工具条，中间是 3D 透视视口，底部是 **Top / Side / Front 三联正交视图**，右侧是 **对象 / 标签 / 任务 / VLA / 更多** 面板（外观与属性都在对象页里）。画框不再在 BEV 里凭空拖拽，而是对齐 CVAT 的两步法：**在 Top 视图拖出底面矩形 → 在 Side 视图拖绿点调高度**。

想看**真实数据**？点左上角 **Point Cloud → 真实数据**，即可一键加载 SUSTechPOINTS 官方样例：**66,899 个真实激光雷达点 + 24 个标注框**，能看到 LiDAR 特有的同心圆扫描线、真实车辆/行人点云。加载后自动进入**分屏模式**：左边点云、右边前视相机图，并把 3D 框投影到图像上（约 10 个框在前视可见），直观验证多传感器对齐。也可直接访问 `http://127.0.0.1:5173/?data=real` 直达。

> 右侧面板收成 5 个 Tab：**对象 / 标签 / 任务 / VLA / 更多**。时序、质检、运镜、性能都收在「更多」里，
> 主流程只保留标注本身。

三个直达链接，覆盖最值得先看的能力（`?data=real` / `?data=sequence` / `?data=qa`）：

| 链接 | 演示内容 |
|---|---|
| `?data=real` | 真实数据 + 相机投影分屏 |
| `?data=sequence` | 5 帧时序序列：目标会移动，默认叠加显示跨帧轨迹线。点「轨迹插值补全」可补出 9 个中间帧框；点「回放」逐帧播放（白点=当前帧），加 `&autoplay=1` 进入即自动播放 |
| `?data=qa` | 质检演示：生成扰动版标注并自动出报告（IoU / kappa / 漏标率） |

其余能力从右侧「更多」进入：**百万点压测**、**贪心 vs Kalman+Hungarian 关联演示**、**相机运镜与录制**（见 [第 ⑩ 篇](docs/10-camera-cinematography.md)）。

```bash
pnpm build      # 类型检查 + 生产构建
pnpm typecheck  # 只做类型检查
pnpm test       # 分层校验 + 1005 项断言（227 核心 / 247 4D 内核 / 47 状态层 / 81 P0 / 39 P2 预标注 / 150 P3 回收 / 97 P3 多任务 / 117 P4 VLA），无需浏览器
pnpm test:browser  # 浏览器手测（另开终端先 pnpm dev --port 5199；已起在别的端口就设 APP_URL）：用本机 Edge 验 IndexedDB / 懒加载 / 时间线 / 草稿恢复 / 跨标签页 / 样本删除 / 帧缓存淘汰 / 预标注复核 / 占据与光流 / VLA 对齐，共 346 项
```

> `test:browser` 复用本机 Edge，不需要 `playwright install`；仓库不把 playwright 列为依赖，
> 首次运行会按「项目依赖 → `PLAYWRIGHT_PATH` → `npx` 缓存」三级查找，找不到会给可执行的提示。


---

## 2. 能做什么（功能清单）

| 功能 | 说明 | 对照原仓库 |
|---|---|---|
| PCD 加载 | ascii / binary；正确处理 CRLF 头偏移、`COUNT>1` 填充字段、rgb 打包颜色 | `PCDLoader` |
| **CVAT 式三视图** | 3D 透视 + Top / Side / Front 三联正交，单击选中、双击最大化、视图间同步 | `pcd_viewer.js` |
| **两步画框** | Top 拖底面矩形 → Side 拖绿点调高度，角点缩放、黄点旋转（Shift 吸附 15°） | `mouse.js` + `auto-adjust.js` |
| **多选与框选** | Ctrl 点选 / 空白拖拽橡皮筋框选 / `Tab` 切换 / `Ctrl+A` 全选；批量改类别、删除、复制、整组平移 | — |
| **实时读数** | 画框、缩放、旋转、调高时在光标旁显示尺寸 / 角度 / 位移；状态栏显示光标处的点云 x/y/z | — |
| **悬停联动** | 指向任一对象：3D 视口套一圈青色光晕、三张正交视图与相机投影图同步加粗描边，并在框旁贴出「长 × 宽 × 高 · 朝向」读数。四个视图共用同一份悬停状态 | — |
| **联动缩放 / 平移** | 右侧「外观」里勾选后，三个正交视图同步到相同「米/像素」，平移也按同一段世界距离同步；判断比例时不会因为各视图缩放不同而看错 | — |
| 自动拟合 | 选中框后 `Shift+F`：用框内点云重新估计 PCA 主方向 + 局部 min/max 拟合尺寸（多选可批量） | `algos/rotation.py` |
| 框编辑 | 直接拖手柄，或 WASD / QE / RF + 属性面板精调 | `box_op.js` |
| 类别与 ID | 类别可增删改色；导入未知类别自动登记；obj_id 全局唯一 | `obj_cfg.js` |
| **对象管理** | 锁定 / 隐藏 / 排序 / 删除，外观可按类别或实例着色、调透明度 | — |
| 导入导出 | 单帧兼容 SUSTechPOINTS；**整段序列**一键导出（不再只导当前帧）；另提供「插值补帧」「RTS 平滑」两种流式导出 | `save.js` |
| **多格式适配** | 导入标注自动识别 KITTI `.txt` / DAIR-V2X JSON / nuScenes 关系表 / Waymo JSON / SUSTechPOINTS，统一转成内部 `Box3D`；坐标与旋转约定集中在 `conventions.ts`，DontCare 以跳过统计提示 | — |
| **逐点语义分割** | PCD `label` 字段或 SemanticKITTI `.label` 导入（**官方原始 id + 高 16 位跨帧实例 id 都保留**）；3D 与三联正交视图支持「默认 / 语义」着色、类别占比图例；内置官方 34 类配色与 learning_map；下采样与 IndexedDB 草稿不丢标签；`?data=semantic` 直达演示 | — |
| **本地草稿** | IndexedDB 自动保存 / 刷新恢复 / 离开拦截，无需后端 | — |
| **多帧导入** | 一次选多个 PCD，按文件名自然排序组成时序；同名 JSON 自动匹配 | — |
| **跨帧复制** | 把选中框按**同 id** 复制到下一帧 / 后续帧 / 全部帧，直接构成轨迹；目标帧已有同 id 则跳过 | batch 模式 |
| **相机投影** | 3D 框投影到前视相机图像，多传感器融合对照；支持可选径向-切向畸变校正（OpenCV `k1,k2,p1,p2,k3`，兼容 KITTI `D` / OpenCalib `Distortion`） | `calib.js` + `image.js` |
| **分屏视图** | 点云 / 分屏 / 相机 三种布局；相机图上的框参与同一套选中与悬停联动 | — |
| **撤销重做** | 文档级命令历史（`Ctrl+Z` / `Ctrl+Shift+Z`），拖拽自动合并为一次；**切帧不再清空历史**，跨帧编辑可回退 | — |
| **多帧时序** | 5 帧演示序列、obj_id 跨帧保持一致、首末帧轨迹插值补全中间帧 | batch 模式 |
| **4D 轨迹叠加回放** | 同目标多帧中心点连成轨迹线（已走过段高亮），播放/暂停/调速逐帧回放，选中目标整条轨迹高亮 | — |
| **相机运镜** | 关键帧 + 转场/停留时间 + 样条/缓入缓出；镜头时间线与数据帧时间线相互独立，可保存/打开轨迹 JSON | rviz_cinematographer `CameraTrajectory` |
| **演示视频录制** | `canvas.captureStream` + `MediaRecorder` 导出 WebM，可选 fps、VP9/VP8、右下角水印 | rviz_cinematographer `Recorder` |
| **跨帧编辑** | 把选中框的改动传播到同 id 框：整框替换 / 增量平移 × 后续/前序/全部帧 | — |
| **4D 真值内核** | `Track`（稀疏关键帧 + 逐帧观测状态）取代"整帧框数组"；`Box3D` 降级为物化视图，渲染/质检/导出零改动；命令可序列化、可审计 | — |
| **轨迹时间线** | 画布下方按帧展示每条轨迹的跨度与关键帧，点击跳帧、双击补关键帧、**拖两端改生命周期**、右键补帧/拆分/裁剪/锁定/删除、一键拆分/合并/插值补全 | — |
| **大序列懒加载** | 超过 20 帧或 120MB 时只解码首帧，其余切帧时在 worker 中按需解析并写入 IndexedDB；标注仍全量加载，4D 能力不受影响 | — |
| **文档级持久化** | IndexedDB v3 分段存储（文档头 / 任务段 / 点云 blob / 使用时间）；改一个框只写几 KB，v1 草稿可自动迁移；**doc-first 恢复**（标注读文档、点云读帧缓存），生命周期/稀疏状态/复核标记刷新后原样保留 | — |
| **预标注与复核** | 三种 Provider（确定性 mock / NDJSON 推理服务 / 离线结果 JSON）走同一套 `AsyncGenerator` 协议，可进度、可中断；逐帧结果按 `modelTrackId` 或 IoU 链成轨迹，四种合并策略（全部待复核 / 只补空帧 / 命中替换 / 投票改类别）；模型框以**灰色虚线 + 置信度角标**呈现，`A` 接受 / `X` 拒绝 / `Tab` 下一处；导出只含已接受与人工标注；与人工框冲突时保留人工几何并进队列裁决 | — |
| **多任务与衍生真值** | 任务注册表把"校验 / 派生 / 序列化 / 体积 / 进度"收成一份契约；**占据**由框 + 地面派生（box carving、地面只用来剪底不写成占格），稀疏索引 + RLE 落 BlobStore，内容寻址让撤销 = 切回旧引用；`InstancedMesh` 渲染 + 高度切片，ROI 单格增删可撤销；**光流**用框内点刚体流 + 地面带自车运动估计（搜索而非 RANSAC，结果确定性），箭头层只看框内点；**跨任务一致性** I1 框内占据率 / I2 框内类别 / I3 语义实例映射；导出 `.occ` + spec，配 `scripts/occ2npz.py` 直出 npz | — |
| **VLA 语言—动作对齐** | 指令段（文本 + 闭区间 + 语义标签 + 复核状态）、动作通道（逐帧标量 + 单位 + 源采样率）、**对齐区间**（可偏离指令区间，偏移本身是标注结果）；底部时间线加两行（指令条 DOM + 四通道曲线 Canvas）共享同一个帧游标；11 条校验规则，核心是 `VLA_ACTION_SIGN`（靠"标签 → 期望符号"配置表跨模态检查，不理解语言）；合成数据确定性且默认零问题、错误靠显式注入；导出 JSONL 复用 P2 的导出闸门，配 `scripts/vla_check.py` 独立回读 | — |
| **帧缓存淘汰（全局 LRU / LFU）** | 配额超过 85% 时先自救：在**所有可重新解码**的数据集里淘汰，跨数据集按同一把尺子排序（含另一个标签页声明可重解码的数据集），直到回到 70%。三种策略：`lru` 最久未用 / `lfu` 最少使用 / `hybrid` 默认先清「只读过一次」的帧再按时间；两侧当前帧邻域都受保护，整帧（位置 + 颜色 + 标签）一起进出；删了对端的帧会反向广播让它撤回落盘记账；腾不够如实报缺口；恢复型会话一帧不动 | — |
| **本地缓存回收** | 大载荷按 `payload/<hash>` 内容寻址 + 引用计数（文档/历史双向校验）；帧缓存按数据集归属清扫；启动、换数据集、清草稿、配额超限四处触发，未知键默认保留；每次清扫进审计流（`studio.gcAudit()`） | — |
| **本地样本列表** | 菜单「本地样本列表…」列出本地落盘的每一份标注：场景、帧数、有哪些任务段、多久以前存的。可二次确认删除；当前样本（会被下次自动保存写回）与其它标签页正在编辑的样本不提供删除 | — |
| **跨标签页协调** | 同一样本只允许一个标签页写（租约 6s TTL + 心跳），后开的转只读并在状态栏点「接管」切换；清扫前广播汇总对端引用，避免互删对方未落盘的载荷；刷新后仍是同一个"我"，不会被自己的旧租约锁住 | — |
| **时序质检** | ID 跳变、速度突变、轨迹抖动、轨迹断裂四类检测，健康分 + 问题列表可跳帧；一键注入缺陷演示 | 智能审核 |
| **遮挡状态机** | alive/occluded/dead 三态、Kalman coasting 预测续接、虚线渲染遮挡框、质检豁免遮挡缺口 | 4D 工具 |
| **全局最优关联** | Kalman 预测 + 门控 + Hungarian 匹配；交叉案例演示贪心如何串 ID | — |
| **性能优化** | 体素网格下采样 + 距离 LOD；实测 100 万点→27 万点、3.7× 压缩；按需渲染 + 签名缓存 | — |
| **质检与一致性** | BEV 旋转框 IoU、目标匹配、漏标/误标率、F1、Cohen's kappa；可叠加显示待评估框 | — |

---

## 3. 学习路线（按顺序读 docs/）

这个仓库既是可运行的工具，也是一套教程。①–⑥ 是从零到能用的主线，⑦–⑪ 是工程化、4D 与多任务进阶：

| 文档 | 配套源码 | 一句话 |
|---|---|---|
| [① 坐标系与整体架构](docs/01-coordinates-and-architecture.md) | `core/types.ts` | z-up 约定、OBB 表示、数据分层 |
| [② 点云数据格式 PCD](docs/02-pcd-format.md) | `core/pcd.ts` | PCD 头结构、ascii / binary 解析 |
| [③ 3D 框与几何算法](docs/03-obb-and-fitting.md) | `core/box.ts` | 8 角点、PCA 主方向、自动拟合 |
| [④ Three.js 渲染原理](docs/04-threejs-rendering.md) | `viewer/PointCloudViewer.ts` | 正交/透视相机、屏幕反投影、按需渲染 |
| [⑤ 交互与序列化](docs/05-interaction-and-io.md) | `state/useAnnotation.ts` / `core/label.ts` | 拖拽画框、快捷键、label JSON 互通 |

> ④⑤ 两篇的正文成文于「BEV 双视口」时期，其中**正交投影、屏幕反投影、按需渲染**的原理部分仍然适用；代码现状是单 3D 视口 + 三个独立 2D canvas 正交视图（`components/OrthoView.vue`），不再开第二个 WebGL 场景。读的时候把「双视口」替换为「三联正交」即可。
| [⑥ 相机标定与投影](docs/06-calibration-and-projection.md) | `core/io/calibration.ts` | 3D 框投到图像、LiDAR 与相机对齐、畸变校正 |
| [⑦ 工程化能力](docs/07-engineering-p0.md) | `core/history.ts` / `sequence.ts` / `downsample.ts` | 快照 vs 差量、轨迹关联与插值、体素 + LOD 实测 |
| [⑧ 4D 轨迹叠加回放](docs/08-4d-trajectory-replay.md) | `core/sequence.ts` / `viewer/PointCloudViewer.ts` | 轨迹提取纯函数、轨迹线渲染、回放定时器 |
| [⑨ 4D 进阶：跨帧编辑与时序质检](docs/09-cross-frame-and-temporal-qa.md) | `core/temporalQA.ts` | 整框/增量传播、四类时序检测、健康分 |
| [⑩ 相机导演：关键帧运镜与录制](docs/10-camera-cinematography.md) | `core/cameraTrajectory.ts` / `viewer/PointCloudViewer.ts` | 双时间线解耦、样条采样、MediaRecorder |
| [⑪ 4D 多任务与 VLA 改造方案](docs/11-4d-multitask-vla-upgrade-plan.md) | `src/domain/*` | 从画框工具到 4D 数据生产；P0/P1 内核、本地持久化与缓存回收、P2 预标注与复核、**P3 多任务（占据 / 光流 / 跨任务一致性）**、**P4 VLA（指令段 / 动作通道 / 对齐校验 / JSONL 互通）**已落地，文末附实现进度与偏差说明 |

另外两个可直接读源码的专题（无独立教程）：`core/io/formats/` 是 KITTI / DAIR-V2X / nuScenes / Waymo 的格式适配与坐标约定；`core/semantics.ts` 是 SemanticKITTI 官方类别表、learning_map（原始 34 类 → 训练 20 类）、`.label` 高低 16 位（语义 / 实例）的读写与统计。

读完 ①–⑥ 就掌握了单机标注的完整闭环。接下来的问题是：这东西离工业级还差多远、该怎么补。

---

## 4. 从学习到生产

### 4.1 差距：算法层追得上，系统层从零开始

按「系统 / 数据 / 质量 / 算法」四个维度看，本项目覆盖的是**单机标注闭环**，缺的是**组织级协作与数据治理**：

| 维度 | 生产级需要 | 本项目现状 |
|---|---|---|
| 存储 | PB 级原始数据放对象存储，元数据进关系库 | 单机 `public/data/`，几十 MB |
| 任务流转 | 任务切片、分派、回收，状态机驱动 | 无，一帧一帧手工打开；多选导入已按文件名自然排序组成时序 |
| 版本管理 | 标注多版本、回滚、审计日志 | **本地草稿已做**（IndexedDB 自动保存 + 刷新恢复 + 离开拦截），缺服务端多版本 / 回滚 / 审计日志 |
| 权限协作 | 标注员 / 质检员 / 管理员分权 | 无，单用户 |
| 质检流程 | 抽检、返修、通过率统计 | **指标有了**（IoU / kappa / 漏误标率），**流程没有** |
| 任务类型 | 3D 框 + 分割 + 车道线 + 关键点 + 可行驶区域 | 3D 框 + **逐点语义分割**（导入 / 着色 / 持久化）+ **占据 / 光流**（由框派生、可抽检修正）+ **VLA 指令—动作对齐**；车道线**只有校验与存储、没有编辑器**（`lane` 任务 `editor: ''`），关键点 / 可行驶区域仍未覆盖 |
| 预标注 | CenterPoint / PointPillars 等模型产出候选框 | **消费端已就绪**（Provider 协议 + 三种适配器 + 合并 + 复核队列 + 导出闸门）；缺真实模型服务，演示用确定性 mock |
| 多任务一致性 | 跨任务约束自动发现"框和占据对不上" | **I1 框内占据率 / I2 框内类别 / I3 语义实例映射**已实现；I4 光流刚体误差 / I5 车道线在可行驶区域内留到规则引擎 |
| 跟踪 | 马氏距离 + JPDA / 多假设 + 轨迹优化 | Kalman + Hungarian 已实现，但只用 2D 常速度 + 欧氏距离 |

难点不在单点算法，而在**让几百人并发标注还不乱**。

### 4.2 演进路线：每一步都能独立交付价值

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 标注体验 | 性能（体素 + LOD + 脏标记）、撤销重做、轨迹插值、**CVAT 式两步画框 + 角点/旋转/高度手柄 + 对象锁定隐藏 + 多帧导入 + 整段序列导出** | 已完成 |
| 2 多传感器 | 相机投影已完成；预标注**消费端**已打通（mock / HTTP / 离线三种来源 + 复核队列），只差接真实 CenterPoint 服务；待补 radar / 多相机融合与按位置选最佳视角 | 部分完成 |
| 3 工程化 | 后端入库与任务分发、角色权限、结果版本化 + 审计日志、服务端并发快照 | 未开始 |
| 4 质量闭环 | 抽检 → 打回带原因码 → 返修 → 通过率统计；多人一致性复用现有 kappa / IoU；对接训练管线形成数据飞轮 | 未开始 |

阶段 1 已交付的部分直接对标 CVAT 3D：工具条（选择 / 平移 / 画框）、`1`–`9` 切类别、`Ctrl+C/V/D` 复制粘贴与克隆、`H` 隐藏、`L` 锁定、`N` 进画框模式并自动最大化 Top 视图、双击正交视图最大化、`Shift` 吸附旋转。剩余体验类欠账是**多框框选批量移动**和**跨帧框选复制**，这两项在单机场景下优先级低于阶段 2 的预标注。

阶段 3 的并发思路，是把本地 history 栈换成服务端的**版本化快照**：提交携带 baseVersion，冲突时把两人差异交给仲裁。

### 4.3 想读工业实现，从这里入手

本项目刻意做了简化。要对照真实实现，直接读 [SUSTechPOINTS](https://github.com/sustech-isus/SUSTechPOINTS)：自动拟合在 `algos/rotation.py` 与 `algos/trajectory.py`，鼠标画框与自动调整在 `public/js/mouse.js`、`auto-adjust.js`，框编辑在 `box_op.js`、`side_view_op.js`，标定投影在 `calib.js`、`image.js`，保存逻辑在 `save.js`，数据管理在 `data.js`、`scene_reader.py`。

原仓库 96% 是 JavaScript，架构朴素但干货都在；有了本项目的算法基础再去读，会顺畅很多。

---

## 5. 项目结构

```
src/
├── core/                 # 纯数据层，不依赖任何 UI / 渲染（按职责分子目录）
│   ├── types.ts          # 类型定义 + 坐标系约定
│   ├── sample.ts         # 程序化演示点云（含语义演示场景）
│   ├── semantics.ts      # 逐点语义：类别表 / 统计 / 配色 / .label 读写
│   ├── history.ts        # 撤销重做：命令模式 + 状态快照
│   ├── io/               # pcd.ts（PCD 解析）· label.ts（单帧/整段序列化）· calibration.ts（投影）
│   │                     # session.ts（IndexedDB 草稿）
│   │   └── formats/      # 外部格式适配：conventions.ts（坐标/角度）· kitti.ts（含 DAIR-V2X）
│   │                     # nuscenes.ts · waymo.ts · sustech.ts · index.ts（嗅探入口）
│   ├── geometry/         # box.ts（OBB + 自动拟合 + PCA）· downsample.ts（体素下采样 + 距离 LOD）
│   ├── sequence/         # sequence.ts（多帧关联 + 轨迹插值）· temporalQA.ts（时序质检）· tracker.ts（Hungarian + Kalman）
│   ├── quality/          # quality.ts（IoU / 匹配 / kappa / 漏误标率）
│   └── camera/           # cameraTrajectory.ts（关键帧 + 样条采样 + JSON 序列化）
├── domain/               # 纯 TS 内核：不依赖 Vue / Three / 浏览器 API（scripts/check-layers.mjs 机器校验）
│   ├── model/            # document.ts（v2 文档）· track.ts · command.ts（可序列化命令）· scene.ts · issue.ts
│   │                     # vla.ts（指令段 / 动作通道 / 对齐 / 符号约定）
│   │                     # task.ts（任务注册表：校验 / 派生 / 序列化 / 体积 / 进度）
│   ├── derive/           # occupancy.ts（占据：网格数学 / box carving / 地面 / RLE / 打包）
│   │                     # flow.ts（刚体流 / 自车运动估计 / 箭头采样）
│   ├── vla/              # rules.ts（11 条对齐校验）· demo.ts（确定性合成）· resample.ts（重采样与统计）
│   ├── qa/               # crossTask.ts（I1 框内占据率 / I2 类别 / I3 语义映射）
│   ├── store/            # trackStore · applyCommand · commandHistory · editSession · materialize
│   │                     # blobRefs（引用抽取）· restorePlan（doc-first 恢复计划）· tabLease（跨标签页判定）
│   │                     # library（样本列表判定）· frameBudget（帧缓存淘汰计划：LRU / LFU / 跨数据集）
│   ├── ops/              # trackOps（生命周期 / 拆分 / 裁剪）· interpolate（插值）· smooth（RTS 平滑）
│   │                     # mergePreLabel（预标注身份关联 + 四种合并策略）· review（复核队列 / 裁决 / 导出闸门）
│   │                     # taskPayload（setTaskPayload 命令构造：描述对象 / 主引用 / 深拷贝）
│   │                     # vlaEdit（指令区间 / 文本 / 对齐 / 符号约定的纯函数）
│   └── io/               # legacyDocument（v1 快照 → v2 文档迁移）· vlaJsonl（VLA 的 JSONL 导入导出）
├── ports/                # 端口：dataSource / documentStore / blobStore / preAnnotation（流式预标注协议）
├── adapters/             # 适配器：IndexedDB 文档与 blob 存储 · PCD worker 池（优先级队列）· 帧加载
│                         # blobGc / studioGc（清扫）· gcAudit（审计）· tabBus（跨标签页租约与广播）
│                         # blobKeys（键规范）· frameCloudStore（帧缓存 + 使用时间）
│                         # occupancyStore（占据帧的 payload 存取）
│                         # preAnnotate/：mockProvider（确定性）· httpProvider（NDJSON）· fileProvider（离线结果）· parse
├── state/                # 状态层：core 持有共享状态，九个业务模块各自管一摊，useStudio 只做装配
│   ├── studioCore.ts     # 共享 ref / 历史栈 / 工具与外观 / 锁定隐藏 / 渲染同步
│   ├── useAnnotation.ts  # 建框、直接操作、撤销重做、复制粘贴、导入导出、快捷键
│   ├── useDataset.ts     # 演示 / 真实数据 / 多帧 PCD 导入 / 草稿恢复
│   ├── useSequence.ts    # 帧切换、回放、轨迹插值、跨帧传播、时序质检
│   ├── useQuality.ts     # 质检报告、关联演示、百万点压测
│   ├── useCameraDirector.ts # 关键帧、运镜播放、WebM 录制
│   ├── useLibrary.ts     # 本地样本列表：读列表 / 删除判定 / 二次确认 / 删后收尾
│   ├── usePreAnnotation.ts # 预标注：跑 Provider / 合并 / 复核队列 / 裁决 / 复核态快捷键
│   ├── useTasks.ts       # 多任务：占据派生 / 渲染层缓存 / ROI 单格 / 自车运动 / 一致性 / 导出
│   ├── useVla.ts         # VLA：指令编辑 / 对齐偏移 / 合成与导入导出 / 校验分组
│   ├── useStudio.ts      # 装配层：viewer、事件、URL 路由、自动保存、生命周期
│   └── studioContext.ts  # provide/inject 注入键
├── viewer/               # Three.js 渲染层（单一 3D 视口 + 按需渲染 + 射线拾取）
│   └── PointCloudViewer.ts
├── components/           # UI 组件层（壳体对齐 CVAT）
│   ├── TopBar.vue        # 文件菜单 / 撤销重做 / 帧导航 / 保存状态
│   ├── ToolRail.vue      # 左侧图标工具条（选择 / 平移 / 画框 / 缩放 / 视图）
│   ├── Stage.vue         # 3D 视口 + 三联正交条 + 相机分屏 + 视图切换
│   ├── OrthoView.vue     # Top/Side/Front 2D 投影、手柄拖拽、滚轮缩放
│   ├── RightPanel.vue    # 对象 / 标签 / 任务 / VLA / 更多
│   ├── Timeline.vue      # 底部时间线：轨迹条 / 关键帧 / 指令条 / 通道曲线 / 当前帧游标
│   ├── StatusBar.vue     # 状态栏：坐标读数 / 提示 / 只读与保存状态
│   ├── HelpModal.vue     # 快捷键与工作流
│   ├── SampleList.vue    # 本地样本列表弹层（浏览 / 删除落盘文档）
│   ├── ReviewQueue.vue   # 预标注复核队列（统计 / 策略 / 逐条裁决 / 快捷键说明）
│   ├── CameraView.vue    # 相机图像 + 投影框
│   └── panels/           # ObjectPanel · CategoryPanel · PropertyPanel · DataPanel
│                         # SequencePanel · CameraDirectorPanel · PerformancePanel · QualityPanel
│                         # TaskPanel（多任务：进度 / 占据 / 光流 / 一致性）
│                         # VlaPanel（VLA：指令段 / 动作通道 / 对齐校验 / JSONL）
├── styles/               # 按职责拆分的样式
│   ├── index.css         # 汇总入口
│   ├── base.css          # 变量 / 重置 / 基础控件
│   ├── layout.css        # 壳体布局 / 顶栏 / 工具条 / 正交视图 / 右侧面板
│   ├── annotation.css    # 对象卡片 / 标签 / 属性 / 外观 / 时序控件
│   └── feature.css       # 相机导演 / 录制 / 质检面板
├── App.vue               # 顶层装配
├── main.ts
docs/                     # 学习文档（见上方路线）
```

> 文档中的 `core/xxx.ts` 路径为模块简写，实际文件按上表位于对应子目录（例如 `core/box.ts` → `core/geometry/box.ts`）。

数据流非常清晰，值得反复体会：

```
PCD 文件/示例  ──parsePCD──▶  PointCloud(positions)
                                   │
                                   ▼
                    Top 视图拖矩形 → Box3D(默认高度)
                                   │
                                   ▼
                    Side 拖绿点调高 → mutate() → 快照入历史
                                   │
                                   ▼
                    IndexedDB 自动保存 / 导出 label JSON
```

---

## 6. 操作说明

### 6.1 界面分区

| 区域 | 内容 |
|---|---|
| 顶栏 | 左：数据集菜单；中：撤销/重做 + 帧导航（`|◀ ◀ 滑块 ▶ ▶|`、可直接输入帧号、`▣` 跳到上一处/下一处标注）；右：草稿保存状态、相机分屏、帮助 |
| 左工具条 | 选择 `V` / 平移 `H` / 画框 `N` / 放大缩小 / 适应数据 / 复位 / 正交条开关 |
| 主视口 | 3D 透视。单击框选中，拖拽旋转/平移，双击复位 |
| 三联视图 | Top / Side / Front。双击任一视图最大化，顶部出现 Top/Side/Front 切换 |
| 右侧面板 | 对象（锁定/隐藏/排序 + 详情 + 外观）、标签（增删类别/改色）、任务（多任务进度与派生）、VLA（指令段与动作通道）、更多（数据集/时序/质检/运镜/性能） |

### 6.2 标注流程（CVAT 两步法）

1. 按 `N`（或点工具条 ▭），Top 视图自动最大化。
2. 在点云上拖一个矩形 → 立即生成带默认高度的 3D 框，并自动选中。
3. 拖角点改长宽、拖黄点改朝向（`Shift` 吸附 15°）；切到 `Side` 拖绿色圆点调高度。
4. 右侧「详情」可精确输入 x/y/z/长/宽/高/朝向；数字键 `1-9` 把选中对象改成第 N 个类别。
5. 也可按 `N` 后在 Top 画完，回到 3D 视口用 `W/A/S/D`、`Q/E`、`R/F` 微调。
6. 序列场景：标好一帧后按 `Ctrl+B` 把选中框铺到后续所有帧（同 id 即同一条轨迹），再用 `Shift+.` / `Shift+,` 逐处检查微调。

### 6.3 常用快捷键

| 操作 | 快捷键 |
|---|---|
| 选择 / 平移 / 画框 | `V` / `H` / `N` |
| 追加选中 / 取消一个 | `Ctrl` + 单击（画布或对象列表都行） |
| 框选一批 | 选择工具下在空白处拖拽（橡皮筋） |
| 全选 / 取消选中 | `Ctrl+A` / `Esc` |
| 跨帧复制 | `Ctrl+B`（把选中框铺到后续所有帧） |
| 上一个 / 下一个对象 | `Shift+Tab` / `Tab` |
| 改选中对象的类别 | `1` – `9`（无选中时只改"下一个新框"的默认类别） |
| 微调位置 | 方向键（`Shift` 加速 5 倍），`PgUp` / `PgDn` 调高度 |
| 复制 / 粘贴 / 原地复制 | `Ctrl+C` / `Ctrl+V` / `Ctrl+D`（均支持多选） |
| 撤销 / 重做 | `Ctrl+Z` / `Ctrl+Shift+Z` |
| 导出当前帧 / 整段序列 | `Ctrl+S` / `Ctrl+Shift+S` |
| 上一帧 / 下一帧 | `,` / `.` |
| 上一处 / 下一处标注 | `Shift+,` / `Shift+.`（跳过空帧） |
| 删除 | `Delete` / `Backspace`（锁定的自动跳过） |
| 帮助 | `F1` |

多选时画布上**主选中描黄边、次选中描白边**，锁定的框描灰边并在框体上方画一把小锁，且不显示角点手柄（4 个角点 × N 个框会糊成一片）；拖动任一已选成员即整组平移，撤销栈里合并为一步。

### 6.4 其他

- **多帧时序**：右侧「更多 → 时序与 4D」，可逐帧切换、轨迹叠加、回放、插值补全、跨帧传播、时序质检。
- **相机导演与录制**：右侧「更多 → 相机导演与录制」，关键帧运镜与 WebM 录制（Chrome / Edge）。
- **性能压测 / 质检报告**：右侧「更多」，分别看体素下采样 + LOD 的实测 FPS、IoU / kappa 指标。
- **本地草稿**：改动后约 1.2 秒自动写入 IndexedDB，刷新自动恢复；顶栏右侧显示「未保存 / 保存中 / 已保存 hh:mm」。
  恢复优先读 v2 文档（标注真值），点云来自快照或逐帧缓存：懒加载数据集只把「封面帧 + 当前帧」
  的点云写进快照，其余切帧时回读，所以 500 帧序列的草稿也只有几 MB。
  只有在点云无法回读（演示数据、落盘失败）时才退回全量内联，此时超过 80MB 会跳过自动保存并提示手动导出。
- **删旧样本**：菜单 →「本地样本列表…」。删除只清文档（标注真值），帧缓存与没人引用的载荷由随后的清扫回收；
  当前这份要用「清除当前样本草稿」，那条路会连帧缓存一起清。
- **两个标签页**：同一样本只允许一个标签页编辑。第二个标签页打开后是可读的（状态栏有橙色「只读 · 接管」），
  点击即接管；原标签页收到广播后立刻转只读，不会两边互相覆盖。刷新不会丢写权。
  清理缓存前会先问一圈其它标签页，它们正在用的载荷与帧缓存不会被当成垃圾。
- **预标注与复核**：菜单 →「预标注」→「跑演示模型（确定性）」会生成 4 条待复核轨迹（灰色虚线 + 置信度角标），
  并自动打开复核队列。`A` 接受 / `X` 拒绝 / `Shift+A` 接受当前帧 / `Tab` 下一处（**仅在面板打开时生效**，
  关掉后 `A` 仍是平移）。待复核与已拒绝的框**不进导出**；人工标注永远导出。
  也可以「导入预标注结果 JSON…」吃别的工具的结果（认本项目导出格式、裸数组、SUSTechPOINTS 三种写法）。
  合并策略（全部待复核 / 只补空帧 / 命中替换 / 投票改类别）在队列顶部切换，只影响下一次合并。
- **多任务（占据 / 光流 / 一致性）**：右侧「任务」页，或菜单 →「多任务」。
  「生成全段」把当前轨迹按 200×200×16 @0.4m 的网格刻成占据（有地面点就先剪掉框底以下的体素 ——
  地面**不**写成占格，占据训练里地面是 free），每帧 RLE 后按内容哈希落 BlobStore，改一格就换一个引用、撤销即切回旧引用。
  勾「显示占据层」后可用高度切片看内部结构；鼠标停在点云上取坐标，再点「补一格 / 删一格」做单格修正。
  「估计自车运动」用两帧地面带做粗到细的刚体搜索，落盘 `dx, dy, dyaw, rmse`（残差 > 0.2m 会提示仅参考）；
  「箭头」画的是上一帧框内点 → 刚体预测位置。生成完点「校验本帧 / 校验前 24 帧」跑 I1/I2/I3，
  问题行点一下跳到该帧。导出得到 `.occ` + `spec.json`，训练侧用
  `python3 scripts/occ2npz.py xxx-occupancy.occ -o xxx.npz` 转成 CSR 稀疏张量（`--dense` 出稠密体素）。
- **VLA（语言—动作对齐）**：右侧「VLA」页。点「生成演示」会铺 5 段指令（`keep-lane / turn-left /
  go-straight / lane-change-right / stop`）配 4 条动作通道（`speed / steer / throttle / brake`），
  默认是干净样本 —— 想验证规则就展开「注入演示错误」勾 `gap / overlap / sign / lag / textEmpty / channelLength`，
  再点一次「生成演示」，红字才该出现。时间线此时多出两行：第二行是**指令条**（拖两端改区间，松手才提交，
  一次拖拽在撤销栈里是一步），第三行是**通道曲线**（各自归一到 0–1，黄色竖线是当前帧）。
  点指令条跳到它的起始帧，「确认 / 拒绝」只改复核态不改来源，待确认的**不进导出**。
  「符号约定」记的是本项目 steer 正负与左右转的对应关系（换一套数据就得改），
  `VLA_ACTION_SIGN` 靠它跨模态检查；扫不出问题而帧率又低时看 `VLA_ACTION_SMOOTH` 的 info
  —— 二阶差分作抖动代理必须和采样率一起看，低于 8Hz 不敢下结论。
  「导出 JSONL」得到每行一条样本的对外格式（snake_case、`{steer:[...]}` 这种对象写法也支持导入）；
  想验证导出没写错，用不带任何依赖的独立脚本回读一遍：
  `python3 scripts/vla_check.py xxx-vla.jsonl` （有问题退出码 1，读不动 2）。
- **导入自己的数据**：右上菜单「导入 PCD（可多选组成时序）」；同时选中同名 JSON 会自动读取标注。
- **导出**：单帧是 SUSTechPOINTS 兼容数组；整段序列是 `{ format, frames:[{ index, objects }] }`，脚本可逐帧拆开。
  「插值补帧」按文档范围把中间帧补齐；「RTS 平滑」在此基础上用后向平滑去掉轨迹抖动
  （人工标注的帧不动，抖动超过 0.3m 的轨迹会被跳过并在状态栏点名）。
- **读坐标**：鼠标停在任一正交视图上，状态栏右侧显示该处点云的 x/y/z；每个视图左下角有比例尺，用来判断网格一格的跨度。
- **认对象**：把鼠标移到框上（3D 视口、任一正交视图、相机投影图都行），其余视图一起亮起来，框顶贴出「4.5 × 1.9 × 1.6 m · 12°」这样的尺寸摘要，状态栏同时给出对象名与 id——24 个框挤在一起时不用点下去试。三联条里场景常有几百米宽，框只有一两个像素时按框心 5px 内也算命中。
- **比比例**：默认每个视图各自适应数据，长宽比悬殊的数据上显得扁平。既要看清细节又要横向比较尺寸时，在「外观」里勾上「三视图联动缩放」，三个视图就共享同一个米/像素；再勾上「三视图联动平移」，你在一个视图里挪到哪，另外两个也跟到同一个世界位置。


---

## 7. 坐标系约定（务必先记住）

```
        z (上)
        │
        │
        └────── y (左)
       ╱
      ╱
     x (前)
```

- 与 KITTI / SUSTechPOINTS 一致：**x 前、y 左、z 上**（右手系）。
- Three.js 默认是 y-up，所以代码里所有相机都显式 `camera.up.set(0,0,1)`。
- 框的 `yaw` 是绕 z 轴的旋转角（弧度）。这一点贯穿全部代码。

---

## 8. 真实数据说明

`public/data/` 里是从 [SUSTechPOINTS 官方样例](https://github.com/sustech-isus/SUSTechPOINTS/tree/master/data/example) 下载的真实数据（帧 `000970`）：

| 文件 | 内容 | 学习价值 |
|---|---|---|
| `000970.pcd` | 66,899 点的真实 LiDAR 扫描，binary 编码，含 x/y/z/intensity/ring 等多字段 | 检验 PCD 解析器对复杂字段的处理；观察真实的扫描线结构 |
| `000970.json` | 24 个 3D 框标注（Car/Rider/Pedestrian...） | 对照学习 label JSON 格式，看看真实标注长什么样 |
| `calib_front.json` | 前视相机外参(4×4)+内参(3×3)，可加可选 `distortion` 字段 | 配合 docs/06 学习相机投影与畸变校正 |
| `front_000970.jpg` | 对应帧的前视相机图像 | 进阶：可做 3D 框到图像的投影验证 |

这份数据的 PCD 头部字段是 `FIELDS x y z _ intensity _ timestamp _ ring _`，带多个 `COUNT>1` 的填充字段——我们的解析器靠 `fields.indexOf()` 计算字段偏移，能正确跳过这些填充，是很好的健壮性验证案例。

> 许可证说明：上述样例数据来自 SUSTechPOINTS（GPL-3.0），仅作学习演示，按其协议使用；其余代码与文档的授权见下方「许可证」。

---

## 9. 许可证

本项目采用 [MIT License](LICENSE)：可自由使用、修改、分发，保留版权与许可声明即可。

需要注意一类**非 MIT** 的内容，细节见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)：

| 内容 | 授权 | 说明 |
|---|---|---|
| `public/data/` 下的 SUSTechPOINTS 样例（`000970.pcd` / `000970.json` / `calib_front.json` / `front_000970.jpg`） | GPL-3.0 | 随原仓库分发，仅作学习演示；如需纯 MIT 副本，删除这四个文件即可 |

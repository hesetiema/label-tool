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

想看**真实数据**？点顶部绿色的 **「◉ 真实数据」** 按钮，即可一键加载 SUSTechPOINTS 官方样例：**66,899 个真实激光雷达点 + 24 个标注框**，能看到 LiDAR 特有的同心圆扫描线、真实车辆/行人点云。加载后自动进入**分屏模式**：左边点云、右边前视相机图，并把 3D 框投影到图像上（约 10 个框在前视可见），直观验证多传感器对齐。也可直接访问 `http://127.0.0.1:5173/?data=real` 直达。

左侧"标注" Tab 下的"视图"栏可在 **点云 / 分屏 / 相机** 三种布局间切换（相机布局需先加载真实数据）。侧栏顶部有三个 Tab：**标注 / 时序 / 演示与质检**，相关功能已按场景归组；URL 演示参数会自动切到对应 Tab。

三个直达链接，覆盖最值得先看的能力：

| 链接 | 演示内容 |
|---|---|
| `?data=real` | 真实数据 + 相机投影分屏 |
| `?data=sequence` | 5 帧时序序列：目标会移动，默认叠加显示跨帧轨迹线。点「轨迹插值补全」可补出 9 个中间帧框；点「回放」逐帧播放（白点=当前帧），加 `&autoplay=1` 进入即自动播放 |
| `?data=qa` | 质检演示：生成扰动版标注并自动出报告（IoU / kappa / 漏标率） |

其余能力都从面板进入，不占链接：**百万点压测**在「演示与质检」Tab，**贪心 vs Kalman+Hungarian 关联演示**在「时序」Tab 底部，**相机运镜与录制**在「演示与质检」→ 相机导演面板的「演示运镜」（见 [第 ⑩ 篇](docs/10-camera-cinematography.md)）。

```bash
pnpm build      # 类型检查 + 生产构建
pnpm typecheck  # 只做类型检查
pnpm test       # 核心算法自检（130 项断言，无需浏览器）
```

---

## 2. 能做什么（功能清单）

| 功能 | 说明 | 对照原仓库 |
|---|---|---|
| PCD 加载 | 支持 ascii / binary 两种 PCD，可导入自己的数据 | `PCDLoader` |
| 双视图渲染 | BEV 鸟瞰（主标注视图）+ 3D 透视（验证用） | `pcd_viewer.js` |
| 画 3D 框 | BEV 拖拽框选点云，自动拟合出 3D 框 | `mouse.js` + `auto-adjust.js` |
| 自动拟合 | 用 PCA 估计主方向 + 局部 min/max 拟合尺寸 | `algos/rotation.py` |
| 框编辑 | WASD 平移、Q/E 旋转、R/F 调长、属性面板精调 | `box_op.js` |
| 类别与 ID | 多类别配置、颜色区分、obj_id 自动生成 | `obj_cfg.js` |
| 导入导出 | 完全兼容 SUSTechPOINTS 的 label JSON 格式 | `save.js` |
| **相机投影** | 3D 框投影到前视相机图像，多传感器融合对照 | `calib.js` + `image.js` |
| **分屏视图** | 点云 / 分屏 / 相机 三种布局，框两边联动高亮 | — |
| **撤销重做** | 命令模式 + 状态快照，`Ctrl+Z` / `Ctrl+Shift+Z`；连续操作自动合并 | — |
| **多帧时序** | 5 帧演示序列、obj_id 跨帧保持一致、首末帧轨迹插值补全中间帧 | batch 模式 |
| **4D 轨迹叠加回放** | 同目标多帧中心点连成轨迹线（已走过段高亮），播放/暂停/调速逐帧回放，选中目标整条轨迹高亮 | — |
| **相机运镜** | 关键帧 + 转场/停留时间 + 样条/缓入缓出；镜头时间线与数据帧时间线相互独立，可保存/打开轨迹 JSON | rviz_cinematographer `CameraTrajectory` |
| **演示视频录制** | `canvas.captureStream` + `MediaRecorder` 导出 WebM，可选 fps、VP9/VP8、右下角水印 | rviz_cinematographer `Recorder` |
| **跨帧编辑** | 把选中框的改动传播到同 id 框：整框替换 / 增量平移 × 后续/前序/全部帧 | — |
| **时序质检** | ID 跳变、速度突变、轨迹抖动、轨迹断裂四类检测，健康分 + 问题列表可跳帧；一键注入缺陷演示 | 智能审核 |
| **遮挡状态机** | alive/occluded/dead 三态、Kalman coasting 预测续接、虚线渲染遮挡框、质检豁免遮挡缺口 | 4D 工具 |
| **全局最优关联** | Kalman 预测 + 门控 + Hungarian 匹配；交叉案例演示贪心如何串 ID | — |
| **性能优化** | 体素网格下采样 + 距离 LOD；实测 100 万点→27 万点、3.7× 压缩 | — |
| **质检与一致性** | BEV 旋转框 IoU、目标匹配、漏标/误标率、F1、Cohen's kappa；可叠加显示待评估框 | — |

---

## 3. 学习路线（按顺序读 docs/）

这个仓库既是可运行的工具，也是一套教程。①–⑥ 是从零到能用的主线，⑦–⑩ 是工程化与 4D 进阶：

| 文档 | 配套源码 | 一句话 |
|---|---|---|
| [① 坐标系与整体架构](docs/01-coordinates-and-architecture.md) | `core/types.ts` | z-up 约定、OBB 表示、数据分层 |
| [② 点云数据格式 PCD](docs/02-pcd-format.md) | `core/pcd.ts` | PCD 头结构、ascii / binary 解析 |
| [③ 3D 框与几何算法](docs/03-obb-and-fitting.md) | `core/box.ts` | 8 角点、PCA 主方向、自动拟合 |
| [④ Three.js 渲染原理](docs/04-threejs-rendering.md) | `viewer/PointCloudViewer.ts` | 正交/透视相机、双视口、屏幕反投影 |
| [⑤ 交互与序列化](docs/05-interaction-and-io.md) | `state/useAnnotation.ts` / `core/label.ts` | 拖拽画框、快捷键、label JSON 互通 |
| [⑥ 相机标定与投影](docs/06-calibration-and-projection.md) | `core/calibration.ts` | 3D 框投到图像、LiDAR 与相机对齐 |
| [⑦ 工程化能力](docs/07-engineering-p0.md) | `core/history.ts` / `sequence.ts` / `downsample.ts` | 快照 vs 差量、轨迹关联与插值、体素 + LOD 实测 |
| [⑧ 4D 轨迹叠加回放](docs/08-4d-trajectory-replay.md) | `core/sequence.ts` / `viewer/PointCloudViewer.ts` | 轨迹提取纯函数、轨迹线渲染、回放定时器 |
| [⑨ 4D 进阶：跨帧编辑与时序质检](docs/09-cross-frame-and-temporal-qa.md) | `core/temporalQA.ts` | 整框/增量传播、四类时序检测、健康分 |
| [⑩ 相机导演：关键帧运镜与录制](docs/10-camera-cinematography.md) | `core/cameraTrajectory.ts` / `viewer/PointCloudViewer.ts` | 双时间线解耦、样条采样、MediaRecorder |

读完 ①–⑥ 就掌握了单机标注的完整闭环。接下来的问题是：这东西离工业级还差多远、该怎么补。

---

## 4. 从学习到生产

### 4.1 差距：算法层追得上，系统层从零开始

按「系统 / 数据 / 质量 / 算法」四个维度看，本项目覆盖的是**单机标注闭环**，缺的是**组织级协作与数据治理**：

| 维度 | 生产级需要 | 本项目现状 |
|---|---|---|
| 存储 | PB 级原始数据放对象存储，元数据进关系库 | 单机 `public/data/`，几十 MB |
| 任务流转 | 任务切片、分派、回收，状态机驱动 | 无，一帧一帧手工打开 |
| 版本管理 | 标注多版本、回滚、审计日志 | 无，导出即覆盖 |
| 权限协作 | 标注员 / 质检员 / 管理员分权 | 无，单用户 |
| 质检流程 | 抽检、返修、通过率统计 | **指标有了**（IoU / kappa / 漏误标率），**流程没有** |
| 任务类型 | 3D 框 + 分割 + 车道线 + 关键点 + 可行驶区域 | 只有 3D 框 |
| 预标注 | CenterPoint / PointPillars 等模型产出候选框 | PCA 传统拟合，无深度学习 |
| 跟踪 | 马氏距离 + JPDA / 多假设 + 轨迹优化 | Kalman + Hungarian 已实现，但只用 2D 常速度 + 欧氏距离 |

难点不在单点算法，而在**让几百人并发标注还不乱**。

### 4.2 演进路线：每一步都能独立交付价值

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 标注体验 | 性能（体素 + LOD）、撤销重做、轨迹插值；待补拖拽微调、多框批量、跨帧复制粘贴 | 大部分完成 |
| 2 多传感器 | 相机投影已完成；待补 radar / 多相机融合与按位置选最佳视角；接入 CenterPoint 预标注，人工只做校正——效率提升最大的一步 | 部分完成 |
| 3 工程化 | 后端入库与任务分发、角色权限、结果版本化 + 审计日志、服务端并发快照 | 未开始 |
| 4 质量闭环 | 抽检 → 打回带原因码 → 返修 → 通过率统计；多人一致性复用现有 kappa / IoU；对接训练管线形成数据飞轮 | 未开始 |

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
│   ├── sample.ts         # 程序化演示点云
│   ├── history.ts        # 撤销重做：命令模式 + 状态快照
│   ├── io/               # pcd.ts（PCD 解析）· label.ts（SUSTechPOINTS 序列化）· calibration.ts（3D框→像素投影）
│   ├── geometry/         # box.ts（OBB + 自动拟合 + PCA）· downsample.ts（体素下采样 + 距离 LOD）
│   ├── sequence/         # sequence.ts（多帧关联 + 轨迹插值）· temporalQA.ts（时序质检）· tracker.ts（Hungarian + Kalman）
│   ├── quality/          # quality.ts（IoU / 匹配 / kappa / 漏误标率）
│   └── camera/           # cameraTrajectory.ts（关键帧 + 样条采样 + JSON 序列化）
├── state/                # 状态层：core 持有共享状态，五个模块各自管一摊业务，useStudio 只做装配
│   ├── studioCore.ts     # 共享 ref / 历史栈 / viewer 句柄 / 渲染同步（其余模块的唯一依赖）
│   ├── useAnnotation.ts  # BEV 画框、框编辑、撤销重做、标注导入导出、快捷键
│   ├── useDataset.ts     # 演示 / 真实数据加载、PCD 导入
│   ├── useSequence.ts    # 帧切换、回放、轨迹插值、跨帧传播、时序质检
│   ├── useQuality.ts     # 质检报告、关联演示、百万点压测
│   ├── useCameraDirector.ts # 关键帧、运镜播放、WebM 录制
│   ├── useStudio.ts      # 装配层：创建 viewer、绑定事件、URL 路由、生命周期
│   └── studioContext.ts  # provide/inject 注入键
├── viewer/               # Three.js 渲染层
│   └── PointCloudViewer.ts
├── components/           # UI 组件层
│   ├── TopBar.vue / Stage.vue / HelpPanel.vue / StatusBar.vue
│   ├── CameraView.vue    # 相机图像视图 + 投影框叠加
│   └── panels/           # ViewPanel · CategoryPanel · ObjectPanel · PropertyPanel · DataPanel
│                         # SequencePanel · CameraDirectorPanel · PerformancePanel · QualityPanel
├── styles/               # 按职责拆分的样式
│   ├── index.css         # 汇总入口
│   ├── base.css          # 变量 / 重置 / 基础控件
│   ├── layout.css        # 三栏布局 / 顶栏 / 侧栏 Tab / 主视口 / 状态栏
│   ├── annotation.css    # 标注面板
│   └── feature.css       # 相机导演 / 录制 / 各类质检面板
├── App.vue               # 界面骨架：装配顶层组件 + 侧栏三 Tab（标注 / 时序 / 演示与质检）
├── main.ts
docs/                     # 学习文档（见上方路线）
```

> 文档中的 `core/xxx.ts` 路径为模块简写，实际文件按上表位于对应子目录（例如 `core/box.ts` → `core/geometry/box.ts`）。

数据流非常清晰，值得反复体会：

```
PCD 文件/示例  ──parsePCD──▶  PointCloud(positions)
                                   │
                    ┌──────────────┴──────────────┐
                    ▼                             ▼
          setPointCloud() 渲染          拖拽框选 → fitBoxToPoints()
                                                  │
                                                  ▼
                                            Box3D[]  ──serialize──▶ label JSON
```

---

## 6. 操作说明

- **BEV 视图**（默认）：在点云上按住左键拖一个矩形，工具会用 PCA 估计朝向并自动拟合出一个贴合的 3D 框；单击框选中。
- **切换到 3D 透视**：验证框的高度和朝向是否贴准（左键旋转、右键平移、滚轮缩放）。
- **编辑选中框**：`W/A/S/D` 平移、`Q/E` 旋转、`R/F` 调长度，按住 `Shift` 加大步长；也可在左侧属性面板精确输入。
- **删除**：`Delete` / `Backspace`。
- **撤销/重做**：`Ctrl+Z` / `Ctrl+Shift+Z`（或 `Ctrl+Y`）。所有编辑（画框、删除、快捷键、属性面板）都可撤销；连续拖动滑杆合并为一次撤销。
- **多帧时序**：切到「时序」Tab，点「加载 5 帧序列」（在「标注」Tab 底部），用时间轴切帧；点「轨迹插值补全」看首末帧标注如何自动补全中间帧。
- **相机导演**：切到「演示与质检」Tab；点「演示运镜」一键生成 4 个镜头关键帧（也可先回「标注」Tab 切到「3D 透视」摆好视角，再点「＋ 记录当前视角」逐帧追加）；设置每段的转场/停留时间后点「▶ 播放运镜」。镜头运动与数据帧回放独立计时，轨迹可保存/打开。
- **录制演示视频**：在「演示与质检」Tab 的「相机导演」面板里选 fps / 编码 / 水印，点「● 录制视频」自动播放一圈运镜并导出 WebM；再点一次可提前结束（需 Chrome / Edge）。
- **性能压测 / 质检报告**：都在「演示与质检」Tab；点「⚡ 生成 100 万点压测」看体素下采样 + LOD 的实测 FPS，点「✓ 生成质检报告」看 IoU / kappa 等指标。
- **导出**：点"导出 JSON"或 `Ctrl+S`，得到可直接被 SUSTechPOINTS 读取的标注文件。

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
| `calib_front.json` | 前视相机外参(4×4)+内参(3×3) | 配合 docs/06 学习相机投影 |
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

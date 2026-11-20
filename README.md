# Point Cloud Label Studio

一个**面向学习的 3D 点云标注工具**：用 Vue 3 + TypeScript + Three.js 从零实现自动驾驶标注的核心闭环，参考 [SUSTechPOINTS](https://github.com/sustech-isus/SUSTechPOINTS) 的设计思想。

> 目标不是做一个生产级标注平台，而是**让你通过动手，真正搞懂这个领域**：点云怎么存、3D 框怎么表示、自动拟合怎么做、数据怎么和算法对接。

---

## 1. 快速开始

```bash
npm install
npm run dev        # 打开 http://127.0.0.1:5173
```

打开后会**自动加载一个程序化生成的演示场景**（地面 + 车道线 + 车辆/行人点云），无需任何外部数据即可体验完整流程。

想看**真实数据**？点顶部绿色的 **「◉ 真实数据」** 按钮，即可一键加载 SUSTechPOINTS 官方样例：**66,899 个真实激光雷达点 + 24 个标注框**，能看到 LiDAR 特有的同心圆扫描线、真实车辆/行人点云。加载后自动进入**分屏模式**：左边点云、右边前视相机图，并把 3D 框投影到图像上（约 10 个框在前视可见），直观验证多传感器对齐。也可直接访问 `http://127.0.0.1:5173/?data=real` 直达。

左侧"视图"栏可在 **点云 / 分屏 / 相机** 三种布局间切换（相机布局需先加载真实数据）。

另外三个直达链接，分别演示面试导向的 P0 能力：

| 链接 | 演示内容 |
|---|---|
| `?data=sequence` | 5 帧时序序列：目标会移动，3 条轨迹只标了首末帧。点「轨迹插值补全」可自动补出 9 个中间帧框 |
| `?data=perf` | 百万点性能压测：生成 100 万点 → 体素下采样 → 距离 LOD → 实测 FPS |
| `?data=qa` | 质检演示：生成扰动版标注并自动出报告（IoU / kappa / 漏标率） |
| `?data=track` | 关联演示：贪心串 ID vs Kalman+Hungarian 正确保持的交叉案例 |
| `?data=real` | 真实数据 + 相机投影分屏 |
| `?data=nuscenes` | nuScenes mini 真实序列：多帧激光雷达 + 官方 3D 标注 + 相机投影（需先转换数据，见 [第 10 节](docs/10-nuscenes-dataset.md)） |

```bash
npm run build      # 类型检查 + 生产构建
npm run typecheck  # 只做类型检查
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
| **全局最优关联** | Kalman 预测 + 门控 + Hungarian 匹配；交叉案例演示贪心如何串 ID | — |
| **性能优化** | 体素网格下采样 + 距离 LOD；实测 100 万点→27 万点、3.7× 压缩 | — |
| **质检与一致性** | BEV 旋转框 IoU、目标匹配、漏标/误标率、F1、Cohen's kappa；可叠加显示待评估框 | — |

---

## 3. 学习路线（按顺序读 docs/）

这个仓库既是可运行的工具，也是一套教程。建议按下面的顺序，边跑边读源码：

| 顺序 | 文档 | 配套源码 | 你将学到 |
|---|---|---|---|
| ① | [坐标系与整体架构](docs/01-coordinates-and-architecture.md) | `core/types.ts` | 为什么 z-up、OBB 是什么、数据如何分层 |
| ② | [点云数据格式 PCD](docs/02-pcd-format.md) | `core/pcd.ts` | PCD 头结构、ascii/binary 解析 |
| ③ | [3D 框与几何算法](docs/03-obb-and-fitting.md) | `core/box.ts` | 8 角点、自动拟合、PCA 主方向 |
| ④ | [Three.js 渲染原理](docs/04-threejs-rendering.md) | `viewer/PointCloudViewer.ts` | 正交/透视相机、双视口、屏幕坐标反投影 |
| ⑤ | [交互与序列化](docs/05-interaction-and-io.md) | `App.vue` / `core/label.ts` | 拖拽画框、快捷键、label JSON 互通 |
| ⑥ | [相机标定与投影（进阶）](docs/06-calibration-and-projection.md) | — | 3D 框如何投到图像、LiDAR 与相机融合 |
| ⑦ | [从学习到生产](docs/07-from-learning-to-production.md) | — | 还缺什么、如何演进成工业级系统 |
| ⑧ | [工程化能力：撤销重做 / 时序 / 性能](docs/08-engineering-p0.md) | `core/history.ts` / `sequence.ts` / `downsample.ts` | 面试高频追问的三块，命令模式、轨迹插值、体素下采样 |
| ⑨ | [面试准备：系统设计题与项目话术](docs/09-interview-prep.md) | `core/quality.ts` | 云端标注平台四层框架、逐项"问题→选择→收益"话术、高频追问速查表 |
| ⑩ | [nuScenes 真实数据集接入](docs/10-nuscenes-dataset.md) | `scripts/convert_nuscenes.py` | 下载/转换真实数据、世界坐标→lidar、四元数→yaw、相机内外参计算 |

---

## 4. 项目结构

```
src/
├── core/                 # 纯数据层，不依赖任何 UI / 渲染
│   ├── types.ts          # 类型定义 + 坐标系约定
│   ├── pcd.ts            # PCD 解析器
│   ├── box.ts            # OBB 几何 + 自动拟合 + PCA
│   ├── label.ts          # 与 SUSTechPOINTS 兼容的序列化
│   ├── calibration.ts    # 相机标定：3D框投影到像素（外参/内参/透视除法）
│   ├── sample.ts         # 程序化演示点云
│   ├── history.ts        # 撤销重做：命令模式 + 状态快照
│   ├── sequence.ts       # 多帧时序：跟踪关联 + 轨迹插值
│   ├── downsample.ts     # 性能：体素下采样 + 距离 LOD
│   ├── quality.ts        # 质检：IoU / 目标匹配 / kappa / 漏误标率
│   └── tracker.ts        # 关联：Hungarian 全局匹配 + Kalman 运动预测
├── viewer/               # Three.js 渲染层
│   └── PointCloudViewer.ts
├── components/
│   └── CameraView.vue    # 相机图像视图 + 投影框叠加
├── App.vue               # 主界面 + 交互编排
├── main.ts
└── styles.css
docs/                     # 学习文档（见上方路线）
```

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

## 5. 操作说明

- **BEV 视图**（默认）：在点云上按住左键拖一个矩形，工具会用 PCA 估计朝向并自动拟合出一个贴合的 3D 框；单击框选中。
- **切换到 3D 透视**：验证框的高度和朝向是否贴准（左键旋转、右键平移、滚轮缩放）。
- **编辑选中框**：`W/A/S/D` 平移、`Q/E` 旋转、`R/F` 调长度，按住 `Shift` 加大步长；也可在左侧属性面板精确输入。
- **删除**：`Delete` / `Backspace`。
- **撤销/重做**：`Ctrl+Z` / `Ctrl+Shift+Z`（或 `Ctrl+Y`）。所有编辑（画框、删除、快捷键、属性面板）都可撤销；连续拖动滑杆合并为一次撤销。
- **多帧时序**：点「加载 5 帧序列」，用时间轴切帧；点「轨迹插值补全」看首末帧标注如何自动补全中间帧。
- **性能压测**：点「⚡ 生成 100 万点压测」，看体素下采样 + LOD 的实时效果与实测 FPS。
- **导出**：点"导出 JSON"或 `Ctrl+S`，得到可直接被 SUSTechPOINTS 读取的标注文件。

---

## 6. 坐标系约定（务必先记住）

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

## 7. 真实数据说明

`public/data/` 里是从 [SUSTechPOINTS 官方样例](https://github.com/sustech-isus/SUSTechPOINTS/tree/master/data/example) 下载的真实数据（帧 `000970`）：

| 文件 | 内容 | 学习价值 |
|---|---|---|
| `000970.pcd` | 66,899 点的真实 LiDAR 扫描，binary 编码，含 x/y/z/intensity/ring 等多字段 | 检验 PCD 解析器对复杂字段的处理；观察真实的扫描线结构 |
| `000970.json` | 24 个 3D 框标注（Car/Rider/Pedestrian...） | 对照学习 label JSON 格式，看看真实标注长什么样 |
| `calib_front.json` | 前视相机外参(4×4)+内参(3×3) | 配合 docs/06 学习相机投影 |
| `front_000970.jpg` | 对应帧的前视相机图像 | 进阶：可做 3D 框到图像的投影验证 |

这份数据的 PCD 头部字段是 `FIELDS x y z _ intensity _ timestamp _ ring _`，带多个 `COUNT>1` 的填充字段——我们的解析器靠 `fields.indexOf()` 计算字段偏移，能正确跳过这些填充，是很好的健壮性验证案例。

> 许可证说明：本项目为学习用途原创实现；SUSTechPOINTS 原仓库为 GPL-3.0，样例数据来自该仓库，使用时请遵守其协议。

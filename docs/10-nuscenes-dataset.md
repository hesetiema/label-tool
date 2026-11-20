# nuScenes mini 真实数据集接入

本目录说明如何把 [nuScenes](https://www.nuscenes.org/) 真实数据接入点云标注工具。
nuScenes 是 Motional 发布的大规模自动驾驶数据集：波士顿/新加坡两座城市、1000 段场景、
6 相机 + 1 激光雷达 + 5 毫米波雷达，23 类 3D 框标注。我们用的是 **mini 版**（10 段场景，
约 400 个关键帧），足够学习真实数据的加载、坐标变换与相机投影。

## 1. 下载

官方数据需注册登录（非商用免费）。这里用的是公开的 HF 镜像 `Kevinwjw/Uniscene_mini_dataset`：

```bash
mkdir -p datasets/nuscenes
curl -L -C - -o datasets/nuscenes/v1.0-mini.tgz \
  "https://hf-mirror.com/datasets/Kevinwjw/Uniscene_mini_dataset/resolve/main/v1.0-mini.tgz"
```

- 文件约 4.17 GB，支持断点续传（`-C -`）。
- 也可以注册后在 <https://www.nuscenes.org/nuscenes#download> 下载官方包。

解压后目录结构（转换器依赖这些 JSON 与 bin/jpg 文件）：

```
datasets/nuscenes/v1.0-mini/
├── samples/                       # 关键帧传感器数据
│   ├── LIDAR_TOP/*.pcd.bin        # 激光雷达点云（每个点 5 个 float32）
│   └── CAM_FRONT/*.jpg            # 前视相机图像
├── sweeps/                        # 中间帧（非关键帧）
└── v1.0-mini/
    ├── sample.json                # 采样帧索引
    ├── sample_data.json           # 每帧各传感器文件与位姿 token
    ├── sample_annotation.json     # 3D 框标注（类别/中心/尺寸/四元数）
    ├── calibrated_sensor.json     # 传感器内参 + 相对车体安装位姿
    └── ego_pose.json              # 自车世界位姿
```

## 2. 转换

两种坐标系模式：

```bash
# lidar 模式（默认）：每帧保持在 ego/lidar 局部系，适合逐帧对照相机图
python scripts/convert_nuscenes.py --mode lidar

# world 模式：用 ego_pose 把点云对齐到统一世界系 —— 真正的 4D-BEV
# 静止背景重合、运动目标拖轨迹，详见第 13 节
python scripts/convert_nuscenes.py --mode world
```

纯标准库实现（无需 numpy/scipy）。可环境变量控制转换帧数：

```bash
MAX_SAMPLES=20 python scripts/convert_nuscenes.py --mode world
```

默认输出到 `public/data/nuscenes/`，world 模式输出到 `public/data/nuscenes_world/`：

| 文件 | 内容 |
|------|------|
| `ns_000.pcd` | binary PCD，字段 `x y z intensity`，工具可直接加载 |
| `ns_000.json` | 标注框，SUSTechPOINTS 兼容格式（`psr` / `obj_type` / `obj_id` / `vertices`） |
| `ns_000_calib.json` | `extrinsic`（4×4 行主序）+ `intrinsic`（3×3 行主序），把 lidar 系点投到相机像素 |
| `ns_000.jpg` | 对应前视相机图像 |
| `index.json` | 帧清单，工具按它逐帧加载 |

### 关键坐标变换（面试常问）

nuScenes 标注框给的是**世界坐标 + 四元数 + [w,l,h]**，工具要的是 **lidar 坐标 + yaw + {x=length, y=width, z=height}**：

1. **中心点** 世界→lidar：`p_lidar = inv(T_ego_world · T_lidar_ego) · p_world`
2. **朝向** 把框的世界旋转左乘 `R_world→lidar`，再取局部 x 轴方向的 `atan2(dy, dx)` 得 yaw
3. **尺寸** nuScenes `[w,l,h]` → 工具 `{x:l, y:w, z:h}`（nuScenes 宽在前，工具长在前）
4. **相机外参** lidar→camera：`T = inv(T_cam_world) · T_lidar_world`，其中 `T_cam_world = T_ego_world · T_cam_ego`
5. **相机内参** nuScenes `camera_intrinsic` 展平成 3×3 行主序，与工具针孔模型一致

转换器自带坐标数学自检（四元数、矩阵求逆、刚体变换、顶点顺序），保证转换正确。

## 3. 在工具里查看

- 点顶部 **◉ nuScenes** 按钮，或访问 `?data=nuscenes`。
- 自动进入分屏：左侧点云 + 3D 框，右侧真实相机图叠加投影框。
- 用时序帧控件逐帧切换；每帧都是官方标注，可与自己的标注结果对照。

## 4. 与 SUSTechPOINTS 样例的区别

| 维度 | SUSTechPOINTS `000970` | nuScenes mini |
|------|------------------------|---------------|
| 场景 | 单帧 | 多帧连续序列 |
| 传感器 | 1 lidar + 1 front camera | 1 lidar + 6 camera + 5 radar |
| 标注对象 | 24 框 | 23 类、逐帧标注、带实例 ID |
| 相机标定 | 已整理好的 extrinsics/intrinsics | 原始 sensor/ego 位姿，需自己算变换 |
| 学习价值 | 快速上手 | 接近真实工程数据链路 |

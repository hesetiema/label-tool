# 第三方资源授权说明

本仓库的源码、样式与文档（`src/`、`scripts/`、`tests/`、`docs/`、`README.md`）采用 [MIT License](LICENSE)。

以下资源**不属于** MIT 授权范围，按各自的原始协议使用。

## 1. SUSTechPOINTS 样例数据（GPL-3.0）

`public/data/` 下的真实激光雷达样例复制自 [SUSTechPOINTS](https://github.com/sustech-isus/SUSTechPOINTS)（GPL-3.0）：

| 文件 | 内容 |
|---|---|
| `public/data/000970.pcd` | 帧 000970 的 LiDAR 点云（66,899 点，binary PCD） |
| `public/data/000970.json` | 该帧的 24 个 3D 框标注 |
| `public/data/calib_front.json` | 前视相机内参 / 外参 |
| `public/data/front_000970.jpg` | 该帧的前视相机图像 |

这些文件仅用于学习与演示，版权归原仓库作者所有。若你需要一份纯 MIT 的副本，删除上述四个文件即可（`?data=real` 演示会随之失效）。

## 2. nuScenes 数据集（CC BY-NC-SA 4.0）

`scripts/convert_nuscenes.py` 的输入是 [nuScenes](https://www.nuscenes.org/) 数据集，产出 `public/data/nuscenes/`、`public/data/nuscenes_world/` 下的聚合数据。nuScenes 采用 CC BY-NC-SA 4.0，**不得用于商业用途**，二次分发需保持相同协议并署名。

`datasets/`（本地下载的原始数据）与上述产出目录均已列入 `.gitignore`，不随本仓库分发。

## 3. 依赖

运行时依赖 `three`、`vue` 及其传递依赖，各自遵循其仓库声明的协议（均为 MIT）。

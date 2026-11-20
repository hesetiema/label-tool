# 4D-BEV 世界系对齐与遮挡状态

> 这是整个项目最接近"真实 4D 标注平台内核"的一节：解决两个生产级问题——
> **坐标系对齐**（静止背景不漂、运动目标才动）与 **遮挡语义**（遮挡 ≠ 漏标）。

## 一、为什么需要世界系（ego-motion 补偿）

每帧激光雷达点云都存于 self / ego（自车）坐标系。自车在前进，所以：

- 一根**静止**的电线杆，在 ego 系里每帧坐标都在后退；
- 直接在 ego 系看多帧，静止物体会拖出一条假轨迹，静止背景无法聚合。

**4D-BEV 的地基是先把所有帧变换到统一世界系**：

```
p_world = R_ego · (R_lidar · p_lidar + t_lidar) + t_ego
```

- `ego_pose` 提供 `(R_ego, t_ego)`：自车在世界中的位姿
- `calibrated_sensor` 提供 `(R_lidar, t_lidar)`：雷达在自车上的安装位姿

对齐后：静止目标多帧坐标**重合**，只有真正运动的目标才有位移。

### 项目里的实现

`scripts/convert_nuscenes.py --mode world`：

1. 读取第一帧 ego 位置作**局部原点**（nuScenes 世界坐标约 x=400/y=1179，直接用作浮点会损失精度，减去原点后落在 ±100m）；
2. 每个 lidar 点用 `M_lidar_to_world` 变换后写入 PCD；
3. 标注框直接用 nuScenes 官方世界坐标 `annotation["translation"]`（省去坐标转换）；
4. 相机外参相应改为 `world -> camera`（因为点云现在在世界系）。

**验证结果**（12 帧实测）：

| 目标类型 | 首末帧位移 | 说明 |
|---|---|---|
| 静止目标（3 个样本） | **0.00 m** | 世界系对齐生效 ✓ |
| 运动目标（3 个样本） | 22～27 m | 真实运动被保留 ✓ |

入口：顶部「◉ 4D-BEV」按钮，或 `?data=world`（`&autoplay=1` 自动回放）。

## 二、遮挡状态机

### 为什么遮挡必须显式建模

时序质检里"目标在第 5 帧缺失"有两种完全不同的语义：

- **漏标**（错误）：标注员漏了这一帧 → 必须告警；
- **遮挡**（正常）：目标被大车挡住 → 不该扣分，框应由轨迹预测补出。

不区分这两者，质检就会对真实场景大量误报。nuScenes 用 `visibility_token`（1～4），MolarData 等平台都有显式遮挡标记。

### 三态模型

`core/tracker.ts`：

| 状态 | 触发条件 | 行为 |
|---|---|---|
| `alive` | 本帧有观测 | 正常标注，`visibility = visible` |
| `occluded` | 连续 1～8 帧无观测 | 保留 ID，用 Kalman 预测位置续接，`visibility = predicted` |
| `dead` | 连续 > 8 帧无观测 | 轨迹终止，不再产出框（避免无限幽灵框） |

关键函数：

- `associateHungarianKalman()`：匹配成功重置 `missedFrames = 0`，失配则 `missedFrames++`（之前这个字段**从不递增**，是个 bug）；
- `stepTrackState()`：按 `missedFrames` 判定三态；
- `coastOccludedTracks()`：只对 `occluded` 状态产出预测框，`dead` 不续。

### 数据模型

`Box3D.visibility?: 'visible' | 'occluded' | 'predicted'`（可选，兼容历史数据）。序列化时作为扩展字段写入 raw label JSON 顶层，SUSTechPOINTS 会忽略未知字段，我们读回时保留。

渲染层（`PointCloudViewer`）：`occluded` / `predicted` 框用**虚线 + 半透明**绘制，标签带 `[遮挡]` / `[预测]` 后缀——一眼区分"真实观测"与"推断补框"。

## 三、遮挡与质检的联动

`core/temporalQA.ts` 做了两件事：

1. **精度类检测跳过遮挡点**：位移 / 速度 / 方向检测遇到 `predicted` / `occluded` 点直接跳过——预测位置不是真观测，拿它算会产生假告警；
2. **断裂检测豁免**：缺口帧若紧邻 predicted 点，视为"已标记遮挡"，不报 `track_gap`。

报告新增 `occludedPoints` 字段，UI 显示"遮挡 N 个"。

**演示**：`?data=sequence` → 点「⚠ 演示缺陷注入」制造断裂 → 点「◐ 演示遮挡标记」，可以看到健康分回升、断裂不再误报。属性面板也有「标记为遮挡」按钮，可手动切换（走历史，可撤销）。

## 四、面试话术

> 面试官：4D 标注怎么处理遮挡？和漏标怎么区分？

"我的做法是显式 visibility 状态，而不是靠阈值硬猜。跟踪器维护三态：正常、遮挡、终止，失配帧累计 missedFrames——1 到 8 帧算遮挡，用 Kalman 预测位置续接，框标成 predicted 并用虚线渲染；超过阈值判定轨迹终止。质检层对 predicted 点跳过精度检测与断裂判定，因为预测位置不是真观测。nuScenes 的 visibility_token 也直接映射到这套状态。

另外世界系对齐是 4D 的前提——每帧点云在 ego 系，自车在动，不做 ego-motion 补偿的话静止物体会拖出假轨迹。我用每帧 ego_pose 把点云变换到统一世界系，实测静止目标首末帧位移 0，运动目标 22 米以上。"

**追问"为什么阈值是 8"**：这是教学用的经验值，生产应该按类别和车速自适应——行人遮挡通常 1～2 帧，高速车辆可能更长；也可以用 Kalman 协方差（预测不确定性）动态决定何时判定终止。

## 五、相关文件

| 文件 | 职责 |
|---|---|
| `scripts/convert_nuscenes.py` | `--mode world` 世界系对齐导出，`--mode lidar` 逐帧局部系 |
| `core/types.ts` | `Visibility` 类型、`Box3D.visibility` 字段 |
| `core/tracker.ts` | 状态机、`missedFrames` 递增、coasting 续接 |
| `core/temporalQA.ts` | 遮挡点统计、断裂豁免 |
| `core/label.ts` | visibility 扩展字段的序列化往返 |
| `viewer/PointCloudViewer.ts` | 虚线渲染遮挡框 |
| `src/App.vue` | `?data=world` 入口、遮挡标记按钮 |

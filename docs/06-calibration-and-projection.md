# ⑥ 相机标定与投影

> 这篇是"3D 框投影到图像"的理论 + 实现，配套源码 `core/calibration.ts` 和 `components/CameraView.vue`。加载真实数据后，分屏视图里就能看到本项目实现的投影效果。

---

## 1. 为什么需要相机标定

自动驾驶车上同时有激光雷达（LiDAR）和多个相机。它们看到的同一个物体，在两个传感器的数据里位置完全不同。要把 3D 框画到图像上做验证，或者做多传感器融合标注，就必须知道**两个传感器之间的几何关系**——这就是标定（calibration）要解决的问题。

---

## 2. 三类坐标系

理解投影，要理清三个坐标系：

| 坐标系 | 说明 |
|---|---|
| **世界/车体坐标系** | 我们的 x 前 y 左 z 上，标注和点云都在这里 |
| **相机坐标系** | 以相机光心为原点，z 轴沿光轴向前 |
| **图像坐标系** | 二维像素坐标 (u, v)，原点在左上角 |

投影就是：世界坐标 → 相机坐标 → 图像坐标。

---

## 3. 外参（extrinsic）：世界 → 相机

外参是一个 4×4 变换矩阵，包含旋转 R 和平移 t：

```
[ R  t ]
[ 0  1 ]
```

把世界点 P 变成相机点：`P_cam = R · P_world + t`（用齐次坐标写成矩阵乘法）。

原仓库 `calib/front.json` 里的 `extrinsic` 就是一个 16 个数的数组（4×4 矩阵，列主序存储）。

---

## 4. 内参（intrinsic）：相机 → 图像

内参是 3×3 矩阵，描述相机的焦距和主点：

```
[ fx  0  cx ]
[ 0  fy  cy ]
[ 0   0   1 ]
```

其中 fx/fy 是焦距（像素单位），cx/cy 是主点（光轴与成像平面的交点，通常在图像中心附近）。

原仓库 `calib/front.json` 的 `intrinsic` 就是它。

投影公式（针孔相机模型）：

```
u = fx · X/Z + cx
v = fy · Y/Z + cy
```

---

## 5. 完整的投影流程

把一个 3D 框的 8 个角点投到图像上：

```
1) 每个角点 P_world（从 boxToVertices 得到）
2) P_cam = extrinsic · P_world          （外参）
3) (u, v) = intrinsic · (P_cam.x/Z, P_cam.y/Z, 1)   （内参，含透视除法）
4) 把 8 个 (u,v) 连成线框，叠加到图像上
```

这样就能在相机图里看到 3D 框的投影，用来人工验证框标得准不准——这正是原仓库 README 里那张"框投影到多相机图像"截图的实现原理。

---

## 6. 畸变（distortion）

真实相机镜头有畸变（桶形/枕形），严格来说投影前要施加畸变模型。标定给出的是 OpenCV 顺序的畸变系数（k1,k2,p1,p2,k3）。原仓库的 calib 文件没有显式畸变参数，可能假设图像已去畸变或使用简化模型；但接 KITTI / nuScenes / DAIR-V2X 这类真实数据集时系数通常是有的，忽略它会让画面边缘的框明显偏位——中心的框看着又是准的，所以特别容易误判成标注问题。

本项目已实现 OpenCV 的径向-切向模型（`distortNormalized()`），作用在归一化相机平面坐标 (x, y) = (X/Z, Y/Z) 上：

```
r²      = x² + y²
radial  = 1 + k1·r² + k2·r⁴ + k3·r⁶
xd      = x·radial + 2·p1·x·y + p2·(r² + 2x²)
yd      = y·radial + p1·(r² + 2y²) + 2·p2·x·y
```

系数通过 calib JSON 的可选 `distortion` 字段传入（兼容 KITTI 的 `D`、OpenCalib 的 `Distortion`，支持数组或空格分隔字符串），缺省时走针孔模型，行为与之前完全一致。

**一个容易踩的坑**：这里做的是「投影时加畸变」（OpenCV `projectPoints` 模型）。如果数据集给的图像已经去畸变（比如 KITTI 的 `P2` 本身就是 rectified 投影矩阵），就不要再传 distortion，否则会二次校正。

---

## 7. 反过来：从图像/雷达做融合

- **相机 → 3D**：单目从图像恢复 3D 是病态问题，需要深度估计或先验；双目靠视差；这也是为什么 LiDAR 对自动驾驶如此重要——它直接给 3D。
- **多雷达融合**：原仓库支持 aux_lidar（辅助激光雷达）和 radar（毫米波雷达），需要各自的标定把它们统一到车体坐标系。

---

## 8. 本项目已实现的投影（对照源码）

加载真实数据后，左侧选"分屏"即可看到点云 + 相机图对照，3D 框已投影叠加。实现分两块：

**算法层 `core/calibration.ts`**（对照原仓库 `public/js/image.js` 的 `box_to_2d_points`）：

```ts
projectPoint(world, calib):
  cam = matVec(calib.extrinsic, [x,y,z,1], 4)   // 外参，行主序 4×4
  if (cam.z <= 0) return null                    // 相机后方，不可见
  if (!calib.distortion)                          // 无畸变：走原来的快速路径
    px = matVec(calib.intrinsic, cam.xyz, 3)     // 内参，行主序 3×3
    return { u: px.x/px.z, v: px.y/px.z }        // 透视除法
  [nx,ny] = distortNormalized(cam.x/cam.z, cam.y/cam.z, calib.distortion)
  px = matVec(calib.intrinsic, [nx*cam.z, ny*cam.z, cam.z], 3)
  return { u: px.x/px.z, v: px.y/px.z }
```

一个从源码里挖出来的**关键细节**：原仓库 `calib.js` 用 `extrinsic[3], [7], [11]` 取平移向量，说明它的 4×4 是**行主序**存储（平移在最后一列）。如果当成列主序（Three.js 的默认），投影会完全错位——这正是照搬库代码容易踩的坑。

**渲染层 `components/CameraView.vue`**：
1. canvas 画相机图（2048×1536），按 `contain` 方式缩放居中
2. 对每个框调 `projectBox()` 得到 8 个像素点
3. 把像素坐标换算到 canvas 显示坐标：`canvas坐标 = offset + 像素 × scale`
4. 按 12 条边连线，选中框高亮黄色

真实数据的效果：24 个框里约 10 个落在前视相机内（其余在相机后方或视野外），投影框准确贴合图像中的车辆。

---

## 9. 动手验证

拿原仓库 `data/example/calib/front.json` 和 `label/000970.json`：

1. 取一个框的 8 个角点，手动套用上面的投影公式，算它们在图像里的位置。
2. 打开对应的 `image/front/000970.jpg`，看算出的位置是否落在车上。
3. 思考：如果外参矩阵用错了（比如行列搞反），投影结果会怎样？

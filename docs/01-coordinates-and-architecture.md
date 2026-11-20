# ① 坐标系与整体架构

> 配套源码：`src/core/types.ts`

这一篇解决一个新手最容易懵的问题：**点云里的 x/y/z 到底哪个是"上"？框的朝向角怎么定义？**

---

## 1. 为什么坐标系这么重要

标注工具的所有计算——画框、拟合、投影、导出——都建立在一个统一的坐标系约定上。约定一旦混乱，就会出现"框画出来了但方向反了""导出的框算法读出来位置不对"这类问题。

自动驾驶领域主流采用 **车辆坐标系**，也叫 ego 坐标系（以自车为原点）：

```
        z ↑ (上 / up)
          │
          │
          └────────→ y (左 / left)
         ╱
        ╱
       x (前 / forward)
```

- **x 向前**：车辆车头方向
- **y 向左**：车辆左侧
- **z 向上**：竖直高度
- 三者构成右手系（x × y = z）

KITTI、nuScenes、SUSTechPOINTS 都遵循这个约定（或非常接近的变体）。我们保持一致。

---

## 2. 一个隐藏的坑：Three.js 是 y-up

Three.js 作为通用图形引擎，默认 **y 轴向上**（这是图形学传统）。而点云数据是 z-up。

如果我们直接把点云喂给 Three.js，会发生什么？地面点云（z≈0 的平面）会被当成"竖直的一面墙"，因为 Three.js 认为 y 才是高度。

解决办法有两条：

1. **转换数据**：读入时把 (x, y, z) 重排成 (x, z, -y)，全程用 y-up。
2. **转换相机**（我们的选择）：保留数据的 z-up，把所有相机的 up 设为 z：
   ```ts
   camera.up.set(0, 0, 1)
   ```

方式 2 的好处是：**数据始终保持原始坐标，导出时不用转来转去**，和原仓库的 label JSON 完全对齐。代价是 OrbitControls 的一些默认行为要留意，但完全可用。

对照原仓库：`public/js/pcd_viewer.js` 里也是通过 `camera.up.set(0,0,1)` 处理这个问题的。

---

## 3. 核心数据结构

整个工具的数据分为三层，理解它们就理解了整个程序：

### 3.1 PointCloud —— 点云

```ts
interface PointCloud {
  positions: Float32Array  // 展平的 [x0,y0,z0, x1,y1,z1, ...]
  count: number            // 点数量
  colors?: Float32Array
}
```

为什么用 `Float32Array` 而不是 `[{x,y,z}, ...]`？

- **性能**：几十万到上百万点，对象数组内存开销巨大；typed array 是连续的二进制块，GPU 友好。
- **Three.js 要求**：`BufferGeometry` 直接接收 `Float32Array` 作为顶点属性。

这是点云处理的一个重要思维转变：**把点云看成一大块数字，而不是一堆对象**。

### 3.2 Box3D —— 3D 框

```ts
interface Box3D {
  id: string
  label: string
  position: Vec3   // 中心点
  scale: Vec3      // 尺寸 x=长 y=宽 z=高
  yaw: number      // 绕 z 轴朝向角
}
```

这就是 **OBB（Oriented Bounding Box，有向包围盒）**。对比一下：

- **AABB**（轴对齐包围盒）：只能表达"正着放"的盒子，没有朝向角。
- **OBB**：可以绕竖直轴旋转，能贴合斜着停的车。只多了一个 `yaw`，表达能力大幅提升。

原仓库 README 里说的 "9 DoF box editing" 指的就是 position(3) + scale(3) + rotation(3)。我们 MVP 先实现最关键的 yaw（绕 z 旋转），roll/pitch 一般场景用不到，留作进阶。

### 3.3 RawLabelObject —— 导出的 JSON 格式

这是算法侧认识的格式，也是与原仓库互通的关键：

```json
{
  "psr": {
    "position": {"x": 6.16, "y": -44.8, "z": 1.13},
    "scale":    {"x": 4.5,  "y": 1.71, "z": 1.70},
    "rotation": {"x": 0,    "y": 0,    "z": 1.43}
  },
  "obj_type": "Car",
  "obj_id": "4",
  "vertices": [5.61, -42.5, 0.15, 1, ...]   // 8 个角点 × 4
}
```

`psr` 是 Position/Scale/Rotation 的缩写。`rotation.z` 就是我们的 `yaw`。`vertices` 是 8 个角点展开，由 `boxToVertices()` 计算（见 ③）。

---

## 4. 分层架构的好处

```
core/     纯数据 + 算法，不依赖 Vue、不依赖 Three.js
viewer/   Three.js 渲染，把数据变成画面
App.vue   交互编排，把用户操作翻译成对数据的修改
```

这套分层的价值：**core 层的代码可以单独测试、单独复用**。比如你以后想换成 React 或 Canvas 渲染，core 一行都不用改。这也正是原仓库把 `algos/`（算法）和 `public/js`（前端）分开的思路。

---

## 5. 动手验证

1. 打开 `core/types.ts`，找到 `DEFAULT_CATEGORIES`，改改 Car 的默认尺寸，重启看看新建框的变化。
2. 思考：如果要把坐标系改成 y-up，需要改哪些地方？（提示：相机 up、yaw 的旋转轴、导出格式）

# ④ Three.js 渲染原理

> 配套源码：`src/viewer/PointCloudViewer.ts`

> **注意**：本篇成文于「BEV 双视口」时期，正文里的「第二视口」已不再由 WebGL 实现。当前界面是 **单 3D 视口 + 三个独立 2D canvas 正交视图**（`src/components/OrthoView.vue`），三个 canvas 用 `ImageData` 逐点写像素，比再开三个 WebGL 视口省一半内存。**正交投影矩阵、屏幕坐标反投影、按需渲染（脏标记）** 这三块原理完全不变，直接照读即可；涉及「双视口」的段落请替换为「三联正交」。

这一篇讲 Three.js 如何把点云和框画出来，以及双视图、屏幕坐标反投影这些交互背后的原理。

---

## 1. Three.js 最小心智模型

只需要先理解四个概念：

| 概念 | 作用 | 类比 |
|---|---|---|
| `Scene` | 场景容器，放所有要显示的东西 | 舞台 |
| `Camera` | 决定从哪个角度、用什么投影看 | 摄像机 |
| `Renderer` | 把场景+相机渲染成像素 | 冲洗照片 |
| `Geometry` + `Material` + `Mesh/Points` | 物体的形状 + 外观 = 物体 | 演员 |

渲染循环就是：

```ts
function animate() {
  requestAnimationFrame(animate)
  renderer.render(scene, camera)  // 每帧重画
}
```

---

## 2. 点云为什么用 `THREE.Points`

点云是"一堆离散的点"，不是三角面。Three.js 提供 `THREE.Points` 专门干这个：

```ts
const geo = new THREE.BufferGeometry()
geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
const mat = new THREE.PointsMaterial({ size: 0.12, color: 0x8fd4ff })
const points = new THREE.Points(geo, mat)
```

- `BufferAttribute(positions, 3)`：告诉 GPU "每 3 个数是一个顶点"。
- 数据**一次性上传 GPU**，之后每帧只做绘制，这也是它能流畅渲染百万点的原因。
- `sizeAttenuation: true`：点会随距离变小，更有空间纵深感。

---

## 3. 两种相机，两个视口

我们维护两个 Scene + 两个 Camera，但**共用一个 Renderer**（切 mode 时渲染不同的组合）。

### 3.1 透视相机（3D 视图）

```ts
new THREE.PerspectiveCamera(60, aspect, 0.1, 2000)
```

近大远小，符合人眼直觉。配合 `OrbitControls`，鼠标左键旋转、右键平移、滚轮缩放。用来**验证框的高度和朝向**。

### 3.2 正交相机（BEV 视图）

```ts
new THREE.OrthographicCamera(-f*aspect, f*aspect, f, -f, 0.1, 1000)
camera.position.set(0, 0, 200)   // 正上方
camera.up.set(0, 1, 0)           // 屏幕上方 = +y
camera.lookAt(0, 0, 0)
```

正交投影没有透视变形，**屏幕上的 xy 与世界 xy 一一对应**（只差缩放和平移）。这才是标注主视图选它的重要原因：拖拽画矩形 = 框定世界 xy 区域，逻辑极其简单。

`up` 设为 +y，是为了让"车头 +x"显示在屏幕右侧、-y（车右）在屏幕下方——符合俯视图习惯。

### 3.3 为什么 z-up 要特殊处理

前面说过，相机 `up` 默认 (0,1,0)。因为数据是 z-up，两个相机都要显式设置 up：

- 3D 相机：`up.set(0,0,1)`（z 朝上）
- BEV 相机：从 +z 往下看，此时"屏幕上方"应该是 +y，所以 `up.set(0,1,0)`

---

## 4. 屏幕坐标反投影（screenToBev）

交互的核心问题：鼠标点在屏幕上的像素坐标，对应世界里哪个 (x,y)？

对正交相机，用 Three.js 的 `unproject`：

```ts
const nx = (clientX - rect.left) / rect.width * 2 - 1   // 归一化到 [-1,1]
const ny = -(clientY - rect.top) / rect.height * 2 + 1  // y 轴翻转
const v = new THREE.Vector3(nx, ny, 0).unproject(cameraBev)
return { x: v.x, y: v.y }
```

三步走：

1. 屏幕像素 → NDC（归一化设备坐标，范围 [-1,1]）
2. NDC 的 y 要**翻转**（屏幕 y 向下，NDC y 向上）
3. `unproject` 用相机的逆矩阵，把 NDC 变回世界坐标

有了这个函数，拖拽起点/终点就能转成世界坐标，进而筛出矩形内的点云索引。

---

## 5. 框的可视化

每个框在两个场景里各有一个 `LineSegments`（12 条边的线框）+ 一个文字精灵（显示类别和 ID）。

- 线框顶点由 `boxToVertices()` 给出的 8 角点，按 12 条边的连接关系生成。
- 选中时改颜色为黄色，实现"高亮"。
- 更新框时替换 geometry，文字精灵的 canvas 重绘。

**性能提示**：每次编辑都重建 geometry 有 GC 开销。生产级工具会用"原地更新顶点位置"（改 BufferAttribute 的 array 再 `needsUpdate = true`），教学版为清晰起见用了更直白的做法。

---

## 6. 大点云的性能要点（进阶）

真实场景百万点，要注意：

1. **避免逐点创建对象**：全程 typed array。
2. **一次上传 GPU**：`BufferGeometry` 建好后不要频繁重建。
3. **控制点大小与.devicePixelRatio**：高分屏像素比过高会拖慢渲染，代码里 `Math.min(devicePixelRatio, 2)` 做了限制。
4. **LOD / 空间索引**：超大规模数据要分块加载、用八叉树做视锥剔除——这是原仓库和工业工具更深的话题。

---

## 7. 动手验证

1. 切到 3D 视图，用鼠标绕着场景转一圈，观察 z-up 的表现（地面始终是"平"的）。
2. 在 BEV 视图滚轮缩放，观察 `zoomBev()` 如何改变正交相机的 `left/right/top/bottom` 并 `updateProjectionMatrix()`。
3. 思考：如果要在两个视口同时显示（而不是切换），需要改什么？（提示：用 `setScissor`/`setViewport` 做分屏渲染）

# ⑤ 交互与序列化

> 配套源码：`src/state/useAnnotation.ts` / `src/core/io/label.ts`

这一篇讲用户操作如何变成数据修改，以及标注结果如何与算法侧对接。

---

## 1. 交互的本质：把鼠标事件翻译成数据操作

标注工具的所有交互，本质都是这个链条：

```
用户操作（鼠标/键盘）
      ↓ 事件处理
修改 Box3D[] 数据
      ↓ syncViewer()
重新渲染
```

`App.vue` 就是这条链条的编排者。它本身不做复杂计算，而是调用 core 层的函数。

---

## 2. 拖拽画框的完整流程

这是最核心的交互，值得逐行理解 `onMouseDown / onMouseMove / onMouseUp`：

### 2.1 mousedown —— 记录起点

```ts
const p = viewer.screenToBev(clientX, clientY)
dragStart = p
dragging = true
```

把屏幕坐标转成世界 xy（见 ④ 的反投影），记下拖拽起点。

### 2.2 mousemove —— 实时画临时矩形

```ts
dragEnd = viewer.screenToBev(clientX, clientY)
viewer.showDraft(dragStart, dragEnd)
```

画一个青色的临时矩形给用户即时反馈。这是良好交互体验的关键——**任何操作都要有视觉反馈**。

### 2.3 mouseup —— 判定意图并执行

这里有个巧妙的设计：**根据拖拽距离区分"点击"和"画框"**:

- 距离很小（<0.4 米）→ 视为点击，做命中检测选中框
- 距离较大 → 视为画框，收集矩形内的点，自动拟合出新框

一个手势承载两种语义，是标注工具常见的效率优化。

### 2.4 收集候选点 + 拟合

```ts
for (let i = 0; i < cloud.count; i++) {
  if (px in [x0,x1] && py in [y0,y1]) indices.push(i)
}
const yaw = estimateYawByPCA(pos, indices)      // 估朝向
const fitted = fitBoxToPoints(pos, indices, yaw) // 拟合框
```

注意这里是**线性扫描所有点**做范围判断。对几十万点没问题；百万级以上要建空间索引（如栅格/八叉树）加速。

---

## 3. 键盘快捷键编辑

```ts
function onKeyDown(e: KeyboardEvent) {
  if (输入框获得焦点) return   // 避免在输入框里打字触发快捷键
  const box = selectedBox.value
  switch (key) {
    case 'w': box.position.x += step; break
    case 'q': box.yaw += 0.05; break
    // ...
  }
  syncViewer()  // 别忘了重新渲染
}
```

两个细节：

1. **焦点判断**：如果用户在属性面板的输入框里打字，不能触发 W/A/S/D。
2. **`step` 可变**：按住 Shift 用大步长，方便粗调；不按用细步长精调。

对照原仓库：`public/js/box_op.js` 有更复杂的快捷键体系（v 切换变换模式、x/y/z 锁定轴等），思路一致。

---

## 4. 响应式与"直接改对象"的注意点

属性面板里这样写：

```ts
@input="selectedBox!.position.x = numVal($event); syncViewer()"
```

`selectedBox` 是 computed，返回的是 `boxes` 数组里的对象引用。直接改它的属性会修改原对象。但 Vue 的响应式依赖 `syncViewer()` 里对 `boxes.value` / `selectedId.value` 的读取来触发更新——所以我们每次都显式调用 `syncViewer()`，确保渲染同步。

> 工程提示：更 Vue 的做法可能是把框状态放进 `reactive` store，用 `watch` 深度监听自动同步。教学版用显式调用，让"数据变化 → 重新渲染"这个因果关系更清晰可见。

---

## 5. 序列化：与 SUSTechPOINTS 格式互通

`label.ts` 提供双向转换：

```ts
Box3D → toRawLabel()    → RawLabelObject → JSON.stringify → 文件
文件 → JSON.parse() → fromRawLabel() → Box3D
```

### 关键点 1：8 角点由参数生成

导出的 `vertices` 不是存储的，而是**每次由 `boxToVertices()` 从 position/scale/yaw 算出来的**。这保证了一致性——不会出现"参数改了但角点没更新"的错误。

### 关键点 2：rotation 的映射

我们的 `yaw`（绕 z）写入 `psr.rotation.z`，读回来也读 z。x/y（roll/pitch）填 0。如果将来要支持完整 9-DoF，这里就是扩展点。

### 关键点 3：触发浏览器下载

```ts
const blob = new Blob([json], { type: 'application/json' })
const url = URL.createObjectURL(blob)
const a = document.createElement('a'); a.href = url; a.download = 'labels.json'; a.click()
URL.revokeObjectURL(url)
```

这是纯前端导出文件的标准套路。

---

## 6. 数据如何喂给算法

导出的是**单帧**的 label JSON（一个对象数组）。真实项目中：

- 每帧一个 JSON 文件，按帧号命名（如 `000970.json`）。
- 与点云帧、相机图、标定文件按目录组织成一个 scene。
- 训练时，数据加载器读取 PCD + label，把 3D 框转换成训练目标（如中心点热力图、anchor 回归目标）。

你导出的文件可以直接放进原仓库的 `data/example/label/` 目录，用它已有的工具链验证——这就是"格式兼容"的意义。

---

## 7. 动手验证

1. 画几个框，导出 JSON，打开文件看看 `psr`、`vertices` 的结构。
2. 把导出的文件用"导入标注"再导回来，框是否完全一致？（这验证了序列化是可逆的）
3. 思考：如果要做多帧跟踪（同一辆车跨帧保持 ID），数据结构和交互要怎么扩展？

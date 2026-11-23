# ⑧ 4D 轨迹叠加回放：把时序标注"看"出来

> 3D 标注加一个时间维度就是 4D。这一篇讲怎么用最低成本，把已经有的多帧时序能力
> 变成**肉眼可见的轨迹回放**——这是 4D 标注工具里性价比最高、展示效果最好的一块。

打开 `?data=sequence` 就能看到效果：默认叠加 6 条彩色轨迹线，点「回放」逐帧播放，
白点标记当前帧位置，已走过的路径高亮。加 `&autoplay=1` 进入即自动播放。

---

## 1. 什么是 4D 标注，轨迹回放解决什么问题

单帧 3D 标注回答"这一帧有什么"；4D 标注还要回答"同一目标在连续帧里怎么动"。
把多帧的同一个 `obj_id` 连起来，就得到一条**轨迹（trajectory）**。轨迹回放把这条线画出来，
让标注员一眼看出：

- 目标运动方向对不对（有没有标反、跳帧）
- ID 有没有串（轨迹突然横跳到另一个目标）
- 插值补的框是否在合理路径上

这三点正是自动驾驶时序感知（跟踪 / 预测）模型训练数据的核心质检项。

## 2. 数据层：轨迹提取是一个纯函数

核心在 `src/core/sequence/sequence.ts` 的 `extractTrajectories`：把帧序列按 `obj_id` 分组，
每组收集"第几帧 + 中心点坐标"，再按帧号排序。

```ts
export interface TrackPoint { frame: number; x: number; y: number; z: number }
export interface Trajectory { id: string; label: string; points: TrackPoint[] }

export function extractTrajectories(frames: FrameData[]): Trajectory[] {
  const byId = new Map<string, Trajectory>()
  frames.forEach((frame, fi) => {
    for (const box of frame.boxes) {
      // 同 id 归入同一条轨迹，记录该帧的中心点
    }
  })
  // 只保留 >= 2 帧的目标（单点连不成线），每个点按 frame 升序
}
```

为什么做成**纯函数**？它无副作用、输入输出确定，可以直接单测（`core-check.ts` 里
验证了：6 条轨迹、点按帧升序、跨帧目标含 5 点、单帧不产生轨迹）。渲染层只负责把数据画出来，
职责清晰——这是面试里体现"分层设计"的现成例子。

## 3. 渲染层：Three.js 里画轨迹

`PointCloudViewer.setTrajectories(tracks, currentFrame, selectedId)` 在 3D 和 BEV 两个场景各建一个
`THREE.Group`，每条轨迹画三样东西：

| 元素 | 作用 | 实现 |
|---|---|---|
| 完整路径 | 半透明彩色线，表示"整条运动路径" | `THREE.Line` + `BufferGeometry.setFromPoints` |
| 已走过段 | 亮实线，取 `frame <= currentFrame` 的点 | 同上，opacity 更高 |
| 采样点 | 小球；当前帧的点放大染白 | `THREE.Mesh(SphereGeometry)` |

几个工程细节：

- **颜色按 id 哈希**：同类不同车（演示里 id 1/2 都是 Car）也能一眼分清，不撞色。
- **BEV 贴地**：BEV 场景里把所有点的 z 设为 `0.35`，避免被地面点云遮挡；3D 场景用真实 z。
- **`depthTest: false`**：轨迹永远可见，不被点云挡住。
- **切帧重绘**：`syncViewer()` 里根据当前帧重新生成轨迹层，白点就跟着回放移动。
- **先清理再重建**：`setTrajectories` 开头先 `dispose()` 旧几何体与材质，避免内存泄漏与叠影。

## 4. 交互层：回放定时器的正确管理

播放逻辑很朴素——`setInterval` 每 `playSpeed` 秒推进一帧，到末尾从头循环：

```ts
function play() {
  playTimer = window.setInterval(() => {
    const next = currentFrame.value + 1
    gotoFrame(next >= frames.value.length ? 0 : next)
  }, playSpeed.value * 1000)
}
```

真正体现工程素养的是**定时器的生命周期管理**，三个易错点都处理了：

1. **切数据集要停**：换演示场景时若不停，旧定时器会继续操作新帧序列 → 索引错乱。
   实现上给 `resetHistory(clearPlayback = true)` 加了开关，切帧时传 `false` 保留回放，
   加载新数据集时默认 `true` 停掉。
2. **调速要重启定时器**：改速度时若正在播放，先 `pausePlay()` 再 `play()`，否则新间隔不生效。
3. **卸载要清理**：`onBeforeUnmount` 调 `pausePlay()`，防止组件销毁后定时器泄漏。

## 5. 面试怎么说（重点）

如果面试官问"4D 标注工具怎么做 / 你做了哪些"，建议这样组织：

> "我在多帧时序的基础上做了一层轨迹可视化：把同 `obj_id` 的框跨帧串成轨迹线，
> 回放时高亮已走过路径和当前帧位置。数据层用纯函数 `extractTrajectories` 提取轨迹，
> 渲染层用 Three.js 的 Line + 采样点小球，交互层用定时器驱动逐帧播放。
>
> 难点在两处：一是**分层**——轨迹提取和渲染解耦，纯函数可单测；
> 二是**定时器生命周期**——切数据集、调速、组件卸载都要正确清理，否则会出现帧错位和内存泄漏。
>
> 往生产演进的话，轨迹数据源不该是标注框本身，而应是跟踪器（Hungarian + Kalman）的输出；
> 遮挡消失要有 visibility 状态，回放要支持按时间戳而非帧号插值。"

这段话把"做过什么 / 为什么这么设计 / 怎么扩展"三层都覆盖了，且每一层都有代码实证。

## 6. 相关文件

- 数据层：`src/core/sequence/sequence.ts` — `extractTrajectories` / `TrackPoint` / `Trajectory`
- 渲染层：`src/viewer/PointCloudViewer.ts` — `setTrajectories`
- 交互层：`src/state/useSequence.ts` — `toggleTrajectories` / `play` / `pausePlay` / `onSpeedChange`
- 测试：`tests/core-check.ts` — 4 项轨迹提取断言
- 本系列前序：多帧时序与关联见 [07 工程化能力](07-engineering-p0.md)

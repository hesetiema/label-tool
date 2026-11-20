# ⑭ 相机导演：关键帧运镜与演示视频录制

> 这一篇讲怎么把「数据回放」和「镜头运动」拆成两条独立时间线，并用关键帧给相机做运镜，
> 最后把视角录成 WebM 视频。思路借鉴 ROS 生态的 [rviz_cinematographer](https://github.com/AIS-Bonn/rviz_cinematographer)，
> 但数据模型和实现完全按本仓库的 Vue 3 + Three.js 技术栈重写。

打开 `?data=sequence&cinema=1` 可直接加载演示运镜：4 个关键帧绕场景一圈，
点「▶ 播放运镜」看镜头运动，点「● 录制视频」自动播放一圈并导出 WebM。

---

## 1. 为什么要区分两条时间线

原来的「回放」只有一条时间线：`setInterval` 推进 `currentFrame`，相机停在一个视角不动。
这只回答了"数据怎么变"，没回答"镜头怎么看"。

rviz_cinematographer 把后者单独抽象成 `CameraTrajectory`：用户在 3D 场景里摆若干个关键帧，
每个关键帧带 `transition_time`（从上一帧走过来多久）和等待时间，
View Controller 按帧率插值移动相机，Recorder 把渲染结果编码成视频。

本仓库沿用这个拆分：

| 时间线 | 状态变量 | 驱动方式 | 回答的问题 |
|---|---|---|---|
| 数据时间线 | `currentFrame` / `playTimer` | `setInterval` | 第几帧点云、第几帧框 |
| 镜头时间线 | `cameraElapsed` / `cameraRaf` | `requestAnimationFrame` | 相机在哪、看哪、停多久 |

两条线互不干扰：可以让点云逐帧播放的同时镜头缓缓环绕，也可以只让镜头动、数据静止。

## 2. 数据层：关键帧模型

核心在 `src/core/camera/cameraTrajectory.ts`。位姿没有用四元数，而是用
`position + target + roll`——对标注工具来说"相机在哪、看向哪个点"比"绕任意轴转了多少度"直观得多。

```ts
export interface CameraPose {
  position: Vec3   // 相机位置
  target: Vec3     // 注视点
  roll: number     // 绕视线的滚转角（弧度）
}

export interface CameraKeyframe {
  id: string
  pose: CameraPose
  transition: number  // 从上一关键帧走过来所需秒数
  hold: number        // 到达后停留秒数
}
```

时间线是「停留 → 转场 → 停留 → 转场…」交替的：第 0 帧在 `t=0` 就位，
先停 `hold[0]`，再用 `transition[1]` 走向第 1 帧。总时长：

```
total = Σhold[i] + Σtransition[i] (i≥1) + (loop ? transition[0] : 0)
```

`sampleTrajectoryInfo(traj, t)` 按时间采样，返回位姿、当前关键帧下标、转场进度。
几个容易踩的坑都在这里处理了：

- **角度最短弧**：roll 从 `+3.1` 到 `-3.1` 只转 `0.08 rad`，不绕远路 `6.2 rad`。
- **端点复制**：Catmull-Rom 样条在首尾段没有前后邻居，用自身复制补齐。
- **零时长保护**：`transition = 0` 时直接落到目标帧，不做除零。
- **loop 取模**：循环播放时对总时长取模，末帧还能平滑回到首帧。

序列化用独立的 `camera-trajectory.json`，和标注框的 `labels.json` 完全分开，互不污染。

## 3. 渲染层：Three.js 相机 API

`PointCloudViewer` 新增三个方法：

| 方法 | 作用 |
|---|---|
| `getCameraPose()` | 读取当前 3D 相机位姿，供「记录当前视角」用 |
| `applyCameraPose(pose)` | 应用位姿；roll 通过绕视线旋转 `camera.up` 实现 |
| `setCameraTrajectory(traj, activeIndex)` | 画关键帧小球、连线、注视方向短线 |

`applyCameraPose` 里有个细节：本仓库是 **z-up**，但视线接近垂直时 `camera.up = (0,0,1)`
会和视线共线导致 `lookAt` 退化，所以这种情况改用 y-up 作为基准，再绕视线施加 roll。
OrbitControls 的 `target` 同步更新，鼠标交互不会失效。

关键帧 marker 只在关键帧切换时重建几何体，而不是每一帧都 `dispose/create`——
这是从轨迹叠加层沿用下来的性能习惯。

## 4. 交互层：RAF 播放与录制回执

`playTrajectory()` 用 `requestAnimationFrame` 按真实经过时间推进，而不是按帧数估算：

```ts
const dt = Math.max(0, (ts - cameraLastTs) / 1000)
let next = cameraElapsed.value + dt
if (next >= total) { /* loop 或播放结束 */ }
applyCameraAtTime(next)
```

暂停 / 复位 / 拖动进度条都会先 `pauseTrajectory()` 取消 RAF，避免多个循环同时跑。
组件卸载时同样清理。

录制借鉴了 rviz 的**渲染方 / 录制方解耦**：

1. `canvas.captureStream(fps)` 把 WebGL 画布变成视频流；
2. `MediaRecorder` 消费流，按 VP9 → VP8 → WebM 优先级选可用编码；
3. 运镜播放结束（或用户提前点结束）调用 `finishRecording()` → `MediaRecorder.stop()`；
4. `onstop` 回调把 Blob 下载成 `.webm`，释放 stream track，回写状态。

水印不是 DOM 覆盖层——那样不会被 `captureStream` 录进去。实现上把带文字的
`THREE.Sprite` 挂在相机下，并把相机加入场景图，这样水印随渲染一起进入视频。
`loop` 打开时录制只跑一圈，在结束前 1 帧停下，避免末帧直接跳回首帧。

## 5. 面试怎么说

> "我把标注工具里的回放拆成两条时间线：数据帧时间线用 setInterval 驱动，
> 镜头时间线用 requestAnimationFrame 按真实时间采样关键帧轨迹，两者互不干扰。
>
> 数据层用纯函数 `sampleTrajectoryInfo`，处理了角度最短弧、样条端点、零时长和 loop 取模；
> 渲染层提供 `getCameraPose / applyCameraPose / setCameraTrajectory`，roll 通过旋转 camera.up 实现；
> 录制层用 captureStream + MediaRecorder，播放结束回调 stop，形成完整的开始—回执—清理闭环。
>
> 这个设计参考了 rviz_cinematographer 的 CameraTrajectory 消息和 View Controller / Recorder 分层，
> 但换成了浏览器原生 API，没有引入 ffmpeg.wasm 之类的重依赖。"

## 6. 已知边界

- 浏览器需要支持 `canvas.captureStream` / `MediaRecorder`（Chrome、Edge 可用）。
- 输出格式是 WebM；如果需要 MP4，可再接 WebCodecs 或 ffmpeg.wasm 转封装。
- roll 打开后 OrbitControls 的旋转手感会跟平时不同，因为它把旋转后的 up 当作轨道轴。
- 当前关键帧 marker 只画在 3D 视口，BEV 视图仍以标注为主。

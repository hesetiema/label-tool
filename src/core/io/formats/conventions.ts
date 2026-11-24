/**
 * ============================================================
 * 坐标与朝向约定转换 —— 格式适配层最容易出错的地方
 * ============================================================
 *
 * 内部约定（与 KITTI LiDAR / SUSTechPOINTS 一致）：
 *   自车 LiDAR 系：x 前、y 左、z 上，右手系
 *   scale = (length, width, height)，长度沿 +x
 *   yaw   = 绕 z 轴、从 +x 轴起算，逆时针为正
 *
 * 外部常见约定的差异：
 *  1) KITTI label 的 location 在相机系（x 右、y 下、z 前），
 *     ry 绕相机 y 轴；转到自车 LiDAR 系要做轴置换，且 ry 的
 *     零点与内部 yaw 相差 π/2、方向相反。
 *  2) nuScenes 的 rotation 是四元数 (w,x,y,z)，size 顺序是 (w,l,h)。
 *  3) DAIR-V2X 的 rotation 在 LiDAR 系，但零点在 +y 轴，
 *     所以 yaw = rotation - π/2。
 *  4) Waymo 的 heading 在 vehicle 系绕 z 轴，与内部约定基本一致。
 *
 * 这里把变换写成纯函数并配测试，避免"看起来对、渲染出来偏 90°"。
 */

/** 角度归一化到 [-π, π) */
export function normalizeAngle(a: number): number {
  let x = a
  while (x >= Math.PI) x -= Math.PI * 2
  while (x < -Math.PI) x += Math.PI * 2
  return x
}

/**
 * KITTI 相机系 → 自车 LiDAR 系的位置变换。
 * 相机：x 右、y 下、z 前；LiDAR：x 前、y 左、z 上。
 *   x_lidar =  z_cam
 *   y_lidar = -x_cam
 *   z_lidar = -y_cam
 */
export function kittiCameraToLidar(x: number, y: number, z: number) {
  return { x: z, y: -x, z: -y }
}

/**
 * KITTI `rotation_y` → 内部 yaw。
 *
 * 推导（对盒长轴方向而言）：
 *  相机系里长轴方向 d_cam = (cos ry, 0, -sin ry)  [绕 +y 下轴旋转 ry]
 *  经轴置换到 LiDAR 系：  d_lidar = (-sin ry, -cos ry, 0)
 *  内部 yaw 满足 (cos yaw, sin yaw) = d_lidar / |d|
 *  且 KITTI 盒子 z 向下的高度要翻正，最终 yaw = -ry - π/2。
 *
 * 这是学界/工业界通用换算；若某工具链的 ry 定义相反，可传 flip=true。
 */
export function kittiRyToYaw(ry: number, flip = false): number {
  const yaw = -ry - Math.PI / 2
  return normalizeAngle(flip ? -yaw : yaw)
}

/** DAIR-V2X `rotation`（从 +y 轴起算）→ 内部 yaw（从 +x 起算） */
export function dairRotationToYaw(rotation: number, flip = false): number {
  return normalizeAngle(flip ? rotation + Math.PI / 2 : rotation - Math.PI / 2)
}

/** Waymo heading（vehicle 系绕 z，从 +x 起算）→ 内部 yaw */
export function waymoHeadingToYaw(heading: number, flip = false): number {
  return normalizeAngle(flip ? -heading : heading)
}

/**
 * 四元数 (w,x,y,z) → 绕 z 轴的 yaw。
 * 自动驾驶里目标通常只有 yaw，但即使带小 pitch/roll，此式取的是 z 分量，
 * 足以还原航向；完整欧拉分解反而会引入万向锁歧义。
 */
export function quaternionToYaw(q: readonly number[]): number {
  if (q.length < 4) return 0
  const [w, x, y, z] = q
  const siny = 2 * (w * z + x * y)
  const cosy = 1 - 2 * (y * y + z * z)
  return Math.atan2(siny, cosy)
}

/** yaw → 四元数 (w,x,y,z)，导出 nuScenes 时用 */
export function yawToQuaternion(yaw: number): [number, number, number, number] {
  return [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)]
}

/**
 * 从长度推类别默认尺寸时用的辅助：把 KITTI/DAIR 的 (h,w,l) 重排为内部 (l,w,h)。
 */
export function hwlToLwh(h: number, w: number, l: number): [number, number, number] {
  return [l, w, h]
}

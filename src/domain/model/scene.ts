/**
 * ============================================================
 * 场景 / 传感器 / 帧引用
 * ============================================================
 *
 * 三条设计理由（方案 4.1）：
 *
 * 1. `ts` 必须独立于 `index`。现有实现用固定 `dt = 0.5` 算速度
 *    （core/sequence/temporalQA.ts:82），真实数据是 10Hz/20Hz 混采、还会丢帧。
 *    速度阈值、VLA 动作对齐、TTC 全部依赖真实时间。
 *
 * 2. 用 `DataRef` 而不是 `PointCloud`。这是把 1GB 内存压到几百 MB 的唯一办法；
 *    `kind: 'inline'` 保证演示场景零改动。
 *
 * 3. `ego` 可选。没有位姿就用地面点估计（P3 的光流模块），但不能假装有 ——
 *    缺失就是 null，下游据此降级。
 */
import type { PointCloud } from '../../core/types'
import type { Pose, Vec3 } from './geometry'

export interface SensorSpec {
  /** 'lidar_top' | 'cam_front' */
  id: string
  kind: 'lidar' | 'camera' | 'radar'
  /** 相对自车坐标系的静态外参；动态标定走 Calibration 版本号 */
  extrinsic?: { rotation: number[]; translation: Vec3 }
  intrinsic?: number[]
  distortion?: number[]
}

export interface SceneMeta {
  id: string
  name: string
  sensors: SensorSpec[]
  /** 名义帧率；每帧仍以 ts 为准，避免 10Hz/20Hz 混采时错位 */
  nominalHz: number
  calibrationVersion: string
}

export type DataRef =
  | { kind: 'inline'; cloud: PointCloud }
  | { kind: 'blob'; key: string; bytes: number; codec: 'pcd-bin' | 'pcd-ascii' | 'xyz-f32' }
  | { kind: 'remote'; url: string; range?: [number, number]; etag?: string }

export interface FrameRef {
  index: number
  /** 绝对时间戳（秒）。没有它就没有速度，也无法和 VLA 动作对齐 */
  ts: number
  /** sensorId → 数据引用 */
  data: Record<string, DataRef>
  /** 自车位姿（世界系）。可选：缺失时由 estimateEgoMotion 估计 */
  ego?: Pose
  /** 各传感器标定版本，允许逐帧切换（在线标定场景） */
  calibVersion?: string
}

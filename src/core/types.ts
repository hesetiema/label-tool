/**
 * ============================================================
 * 核心类型定义 —— 整个工具的数据"骨架"
 * ============================================================
 *
 * 学习要点：标注工具本质上是「一套数据结构 + 一套把它们可视化的代码」。
 * 先把数据模型定清楚，后面的渲染、交互、序列化都只是围绕它做变换。
 */

/** 三维向量（普通对象，便于 JSON 序列化） */
export interface Vec3 {
  x: number
  y: number
  z: number
}

/**
 * OBB（Oriented Bounding Box，有向包围盒）3D 框模型
 *
 * 它是自动驾驶标注最常用的框形式：一个可以绕竖直轴旋转的长方体。
 * - position: 框中心点坐标
 * - scale:    三个方向的尺寸。约定 x=长度(length，车头方向)，y=宽度(width)，z=高度(height)
 * - yaw:      绕竖直轴(z轴)的旋转角，弧度制。决定车头朝向
 *
 * 为什么叫"有向"？因为普通 AABB 轴对齐、不能旋转，而真实车辆是斜着停的，
 * 必须带一个朝向角才能贴合。这就是 9-DoF 里最关键的那个旋转自由度。
 */
/**
 * 目标的可见性状态（4D 时序标注的核心语义）。
 * - visible  ：本帧能直接看到并标注
 * - occluded ：目标被遮挡，框由轨迹预测/插值补出，不应算作"漏标"或参与位置精度评估
 * - predicted：目标离开视野或完全消失，Kalman 外推的预测框（coasting）
 *
 * 为什么需要它：时序质检里"中间帧缺失"既可能是漏标（错误），也可能是正常遮挡。
 * 不显式标记就无法区分——这正是生产标注平台（如 nuScenes 的 visibility_token、
 * MolarData 的遮挡状态）必做的字段。
 */
export type Visibility = 'visible' | 'occluded' | 'predicted'

export interface Box3D {
  /** 唯一标识，对应原仓库的 obj_id */
  id: string
  /** 目标类别：Car / Pedestrian / Rider / Truck ... */
  label: string
  position: Vec3
  scale: Vec3
  yaw: number
  /** 可见性，默认 visible。可选以兼容历史数据与 SUSTechPOINTS 格式 */
  visibility?: Visibility
}

/**
 * 与 SUSTechPOINTS 兼容的 label JSON 中「单个框」的结构。
 * 参考仓库 data/example/label/000970.json 的真实格式。
 */
export interface RawLabelObject {
  /** psr = Position / Scale / Rotation，原仓库作者的命名 */
  psr: {
    position: Vec3
    scale: Vec3
    rotation: { x: number; y: number; z: number }
  }
  obj_type: string
  obj_id: string
  /**
   * 8 个角点，每个角点 4 个数 [x, y, z, 1]（最后一个是齐次坐标占位）。
   * 顺序：车头面4点(底左,底右,顶右,顶左) + 车尾面4点(同序)。
   */
  vertices: number[]
  /** 扩展字段：本工具的 4D 遮挡状态。SUSTechPOINTS 会忽略未知字段，我们读回时保留 */
  visibility?: Visibility
}

/**
 * 点云数据容器。
 * - positions: 展平的 xyz 坐标 [x0,y0,z0, x1,y1,z1, ...]，长度 = count*3
 * - count: 点的数量
 * - colors: 可选，展平的 rgb 归一化到 0~1
 */
export interface PointCloud {
  positions: Float32Array
  count: number
  colors?: Float32Array
}

/** 类别配置：颜色用于区分不同类别的框 */
export interface ObjectCategory {
  name: string
  /** 0xRRGGBB */
  color: number
  /** 默认尺寸 length/width/height，新建框时的初始值 */
  defaultSize: [number, number, number]
}

/**
 * 自动驾驶坐标系约定（重点！新手最容易在这里晕）
 *
 * 本工具与 SUSTechPOINTS、KITTI 等保持一致，采用 z-up 右手系：
 *   x 轴：车辆前进方向（前）
 *   y 轴：车辆左侧方向（左）
 *   z 轴：竖直向上（上）  ← 注意 Three.js 默认是 y-up，这里要特别处理
 *
 * 因为 z 是"上"，所以相机需要设置 camera.up.set(0,0,1)，
 * 旋转 yaw 就是绕 z 轴。这个约定贯穿全文，务必记牢。
 */
export const DEFAULT_CATEGORIES: ObjectCategory[] = [
  { name: 'Car', color: 0x4fc3f7, defaultSize: [4.5, 1.8, 1.6] },
  { name: 'Truck', color: 0x9575cd, defaultSize: [8.0, 2.5, 3.0] },
  { name: 'Pedestrian', color: 0xffb74d, defaultSize: [0.7, 0.7, 1.75] },
  { name: 'Rider', color: 0xef5350, defaultSize: [2.0, 0.8, 1.7] },
  { name: 'Cyclist', color: 0x66bb6a, defaultSize: [1.8, 0.6, 1.7] },
]

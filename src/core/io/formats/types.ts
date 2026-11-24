/**
 * ============================================================
 * 标注格式适配层 —— 公共契约
 * ============================================================
 *
 * 为什么需要这一层：
 *   KITTI / DAIR-V2X / nuScenes / Waymo 描述的都是「一个 3D 框」，
 *   但字段顺序、旋转基准、坐标系、文件结构各不相同。如果每种格式
 *   都在 UI 层写一段 if，导入逻辑很快会变成一团乱麻。
 *
 * 本层把所有外部格式收敛到内部统一模型 Box3D：
 *   position  = 框中心，LiDAR 自车系（x 前、y 左、z 上）
 *   scale     = (length, width, height)，长度沿 +x
 *   yaw       = 绕 z 轴，从 +x 轴正向起算，逆时针为正
 *
 * 每个适配器只做两件事：detect（这是不是我的格式）+ parse（转成 Box3D）。
 * 这样新增数据集 = 新增一个文件，不动任何既有代码。
 */
import type { Box3D } from '../../types'

/** 支持的外部标注格式 */
export type LabelFormat = 'sustech' | 'kitti' | 'dair-v2x' | 'nuscenes' | 'waymo'

/** 一次解析被跳过的对象统计（比如 KITTI 的 DontCare） */
export interface SkippedInfo {
  reason: string
  count: number
}

export interface FormatParseResult {
  boxes: Box3D[]
  skipped: SkippedInfo[]
  /** 解析时采用的坐标/角度约定，写进状态栏便于复现与排错 */
  convention: string
}

/** 解析选项：约定可以通过 UI / 调用方覆盖，避免把「猜测」写死在代码里 */
export interface ParseOptions {
  /** 强制指定坐标系，适配器可据此选择变换；不传则用该格式的默认值 */
  frame?: 'camera' | 'lidar' | 'global'
  /** KITTI 风格 rotation 的符号翻转（不同工具链的 ry 定义偶尔相反） */
  flipYaw?: boolean
  /** 类别名映射：外部类别名 → 内部类别名。未提供时用适配器内置映射 */
  nameMap?: Record<string, string>
  /** nuScenes：token → 类别名映射（来自 categories.json），缺省用内置映射 */
  categoryTokens?: Record<string, string>
  /** nuScenes：只导入该 sample_token 下的标注，缺省导入全部 */
  sampleToken?: string
}

/** 适配器接口 */
export interface FormatAdapter {
  readonly id: LabelFormat
  readonly label: string
  /** 内容嗅探置信度 0~1。只做高置信度判断，拿不准就返回 0 */
  detect(raw: unknown, filename?: string): number
  /** 把原始内容解析为内部框；解析失败应抛 Error，由入口统一转成状态提示 */
  parse(raw: unknown, options?: ParseOptions): FormatParseResult
  /** 可选：把内部框导回该格式（目前 kitti / dair-v2x / sustech 支持） */
  serialize?(boxes: Box3D[], options?: ParseOptions): string
}

/** 自动识别后的完整结果 */
export interface AutoParseResult extends FormatParseResult {
  format: LabelFormat
  formatLabel: string
}

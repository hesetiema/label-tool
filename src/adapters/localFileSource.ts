/**
 * ============================================================
 * 适配器：本地文件数据源（File API）
 * ============================================================
 *
 * 【解决的问题】
 *   旧 `importFiles` 是"选完文件就全部解析"，500 帧 × 1.8MB = 900MB，
 *   浏览器会直接崩。这里把"文件名列表"变成 `DataSource`：
 *   打开时只建句柄，真正解码发生在 `frame(i)`。
 *
 * 【为什么标注文件要立刻读完，点云却懒加载】
 *   一个 JSON 标注几十 KB，500 帧全读也就十几 MB，而且 `TrackStore`、
 *   时间线、时序质检都需要**全部帧的框**才能建出完整轨迹。
 *   点云才是 MB 级的。所以：标注同步读全量，点云按需解码。
 *   这个划分是"能不能做 4D"的关键 —— 只懒加载点云，不影响任何 4D 能力。
 *
 * 【帧号与文件名】
 *   按文件名自然排序（`frame_2` 在 `frame_10` 前面），帧号就是排序后的下标。
 *   真实数据集常用 `000970.pcd` 这种零填充命名，自然排序与字典序一致；
 *   但 `2.pcd` / `10.pcd` 这种必须自然排序，否则时序会乱。
 */
import type { Box3D, PointCloud } from '../core/types'
import type { DataSource, FramePayload, FrameRequestOptions, SampleHandle, SampleSummary } from '../ports/dataSource'
import type { SceneMeta } from '../domain/model/scene'
import type { Calibration } from '../core/io/calibration'
import { parseCloudAsync } from './pcdParser'
import { sampleIdOf } from '../domain/model/ids'

/** 认的点云扩展名。真正用什么解析器由 core/io/cloud.ts 按内容判定，这里只管挑文件 */
export const CLOUD_FILE_RE = /\.(pcd|ply|bin)$/i

export interface LocalFilePair {
  /** 点云文件（.pcd / .ply / KITTI .bin） */
  cloud: File
  /** 同名标注（.json），可选 */
  labels?: File
}

export interface LocalSourceOptions {
  name?: string
  sceneId?: string
  /** 名义帧率，只用于 `FrameRef.ts`；真实时间戳优先 */
  nominalHz?: number
}

export interface LocalSampleHandle extends SampleHandle {
  /** 逐帧标注（导入时就已全部解析，这里只是取缓存） */
  labels(i: number): Promise<Box3D[]>
  /** 导入阶段把已解析的标注塞进缓存，避免为了拿框再读一次盘 */
  primeLabels(all: Box3D[][]): void
  fileNames(): string[]
}

/** 空点云占位：懒加载帧在解码前用它，`count === 0` 是"未加载"的唯一判据 */
export function placeholderCloud(): PointCloud {
  return { positions: new Float32Array(0), count: 0 }
}

export function isPlaceholder(cloud: PointCloud | null | undefined): boolean {
  return !cloud || cloud.count === 0
}

/** 自然排序：数字段按数值比较，避免 frame_10 排到 frame_2 前面 */
export function sortCloudFiles<T extends { name: string }>(files: T[]): T[] {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
}

/**
 * 把"用户选中的一堆文件"配成 (点云, 标注) 对。
 * 标注按去掉扩展名的文件名匹配，例如 `000970.pcd` ↔ `000970.json`。
 */
export function pairLocalFiles(files: File[]): LocalFilePair[] {
  const clouds = sortCloudFiles(files.filter((f) => CLOUD_FILE_RE.test(f.name)))
  const jsons = files.filter((f) => /\.json$/i.test(f.name))
  return clouds.map((cloud) => {
    // 标注按「去掉点云扩展名」的文件名匹配：000970.pcd ↔ 000970.json
    const stem = cloud.name.replace(CLOUD_FILE_RE, '')
    const labels = jsons.find((j) => j.name.replace(/\.json$/i, '') === stem)
    return labels ? { cloud, labels } : { cloud }
  })
}

class LocalFileHandle implements LocalSampleHandle {
  private labelCache = new Map<number, Box3D[]>()
  private closed = false

  /**
   * 背后是用户选的 File 对象，随时可以重新读盘解析。
   * 所以它的帧缓存是可再生的：配额吃紧时删掉几帧，下次切回来重解即可。
   */
  readonly reloadable = true

  constructor(
    private readonly pairs: LocalFilePair[],
    private readonly metaInfo: SceneMeta,
  ) {}

  meta(): SceneMeta {
    return this.metaInfo
  }

  async frame(i: number, opts?: FrameRequestOptions): Promise<FramePayload> {
    if (this.closed) throw new Error('数据源已关闭')
    const pair = this.pairs[i]
    if (!pair) throw new Error(`帧 ${i} 超出范围（共 ${this.pairs.length} 帧）`)
    // 读盘本身在主线程，真正的耗时在 worker 解析；优先级透传下去才能起到排队作用
    const cloud = await parseCloudAsync(await pair.cloud.arrayBuffer(), { ...opts, name: pair.cloud.name })
    return {
      ref: {
        index: i,
        ts: i / this.metaInfo.nominalHz,
        data: { lidar_top: { kind: 'inline', cloud } },
      },
      cloud,
    }
  }

  /** 标注在 openSample 时已全部解析进缓存；未匹配到 JSON 的帧返回空数组 */
  async labels(i: number): Promise<Box3D[]> {
    return this.labelCache.get(i) ?? []
  }

  /** 导入阶段调用，把已解析的标注塞进缓存（避免二次读盘） */
  primeLabels(all: Box3D[][]): void {
    all.forEach((boxes, i) => this.labelCache.set(i, boxes))
  }

  async calibrations(): Promise<Record<string, Calibration>> {
    return {}
  }

  fileNames(): string[] {
    return this.pairs.map((p) => p.cloud.name)
  }

  close(): void {
    this.closed = true
    this.labelCache.clear()
  }
}

/**
 * 句柄类型收窄：`openSample` 返回的实例多了 `labels()` 与 `primeLabels()`，
 * 直接写成 `DataSource & {...}` 会让 TS 把两个同名方法合成重载，调用处拿不到收窄类型。
 */
export interface LocalFileSource extends DataSource {
  openSample(sampleId: string): Promise<LocalSampleHandle>
}

export function createLocalFileSource(pairs: LocalFilePair[], opts: LocalSourceOptions = {}): LocalFileSource {
  const sceneId = opts.sceneId ?? 'local'
  const name = opts.name ?? pairs[0]?.cloud.name ?? '本地文件'
  const range: [number, number] = pairs.length ? [0, pairs.length - 1] : [0, 0]
  const sampleId = sampleIdOf(sceneId, range)
  const meta: SceneMeta = {
    id: sceneId,
    name,
    sensors: [{ id: 'lidar_top', kind: 'lidar' }],
    nominalHz: opts.nominalHz ?? 10,
    calibrationVersion: 'none',
  }

  return {
    id: 'local-file',
    async listSamples(): Promise<SampleSummary[]> {
      return [
        {
          sampleId,
          sceneId,
          name,
          frameRange: range,
          sensorKinds: ['lidar'],
          bytes: pairs.reduce((n, p) => n + p.cloud.size + (p.labels?.size ?? 0), 0),
        },
      ]
    },
    async openSample(id: string): Promise<LocalSampleHandle> {
      if (id !== sampleId) throw new Error(`未知样本 ${id}`)
      return new LocalFileHandle(pairs, meta)
    },
  }
}

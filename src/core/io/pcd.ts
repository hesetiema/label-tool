/**
 * ============================================================
 * PCD 解析器 —— 理解点云数据格式的最佳入口
 * ============================================================
 *
 * PCD (Point Cloud Data) 是 PCL（Point Cloud Library）定义的一种格式，
 * 由「文本头 + 数据块」两部分组成。一个典型文件长这样：
 *
 *   # .PCD v0.7 - Point Cloud Data file format
 *   VERSION 0.7
 *   FIELDS x y z intensity        ← 有哪些字段
 *   SIZE 4 4 4 4                 ← 每个字段占几字节
 *   TYPE F F F F                 ← F=浮点 U=无符号 I=有符号
 *   COUNT 1 1 1 1
 *   WIDTH 100000                  ← 点数（无序点云时 WIDTH=点数, HEIGHT=1）
 *   HEIGHT 1
 *   VIEWPOINT 0 0 0 1 0 0 0
 *   POINTS 100000
 *   DATA binary                   ← 数据编码：ascii / binary / binary_compressed
 *
 * 我们这里支持 ascii 与 binary 两种（覆盖绝大多数场景）。
 * 教学版刻意写得直白，方便你看懂每行在做什么。
 */
import type { PointCloud } from '../types'

interface PcdHeader {
  fields: string[]
  size: number[]
  type: string[]
  count: number[]
  width: number
  height: number
  points: number
  /** 每个点占用的字节数，由 size*count 累加得到 */
  pointStep: number
  /** 数据段在 ArrayBuffer 中的起始字节偏移 */
  dataOffset: number
  encoding: 'ascii' | 'binary' | 'binary_compressed'
  /** 各字段在点云记录内的字节偏移，用于定位 x/y/z/rgb */
  offsets: Record<string, number>
}

/** 逐行解析文本头，返回元信息 */
function parseHeader(text: string): PcdHeader {
  const lines = text.split(/\r?\n/)
  const kv: Record<string, string[]> = {}
  let dataLineIndex = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    const key = parts[0]
    if (key === 'DATA') {
      kv[key] = [parts[1]]
      dataLineIndex = i
      break // DATA 之后就是二进制数据，不能再按文本解析
    }
    kv[key] = parts.slice(1)
  }

  const fields = kv.FIELDS ?? ['x', 'y', 'z']
  const size = (kv.SIZE ?? fields.map(() => '4')).map(Number)
  const type = kv.TYPE ?? fields.map(() => 'F')
  const count = (kv.COUNT ?? fields.map(() => '1')).map(Number)

  // 计算每个字段的字节偏移。例如 x:0, y:4, z:8, intensity:12
  const offsets: Record<string, number> = {}
  let acc = 0
  fields.forEach((f, i) => {
    offsets[f] = acc
    acc += size[i] * count[i]
  })

  // 文本头结束的字节位置 = DATA 行之后第一个换行符的下一个字节
  // 用累计字符长度求偏移（头部均为 ASCII，1 字符 = 1 字节）
  let headerByteLen = 0
  for (let i = 0; i <= dataLineIndex; i++) headerByteLen += lines[i].length + 1

  return {
    fields,
    size,
    type,
    count,
    width: Number(kv.WIDTH?.[0] ?? 0),
    height: Number(kv.HEIGHT?.[0] ?? 1),
    points: Number(kv.POINTS?.[0] ?? 0),
    pointStep: acc,
    dataOffset: headerByteLen,
    encoding: (kv.DATA?.[0] ?? 'ascii') as PcdHeader['encoding'],
    offsets,
  }
}

/**
 * 解析 PCD 文件的主入口。
 * @param buffer 文件的原始 ArrayBuffer
 */
export function parsePCD(buffer: ArrayBuffer): PointCloud {
  // 先只把头部当文本读出来（用一个 TextDecoder 解码前若干字节即可）
  const headText = new TextDecoder('utf-8').decode(new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 4096)))
  const header = parseHeader(headText)

  const { points, fields, offsets, size, type, pointStep } = header
  const positions = new Float32Array(points * 3)
  let colors: Float32Array | undefined

  const ix = fields.indexOf('x')
  const iy = fields.indexOf('y')
  const iz = fields.indexOf('z')
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PCD 缺少 x/y/z 字段')

  const hasColor = fields.includes('rgb') || fields.includes('rgba')
  if (hasColor) colors = new Float32Array(points * 3)

  if (header.encoding === 'ascii') {
    // ---- ASCII：按空白切分，每个点一行 ----
    const body = new TextDecoder('utf-8').decode(new Uint8Array(buffer, header.dataOffset))
    const tokens = body.split(/\s+/).filter(Boolean)
    for (let i = 0; i < points; i++) {
      const base = i * fields.length
      positions[i * 3] = Number(tokens[base + ix])
      positions[i * 3 + 1] = Number(tokens[base + iy])
      positions[i * 3 + 2] = Number(tokens[base + iz])
    }
  } else if (header.encoding === 'binary') {
    // ---- BINARY：按 pointStep 步进，用 DataView 按类型读取 ----
    const view = new DataView(buffer)
    const readNum = (byteOffset: number, fieldIdx: number): number => {
      const littleEndian = true
      const t = type[fieldIdx]
      if (t === 'F') return size[fieldIdx] === 4 ? view.getFloat32(byteOffset, littleEndian) : view.getFloat64(byteOffset, littleEndian)
      if (t === 'U') return size[fieldIdx] === 1 ? view.getUint8(byteOffset) : view.getUint32(byteOffset, littleEndian)
      return size[fieldIdx] === 1 ? view.getInt8(byteOffset) : view.getInt32(byteOffset, littleEndian)
    }
    for (let i = 0; i < points; i++) {
      const rowStart = header.dataOffset + i * pointStep
      positions[i * 3] = readNum(rowStart + offsets.x, ix)
      positions[i * 3 + 1] = readNum(rowStart + offsets.y, iy)
      positions[i * 3 + 2] = readNum(rowStart + offsets.z, iz)
    }
  } else {
    throw new Error('binary_compressed 编码暂未支持，请转换为 ascii 或 binary')
  }

  return { positions, count: points, colors }
}

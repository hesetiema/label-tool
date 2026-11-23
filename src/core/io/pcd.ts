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
 *
 * 【两个容易踩的坑，本文件已专门处理】
 *  1. 头部字节偏移不能按「行数 + 换行符」估算：Windows 导出的是 CRLF，
 *     每行多一个 \r，估出来的偏移会少算 N 字节，binary 数据整体错位。
 *     正确做法是在字节层面找到 DATA 行的 \n，偏移就是它后面一个字节。
 *  2. COUNT > 1 的填充字段：PCD 允许一个字段占多个分量（例如 SUSTechPOINTS
 *     样例里的 `_` 字段）。ASCII 的每点 token 数应该按 sum(COUNT) 算，
 *     而不是按字段个数算，否则读出来的 x/y/z 全是错位的。
 */
import type { PointCloud } from '../types'

interface PcdHeader {
  fields: string[]
  size: number[]
  type: string[]
  count: number[]
  /** 每个点占用的字节数，由 size*count 累加得到 */
  pointStep: number
  /** 每个字段第一个分量在「一个点」内的 token 下标（ASCII 用） */
  tokenOffset: number[]
  /** 每个字段第一个分量在「一个点」内的字节偏移 */
  byteOffset: number[]
  points: number
  encoding: 'ascii' | 'binary' | 'binary_compressed'
}

const decoder = new TextDecoder('utf-8')

/**
 * 在字节层面定位 DATA 行，返回头部文本与数据段起始字节。
 * 逐行扫描的好处：天然兼容 LF / CRLF，也不依赖「头部不超过 4096 字节」的假设。
 */
function locateHeader(bytes: Uint8Array): { headText: string; dataOffset: number } {
  let lineStart = 0
  // 头部一般只有几百字节；给到 1MB 已经远超任何正常 PCD
  const limit = Math.min(bytes.length, 1 << 20)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 10) continue // '\n'
    const line = decoder.decode(bytes.subarray(lineStart, i)).trim()
    if (/^DATA\s+/i.test(line)) {
      return {
        headText: decoder.decode(bytes.subarray(0, i)),
        dataOffset: i + 1,
      }
    }
    lineStart = i + 1
  }
  throw new Error('PCD 头部缺少 DATA 行，文件可能损坏')
}

/** 逐行解析文本头，返回元信息 */
function parseHeader(text: string): PcdHeader {
  const kv: Record<string, string[]> = {}

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const parts = line.split(/\s+/)
    kv[parts[0].toUpperCase()] = parts.slice(1)
  }

  const fields = kv.FIELDS ?? ['x', 'y', 'z']
  const size = (kv.SIZE ?? fields.map(() => '4')).map(Number)
  const type = (kv.TYPE ?? fields.map(() => 'F')).map((t) => t.toUpperCase())
  const count = (kv.COUNT ?? fields.map(() => '1')).map(Number)

  // 一个点内每个字段的字节偏移与 token 偏移
  const byteOffset: number[] = []
  const tokenOffset: number[] = []
  let byteAcc = 0
  let tokenAcc = 0
  fields.forEach((_f, i) => {
    byteOffset[i] = byteAcc
    tokenOffset[i] = tokenAcc
    byteAcc += size[i] * count[i]
    tokenAcc += count[i]
  })

  const width = Number(kv.WIDTH?.[0] ?? 0)
  const height = Number(kv.HEIGHT?.[0] ?? 1)
  // POINTS 偶尔缺失，用 WIDTH*HEIGHT 兜底
  const points = Number(kv.POINTS?.[0] ?? width * height)

  return {
    fields,
    size,
    type,
    count,
    pointStep: byteAcc,
    tokenOffset,
    byteOffset,
    points,
    encoding: (kv.DATA?.[0] ?? 'ascii').toLowerCase() as PcdHeader['encoding'],
  }
}

/** 按 TYPE/SIZE 读取一个数值（binary 用） */
function readNumber(view: DataView, byteOffset: number, type: string, size: number): number {
  const le = true
  if (type === 'F') {
    if (size === 4) return view.getFloat32(byteOffset, le)
    if (size === 8) return view.getFloat64(byteOffset, le)
    return 0
  }
  if (type === 'U') {
    if (size === 1) return view.getUint8(byteOffset)
    if (size === 2) return view.getUint16(byteOffset, le)
    if (size === 4) return view.getUint32(byteOffset, le)
    return 0
  }
  // I（有符号）
  if (size === 1) return view.getInt8(byteOffset)
  if (size === 2) return view.getInt16(byteOffset, le)
  if (size === 4) return view.getInt32(byteOffset, le)
  return 0
}

/**
 * PCD 的 rgb 字段通常是「把 0x00RRGGBB 塞进一个 float32」的写法（PCL 的历史包袱），
 * 也可能是 uint32。两种都不是真正的浮点颜色，所以直接按 4 字节无符号整数取。
 */
function unpackRgb(view: DataView, byteOffset: number): [number, number, number] {
  const v = view.getUint32(byteOffset, true)
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255]
}

/**
 * 解析 PCD 文件的主入口。
 * @param buffer 文件的原始 ArrayBuffer
 */
export function parsePCD(buffer: ArrayBuffer): PointCloud {
  const bytes = new Uint8Array(buffer)
  const { headText, dataOffset } = locateHeader(bytes)
  const header = parseHeader(headText)

  const { points, fields, count, size, type, pointStep, byteOffset, tokenOffset } = header
  if (!points || points < 0) throw new Error('PCD 未声明有效点数（POINTS / WIDTH）')

  const positions = new Float32Array(points * 3)
  let colors: Float32Array | undefined

  const ix = fields.indexOf('x')
  const iy = fields.indexOf('y')
  const iz = fields.indexOf('z')
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PCD 缺少 x/y/z 字段')

  const colorIdx = fields.findIndex((f) => f === 'rgb' || f === 'rgba')
  if (colorIdx >= 0) colors = new Float32Array(points * 3)

  if (header.encoding === 'ascii') {
    // ---- ASCII：按空白切分，每个点 stride 个 token（stride = sum(COUNT)）----
    const stride = count.reduce((a, b) => a + b, 0)
    const body = decoder.decode(bytes.subarray(dataOffset))
    const tokens = body.split(/\s+/)
    for (let i = 0; i < points; i++) {
      const base = i * stride
      positions[i * 3] = Number(tokens[base + tokenOffset[ix]])
      positions[i * 3 + 1] = Number(tokens[base + tokenOffset[iy]])
      positions[i * 3 + 2] = Number(tokens[base + tokenOffset[iz]])
    }
  } else if (header.encoding === 'binary') {
    // ---- BINARY：按 pointStep 步进，用 DataView 按类型读取 ----
    const view = new DataView(buffer)
    for (let i = 0; i < points; i++) {
      const rowStart = dataOffset + i * pointStep
      // 数据段比声明短时提前结束，避免抛 RangeError 整个文件打不开
      if (rowStart + pointStep > buffer.byteLength) {
        positions.fill(0, i * 3)
        break
      }
      positions[i * 3] = readNumber(view, rowStart + byteOffset[ix], type[ix], size[ix])
      positions[i * 3 + 1] = readNumber(view, rowStart + byteOffset[iy], type[iy], size[iy])
      positions[i * 3 + 2] = readNumber(view, rowStart + byteOffset[iz], type[iz], size[iz])
      if (colors && colorIdx >= 0) {
        const [r, g, b] = unpackRgb(view, rowStart + byteOffset[colorIdx])
        colors[i * 3] = r
        colors[i * 3 + 1] = g
        colors[i * 3 + 2] = b
      }
    }
  } else {
    throw new Error('binary_compressed 编码暂未支持，请用 PCL 转存为 ascii 或 binary')
  }

  return { positions, count: points, colors }
}

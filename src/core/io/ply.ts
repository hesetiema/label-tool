/**
 * ============================================================
 * PLY（Polygon File Format）解析器
 * ============================================================
 *
 * PLY 是斯坦福那套「可读文本头 + 数据区」的格式，头部长这样：
 *
 *   ply
 *   format binary_little_endian 1.0
 *   comment exported by CloudCompare
 *   element vertex 100000
 *   property float x
 *   property float y
 *   property float z
 *   property uchar red
 *   property uchar green
 *   property uchar blue
 *   element face 0
 *   property list uchar int vertex_indices
 *   end_header
 *
 * 相比 PCD，它的坑更多：
 *  1. **属性顺序不固定**：x/y/z 可能夹在 normal_x、curvature 之间，
 *     所以不能按「前三个属性就是坐标」读，必须按名字查偏移。
 *  2. **类型不固定**：坐标可能是 float32 也可能是 float64，
 *     颜色既可能是 `uchar` 0~255 也可能是 `float` 0~1。
 *  3. **可以有多段 element**：`vertex` 后面常有 `face`（三角面片），
 *     我们只要顶点，但 binary 下必须知道 face 段占多少字节才不会读错位 ——
 *     所以下面按 element 顺序累加偏移，跳过不认识的段。
 *  4. `format binary_big_endian` 我们在浏览器里几乎见不到（大端机器导出的），
 *     直接给一句明确报错，比默默读出一堆乱点好。
 *
 * 只支持 `ascii` 与 `binary_little_endian`：这两者覆盖了 CloudCompare /
 * Open3D / MeshLab 的默认导出，剩下的换算成本高收益低。
 */
import type { PointCloud } from '../types'

/** PLY 标量类型 → [字节数, 读法] */
const SCALAR_SIZES: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
}

interface PlyProperty {
  name: string
  /** 小写类型名 */
  type: string
  /** list 属性的元素个数类型（只有 face 这类才会有），标量属性为 null */
  listCountType: string | null
}

interface PlyElement {
  name: string
  count: number
  props: PlyProperty[]
}

const decoder = new TextDecoder('utf-8')

/** 逐行扫描头部，返回头部文本与数据段起始字节（与 pcd.ts 同一套路，兼容 CRLF） */
function locateHeader(bytes: Uint8Array): { headText: string; dataOffset: number } {
  let lineStart = 0
  const limit = Math.min(bytes.length, 1 << 20)
  for (let i = 0; i < limit; i++) {
    if (bytes[i] !== 10) continue
    const line = decoder.decode(bytes.subarray(lineStart, i)).trim()
    if (/^end_header\b/i.test(line)) {
      return { headText: decoder.decode(bytes.subarray(0, i)), dataOffset: i + 1 }
    }
    lineStart = i + 1
  }
  throw new Error('PLY 头部缺少 end_header，文件可能损坏')
}

function parseHeader(text: string): { encoding: 'ascii' | 'binary_little_endian'; elements: PlyElement[] } {
  const lines = text.split(/\r?\n/)
  if (!/^ply\s*$/i.test((lines[0] ?? '').trim())) throw new Error('不是 PLY 文件（首行应为 ply）')

  let encoding: 'ascii' | 'binary_little_endian' | null = null
  const elements: PlyElement[] = []

  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    if (!line || line.startsWith('comment') || line.startsWith('obj_info')) continue
    const parts = line.split(/\s+/)
    const key = parts[0].toLowerCase()

    if (key === 'format') {
      const fmt = (parts[1] ?? '').toLowerCase()
      if (fmt === 'binary_big_endian') {
        throw new Error('暂不支持 PLY 的 binary_big_endian 编码，请用 CloudCompare 转存为 binary_little_endian')
      }
      if (fmt !== 'ascii' && fmt !== 'binary_little_endian') {
        throw new Error(`未知的 PLY 编码：${fmt || '(缺失)'}`)
      }
      encoding = fmt
      continue
    }
    if (key === 'element') {
      elements.push({ name: (parts[1] ?? '').toLowerCase(), count: Number(parts[2] ?? 0), props: [] })
      continue
    }
    if (key === 'property') {
      const target = elements[elements.length - 1]
      if (!target) throw new Error('PLY 头部里 property 出现在 element 之前')
      if ((parts[1] ?? '').toLowerCase() === 'list') {
        // list 属性（面片索引）：类型是 [个数类型, 元素类型, 名字]
        target.props.push({
          name: (parts[4] ?? '').toLowerCase(),
          type: (parts[3] ?? '').toLowerCase(),
          listCountType: (parts[2] ?? '').toLowerCase(),
        })
      } else {
        target.props.push({
          name: (parts[2] ?? '').toLowerCase(),
          type: (parts[1] ?? '').toLowerCase(),
          listCountType: null,
        })
      }
    }
  }

  if (!encoding) throw new Error('PLY 头部缺少 format 行')
  return { encoding, elements }
}

/** 一个 element 里一条记录占的字节数；list 属性无法定长，返回 -1 */
function recordStride(elem: PlyElement): number {
  let size = 0
  for (const p of elem.props) {
    if (p.listCountType) return -1
    const s = SCALAR_SIZES[p.type]
    if (!s) throw new Error(`PLY 里出现未知属性类型：${p.type}`)
    size += s
  }
  return size
}

/** 按类型从 DataView 读一个标量（PLY binary 是小端） */
function readScalar(view: DataView, offset: number, type: string): number {
  switch (type) {
    case 'char':
    case 'int8':
      return view.getInt8(offset)
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset)
    case 'short':
    case 'int16':
      return view.getInt16(offset, true)
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, true)
    case 'int':
    case 'int32':
      return view.getInt32(offset, true)
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, true)
    case 'float':
    case 'float32':
      return view.getFloat32(offset, true)
    case 'double':
    case 'float64':
      return view.getFloat64(offset, true)
    default:
      return 0
  }
}

/** 颜色分量归一化：uchar 走 /255，float 的 0~1 原样，0~255 的也认 */
function normalizeColor(value: number, type: string): number {
  if (SCALAR_SIZES[type] === 1) return value / 255
  if (!Number.isFinite(value)) return 0
  return value > 1 ? value / 255 : value
}

const X_NAMES = ['x']
const Y_NAMES = ['y']
const Z_NAMES = ['z']
const INTENSITY_NAMES = ['intensity', 'scalar_intensity', 'reflectance', 'quality']
const RED_NAMES = ['red', 'r', 'diffuse_red']
const GREEN_NAMES = ['green', 'g', 'diffuse_green']
const BLUE_NAMES = ['blue', 'b', 'diffuse_blue']

/** 取三元组里第一个存在的属性名（`red` → `r` → `diffuse_red` 这种回退顺序） */
function pickProp(elem: PlyElement, names: string[]): number {
  for (const n of names) {
    const i = elem.props.findIndex((p) => p.name === n)
    if (i >= 0) return i
  }
  return -1
}

/**
 * 解析 PLY 点云。
 * 只读 `vertex` 段，其余段（face / edge）按字节或 token 跳过。
 */
export function parsePLY(buffer: ArrayBuffer): PointCloud {
  const bytes = new Uint8Array(buffer)
  const { headText, dataOffset } = locateHeader(bytes)
  const { encoding, elements } = parseHeader(headText)

  const vertexIndex = elements.findIndex((e) => e.name === 'vertex')
  if (vertexIndex < 0) throw new Error('PLY 里没有 vertex 段')
  const vertex = elements[vertexIndex]
  if (!vertex.count || vertex.count <= 0) throw new Error('PLY 的 vertex 数为 0')

  const ix = pickProp(vertex, X_NAMES)
  const iy = pickProp(vertex, Y_NAMES)
  const iz = pickProp(vertex, Z_NAMES)
  if (ix < 0 || iy < 0 || iz < 0) throw new Error('PLY 的 vertex 缺少 x/y/z 属性')

  const iIntensity = pickProp(vertex, INTENSITY_NAMES)
  const iR = pickProp(vertex, RED_NAMES)
  const iG = pickProp(vertex, GREEN_NAMES)
  const iB = pickProp(vertex, BLUE_NAMES)
  const hasColor = iR >= 0 && iG >= 0 && iB >= 0

  // 顶点数同样是不可信输入：先按数据段能容纳的记录数收紧，避免恶意/损坏的
  // `element vertex 1e9` 直接触发巨额分配
  const dataBytes = Math.max(0, buffer.byteLength - dataOffset)
  const stride = recordStride(vertex)
  let count = vertex.count
  if (encoding === 'binary_little_endian') {
    if (stride > 0) count = Math.min(count, Math.floor(dataBytes / stride))
  } else {
    // ascii 一个 token 至少 2 字节，按属性数估上界
    count = Math.min(count, Math.floor(dataBytes / Math.max(1, 2 * vertex.props.length)))
  }
  if (count <= 0) throw new Error('PLY 的 vertex 数据段为空')

  const positions = new Float32Array(count * 3)
  const colors = hasColor ? new Float32Array(count * 3) : undefined
  const intensity = iIntensity >= 0 ? new Float32Array(count) : undefined

  let w = 0

  if (encoding === 'ascii') {
    const tokens = decoder.decode(bytes.subarray(dataOffset)).split(/\s+/)
    // vertex 之前的 element 也要消耗 token，否则整段错位
    let cursor = 0
    for (let e = 0; e < vertexIndex; e++) {
      const prev = elements[e]
      cursor += prev.count * Math.max(1, prev.props.length)
    }
    const perPoint = Math.max(1, vertex.props.length)
    for (let vi = 0; vi < count; vi++) {
      const base = cursor + vi * perPoint
      const x = Number(tokens[base + ix])
      const y = Number(tokens[base + iy])
      const z = Number(tokens[base + iz])
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      positions[w * 3] = x
      positions[w * 3 + 1] = y
      positions[w * 3 + 2] = z
      if (colors && hasColor) {
        colors[w * 3] = normalizeColor(Number(tokens[base + iR]), vertex.props[iR].type)
        colors[w * 3 + 1] = normalizeColor(Number(tokens[base + iG]), vertex.props[iG].type)
        colors[w * 3 + 2] = normalizeColor(Number(tokens[base + iB]), vertex.props[iB].type)
      }
      if (intensity) intensity[w] = Number(tokens[base + iIntensity])
      w++
    }
  } else {
    const view = new DataView(buffer)
    // 每个属性在一个顶点记录内的字节偏移
    const offsets: number[] = []
    let acc = 0
    for (const p of vertex.props) {
      offsets.push(acc)
      acc += SCALAR_SIZES[p.type] ?? 0
    }
    let cursor = dataOffset
    // 跳过 vertex 之前的 element（它们可能是定长的，也可能是 list —— 后者直接用
    // recordStride 的 -1 报错，让用户先转换，比读出错位数据好）
    for (let e = 0; e < vertexIndex; e++) {
      const prev = elements[e]
      const s = recordStride(prev)
      if (s < 0) throw new Error(`PLY 的 ${prev.name} 段含 list 属性且排在 vertex 之前，暂不支持`)
      cursor += s * prev.count
    }
    const step = recordStride(vertex)
    if (step <= 0) throw new Error('PLY 的 vertex 段含 list 属性，暂不支持')
    for (let vi = 0; vi < count; vi++) {
      const row = cursor + vi * step
      if (row + step > buffer.byteLength) break
      const x = readScalar(view, row + offsets[ix], vertex.props[ix].type)
      const y = readScalar(view, row + offsets[iy], vertex.props[iy].type)
      const z = readScalar(view, row + offsets[iz], vertex.props[iz].type)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      positions[w * 3] = x
      positions[w * 3 + 1] = y
      positions[w * 3 + 2] = z
      if (colors && hasColor) {
        colors[w * 3] = normalizeColor(
          readScalar(view, row + offsets[iR], vertex.props[iR].type),
          vertex.props[iR].type,
        )
        colors[w * 3 + 1] = normalizeColor(
          readScalar(view, row + offsets[iG], vertex.props[iG].type),
          vertex.props[iG].type,
        )
        colors[w * 3 + 2] = normalizeColor(
          readScalar(view, row + offsets[iB], vertex.props[iB].type),
          vertex.props[iB].type,
        )
      }
      if (intensity) intensity[w] = readScalar(view, row + offsets[iIntensity], vertex.props[iIntensity].type)
      w++
    }
  }

  if (w === 0) throw new Error('PLY 里没有有效点（全部是 nan 或字段缺失）')
  if (w === count) return { positions, count: w, colors, intensity }
  return {
    positions: positions.slice(0, w * 3),
    count: w,
    colors: colors?.slice(0, w * 3),
    intensity: intensity?.slice(0, w),
  }
}

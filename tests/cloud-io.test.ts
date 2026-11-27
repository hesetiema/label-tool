/**
 * ============================================================
 * 点云读取：PCD / PLY / KITTI .bin 与标量着色
 * ============================================================
 *
 * 这一支单独成文件，因为它测的是"文件进得来"这件事：
 * `core/io/cloud.ts` 的分发、两个新解析器（`ply.ts` / `bin.ts`）、
 * 以及 `intensity` 贯通后 `core/geometry/colorize.ts` 的取色。
 *
 * 断言风格与其它用例一致（tests/harness.ts 的 check/finish），
 * 好处是失败时只打印不中断，一次能看全所有问题。
 */
import { it } from 'vitest'
import { createChecker } from './harness.ts'
import { parsePCD } from '../src/core/io/pcd.ts'
import { parsePLY } from '../src/core/io/ply.ts'
import { parseVelodyneBin, binStride } from '../src/core/io/bin.ts'
import { detectCloudFormat, parseCloudBuffer, cloudFormatOfName } from '../src/core/io/cloud.ts'
import { cloudColorsFor, heightsOf, rampColor, scalarColors, scalarRange } from '../src/core/geometry/colorize.ts'

const { check, finish } = createChecker()
const enc = new TextEncoder()

function ab(text: string): ArrayBuffer {
  const bytes = enc.encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** 拼一个二进制 buffer：先把各段写进一个数组，最后一次拷成 ArrayBuffer */
function abFrom(parts: (ArrayBufferView | number[])[]): ArrayBuffer {
  const chunks = parts.map((p) =>
    Array.isArray(p) ? new Uint8Array(p) : new Uint8Array(p.buffer, p.byteOffset, p.byteLength),
  )
  const total = chunks.reduce((n, c) => n + c.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out.buffer
}

const f32 = (...values: number[]) => new Float32Array(values)
const u8 = (...values: number[]) => new Uint8Array(values)

// ---------------------------------------------------------------
console.log('\n[1] PCD：intensity 字段被读出并保持与坐标同长')
{
  const pcd = [
    '# .PCD v0.7 - Point Cloud Data file format',
    'VERSION 0.7',
    'FIELDS x y z intensity',
    'SIZE 4 4 4 4',
    'TYPE F F F F',
    'COUNT 1 1 1 1',
    'WIDTH 3',
    'HEIGHT 1',
    'POINTS 3',
    'DATA ascii',
    '1 2 3 0.25',
    '4 5 6 0.5',
    '7 8 9 0.75',
    '',
  ].join('\n')
  const cloud = parsePCD(ab(pcd))
  check('intensity 被解析出来', !!cloud.intensity, String(cloud.intensity))
  check('intensity 长度 = 点数', cloud.intensity?.length === 3)
  check('intensity 值正确', cloud.intensity?.[1] === 0.5, String(cloud.intensity?.[1]))
  check('坐标仍然正确', cloud.positions[7] === 8 && cloud.count === 3)
}

// ---------------------------------------------------------------
console.log('\n[2] KITTI .bin：每点 4 个 float（xyz + 反射率）')
{
  const buf = abFrom([f32(1, 2, 3, 0.9, -4, 5, 6, 0.1)])
  check('步长推测为 4', binStride(buf) === 4)
  const cloud = parseVelodyneBin(buf)
  check('点数 = 2', cloud.count === 2, String(cloud.count))
  check('第二点 x = -4', cloud.positions[3] === -4)
  check('强度数组存在', !!cloud.intensity)
  // Float32Array 存 0.1 会得到 0.10000000149011612，所以一律按误差比较，
  // 不要用 === 断言 float 字面量。
  check('第二点强度 = 0.1', Math.abs((cloud.intensity?.[1] ?? 0) - 0.1) < 1e-6, String(cloud.intensity?.[1]))
}

console.log('\n[3] KITTI .bin：每点 3 个 float 也能读（没有强度）')
{
  const buf = abFrom([f32(1, 2, 3, 4, 5, 6)])
  check('步长推测为 3', binStride(buf) === 3)
  const cloud = parseVelodyneBin(buf)
  check('点数 = 2', cloud.count === 2)
  check('没有 intensity 字段', cloud.intensity === undefined)
  check('第二点 y = 5', cloud.positions[4] === 5)
}

console.log('\n[4] KITTI .bin：非法输入')
{
  let msg = ''
  try {
    parseVelodyneBin(abFrom([u8(1, 2, 3, 4, 5)])) // 5 字节，不是 4 的倍数
  } catch (err) {
    msg = (err as Error).message
  }
  check('字节数不整除时报错', msg.includes('不是 float32 点云'), msg)

  let empty = ''
  try {
    parseVelodyneBin(new ArrayBuffer(0))
  } catch (err) {
    empty = (err as Error).message
  }
  check('空文件报错', empty.includes('空的'), empty)

  // 一个 NaN 点应被剔除，而不是让整个点云消失
  const withNan = abFrom([f32(1, 2, 3, 0, Number.NaN, 0, 0, 0)])
  const cloud = parseVelodyneBin(withNan)
  check('NaN 点被剔除', cloud.count === 1, String(cloud.count))
}

// ---------------------------------------------------------------
console.log('\n[5] PLY：ascii + uchar 颜色 + 额外属性乱序')
{
  const ply = [
    'ply',
    'format ascii 1.0',
    'comment 故意把 y 放在中间，验证按名字查偏移',
    'element vertex 2',
    'property float x',
    'property uchar red',
    'property float y',
    'property uchar green',
    'property float z',
    'property uchar blue',
    'element face 0',
    'property list uchar int vertex_indices',
    'end_header',
    '1 255 2 0 3 0',
    '-4 0 5 128 -6 255',
    '',
  ].join('\n')
  const cloud = parsePLY(ab(ply))
  check('点数 = 2', cloud.count === 2, String(cloud.count))
  check(
    '坐标按名字读取（x=1,y=2,z=3）',
    cloud.positions[0] === 1 && cloud.positions[1] === 2 && cloud.positions[2] === 3,
  )
  check(
    '颜色归一化到 0~1',
    cloud.colors?.[0] === 1 && cloud.colors?.[1] === 0,
    JSON.stringify(cloud.colors?.slice(0, 3)),
  )
  // 128/255 在 Float32 里是 0.501960813999176，不是 double 的 0.5019607843137255
  check('第二点颜色正确', Math.abs((cloud.colors?.[4] ?? 0) - 128 / 255) < 1e-6, String(cloud.colors?.[4]))
}

console.log('\n[6] PLY：binary_little_endian + intensity + 尾部 face 段')
{
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'element vertex 2',
    'property float x',
    'property float y',
    'property float z',
    'property float intensity',
    'element face 1',
    'property list uchar int vertex_indices',
    'end_header',
    '',
  ].join('\n')
  const buf = abFrom([
    enc.encode(header),
    f32(1, 2, 3, 0.5, 4, 5, 6, 0.75),
    // 一个三角面片：3 个索引（1 字节个数 + 3×4 字节）
    u8(3),
    new Int32Array([0, 1, 1]),
  ])
  const cloud = parsePLY(buf)
  check('点数 = 2（face 段不影响顶点）', cloud.count === 2, String(cloud.count))
  check('第二点 z = 6', cloud.positions[5] === 6)
  check('intensity 读出来了', cloud.intensity?.[1] === 0.75, String(cloud.intensity?.[1]))
}

console.log('\n[7] PLY：不支持的编码 / 缺字段 给出可执行报错')
{
  let big = ''
  try {
    parsePLY(ab('ply\nformat binary_big_endian 1.0\nelement vertex 1\nproperty float x\nend_header\n'))
  } catch (err) {
    big = (err as Error).message
  }
  check('大端报错并给出转换建议', big.includes('binary_big_endian') && big.includes('CloudCompare'), big)

  let noXyz = ''
  try {
    parsePLY(ab('ply\nformat ascii 1.0\nelement vertex 1\nproperty float u\nproperty float v\nend_header\n1 2\n'))
  } catch (err) {
    noXyz = (err as Error).message
  }
  check('缺 x/y/z 报错', noXyz.includes('x/y/z'), noXyz)

  let notPly = ''
  try {
    parsePLY(ab('ply-ish but no header'))
  } catch (err) {
    notPly = (err as Error).message
  }
  check('缺 end_header 报错', notPly.includes('end_header'), notPly)
}

// ---------------------------------------------------------------
console.log('\n[8] 格式分发：内容优先于扩展名')
{
  const plyBuf = ab(
    'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n1 2 3\n',
  )
  const pcdBuf = ab(
    '# .PCD v0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\nCOUNT 1 1 1\nWIDTH 1\nPOINTS 1\nDATA ascii\n1 2 3\n',
  )
  const binBuf = abFrom([f32(1, 2, 3, 0)])

  check('PLY 靠魔数识别', detectCloudFormat(plyBuf, 'actually-a-pcd.pcd') === 'ply')
  check('PCD 靠 FIELDS/DATA 行识别', detectCloudFormat(pcdBuf, 'noext') === 'pcd')
  check('.bin 靠扩展名 + 字节数兜底', detectCloudFormat(binBuf, '000000.bin') === 'bin')
  check('扩展名解析', cloudFormatOfName('a.PLY') === 'ply' && cloudFormatOfName('a.bin') === 'bin')
  check('未知扩展名返回 null', cloudFormatOfName('a.txt') === null)

  let unknown = ''
  try {
    detectCloudFormat(abFrom([u8(1, 2, 3)]))
  } catch (err) {
    unknown = (err as Error).message
  }
  check('认不出的数据直接报错而不是硬读', unknown.includes('无法识别的点云格式'), unknown)

  check('parseCloudBuffer 分发到 PLY', parseCloudBuffer(plyBuf, { name: 'x.ply' }).count === 1)
  check('parseCloudBuffer 分发到 PCD', parseCloudBuffer(pcdBuf, { name: 'x.pcd' }).count === 1)
  check('parseCloudBuffer 分发到 .bin', parseCloudBuffer(binBuf, { name: 'x.bin' }).count === 1)
  check('显式指定 format 时跳过嗅探', parseCloudBuffer(binBuf, { format: 'bin' }).count === 1)

  let emptyBuf = ''
  try {
    parseCloudBuffer(new ArrayBuffer(0))
  } catch (err) {
    emptyBuf = (err as Error).message
  }
  check('空 buffer 报错', emptyBuf.includes('空的'), emptyBuf)
}

// ---------------------------------------------------------------
console.log('\n[9] 标量着色：色带、分位裁剪、高度提取')
{
  const [r0, _g0, b0] = rampColor(0, 'turbo')
  const [r1, , b1] = rampColor(1, 'turbo')
  check('色带两端颜色不同', r0 !== r1 || b0 !== b1)
  check('越界的 t 被夹到端点', JSON.stringify(rampColor(2, 'turbo')) === JSON.stringify(rampColor(1, 'turbo')))
  check('g 分量在中间段更高', rampColor(0.5, 'turbo')[1] > rampColor(0.05, 'turbo')[1])

  // 1000 个值里塞两个离群点：分位裁剪应把它们排除在范围外
  const values = new Float32Array(1000)
  values[0] = -1e6
  values[1] = 1e6
  for (let i = 2; i < 1000; i++) values[i] = i % 100
  const range = scalarRange(values, 0.02)
  check('分位裁剪挡住离群点', range.min > -1000 && range.max < 1000, JSON.stringify(range))

  const colors = scalarColors(values)
  check('颜色数组长度 = 点数 × 3', colors.length === values.length * 3)
  // 逐点扫描没法证明"颜色随标量变化"：上面这批值大多挤在色带左端，
  // 相邻点同色本来就是对的。改成用 5 个均匀铺开的标量看是否 5 种颜色，
  // 再单独确认色带两处不同位置确实不同色。
  const spread = scalarColors(f32(0, 25, 50, 75, 100))
  const seen = new Set<string>()
  for (let i = 0; i < 5; i++) {
    seen.add(`${spread[i * 3].toFixed(3)},${spread[i * 3 + 1].toFixed(3)},${spread[i * 3 + 2].toFixed(3)}`)
  }
  check('均匀标量映射出 5 种颜色', seen.size === 5, String(seen.size))
  const lo = rampColor(0.1, 'turbo')
  const hi = rampColor(0.6, 'turbo')
  check('色带不同位置不同色', lo[0] !== hi[0] || lo[1] !== hi[1] || lo[2] !== hi[2], `${lo} vs ${hi}`)

  const heights = heightsOf(f32(1, 2, 3, 4, 5, 6))
  check('heightsOf 取 z 分量', heights[0] === 3 && heights[1] === 6)

  const allSame = scalarColors(new Float32Array(8).fill(5))
  check('全等值不会产生 NaN 颜色', Number.isFinite(allSame[0]) && Number.isFinite(allSame[1]))
}

// ---------------------------------------------------------------
console.log('\n[10] cloudColorsFor：3D 与三视图共用的模式判定')
{
  const base = {
    positions: f32(0, 0, 0, 1, 1, 2),
    count: 2,
    intensity: f32(0.2, 0.8),
  }
  check('default 模式不生成颜色（走默认冷灰）', cloudColorsFor(base, 'default') === undefined)
  check('semantic 模式交给调用方（core 不认类别表）', cloudColorsFor(base, 'semantic') === undefined)
  check('height 模式生成颜色', cloudColorsFor(base, 'height')?.length === 6)
  check('intensity 模式生成颜色', cloudColorsFor(base, 'intensity')?.length === 6)

  // 没有 intensity 的数据选到强度模式时应当退回默认，而不是画出一片同色
  const noIntensity = { positions: f32(0, 0, 0), count: 1 }
  check('缺 intensity 时强度模式退回 undefined', cloudColorsFor(noIntensity, 'intensity') === undefined)
}

it('点云读取：PCD / PLY / .bin 与标量着色全部断言通过', () => {
  finish()
})

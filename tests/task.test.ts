/**
 * P3 测试 —— 多任务与衍生真值（不需要浏览器）
 *   pnpm test -- task
 *
 * 覆盖五块纯逻辑：
 *   1. 占据网格：索引数学、规格自检、派生（含地面剪裁 / 冲突裁决）、RLE 与打包
 *   2. 光流：刚体流的解析解、自车运动估计（合成数据还原已知变换）
 *   3. 跨任务一致性：I1 / I2 / I3 三条规则该报的时候报、不该报的时候不报
 *   4. 任务注册表：进度、校验、体积估算
 *   5. 命令接线：`setTaskPayload` 的写入 → 撤销 → 重做 → 引用收集
 *
 * 为什么这些能脱离浏览器测：
 *   占据是"框 + 规格"的纯函数，编码是纯字节操作，一致性规则只读文档与帧数据。
 *   IndexedDB 与 WebGL 不在这里 —— 它们的行为由 `scripts/browser/task.mjs` 走查。
 */
import { it } from 'vitest'
import { createChecker } from './harness.ts'
import {
  carveFromTracks,
  defaultOccupancySpec,
  decodeOccBundle,
  decodeOccRle,
  editOccupancy,
  encodeOccBundle,
  encodeOccRle,
  groundAt,
  indexToVoxel,
  labelAt,
  occStats,
  occupancySpecKey,
  occupiedInBox,
  validateOccupancySpec,
  voxelCenter,
  voxelCount,
  voxelToIndex,
  worldToIndex,
  type GroundField,
  type OccupancyFrame,
} from '../src/domain/derive/occupancy.ts'
import { applyEgoMotion, egoBetween, estimateEgoMotion, flowSegments, rigidFlow } from '../src/domain/derive/flow.ts'
import { checkCrossTask, checkCrossTaskFrames } from '../src/domain/qa/crossTask.ts'
import { createDefaultRegistry } from '../src/domain/model/task.ts'
import { buildTaskPayloadCommand } from '../src/domain/ops/taskPayload.ts'
import { createEmptyDocument } from '../src/domain/model/document.ts'
import { createTrackRecord } from '../src/domain/model/track.ts'
import { TrackStore } from '../src/domain/store/trackStore.ts'
import { buildDocumentFromFrames } from '../src/domain/io/legacyDocument.ts'
import { commandBlobRefs } from '../src/domain/store/blobRefs.ts'
import type { BoxGeometry } from '../src/domain/model/geometry.ts'

const { check, finish } = createChecker()

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
/** 命令是判别联合，取 setTaskPayload 那一支的字段要先收窄 */
const payloadCmd = (c: import('../src/domain/model/command.ts').Command) =>
  c as Extract<import('../src/domain/model/command.ts').Command, { type: 'setTaskPayload' }>
const geo = (x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0): BoxGeometry => ({
  position: { x, y, z },
  scale: { x: sx, y: sy, z: sz },
  yaw,
})

/** 测试用的小网格：10×10×4 @1m，原点 (-5,-5,-1)，便于手算 */
function smallSpec(classIds: string[] = ['Car', 'Truck']) {
  return { resolution: 1, origin: { x: -5, y: -5, z: -1 }, size: { x: 10, y: 10, z: 4 }, classIds }
}

function mkTrack(id: string, classId: string, frame: number, g: BoxGeometry) {
  return createTrackRecord({ id, classId, frame, geometry: g })
}

console.log('\n[1] 占据网格数学')
{
  const spec = defaultOccupancySpec(['Car'])
  check(
    '默认规格 200×200×16 @0.4m',
    spec.size.x === 200 && spec.size.y === 200 && spec.size.z === 16 && near(spec.resolution, 0.4),
  )
  check('默认规格自检通过', validateOccupancySpec(spec).length === 0, validateOccupancySpec(spec).join('；'))
  check('体素总数 = 64 万', voxelCount(spec) === 640_000)

  const i = voxelToIndex(spec, 3, 5, 2)
  check('线性索引 x 最快', i === 3 + 200 * (5 + 200 * 2), String(i))
  const back = indexToVoxel(spec, i)
  check('索引 ↔ 体素往返', back.ix === 3 && back.iy === 5 && back.iz === 2, JSON.stringify(back))
  const center = voxelCenter(spec, i)
  check('体素中心 → 索引往返', worldToIndex(spec, center) === i, JSON.stringify(center))
  check('越界返回 -1', voxelToIndex(spec, -1, 0, 0) === -1 && voxelToIndex(spec, 200, 0, 0) === -1)
  check('world 越界返回 -1', worldToIndex(spec, { x: 100, y: 0, z: 0 }) === -1)

  check(
    '指纹忽略 classIds（几何没变就能读旧帧）',
    occupancySpecKey({ ...spec, classIds: ['Car', 'Truck'] }) === occupancySpecKey(spec),
  )
  check('指纹区分分辨率', occupancySpecKey({ ...spec, resolution: 0.5 }) !== occupancySpecKey(spec))

  check('分辨率非法被报出', validateOccupancySpec({ ...spec, resolution: 0 }).length > 0)
  check('size 非整数被报出', validateOccupancySpec({ ...spec, size: { x: 10, y: 0, z: 4 } }).length > 0)
  check('类别重复被报出', validateOccupancySpec({ ...spec, classIds: ['Car', 'Car'] }).length > 0)
}

console.log('\n[2] 从轨迹派生占据')
{
  const spec = smallSpec()
  const car = mkTrack('a', 'Car', 0, geo(0, 0, 0.5, 2, 2, 1))
  const r = carveFromTracks([car], 0, spec)
  check('2×2×1 的框刻出 4 个体素', r.frame.occupied.length === 4, String(r.frame.occupied.length))
  check('covered 也是 4', r.covered === 4, String(r.covered))
  check(
    '标签全是 Car（下标 0）',
    [...r.frame.labels].every((l) => l === 0),
  )
  check('没有冲突', r.overlapVoxels === 0 && r.overlapPairs.length === 0)
  check('帧号与指纹写进帧', r.frame.frame === 0 && r.frame.spec === occupancySpecKey(spec))
  check('来源是 derived', r.frame.source.kind === 'derived')

  // 旋转 90°：3×1 的框转到 y 轴。刻意偏移 0.25m，让体素中心不落在框边界上 ——
  // 边界上的体素算不算"框内"取决于 eps，那种断言测的是网格对齐而不是几何
  const rot = carveFromTracks([mkTrack('b', 'Car', 0, geo(0.25, 0.25, 0.5, 3, 1, 1, Math.PI / 2))], 0, spec)
  check('yaw=90° 时长边转到 y 轴', rot.frame.occupied.length === 3, String(rot.frame.occupied.length))
  const centers = [...rot.frame.occupied].map((idx) => voxelCenter(spec, idx))
  check(
    '旋转后的体素确实沿 y 展开',
    new Set(centers.map((c) => c.y.toFixed(1))).size === 3 && new Set(centers.map((c) => c.x.toFixed(1))).size === 1,
    JSON.stringify(centers),
  )

  // 遮挡帧不刻：占据是"确实有东西"，不能把猜的算进去
  const occ = mkTrack('c', 'Car', 0, geo(2, 2, 0.5, 2, 2, 1))
  occ.states.set(0, { visibility: 'occluded', source: { kind: 'manual' }, review: 'none' })
  const skip = carveFromTracks([occ], 0, spec)
  check(
    '遮挡轨迹默认不刻',
    skip.frame.occupied.length === 0 && skip.skipped[0]?.reason === 'invisible',
    JSON.stringify(skip.skipped),
  )
  const withOcc = carveFromTracks([occ], 0, spec, { includeOccluded: true })
  check('显式允许时才刻遮挡轨迹', withOcc.frame.occupied.length === 4)

  const unknown = carveFromTracks([mkTrack('d', 'Bus', 0, geo(0, 0, 0.5, 2, 2, 1))], 0, spec)
  check('类别不在表里 → 跳过并报原因', unknown.skipped[0]?.reason === 'unknown-class')

  const outside = carveFromTracks([mkTrack('e', 'Car', 0, geo(0, 0, 0.5, 2, 2, 1))], 3, spec)
  check('生命周期外没有几何 → 跳过', outside.skipped[0]?.reason === 'no-geometry')

  // 冲突：小框压大框，小的赢
  const big = mkTrack('big', 'Truck', 0, geo(0, 0, 0.5, 4, 4, 1))
  const small = mkTrack('small', 'Car', 0, geo(0, 0, 0.5, 2, 2, 1))
  const conflict = carveFromTracks([big, small], 0, spec)
  check('多框覆盖记 overlap', conflict.overlapVoxels > 0, String(conflict.overlapVoxels))
  check('冲突对去重且只有一对', conflict.overlapPairs.length === 1, JSON.stringify(conflict.overlapPairs))
  const overlapCell = [...conflict.frame.occupied].find((idx) => {
    const c = voxelCenter(spec, idx)
    return Math.abs(c.x) < 1 && Math.abs(c.y) < 1
  })!
  check(
    '重叠处取体积小的类别',
    labelAt(conflict.frame, overlapCell) === 0,
    String(labelAt(conflict.frame, overlapCell)),
  )
}

console.log('\n[3] 地面剪裁与地面层')
{
  const spec = smallSpec(['Car', 'ground'])
  // 框在 z ∈ [-0.8, 1.2]，跨两个体素层（中心 -0.5 与 0.5）
  const car = mkTrack('a', 'Car', 0, geo(0, 0, 0.2, 2, 2, 2))
  const plain = carveFromTracks([car], 0, spec)
  check('没有地面时两层都刻', plain.frame.occupied.length === 8, String(plain.frame.occupied.length))

  const field: GroundField = {
    cell: 1,
    minX: -5,
    minY: -5,
    nx: 10,
    ny: 10,
    height: new Float32Array(100).fill(0.2),
    observed: 100,
  }
  check('地面查询命中', near(groundAt(field, 0.2, 0.2)!, 0.2, 1e-6))
  check('地面查询越界返回 null', groundAt(field, 99, 99) === null)

  const clipped = carveFromTracks([car], 0, spec, { mode: 'box+ground', ground: field })
  const carVox = [...clipped.frame.occupied].filter((idx) => labelAt(clipped.frame, idx) === 0)
  check('地面之下的体素被剪掉', carVox.length === 4, String(carVox.length))
  check(
    '保留的都是地面以上',
    carVox.every((idx) => voxelCenter(spec, idx).z > 0.2 - 0.5),
    JSON.stringify(carVox.map((i) => voxelCenter(spec, i))),
  )

  const layered = carveFromTracks([car], 0, spec, { mode: 'box+ground', ground: field, groundClass: 'ground' })
  const groundVox = [...layered.frame.occupied].filter((idx) => labelAt(layered.frame, idx) === 1)
  check('可选地面层被写入', groundVox.length > 0, String(groundVox.length))
  check('地面层不与框冲突', layered.overlapVoxels === 0)
}

console.log('\n[4] RLE / 打包 / 统计 / 局部编辑')
{
  const spec = smallSpec()
  const r = carveFromTracks(
    [mkTrack('a', 'Car', 0, geo(0, 0, 0.5, 2, 2, 1)), mkTrack('b', 'Truck', 0, geo(3, 0, 0.5, 2, 2, 1))],
    0,
    spec,
  )
  const bytes = encodeOccRle(r.frame)
  const back = decodeOccRle(bytes)
  check('RLE 往返帧号一致', back.frame === r.frame.frame)
  check('RLE 往返指纹一致', back.spec === r.frame.spec)
  check(
    'RLE 往返体素一致',
    [...back.occupied].join(',') === [...r.frame.occupied].join(','),
    `${back.occupied.length}/${r.frame.occupied.length}`,
  )
  check('RLE 往返标签一致', [...back.labels].join(',') === [...r.frame.labels].join(','))
  check('RLE 有界：头 + 每段 9 字节', bytes.byteLength <= 21 + r.frame.occupied.length * 9, `${bytes.byteLength}B`)

  // 连续区域才体现 RLE 的价值：8×8 的框在一层里铺满 64 格
  const dense = carveFromTracks([mkTrack('dense', 'Car', 0, geo(0, 0, 0.5, 8, 8, 1))], 0, spec)
  const denseBytes = encodeOccRle(dense.frame)
  check(
    '密集区域 RLE 明显小于逐格 5 字节',
    denseBytes.byteLength < dense.frame.occupied.length * 5,
    `${denseBytes.byteLength}B vs ${dense.frame.occupied.length * 5}B`,
  )
  check('密集帧往返一致', [...decodeOccRle(denseBytes).occupied].join(',') === [...dense.frame.occupied].join(','))

  const bundle = encodeOccBundle(spec, [r.frame, { ...r.frame, frame: 1 }])
  const decoded = decodeOccBundle(bundle)
  check('打包往返 2 帧', decoded.frames.length === 2 && decoded.frames[1].frame === 1)
  check('打包带回 spec', decoded.spec.size.x === 10 && decoded.spec.classIds.length === 2)
  check(
    '坏包报错',
    (() => {
      try {
        decodeOccRle(new ArrayBuffer(16))
        return false
      } catch {
        return true
      }
    })(),
  )

  const stats = occStats(r.frame, spec)
  check('统计比例 = 占用/总数', near(stats.ratio, stats.occupied / stats.total), String(stats.ratio))
  check(
    '统计按类别分组',
    stats.perClass.length === 2 && stats.perClass[0].count >= stats.perClass[1].count,
    JSON.stringify(stats.perClass),
  )

  const box = { position: { x: 0, y: 0, z: 0.5 }, scale: { x: 2, y: 2, z: 1 }, yaw: 0 }
  const inBox = occupiedInBox(r.frame, spec, box)
  check('框内 covered/occupied 都算对', inBox.covered === 4 && inBox.occupied === 4, JSON.stringify(inBox))
  check('框内类别统计正确', inBox.perClass.get(0) === 4)

  const empty = { ...r.frame, occupied: new Uint32Array(0), labels: new Uint8Array(0) }
  const added = editOccupancy(empty, spec, [{ index: voxelToIndex(spec, 0, 0, 0), label: 1 }])
  check('局部编辑可新增', added.occupied.length === 1 && added.labels[0] === 1)
  const removed = editOccupancy(added, spec, [{ index: voxelToIndex(spec, 0, 0, 0), label: null }])
  check('局部编辑可删除', removed.occupied.length === 0)
  const bad = editOccupancy(added, spec, [{ index: 999999, label: 1 }])
  check('越界编辑被忽略', bad.occupied.length === 1)
  const unchanged = editOccupancy(r.frame, spec, [])
  check('空编辑不改变内容', unchanged.occupied.length === r.frame.occupied.length)
}

console.log('\n[5] 光流与自车运动')
{
  const pts = Float32Array.from([2, 0, 0, 0, 0, 0, 1, 1, 0.5])
  const out = new Float32Array(9)
  rigidFlow(pts, [0, 1, 2], geo(0, 0, 0, 1, 1, 1), geo(1, 0, 0, 1, 1, 1), out)
  check('纯平移：每个点 +1m', near(out[0], 3, 1e-6) && near(out[3], 1, 1e-6))

  const rot = new Float32Array(9)
  rigidFlow(pts, [0], geo(0, 0, 0, 1, 1, 1), geo(1, 2, 0, 1, 1, 1, Math.PI / 2), rot, 0)
  check('绕框中心转 90° 再平移：(2,0)→(1,4)', near(rot[0], 1, 1e-6) && near(rot[1], 4, 1e-6), `${rot[0]},${rot[1]}`)

  const seg = flowSegments(pts, geo(0, 0, 0, 1, 1, 1), geo(1, 0, 0, 1, 1, 1), { indices: [0, 2] })
  check('箭头段数 = 2（每段 6 个数）', seg.length === 12, String(seg.length))
  check('箭头起点是原点、终点是预测点', near(seg[0], 2) && near(seg[3], 3), `${seg[0]}→${seg[3]}`)

  // 合成地面：确定性伪随机点，避免网格自相似的"多重最优解"
  let seed = 1234567
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const n = 2000
  const a = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    a[i * 3] = (rnd() - 0.5) * 40
    a[i * 3 + 1] = (rnd() - 0.5) * 40
    a[i * 3 + 2] = (rnd() - 0.5) * 0.1
  }
  const motion = { dx: 1.2, dy: -0.3, dyaw: 0.08, inliers: 0, rmse: 0, samples: 0 }
  const b = new Float32Array(n * 3)
  applyEgoMotion(a, b, motion)

  const est = estimateEgoMotion({ positions: a, count: n }, { positions: b, count: n })
  check('自车运动：dx 还原到 0.2m 内', near(est.dx, 1.2, 0.2), String(est.dx))
  check('自车运动：dy 还原到 0.2m 内', near(est.dy, -0.3, 0.2), String(est.dy))
  check('自车运动：dyaw 还原到 0.02rad 内', near(est.dyaw, 0.08, 0.02), String(est.dyaw))
  check('自车运动：内点占多数', est.inliers > est.samples * 0.6, `${est.inliers}/${est.samples}`)
  check('自车运动：残差很小', est.rmse < 0.15, String(est.rmse))

  const between = egoBetween(
    { position: { x: 10, y: 0, z: 0 }, yaw: 0.5 },
    { position: { x: 10.5, y: 0.2, z: 0 }, yaw: 0.6 },
  )
  // 自车往前走，点在下一帧里就往后移：dx 应为负
  check('两位姿之间的变换：前进 → 点在下一帧后移', between.dx < 0, String(between.dx))

  const tiny = estimateEgoMotion(
    { positions: new Float32Array(30), count: 10 },
    { positions: new Float32Array(30), count: 10 },
  )
  check('点太少时如实返回空估计（不编造）', tiny.samples < 20 && tiny.inliers === 0)
}

console.log('\n[6] 跨任务一致性')
{
  const spec = smallSpec()
  const car = mkTrack('a', 'Car', 0, geo(0, 0, 0.5, 2, 2, 1))
  const carved = carveFromTracks([car], 0, spec)
  const box = { id: 'a', label: 'Car', position: { x: 0, y: 0, z: 0.5 }, scale: { x: 2, y: 2, z: 1 }, yaw: 0 }

  const clean = checkCrossTask({
    frame: 0,
    boxes: [box],
    spec,
    occ: carved.frame,
    trackIds: ['a'],
    // 小网格里一个 2×2×1 的框只覆盖 4 个格；默认阈值（8）会跳过它，这里显式放宽
    opts: { minCoveredVoxels: 2 },
  })
  check('派生出来的占据与框一致：无问题', clean.length === 0, clean.map((i) => i.code).join(','))

  // 删掉 30% 以上体素 → I1 必须报，且指名到轨迹
  const keep = [...carved.frame.occupied].slice(1)
  const holes: OccupancyFrame = {
    ...carved.frame,
    occupied: Uint32Array.from(keep),
    labels: carved.frame.labels.slice(1),
  }
  const holed = checkCrossTask({
    frame: 0,
    boxes: [box],
    spec,
    occ: holes,
    trackIds: ['a'],
    opts: { minCoveredVoxels: 2 },
  })
  const i1 = holed.find((i) => i.code === 'XT_OCC_BOX_CONTAINMENT')
  check('删体素后报 I1', !!i1, holed.map((i) => i.code).join(','))
  check('I1 指到具体轨迹与帧', i1?.targets.some((t) => t.trackId === 'a' && t.frame === 0) === true)
  check('I1 带上实测值与阈值', typeof i1?.value === 'number' && i1?.threshold === 0.9, JSON.stringify(i1?.value))

  // 类别不符：Car 的框里塞 Truck 的占格
  const truckOcc = carveFromTracks([mkTrack('b', 'Truck', 0, geo(0, 0, 0.5, 2, 2, 1))], 0, spec)
  const i2 = checkCrossTask({
    frame: 0,
    boxes: [box],
    spec,
    occ: truckOcc.frame,
    trackIds: ['a'],
    opts: { minCoveredVoxels: 2 },
  })
  check(
    '类别不符报 I2',
    i2.some((i) => i.code === 'XT_OCC_CLASS_MISMATCH'),
    i2.map((i) => i.code).join(','),
  )

  const parentOk = checkCrossTask({
    frame: 0,
    boxes: [box],
    spec,
    occ: truckOcc.frame,
    trackIds: ['a'],
    opts: { minCoveredVoxels: 2, parentOf: (c) => (c === 'Car' ? ['Truck'] : []) },
  })
  check(
    '允许的父类不算类别不符',
    !parentOk.some((i) => i.code === 'XT_OCC_CLASS_MISMATCH'),
    parentOk.map((i) => i.code).join(','),
  )

  const tinyBox = { id: 'a', label: 'Car', position: { x: 0, y: 0, z: 0.5 }, scale: { x: 0.3, y: 0.3, z: 0.3 }, yaw: 0 }
  const tinyIssues = checkCrossTask({ frame: 0, boxes: [tinyBox], spec, occ: holes, trackIds: ['a'] })
  check('体素太少的框跳过 I1/I2（避免淹没真问题）', tinyIssues.length === 0, tinyIssues.map((i) => i.code).join(','))

  const dangling = checkCrossTask({
    frame: 0,
    boxes: [],
    spec: null,
    occ: null,
    trackIds: ['a'],
    instanceMap: { '7': 'a', '8': 'ghost' },
  })
  check(
    '悬空的语义实例映射报 I3',
    dangling.length === 1 && dangling[0].code === 'XT_SEM_INSTANCE_UNMAPPED',
    dangling.map((i) => `${i.code}:${i.targets[1]?.trackId}`).join(','),
  )
  check('I3 是 error 级', dangling[0]?.severity === 'error')

  const multi = checkCrossTaskFrames([
    { frame: 0, boxes: [box], spec, occ: holes, trackIds: ['a'], opts: { minCoveredVoxels: 2 } },
    { frame: 1, boxes: [box], spec, occ: carved.frame, trackIds: ['a'], opts: { minCoveredVoxels: 2 } },
  ])
  check(
    '多帧汇总只统计有问题的帧',
    multi.checked === 2 && multi.framesWithIssues === 1,
    JSON.stringify(multi.framesWithIssues),
  )
}

console.log('\n[7] 任务注册表')
{
  const registry = createDefaultRegistry()
  check('默认注册 6 个任务（P4 起含 vla）', registry.keys.length === 6, registry.keys.join(','))
  check('vla 已进注册表（P4）', registry.keys.includes('vla'), registry.keys.join(','))
  check('boxes 是必选', registry.get('boxes')?.optional === false)

  const doc = createEmptyDocument({ sampleId: 's#0-4', sceneId: 's', range: [0, 4] })
  const store = new TrackStore(doc)
  store.exec({
    type: 'createTrack',
    track: mkTrack('1', 'Car', 1, geo(0, 0, 0.5, 2, 2, 1)),
    meta: { id: 'c1', label: 'test', at: 0, actor: 'test', affects: { frames: [1], tracks: ['1'], tasks: ['boxes'] } },
  })
  const progress = registry.progress(doc)
  const boxesRow = progress.find((r) => r.key === 'boxes')!
  check(
    'boxes 进度 = 关键帧帧数 / 帧数',
    boxesRow.progress?.done === 1 && boxesRow.progress?.total === 5,
    JSON.stringify(boxesRow.progress),
  )
  check('未做的任务 present=false', progress.find((r) => r.key === 'occupancy')?.present === false)
  check(
    '未做的可选任务不产生问题',
    registry.validate(doc).length === 0,
    registry
      .validate(doc)
      .map((i) => i.code)
      .join(','),
  )
  check('体积估算 > 0', registry.estimateBytes(doc) > 0, String(registry.estimateBytes(doc)))

  // 坏载荷：越界帧 + 重复帧 + 非 payload 引用
  doc.tasks.occupancy = {
    spec: smallSpec(),
    frames: [
      { frame: 0, ref: 'payload/aaa' },
      { frame: 0, ref: 'payload/aaa' },
      { frame: 9, ref: 'frames/bad' },
    ],
  }
  const issues = registry.validate(doc).map((i) => i.code)
  check('占据越界帧被报出', issues.includes('TASK_FRAME_OUT_OF_RANGE'), issues.join(','))
  check('占据重复帧被报出', issues.includes('TASK_FRAME_DUPLICATE'), issues.join(','))
  check('非 payload 引用被报出', issues.includes('TASK_BAD_REF'), issues.join(','))

  doc.tasks.semantic = { instanceMap: { '': '1' } }
  check(
    '空语义实例 id 被报出',
    registry.validate(doc).some((i) => i.code === 'TASK_SEM_INSTANCE_EMPTY'),
  )

  doc.tasks.lane = { lanes: [{ id: 'l1', points: [{ x: 0, y: 0, z: 0 }] }] }
  check(
    '少于两点的车道线被报出',
    registry.validate(doc).some((i) => i.code === 'TASK_LANE_POINTS'),
  )
}

console.log('\n[8] setTaskPayload 命令：写入 → 撤销 → 重做 → 引用')
{
  const doc = buildDocumentFromFrames([
    {
      index: 0,
      boxes: [{ id: '1', label: 'Car', position: { x: 0, y: 0, z: 0.5 }, scale: { x: 2, y: 2, z: 1 }, yaw: 0 }],
    },
  ])
  const store = new TrackStore(doc)
  const payload = {
    spec: smallSpec(),
    frames: [{ frame: 0, ref: 'payload/deadbeef' }],
    source: { kind: 'derived' as const },
  }
  const cmd = buildTaskPayloadCommand({ task: 'occupancy', before: null, after: payload, label: '生成占据' })
  store.exec(cmd)
  check('命令写入文档', doc.tasks.occupancy?.frames?.length === 1, JSON.stringify(doc.tasks.occupancy))
  check('主引用被记录', payloadCmd(cmd).afterRef === 'payload/deadbeef', String(payloadCmd(cmd).afterRef))
  check('引用收集拿到帧载荷', commandBlobRefs(cmd).includes('payload/deadbeef'))
  check('受影响的 task 报为 occupancy', cmd.meta.affects.tasks.join(',') === 'occupancy')

  store.undo()
  check('撤销后载荷消失', doc.tasks.occupancy === undefined)
  store.redo()
  check('重做后载荷回来', doc.tasks.occupancy?.frames?.[0]?.ref === 'payload/deadbeef')

  const cleared = buildTaskPayloadCommand({
    task: 'occupancy',
    before: doc.tasks.occupancy ?? null,
    after: null,
    label: '清除占据',
  })
  store.exec(cleared)
  check('清除命令把载荷置空', doc.tasks.occupancy === undefined)
  check('清除命令的 beforeRef 仍持有旧帧', payloadCmd(cleared).beforeRef === 'payload/deadbeef')
  store.undo()
  check('撤销清除后载荷恢复', doc.tasks.occupancy?.frames?.[0]?.ref === 'payload/deadbeef')

  check(
    'boxes 不能走 setTaskPayload（防御）',
    (() => {
      const bad = buildTaskPayloadCommand({ task: 'boxes', before: null, after: { x: 1 }, label: 'bad' })
      store.exec(bad)
      return doc.tasks.boxes.tracks.length === 1
    })(),
  )

  // 描述对象深拷贝：命令构造之后再改原对象，不应影响 redo
  const before = { spec: smallSpec(), frames: [{ frame: 0, ref: 'payload/aaa' }] }
  const after = { spec: smallSpec(), frames: [{ frame: 0, ref: 'payload/bbb' }] }
  const deep = buildTaskPayloadCommand({ task: 'occupancy', before, after, label: 'deep' })
  after.frames[0].ref = 'payload/ccc'
  check(
    '描述对象是深拷贝（redo 不会拿到改过的对象）',
    payloadCmd(deep).afterRef === 'payload/bbb',
    String(payloadCmd(deep).afterRef),
  )
}

it('task：占据/光流/一致性/注册表/命令 全部断言通过', () => {
  finish()
})

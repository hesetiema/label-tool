/**
 * 核心算法自检脚本 —— 不需要浏览器，直接跑：
 *   node --experimental-strip-types tests/core-check.ts
 *
 * 它验证 core 层最关键的几个算法是否数学正确。既是测试，也是学习材料：
 * 你可以改参数、加断言，直观看到算法的行为。
 */
import { boxToVertices, fitBoxToPoints, estimateYawByPCA, pointInBoxBev } from '../src/core/box.ts'
import { generateDemoScene } from '../src/core/sample.ts'
import { serializeLabels, parseLabels } from '../src/core/label.ts'
import { parsePCD } from '../src/core/pcd.ts'
import { matVec, projectPoint, projectBox, type Calibration } from '../src/core/calibration.ts'
import { HistoryStack, cloneBoxes } from '../src/core/history.ts'
import { lerpAngle, lerpBox, associateNearest, interpolateTracks, generateDemoSequence, extractTrajectories, propagateBox, type FrameData } from '../src/core/sequence.ts'
import { evaluateTemporal, injectTemporalDefects, markOccluded } from '../src/core/temporalQA.ts'
import { voxelDownsample, distanceLod, generateMassiveCloud } from '../src/core/downsample.ts'
import { bevIoU, boxIoU3D, matchBoxes, cohenKappa, evaluateQuality, perturbLabels, boxBevCorners } from '../src/core/quality.ts'
import {
  hungarian, greedyAssign, KalmanFilter2D, demoCrossingCase,
  initTracks, associateHungarianKalman, stepTrackState, coastOccludedTracks,
  demoOcclusionCase,
} from '../src/core/tracker.ts'
import type { Box3D } from '../src/core/types.ts'
import {
  createDefaultTrajectory, appendKeyframe, sampleTrajectory, sampleTrajectoryInfo,
  trajectoryDuration, serializeTrajectory, parseTrajectory,
  type CameraTrajectory, type CameraPose, type CameraKeyframe,
} from '../src/core/cameraTrajectory.ts'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}  ${detail}`) }
}
function close(a: number, b: number, tol = 0.05) { return Math.abs(a - b) < tol }

console.log('\n[1] boxToVertices 8 角点计算')
const box: Box3D = {
  id: '1', label: 'Car',
  position: { x: 10, y: 20, z: 1 },
  scale: { x: 4, y: 2, z: 1.5 },
  yaw: 0,
}
const v = boxToVertices(box)
check('生成 8 个角点(32 个数)', v.length === 32, `实际 ${v.length}`)
check('yaw=0 时长=scale.x', close(v[0] - v[16], 4) && close(v[5] - v[1], 2), `长=${v[0] - v[16]} 宽=${v[5] - v[1]}`)
check('角点 z 范围正确', close(v[2], 0.25) && close(v[10], 1.75), `z: ${v[2]} ~ ${v[10]}`)

console.log('\n[2] pointInBoxBev 命中检测')
check('中心点在框内', pointInBoxBev(box, 10, 20))
check('远处点在框外', !pointInBoxBev(box, 100, 100))

console.log('\n[3] fitBoxToPoints 自动拟合')
// 造一个已知的斜放长方形点云，看能否拟合回来
const pts: number[] = []
const cx = 5, cy = -3, L = 4.4, W = 1.8, yawAngle = 0.6
const c = Math.cos(yawAngle), s = Math.sin(yawAngle)
for (let i = -20; i <= 20; i++) {
  for (let j = -8; j <= 8; j++) {
    const lx = (i / 20) * L / 2, ly = (j / 8) * W / 2
    pts.push(cx + lx * c - ly * s, cy + lx * s + ly * c, 1.0)
  }
}
const posArr = new Float32Array(pts)
const idx = Array.from({ length: posArr.length / 3 }, (_, i) => i)
const fit = fitBoxToPoints(posArr, idx, yawAngle)
check('拟合出中心 x', !!fit && close(fit.position.x, cx, 0.1), `得到 ${fit?.position.x}`)
check('拟合出中心 y', !!fit && close(fit.position.y, cy, 0.1), `得到 ${fit?.position.y}`)
check('拟合出长度', !!fit && close(fit.scale.x, L, 0.1), `得到 ${fit?.scale.x}`)
check('拟合出宽度', !!fit && close(fit.scale.y, W, 0.1), `得到 ${fit?.scale.y}`)

console.log('\n[4] estimateYawByPCA 主方向估计')
const estYaw = estimateYawByPCA(posArr, idx)
check('PCA 估出朝向(允许 90° 歧义)', close(Math.abs(estYaw), Math.abs(yawAngle), 0.1) || close(Math.abs(estYaw), Math.abs(Math.PI / 2 - Math.abs(yawAngle)), 0.1), `得到 ${estYaw.toFixed(3)} vs 真值 ${yawAngle}`)

console.log('\n[5] 序列化可逆性')
const { boxes } = generateDemoScene()
const json = serializeLabels(boxes)
const restored = parseLabels(json)
check('框数量一致', restored.length === boxes.length)
check('首个框 position 一致', close(restored[0].position.x, boxes[0].position.x, 1e-6))
check('首个框 yaw 一致', close(restored[0].yaw, boxes[0].yaw, 1e-6))
check('JSON 含 psr/obj_type/vertices', json.includes('"psr"') && json.includes('"obj_type"') && json.includes('"vertices"'))

console.log('\n[6] parsePCD 解析 ASCII')
const asciiPcd = `VERSION 0.7
FIELDS x y z
SIZE 4 4 4
TYPE F F F
COUNT 1 1 1
WIDTH 3
HEIGHT 1
POINTS 3
DATA ascii
1 2 3
4 5 6
7 8 9
`
const buf = new TextEncoder().encode(asciiPcd)
const cloud = parsePCD(buf.buffer)
check('点数正确', cloud.count === 3, `得到 ${cloud.count}`)
check('第一个点坐标', close(cloud.positions[0], 1) && close(cloud.positions[2], 3))

console.log('\n[7] 相机标定与投影')
// 构造一个最简单的相机：外参=单位阵(世界系即相机系)，内参 fx=fy=1000, cx=320, cy=240
const calib: Calibration = {
  extrinsic: [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  intrinsic: [1000,0,320, 0,1000,240, 0,0,1],
}
check('matVec 单位阵', (() => { const r = matVec(calib.extrinsic, [1,2,3,1], 4); return close(r[0],1)&&close(r[1],2)&&close(r[2],3) })())
// 光轴上的点 (0,0,10) 应投到主点 (cx,cy)
const pc = projectPoint([0, 0, 10], calib)!
check('光轴点投到主点', !!pc && close(pc.u, 320) && close(pc.v, 240), `得到 ${pc?.u},${pc?.v}`)
// 点 (1,2,10) → u=1000/10+320=420, v=2000/10+240=440
const p2 = projectPoint([1, 2, 10], calib)!
check('透视除法正确', !!p2 && close(p2.u, 420) && close(p2.v, 440), `得到 ${p2?.u},${p2?.v}`)
check('相机后方的点返回 null', projectPoint([0, 0, -5], calib) === null)
// 平移外参：相机在 x=10 处，世界点 (10,0,10) 相对相机是 (0,0,10) → 投到主点
const calibT: Calibration = {
  extrinsic: [1,0,0,-10, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  intrinsic: calib.intrinsic,
}
const p3 = projectPoint([10, 0, 10], calibT)!
check('外参平移生效', !!p3 && close(p3.u, 320) && close(p3.v, 240), `得到 ${p3?.u},${p3?.v}`)
// 整框投影：相机前方一个框应得到 8 个点
const frontBox: Box3D = { id:'p1', label:'Car', position:{x:0,y:0,z:10}, scale:{x:4,y:2,z:1.5}, yaw:0 }
const proj = projectBox(frontBox, calib)
check('框投影得到8个点', !!proj && proj.length === 8)
// 相机后方的框返回 null
const backBox: Box3D = { ...frontBox, position:{x:0,y:0,z:-10} }
check('相机后方框不可见', projectBox(backBox, calib) === null)

// ============ P0-1 撤销重做 ============
console.log('\n[8] 撤销重做（命令模式）')
const h = new HistoryStack<Box3D[]>({ mergeWindowMs: 0 })
const s0: Box3D[] = [{ id: '1', label: 'Car', position: { x: 0, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }]
const s1 = cloneBoxes(s0); s1[0].position.x = 5
const s2 = cloneBoxes(s1); s2.push({ id: '2', label: 'Pedestrian', position: { x: 1, y: 2, z: 1 }, scale: { x: 0.7, y: 0.7, z: 1.75 }, yaw: 0 })
h.commit(s0, s1, '移动框')
h.commit(s1, s2, '新建框')
check('两次提交后可撤销', h.canUndo && h.undoCount === 2)
const undone1 = h.undo()!
check('撤销回到一步前', undone1.length === 1 && close(undone1[0].position.x, 5), `x=${undone1[0]?.position.x}`)
const undone2 = h.undo()!
check('再撤销回到起点', close(undone2[0].position.x, 0))
check('撤销到底后不可再撤销', !h.canUndo)
check('可重做', h.canRedo)
check('重做恢复一步', close(h.redo()![0].position.x, 5))
check('新操作清空重做栈', (() => { h.undo(); h.commit(cloneBoxes(s0), cloneBoxes(s1), '新分支'); return !h.canRedo })())
// 快照深拷贝：修改快照不应污染原数组（也不能污染原数组影响后续断言）
const snap = cloneBoxes(s0); snap[0].position.x = 999
check('快照深拷贝隔离', close(s0[0].position.x, 0) && close(snap[0].position.x, 999))
// 连续操作合并
const hm = new HistoryStack<Box3D[]>({ mergeWindowMs: 9999 })
hm.commit(s0, s1, '平移', 'k:1:x+')
hm.commit(s1, cloneBoxes([{ ...s1[0], position: { x: 9, y: 0, z: 1 } }]), '平移', 'k:1:x+')
check('连续同类操作合并为一条', hm.undoCount === 1, `实际 ${hm.undoCount}`)
check('合并后撤销回到最初', close(hm.undo()![0].position.x, 0))

// ============ P0-2 多帧时序 ============
console.log('\n[9] 多帧时序与轨迹插值')
// 3.1 → -3.1 的最短弧是 +0.083 rad（跨过 +π 到 -π），中点正好是 π 附近
check('角度插值走最短弧(跨界)', close(Math.abs(lerpAngle(3.1, -3.1, 0.5)), Math.PI, 0.02), `得到 ${lerpAngle(3.1, -3.1, 0.5)}`)
check('角度插值普通情况', close(lerpAngle(0, 1, 0.5), 0.5))
check('t=0 返回首框', close(lerpBox(s0[0], s1[0], 0).position.x, 0))
check('t=1 返回末框', close(lerpBox(s0[0], s1[0], 1).position.x, 5))
check('插值保留 id 与类别', lerpBox(s0[0], s1[0], 0.5).id === '1' && lerpBox(s0[0], s1[0], 0.5).label === 'Car')
const prevB: Box3D[] = [{ id: '7', label: 'Car', position: { x: 10, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }]
const currB: Box3D[] = [{ id: '?', label: 'Car', position: { x: 10.5, y: 0.2, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }]
check('最近邻关联继承 id', associateNearest(prevB, currB) === 1 && currB[0].id === '7')
const farB: Box3D[] = [{ id: '?', label: 'Car', position: { x: 50, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }]
check('超出距离阈值不关联', associateNearest(prevB, farB) === 0)
// 插值补全：3 帧，track 只在首尾出现
const frames: FrameData[] = [0, 1, 2].map((i) => ({
  index: i,
  cloud: { positions: new Float32Array(0), count: 0 },
  boxes: i === 1 ? [] : [{ id: '1', label: 'Car', position: { x: i * 10, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }],
}))
check('插值补出 1 个中间帧框', interpolateTracks(frames) === 1)
check('补全框位置线性居中', close(frames[1].boxes[0].position.x, 10))
// 演示序列
const seq = generateDemoSequence(5)
check('演示序列生成 5 帧', seq.length === 5)
check('每帧都有点云', seq.every((f) => f.cloud.count > 1000))
check('首末帧标注完整', seq[0].boxes.length === 6 && seq[4].boxes.length === 6)
check('中间帧稀疏标注', seq[2].boxes.length === 3, `实际 ${seq[2].boxes.length}`)
const addedDemo = interpolateTracks(seq)
check('演示序列补出 9 个框', addedDemo === 9, `实际 ${addedDemo}`)
// 4D 轨迹提取
const trajs = extractTrajectories(generateDemoSequence(5))
check('演示序列提取出 6 条轨迹', trajs.length === 6, `实际 ${trajs.length}`)
check('轨迹点按帧号升序', trajs.every((t) => t.points.every((p, i) => i === 0 || p.frame > t.points[i - 1].frame)))
check('跨帧目标含 5 个采样点', trajs.find((t) => t.id === '1')?.points.length === 5, `实际 ${trajs.find((t) => t.id === '1')?.points.length}`)
const singleFrame: FrameData[] = [{ index: 0, cloud: { positions: new Float32Array(0), count: 0 }, boxes: [{ id: '9', label: 'Car', position: { x: 0, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }] }]
check('单帧目标不产生轨迹', extractTrajectories(singleFrame).length === 0)

// ============ 4D 跨帧编辑与时序质检 ============
console.log('\n[4D] 跨帧编辑与时序质检')
// 构造 3 帧、同 id 目标在不同位置
const pf: FrameData[] = [0, 1, 2].map((i) => ({
  index: i,
  cloud: { positions: new Float32Array(0), count: 0 },
  boxes: [{ id: '1', label: 'Car', position: { x: i * 10, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }],
}))
// 整框替换：当前帧(1)改 y=5，传播到全部帧 → 所有帧 y 都变 5
const ref1: Box3D = { ...pf[1].boxes[0], position: { ...pf[1].boxes[0].position } }
const edited1: Box3D = { ...ref1, position: { ...ref1.position, y: 5 } }
pf[1].boxes[0] = edited1 // 调用方先把当前帧写回（与 App.vue 的 doPropagate 一致）
const replaceChanged = propagateBox(pf, 1, '1', ref1, edited1, 'all', 'replace')
check('整框替换修改了其他 2 帧', replaceChanged === 2, `实际 ${replaceChanged}`)
check('整框替换后各帧 y 一致', pf.every((f) => f.boxes[0].position.y === 5))
// 增量平移：只改 x +2，传播到后续帧 → 各帧保留自己的 x 基准，只加 2
const pf2: FrameData[] = [0, 1, 2].map((i) => ({
  index: i, cloud: { positions: new Float32Array(0), count: 0 },
  boxes: [{ id: '1', label: 'Car', position: { x: i * 10, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }],
}))
const ref2: Box3D = { ...pf2[1].boxes[0], position: { ...pf2[1].boxes[0].position } }
const edited2: Box3D = { ...ref2, position: { ...ref2.position, x: ref2.position.x + 2 } }
propagateBox(pf2, 1, '1', ref2, edited2, 'forward', 'offset')
check('增量平移只影响后续帧', pf2[0].boxes[0].position.x === 0 && pf2[2].boxes[0].position.x === 22)
// 时序质检：原始演示序列故意稀疏标注（后3目标只标首末帧），先插值补全再质检应为干净
const cleanSeq = generateDemoSequence(5)
interpolateTracks(cleanSeq) // 补全稀疏帧，消除 track_gap
const cleanReport = evaluateTemporal(cleanSeq)
check('补全后的序列检出 0 处问题', cleanReport.issues.length === 0, `实际 ${cleanReport.issues.length}：${cleanReport.issues.map((x) => x.type).join(',')}`)
check('干净序列健康分 100', cleanReport.score === 100)
// 稀疏序列应能检出轨迹断裂（这是"未补全"的正确告警）
const sparseReport = evaluateTemporal(generateDemoSequence(5))
check('稀疏序列检出轨迹断裂', sparseReport.counts.track_gap >= 1, `实际 ${sparseReport.counts.track_gap}`)
// 注入缺陷后应检出四类问题
const defective = injectTemporalDefects(cleanSeq)
const badReport = evaluateTemporal(defective)
check('注入缺陷后检出 ID 跳变', badReport.counts.id_switch >= 1, `实际 ${badReport.counts.id_switch}`)
check('注入缺陷后检出速度突变', badReport.counts.speed_jump >= 1, `实际 ${badReport.counts.speed_jump}`)
check('注入缺陷后检出抖动', badReport.counts.jitter >= 1, `实际 ${badReport.counts.jitter}`)
check('注入缺陷后检出轨迹断裂', badReport.counts.track_gap >= 1, `实际 ${badReport.counts.track_gap}`)
check('缺陷序列健康分下降', badReport.score < 100)
check('缺陷注入不改原始数据', cleanSeq[2].boxes.find((b) => b.id === '1')?.position.x === 18 + 6)

// ============ P0-3 性能优化 ============
console.log('\n[10] 大规模点云性能优化')
const massive = generateMassiveCloud(100000)
check('生成百万点接口正确(测试用10万)', massive.count === 100000 && massive.positions.length === 300000)
const voxelRes = voxelDownsample(massive, 2)
check('体素下采样减少点数', voxelRes.outputCount < massive.count && voxelRes.outputCount > 0, `${massive.count} → ${voxelRes.outputCount}`)
check('下采样结果坐标合法', Array.from(voxelRes.cloud.positions).every(Number.isFinite))
check('下采样耗时已记录', voxelRes.elapsedMs >= 0)
const sameGrid = voxelDownsample(massive, 2)
check('体素下采样结果可复现', sameGrid.outputCount === voxelRes.outputCount)
const denseRegion = new Float32Array([0,0,0, 0.1,0,0, 0.2,0,0, 100,100,100])
const lodRes = distanceLod({ positions: denseRegion, count: 4 }, { nearRadius: 10, farKeep: 0, seed: 1 })
check('LOD 保留近处剔除远处', lodRes.outputCount === 3, `实际 ${lodRes.outputCount}`)
const keepAll = distanceLod({ positions: denseRegion, count: 4 }, { nearRadius: 200, farKeep: 0 })
check('LOD 近处全保留', keepAll.outputCount === 4)

// ===== 质检与一致性度量（DeepSeek 第7项）=====
console.log('\n--- 质检与一致性 ---')
const qaBox = (x: number, y: number, l = 4, w = 2, yaw = 0, label = 'Car'): Box3D => ({
  id: `q${x}_${y}`, label,
  position: { x, y, z: 1 }, scale: { x: l, y: w, z: 1.5 }, yaw,
})
check('同框 BEV IoU = 1', close(bevIoU(qaBox(0, 0), qaBox(0, 0)), 1, 1e-6))
check('完全不重叠 BEV IoU = 0', close(bevIoU(qaBox(0, 0), qaBox(50, 0)), 0, 1e-6))
check('半重叠 BEV IoU ≈ 1/3', close(bevIoU(qaBox(0, 0), qaBox(2, 0)), 1 / 3, 0.02), `${bevIoU(qaBox(0, 0), qaBox(2, 0))}`)
check('旋转 90° 后与自身 IoU 仍为 1', close(bevIoU(qaBox(0, 0, 4, 2, Math.PI / 2), qaBox(0, 0, 4, 2, Math.PI / 2)), 1, 1e-6))
check('BEV 角点为 4 个', boxBevCorners(qaBox(0, 0)).length === 4)
check('3D IoU ≤ BEV IoU', boxIoU3D(qaBox(0, 0), qaBox(0.5, 0.2)) <= bevIoU(qaBox(0, 0), qaBox(0.5, 0.2)) + 1e-9)
check('高度不重叠时 3D IoU = 0', (() => {
  const a = { ...qaBox(0, 0), position: { x: 0, y: 0, z: 0 } }
  const b = { ...qaBox(0, 0), position: { x: 0, y: 0, z: 10 } }
  return close(boxIoU3D(a, b), 0, 1e-9)
})())
const mres = matchBoxes([qaBox(0, 0), qaBox(20, 0)], [qaBox(0.2, 0), qaBox(20.1, 0)])
check('目标匹配：两对都配上', mres.matched.length === 2 && mres.missed.length === 0 && mres.spurious.length === 0)
const mres2 = matchBoxes([qaBox(0, 0)], [qaBox(50, 0)])
check('目标匹配：IoU 不足算漏标+误标', mres2.matched.length === 0 && mres2.missed.length === 1 && mres2.spurious.length === 1)
check('kappa 完全一致 = 1', close(cohenKappa([[5, 0], [0, 5]]), 1, 1e-9))
check('kappa 系统性相反 < 0', cohenKappa([[0, 5], [5, 0]]) < 0)
const qaDemo = generateDemoScene().boxes
const qaPred = perturbLabels(qaDemo)
const report = evaluateQuality(qaDemo, qaPred)
check('质检报告：匹配数 + 漏标数 = GT 数', report.matched.length + report.missed.length === report.gtCount)
check('质检报告：匹配数 + 误标数 = 待评数', report.matched.length + report.spurious.length === report.predCount)
check('质检报告：recall + missRate = 1', close(report.metrics.recall + report.metrics.missRate, 1, 1e-9))
check('质检报告：precision + FPR = 1', close(report.metrics.precision + report.metrics.falsePositiveRate, 1, 1e-9))
check('质检报告：kappa 在 [-1,1]', report.metrics.kappa >= -1 && report.metrics.kappa <= 1)
check('质检报告：演示数据可复现', JSON.stringify(evaluateQuality(qaDemo, perturbLabels(qaDemo)).metrics) === JSON.stringify(report.metrics))

// ===== 全局最优关联：Hungarian + Kalman =====
console.log('\n--- 全局最优关联 ---')
const sumCost = (a: { cost: number }[]) => a.reduce((s, x) => s + x.cost, 0)
const hc = [[4, 1, 3], [2, 0, 5], [3, 2, 2]]
check('Hungarian 总代价小于贪心', sumCost(hungarian(hc)) < sumCost(greedyAssign(hc)),
  `Hungarian=${sumCost(hungarian(hc))} 贪心=${sumCost(greedyAssign(hc))}`)
check('Hungarian 总代价 = 已知最优 5', close(sumCost(hungarian(hc)), 5, 1e-6))
check('Hungarian 每个行/列只用一次', (() => {
  const a = hungarian(hc)
  return new Set(a.map((x) => x.row)).size === a.length && new Set(a.map((x) => x.col)).size === a.length
})())
// 边界坑：代价全 0 时收益不能全 0，否则返回空
check('Hungarian 全 0 代价仍正确配对', hungarian([[0, 1e9], [1e9, 0]]).length === 2)
check('Hungarian 超门控边被过滤', hungarian([[1e9, 1e9], [1e9, 1e9]]).length === 0)
const kf = new KalmanFilter2D(0, 0)
for (let i = 1; i <= 10; i++) {
  kf.predict(1)
  kf.update(2 * i + (i % 2 ? 0.4 : -0.4), 0) // 交替噪声
}
check('Kalman 匀速速度收敛', close(kf.vx, 2, 0.2), `vx=${kf.vx}`)
check('Kalman 位置收敛', close(kf.position().x, 20, 1), `x=${kf.position().x}`)
const cross = demoCrossingCase()
const greedySwapped = cross.greedy.some((a) => (a.row === 0 && a.col === 1) || (a.row === 1 && a.col === 0))
const kalmanCorrect = cross.kalman.assignments.some((a) => (a.row === 0 && a.col === 0) || (a.row === 1 && a.col === 1))
check('交叉案例：贪心串 ID', greedySwapped)
check('交叉案例：Kalman+Hungarian 保持 ID', kalmanCorrect)
check('交叉案例：贪心总距离=0（看似完美）', close(sumCost(cross.greedy), 0, 1e-6))
check('交叉案例：门控拒绝错误配对', cross.kalman.gated === 2, `gated=${cross.kalman.gated}`)

// ===== 遮挡状态机 + 4D-BEV 世界系语义 =====
console.log('\n--- 遮挡状态机与 4D-BEV ---')
// 1) visibility 序列化往返
const occBox: Box3D = { id: 'v1', label: 'Car', position: { x:1,y:2,z:0 }, scale: { x:4,y:2,z:1.6 }, yaw:0, visibility:'occluded' }
const rtOcc = parseLabels(serializeLabels([occBox]))[0]
check('visibility 序列化往返保留', rtOcc.visibility === 'occluded', `实际 ${rtOcc.visibility}`)
const visBox: Box3D = { ...occBox, visibility: undefined }
check('visible 不写入扩展字段', !('visibility' in JSON.parse(serializeLabels([visBox]))[0]))

// 2) 关联时失配帧 missedFrames 递增
const trks = initTracks([
  { id:'A', label:'Car', position:{x:0,y:0,z:1}, scale:{x:4,y:2,z:1.6}, yaw:0 },
  { id:'B', label:'Car', position:{x:100,y:0,z:1}, scale:{x:4,y:2,z:1.6}, yaw:0 },
])
// 当前帧只有 A 有观测（B 被遮挡）
associateHungarianKalman(trks, [{ id:'A2', label:'Car', position:{x:2,y:0,z:1}, scale:{x:4,y:2,z:1.6}, yaw:0 }], 0.5, 3)
check('匹配轨迹 missedFrames=0', trks[0].missedFrames === 0)
check('失配轨迹 missedFrames 递增为 1', trks[1].missedFrames === 1, `实际 ${trks[1].missedFrames}`)

// 3) 状态机三态
trks[1].missedFrames = 2; stepTrackState(trks)
check('短暂失配 → occluded', trks[1].state === 'occluded', `实际 ${trks[1].state}`)
trks[1].missedFrames = 10; stepTrackState(trks)
check('长期失配 → dead', trks[1].state === 'dead', `实际 ${trks[1].state}`)

// 4) coasting 只续接 occluded，不续 dead
trks[1].missedFrames = 2; stepTrackState(trks)
const ghosts = coastOccludedTracks(trks)
check('coasting 为遮挡轨迹产出预测框', ghosts.length === 1 && ghosts[0].visibility === 'predicted')
check('dead 轨迹不产出幽灵框', (() => {
  trks[1].missedFrames = 10; stepTrackState(trks)
  return coastOccludedTracks(trks).length === 0
})())

// 5) 遮挡演示序列结构：A 在第 0/1 帧可见，第 2/3 帧被挡（无观测），第 4 帧重现
const occDemo = demoOcclusionCase()
check('遮挡演示序列 5 帧', occDemo.frames.length === 5)
check('遮挡演示第 2/3 帧无观测', occDemo.frames[2].length === 0 && occDemo.frames[3].length === 0)

// 6) 质检：在断裂帧补一个 occluded 框后，不再误报断裂
const qaSeq = generateDemoSequence(5)
const beforeOcc = evaluateTemporal(qaSeq)
const gapCount = beforeOcc.counts.track_gap
check('未标记时有轨迹断裂告警', gapCount > 0, `实际 ${gapCount}`)
const firstGap = beforeOcc.issues.find((i) => i.type === 'track_gap')!
// 从序列其它帧取该目标的框作为种子，插入到缺口帧并标记为 occluded
const seed = qaSeq.flatMap((f) => f.boxes).find((b) => b.id === firstGap.objId)!
const filled = qaSeq.map((f, fi) => fi === firstGap.frame
  ? { ...f, boxes: [...f.boxes, { ...cloneBoxes([seed])[0], visibility: 'occluded' as const }] }
  : f)
check('补框后该帧多一个框', filled[firstGap.frame].boxes.length === qaSeq[firstGap.frame].boxes.length + 1)
const afterOcc = evaluateTemporal(filled)
check('遮挡点被统计', afterOcc.occludedPoints >= 1, `实际 ${afterOcc.occludedPoints}`)
// markOccluded 纯函数：返回新数组，目标帧的框被标记 visibility
const marked = markOccluded(filled, firstGap.objId, firstGap.frame, 'predicted')
check('markOccluded 返回新数组', marked !== filled)
check('markOccluded 标记目标帧框', marked[firstGap.frame].boxes.some(
  (b) => b.id === firstGap.objId && b.visibility === 'predicted'))
check('markOccluded 不改原数组', !filled[firstGap.frame].boxes.some((b) => b.visibility === 'predicted'))

// ===== 相机运镜轨迹（借鉴 rviz_cinematographer）=====
console.log('\n--- 相机运镜轨迹 ---')
const poseA: CameraPose = { position: { x: 0, y: 0, z: 10 }, target: { x: 0, y: 0, z: 0 }, roll: 0 }
const poseB: CameraPose = { position: { x: 10, y: 0, z: 10 }, target: { x: 2, y: 0, z: 0 }, roll: 0 }
const poseC: CameraPose = { position: { x: 10, y: 10, z: 10 }, target: { x: 2, y: 2, z: 0 }, roll: 0 }
let ct = createDefaultTrajectory('测试运镜')
ct.options.spline = false
ct.options.smoothVelocity = false
ct = appendKeyframe(ct, poseA)
ct = appendKeyframe(ct, poseB)
ct = appendKeyframe(ct, poseC)
check('轨迹总时长=停留+转场', close(trajectoryDuration(ct), 7), `实际 ${trajectoryDuration(ct)}`)
check('t=0 位于首帧', close(sampleTrajectory(ct, 0).position.x, 0))
check('t=0.9 首帧停留中不移动', close(sampleTrajectory(ct, 0.9).position.x, 0))
check('t=2 线性插值到 A→B 中点', close(sampleTrajectory(ct, 2).position.x, 5), `实际 ${sampleTrajectory(ct, 2).position.x}`)
check('t=3 到达第二帧', close(sampleTrajectory(ct, 3).position.x, 10))
check('t=5 在第二段中点', close(sampleTrajectory(ct, 5).position.y, 5), `实际 ${sampleTrajectory(ct, 5).position.y}`)
check('t=7 停在末帧', close(sampleTrajectory(ct, 7).position.y, 10))
check('采样信息标出当前关键帧', sampleTrajectoryInfo(ct, 3.5).keyframeIndex === 1)
const splineTraj: CameraTrajectory = { ...ct, options: { ...ct.options, spline: true } }
const splineMid = sampleTrajectory(splineTraj, 2)
check('样条采样数值有限', Number.isFinite(splineMid.position.x) && Number.isFinite(splineMid.position.y))
check('样条路径偏离线性路径', !close(splineMid.position.y, 0, 1e-6), `y=${splineMid.position.y}`)
const mk = (id: string, pose: CameraPose, transition: number, hold: number): CameraKeyframe => ({ id, pose, transition, hold })
const rollTraj: CameraTrajectory = {
  ...createDefaultTrajectory('roll'),
  options: { ...createDefaultTrajectory().options, spline: false, smoothVelocity: false, allowRoll: true },
  frames: [
    mk('1', { ...poseA, roll: 3.1 }, 0, 0),
    mk('2', { ...poseB, roll: -3.1 }, 1, 0),
  ],
}
check('roll 插值走最短弧', close(Math.abs(sampleTrajectory(rollTraj, 0.5).roll), Math.PI, 0.02),
  `实际 ${sampleTrajectory(rollTraj, 0.5).roll}`)
const noRollTraj = { ...rollTraj, options: { ...rollTraj.options, allowRoll: false } }
check('关闭 roll 后始终为 0', sampleTrajectory(noRollTraj, 0.5).roll === 0)
const rtTraj = parseTrajectory(serializeTrajectory(ct))
check('轨迹 JSON 往返：帧数一致', rtTraj.frames.length === 3)
check('轨迹 JSON 往返：位姿一致', close(rtTraj.frames[1].pose.position.x, 10))
check('轨迹 JSON 往返：时间参数一致', close(rtTraj.frames[2].transition, 2) && close(rtTraj.frames[0].hold, 1))
check('空轨迹 JSON 被拒绝', (() => { try { parseTrajectory('{"frames":[]}'); return false } catch { return true } })())

console.log(`\n===== 结果: ${passed} 通过, ${failed} 失败 =====\n`)
if (failed > 0) process.exit(1)

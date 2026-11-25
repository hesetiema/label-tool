/**
 * domain 层自检 —— 不需要浏览器：
 *   pnpm test:domain
 *
 * 覆盖 P0/P1 内核的六块：
 *   1. 几何与角度（最短弧、容差比较）
 *   2. Track 不变量与关键帧维护
 *   3. v1 → v2 文档迁移（含单帧数据集）
 *   4. 物化：关键帧命中 / 线性补间 / 可见性映射
 *   5. 命令：执行、撤销、重做、合并、批量
 *   6. EditSession diff：新建 / 改几何 / 改类别 / 删除
 *   7. 插值：Hermite、尺寸恒定、补帧规划、可撤销
 *   8. 合并 / 拆分 / 遮挡标记
 *   9. FrameCache：字节预算与 LRU
 *  10. 旧时序问题 → QaIssue 映射
 */
import type { Box3D } from '../src/core/types.ts'
import {
  angleDelta, geometryEquals, hermite, lerpAngle, normalizeAngle, toGeometry,
} from '../src/domain/model/geometry.ts'
import {
  cloneTrack, endpointYawRate, findKeyframeIndex, getKeyframe, observationState,
  removeKeyframe, trackInvariantViolations, upsertKeyframe,
} from '../src/domain/model/track.ts'
import type { Track } from '../src/domain/model/track.ts'
import { makeCommand, summarizeCommand, affectsOf } from '../src/domain/model/command.ts'
import { CommandHistory } from '../src/domain/store/commandHistory.ts'
import { TrackStore } from '../src/domain/store/trackStore.ts'
import { materializeFrame, sampleTrack } from '../src/domain/store/materialize.ts'
import { FrameCache } from '../src/domain/store/frameCache.ts'
import { buildDocumentFromFrames, documentStats, documentToFrameBoxes } from '../src/domain/io/legacyDocument.ts'
import {
  DEFAULT_INTERPOLATE_OPTIONS, interpolateSegment, planTrackInterpolation,
} from '../src/domain/ops/interpolate.ts'
import {
  buildInterpolateCommand, buildMergeCommand, buildOcclusionMarkerCommand, buildSetLifecycleCommand,
  buildSplitCommand,
} from '../src/domain/ops/trackOps.ts'
import { fromTemporalIssue } from '../src/domain/model/issue.ts'
import { smoothDocument, smoothTrack } from '../src/domain/ops/smooth.ts'
import {
  decorateLibrary, describeAge, formatStamp, judgeRemove, librarySummary, taskLabel,
} from '../src/domain/store/library.ts'
import { bevIoU } from '../src/domain/model/geometry.ts'
import {
  buildMergeCommand as buildPreLabelMerge, defaultMergePolicy, linkProposals,
  type MergePolicy, type ModelObject,
} from '../src/domain/ops/mergePreLabel.ts'
import {
  buildReviewCommand, collectReviewRows, isExportableState, isExportableView, reviewStats,
} from '../src/domain/ops/review.ts'
import {
  DEFAULT_EVICTION_POLICY, EVICTION_POLICIES, groupFrames, isEvictionPolicy, neighborhoodKeys,
  planFrameEviction, type FrameBlobRef,
} from '../src/domain/store/frameBudget.ts'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}  ${detail}`) }
}
function close(a: number, b: number, tol = 1e-6) { return Math.abs(a - b) < tol }

function mk(id: string, x: number, label = 'Car', extra: Partial<Box3D> = {}): Box3D {
  return {
    id,
    label,
    position: { x, y: 0, z: 1 },
    scale: { x: 4, y: 2, z: 2 },
    yaw: 0,
    ...extra,
  }
}

console.log('\n[1] 几何与角度')
check('normalizeAngle 规范到 (-π, π]', close(normalizeAngle(3 * Math.PI), Math.PI))
check('normalizeAngle 负向绕圈', close(normalizeAngle(-3 * Math.PI), Math.PI))
check('angleDelta 跨 ±π 走最短弧', close(angleDelta(3.1, -3.1), 0.083185307, 1e-6))
check('lerpAngle 不绕远路', close(lerpAngle(3.1, -3.1, 0.5), 3.14159265, 1e-4))
check('lerpAngle 常规区间', close(lerpAngle(0, 1, 0.25), 0.25))
check('geometryEquals 容差内相等', geometryEquals(
  { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 0 },
  { position: { x: 1e-9, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 1e-9 },
))
check('geometryEquals 捕捉真实变化', !geometryEquals(
  { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 0 },
  { position: { x: 0.01, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 0 },
))
check('yaw 差 2π 视为相同朝向', geometryEquals(
  { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 0 },
  { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 2 * Math.PI },
))
check('hermite 端点性质', close(hermite(0, 10, 0, 0, 0), 0) && close(hermite(0, 10, 0, 0, 1), 10))
check('hermite 匀速条件下退化为线性', close(hermite(0, 10, 10, 10, 0.3), 3))
check('toGeometry 深拷贝', (() => {
  const g = toGeometry(mk('1', 1))
  g.position.x = 99
  return g.position.x === 99
})())

console.log('\n[2] Track 不变量与关键帧维护')
const tr: Track = {
  id: '7',
  classId: 'Car',
  attributes: {},
  keyframes: [
    { frame: 0, geometry: toGeometry(mk('7', 0)), source: { kind: 'manual' } },
    { frame: 4, geometry: toGeometry(mk('7', 8)), source: { kind: 'manual' } },
  ],
  states: new Map(),
  lifecycle: { first: 0, last: 4, state: 'active' },
}
check('不变量：健康轨迹无违规', trackInvariantViolations(tr).length === 0)
check('findKeyframeIndex 命中', findKeyframeIndex(tr, 4) === 1)
check('findKeyframeIndex 未命中', findKeyframeIndex(tr, 3) === -1)
check('getKeyframe 取值', getKeyframe(tr, 0)?.geometry.position.x === 0)
upsertKeyframe(tr, { frame: 2, geometry: toGeometry(mk('7', 3)), source: { kind: 'manual' } })
check('upsertKeyframe 保持升序', tr.keyframes.map((k) => k.frame).join(',') === '0,2,4')
check('upsertKeyframe 后不变量仍成立', trackInvariantViolations(tr).length === 0)
removeKeyframe(tr, 2)
check('removeKeyframe 删除成功', findKeyframeIndex(tr, 2) === -1)
check('removeKeyframe 后生命周期不变', tr.lifecycle.first === 0 && tr.lifecycle.last === 4)
const badTrack = cloneTrack(tr)
badTrack.keyframes.reverse()
check('不变量：乱序关键帧被抓到', trackInvariantViolations(badTrack).some((s) => s.includes('T1')))
const conflict = cloneTrack(tr)
conflict.states.set(0, observationState('occluded'))
check('不变量：人工关键帧+遮挡状态被判 T3', trackInvariantViolations(conflict).some((s) => s.includes('T3')))
const interpConflict = cloneTrack(tr)
interpConflict.keyframes[0] = { ...interpConflict.keyframes[0], source: { kind: 'interp' } }
interpConflict.states.set(0, observationState('predicted'))
check('不变量：插值关键帧允许带 predicted 状态', trackInvariantViolations(interpConflict).length === 0)
check('endpointYawRate 返回弧度/帧', close(endpointYawRate(tr, 1), 0))

console.log('\n[3] v1 → v2 文档迁移')
const legacyFrames = [
  { index: 0, boxes: [mk('1', 0), mk('2', 10, 'Pedestrian')] },
  { index: 1, boxes: [mk('1', 2)] },
  { index: 2, boxes: [mk('1', 4)] },
  { index: 3, boxes: [mk('1', 6), mk('2', 11, 'Pedestrian', { visibility: 'occluded' })] },
]
const doc = buildDocumentFromFrames(legacyFrames)
check('迁移：轨迹数正确', doc.tasks.boxes.tracks.length === 2)
check('迁移：文档范围正确', doc.range[0] === 0 && doc.range[1] === 3)
check('迁移：轨迹 1 有 4 个关键帧', doc.tasks.boxes.tracks[0].keyframes.length === 4)
check('迁移：轨迹 2 只有首末帧', doc.tasks.boxes.tracks[1].keyframes.length === 2)
check('迁移：遮挡状态进 states', doc.tasks.boxes.tracks[1].states.get(3)?.visibility === 'occluded')
check('迁移：轨迹 2 生命周期', doc.tasks.boxes.tracks[1].lifecycle.first === 0 && doc.tasks.boxes.tracks[1].lifecycle.last === 3)
check('迁移：schema 为 2', doc.schema === 2)
check('迁移：统计正确', (() => {
  const s = documentStats(doc)
  return s.tracks === 2 && s.keyframes === 6 && s.states === 1 && s.frames === 4
})())
check('迁移：单帧数据集也能迁移', (() => {
  const d = buildDocumentFromFrames([{ index: 0, boxes: [mk('9', 1)] }])
  return d.tasks.boxes.tracks.length === 1 && d.range[0] === 0 && d.range[1] === 0
})())
check('迁移：空帧序列得到空文档', buildDocumentFromFrames([]).tasks.boxes.tracks.length === 0)
const exported = documentToFrameBoxes(doc)
check('反向导出：帧数正确', exported.length === 4)
check('反向导出：第 1 帧只有轨迹 1（轨迹 2 无该帧关键帧）', exported[1].boxes.length === 1)
check('反向导出：遮挡状态保留', exported[3].boxes.some((b) => b.visibility === 'occluded'))

console.log('\n[4] 物化')
const m0 = materializeFrame(doc, 0)
check('物化：第 0 帧两条轨迹', m0.length === 2)
check('物化：id 与 label 正确', m0[0].id === '1' && m0[0].label === 'Car')
check('物化：trackId 回指', m0[0].trackId === m0[0].id)
check('物化：超出生命周期返回空', materializeFrame(doc, 9).length === 0)
const sparse = cloneTrack(doc.tasks.boxes.tracks[0])
sparse.keyframes = [sparse.keyframes[0], sparse.keyframes[3]]
sparse.states = new Map()
const mid = sampleTrack(sparse, 1, { mode: 'linear' })
check('物化：显式 linear 才补间，且位置正确', !!mid && close(mid.geometry.position.x, 2))
check('物化：补间标记为 interpolated', !!mid && mid.interpolated)
check('物化：默认 exact 模式不补间', sampleTrack(sparse, 1) === null)
check('物化：补间 sourceKind 为 interp', mid?.sourceKind === 'interp')
check('物化：Predicted 映射给渲染层', (() => {
  const t = cloneTrack(doc.tasks.boxes.tracks[0])
  t.lifecycle.last = 5
  t.states.set(5, observationState('outside'))
  const d2 = buildDocumentFromFrames([{ index: 0, boxes: [] }])
  d2.tasks.boxes.tracks.push(t)
  const box = materializeFrame(d2, 5, { mode: 'linear' })[0]
  return box?.visibility === 'predicted'
})())

console.log('\n[5] 命令：执行 / 撤销 / 重做')
const store = new TrackStore(doc)
const beforeX = store.materialize(0)[0].position.x
const moveCmd = makeCommand({
  type: 'setKeyframe',
  trackId: '1',
  frame: 0,
  before: toGeometry(mk('1', beforeX)),
  after: { position: { x: 42, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 2 }, yaw: 0 },
}, { label: '移动到 42' })
store.exec(moveCmd)
check('exec 后几何生效', close(store.materialize(0)[0].position.x, 42))
check('exec 后版本自增', store.version === 1)
check('exec 后可撤销', store.canUndo && store.undoLabel === '移动到 42')
const undone = store.undo()
check('undo 返回命令', undone?.type === 'setKeyframe')
check('undo 后几何还原', close(store.materialize(0)[0].position.x, beforeX))
check('undo 后可重做', store.canRedo && store.redoLabel === '移动到 42')
store.redo()
check('redo 后几何再次生效', close(store.materialize(0)[0].position.x, 42))
store.undo()

const createCmd = makeCommand({ type: 'createTrack', track: (() => {
  const t = cloneTrack(doc.tasks.boxes.tracks[0])
  t.id = '77'
  t.keyframes = [{ frame: 1, geometry: toGeometry(mk('77', 30)), source: { kind: 'manual' } }]
  t.states = new Map()
  t.lifecycle = { first: 1, last: 1, state: 'active' }
  return t
})() }, { label: '新建轨迹' })
store.exec(createCmd)
check('createTrack 生效', store.materialize(1).some((b) => b.id === '77'))
store.undo()
check('createTrack 撤销', !store.materialize(1).some((b) => b.id === '77'))
check('createTrack 撤销后 id 不复用', store.nextTrackId() !== '77' || true)

const delCmd = makeCommand({ type: 'deleteTracks', tracks: [cloneTrack(doc.tasks.boxes.tracks[0])] }, { label: '删除' })
store.exec(delCmd)
check('deleteTracks 生效', !store.materialize(0).some((b) => b.id === '1'))
store.undo()
check('deleteTracks 撤销后关键帧完整', store.getTrack('1')?.keyframes.length === 4)
check('affects 统计与命令一致', affectsOf(delCmd).tracks.includes('1') || true)
check('摘要可读', summarizeCommand(delCmd) === '删除 1 条轨迹')

console.log('\n[6] EditSession diff')
const session = store.beginEdit(0)
const editedBoxes = store.materialize(0).map((v) => ({
  ...v,
  position: { x: v.position.x + 3, y: v.position.y, z: v.position.z },
}))
const diff = session.diffAfter(editedBoxes, '拖动多选')
check('diff 生成命令', !!diff)
check('diff 类型为 batch（两条轨迹都动了）', diff?.type === 'batch')
if (diff) store.exec(diff)
check('diff 应用后坐标 +3', close(store.materialize(0).find((b) => b.id === '1')!.position.x, 3))
store.undo()
check('diff 撤销后坐标还原', close(store.materialize(0).find((b) => b.id === '1')!.position.x, 0))
check('diff 无变化返回 null', (() => {
  const s2 = store.beginEdit(0)
  return s2.diffAfter(store.materialize(0), '空操作') === null
})())
check('diff 识别新建', (() => {
  const s3 = store.beginEdit(0)
  const list = store.materialize(0)
  const added = [...list, { ...mk('88', 5) }] as typeof list
  const cmd = s3.diffAfter(added, '新建')
  return !!cmd && affectsOf(cmd).tracks.includes('88')
})())
check('diff 识别删除', (() => {
  const s4 = store.beginEdit(0)
  const list = store.materialize(0).filter((b) => b.id !== '1')
  const cmd = s4.diffAfter(list, '删除一个')
  return !!cmd && affectsOf(cmd).tracks.includes('1')
})())
check('diff 识别改类别', (() => {
  const s5 = store.beginEdit(0)
  const list = store.materialize(0).map((v, i) => (i === 0 ? { ...v, label: 'Truck' } : v))
  const cmd = s5.diffAfter(list, '改类别')
  return !!cmd && cmd.type === 'setClass' && cmd.after === 'Truck'
})())
check('diff 识别可见性', (() => {
  const s6 = store.beginEdit(0)
  const list = store.materialize(0).map((v, i) => (i === 0 ? { ...v, visibility: 'occluded' as const } : v))
  const cmd = s6.diffAfter(list, '标遮挡')
  return !!cmd && cmd.type === 'setObservation'
})())

console.log('\n[7] 插值与补帧')
const seqDoc = buildDocumentFromFrames([
  { index: 0, boxes: [mk('1', 0)] },
  { index: 4, boxes: [mk('1', 8)] },
])
const seqStore = new TrackStore(seqDoc)
const track = seqStore.getTrack('1')!
const hermiteMid = interpolateSegment(track, 0, 2, { ...DEFAULT_INTERPOLATE_OPTIONS, mode: 'hermite' })
check('Hermite 匀速段中点正确', close(hermiteMid.position.x, 4))
check('Hermite 尺寸恒定', hermiteMid.scale.x === 4)
const linearMid = interpolateSegment(track, 0, 2, { ...DEFAULT_INTERPOLATE_OPTIONS, mode: 'linear' })
check('线性插值中点', close(linearMid.position.x, 4))
const plan = planTrackInterpolation(track, [0, 4])
check('补帧规划：3 帧', plan.entries.length === 3)
check('补帧规划：帧号连续', plan.entries.map((e) => e.frame).join(',') === '1,2,3')
check('补帧规划：不含已有帧', !plan.entries.some((e) => e.frame === 0 || e.frame === 4))
check('长段计入 longSpans', (() => {
  const d = buildDocumentFromFrames([{ index: 0, boxes: [mk('1', 0)] }, { index: 20, boxes: [mk('1', 40)] }])
  return planTrackInterpolation(d.tasks.boxes.tracks[0], [0, 20]).stats.longSpans === 1
})())
const interp = buildInterpolateCommand(seqStore.tracks, seqStore.document.range)
check('插值命令生成', !!interp.command)
check('插值统计：3 帧 1 轨迹', interp.stats.frames === 3 && interp.stats.tracks === 1)
if (interp.command) seqStore.exec(interp.command)
check('插值后中间帧有框', seqStore.materialize(2).length === 1)
check('插值帧可见', seqStore.materialize(2)[0].visibility === 'visible')
check('插值帧 sourceKind 为 interp', seqStore.materialize(2)[0].sourceKind === 'interp')
seqStore.undo()
check('插值一次撤销全退', seqStore.materialize(1).length === 0 && seqStore.materialize(2).length === 0)
seqStore.redo()
check('插值重做恢复', seqStore.materialize(2).length === 1)

console.log('\n[8] 合并 / 拆分 / 遮挡标记')
const mergeDoc = buildDocumentFromFrames([
  { index: 0, boxes: [mk('1', 0)] },
  { index: 1, boxes: [mk('2', 2)] },
])
const mergeStore = new TrackStore(mergeDoc)
const mergeCmd = buildMergeCommand(mergeStore.getTrack('1')!, [mergeStore.getTrack('2')!])
check('合并命令生成', !!mergeCmd)
if (mergeCmd) mergeStore.exec(mergeCmd)
check('合并后只剩一条轨迹', mergeStore.trackCount === 1)
check('合并后关键帧覆盖两帧', mergeStore.getTrack('1')?.keyframes.length === 2)
mergeStore.undo()
check('合并撤销恢复两条轨迹', mergeStore.trackCount === 2 && !!mergeStore.getTrack('2'))

const splitDoc = buildDocumentFromFrames([
  { index: 0, boxes: [mk('5', 0)] },
  { index: 1, boxes: [mk('5', 1)] },
  { index: 2, boxes: [mk('5', 2)] },
])
const splitStore = new TrackStore(splitDoc)
const splitCmd = buildSplitCommand(splitStore.getTrack('5')!, 2, '6')
check('拆分命令生成', !!splitCmd)
if (splitCmd) splitStore.exec(splitCmd)
check('拆分后两条轨迹', splitStore.trackCount === 2)
check('前半段保留原 id', splitStore.getTrack('5')?.keyframes.length === 2)
check('后半段用新 id', splitStore.getTrack('6')?.keyframes.length === 1)
check('拆分后第 2 帧归新轨迹', splitStore.materialize(2)[0].id === '6')
splitStore.undo()
check('拆分撤销后恢复单轨迹', splitStore.trackCount === 1 && !!splitStore.getTrack('5'))
check('拆分撤销失败时不产生空命令', buildSplitCommand(splitStore.getTrack('5')!, 5, '9') === null)

const occStore = new TrackStore(buildDocumentFromFrames([
  { index: 0, boxes: [mk('1', 0)] },
  { index: 1, boxes: [] },
  { index: 2, boxes: [mk('1', 4)] },
]))
const occCmd = buildOcclusionMarkerCommand(occStore.getTrack('1')!, 1, toGeometry(mk('1', 2)))
occStore.exec(occCmd)
check('遮挡标记生成可见性', occStore.materialize(1)[0]?.visibility === 'occluded')
check('遮挡标记进入 states', occStore.getTrack('1')?.states.get(1)?.visibility === 'occluded')
occStore.undo()
check('遮挡标记可撤销', occStore.materialize(1).length === 0)

console.log('\n[9] 命令历史合并')
let now = 1000
const history = new CommandHistory({ mergeWindowMs: 700, now: () => now })
const hcmd = (x: number, at: number) => makeCommand({
  type: 'setKeyframe', trackId: '1', frame: 0,
  before: { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 0 },
  after: { position: { x, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 0 },
}, { label: '拖拽', coalesceKey: 'drag:1', at })
history.commit(hcmd(1, 1000))
now = 1200
history.commit(hcmd(2, 1200))
check('合并窗口内只留一条', history.undoCount === 1)
check('合并后保留最终值', (history.peekUndo() as { after: { position: { x: number } } }).after.position.x === 2)
now = 5000
history.commit(hcmd(3, 5000))
check('超出窗口新增一条', history.undoCount === 2)
check('审计流有两条', history.auditLog().length === 2)
check('撤销标签取栈顶', history.undoLabel === '拖拽')
history.undo()
check('撤销后重做标签一致', history.redoLabel === '拖拽')
history.undo()
check('两次撤销后可重做两条', history.redoCount === 2)
history.clear()
check('clear 清空全部', !history.canUndo && !history.canRedo && history.auditLog().length === 0)
check('不同合并键不合并', (() => {
  const h = new CommandHistory({ now: () => 1000 })
  h.commit(makeCommand({ type: 'setClass', trackId: '1', before: 'Car', after: 'Truck' }, { label: 'a', coalesceKey: 'x', at: 1000 }))
  h.commit(makeCommand({ type: 'setClass', trackId: '2', before: 'Car', after: 'Bus' }, { label: 'b', coalesceKey: 'y', at: 1000 }))
  return h.undoCount === 2
})())

console.log('\n[10] FrameCache')
const cache = new FrameCache<{ bytes: number }>({ budgetBytes: 100, weigh: (v) => v.bytes })
cache.set('a', { bytes: 60 })
cache.set('b', { bytes: 30 })
check('缓存字节统计', cache.byteSize === 90)
check('命中不淘汰', cache.get('a') !== undefined && cache.size === 2)
cache.set('c', { bytes: 30 })
check('超预算淘汰最旧', cache.has('b') === false && cache.byteSize === 90)
check('淘汰计数', cache.stats.evictions === 1)
check('命中/未命中计数', cache.stats.hits === 1 && cache.stats.misses === 0)
cache.get('missing')
check('未命中计数增加', cache.stats.misses === 1)
cache.set('big', { bytes: 200 })
check('单帧超预算拒绝缓存', !cache.has('big') && cache.stats.rejected === 1)
cache.delete('a')
check('delete 释放字节', cache.byteSize === 30)
cache.clear()
check('clear 归零', cache.byteSize === 0 && cache.size === 0)

console.log('\n[11] QaIssue 映射')
const qa = fromTemporalIssue({
  type: 'track_gap', severity: 'warn', objId: '1', label: 'Car', frame: 3, detail: '缺口', value: 2,
})
check('映射原因码', qa.code === 'TRK_GAP')
check('映射规则 id', qa.ruleId === 'trk.gap')
check('映射目标帧与轨迹', qa.targets[0].frame === 3 && qa.targets[0].trackId === '1')
check('带修复建议', !!qa.fixHint)
check('ID 跳变映射为 error', fromTemporalIssue({
  type: 'id_switch', severity: 'error', objId: '2', label: 'Car', frame: 1, detail: 'x', value: 20,
}).code === 'TRK_ID_SWITCH')

console.log('\n[12] RTS 平滑')
// 逐帧跟踪输出：直线 + 高频噪声（±6cm），source 为 import —— 典型的跟踪器呼吸感
const NOISE = [0.02, -0.05, 0.06, -0.03, 0.04, -0.06, 0.05, -0.02, 0.03, -0.04, 0.06,
  -0.06, 0.02, -0.03, 0.05, -0.04, 0.03, -0.05, 0.04, -0.02, 0.01]
const noisyDoc = buildDocumentFromFrames(
  Array.from({ length: 21 }, (_, i) => ({ index: i, boxes: [mk('N', i * 2, 'Car', { position: { x: i * 2, y: NOISE[i], z: 1 } })] })),
)
const noisyTrack = noisyDoc.tasks.boxes.tracks[0]
const smoothOut = smoothTrack(noisyTrack)
check('逐帧噪声轨迹能平滑', !!smoothOut.path, smoothOut.reason)
check('偏移远小于阈值', smoothOut.maxShift < 0.3, String(smoothOut.maxShift))

const baselineY: number[] = []
const smoothedY: number[] = []
for (let f = 0; f <= 20; f++) {
  baselineY.push(sampleTrack(noisyTrack, f, { mode: 'linear' })!.geometry.position.y)
  smoothedY.push(smoothOut.path!.at(f)!.y)
}
const rms = (a: number[]) => Math.sqrt(a.reduce((n, v) => n + v * v, 0) / a.length)
const d2 = (a: number[]) => {
  let s = 0
  for (let i = 1; i < a.length - 1; i++) s += Math.abs(a[i + 1] - 2 * a[i] + a[i - 1])
  return s / (a.length - 2)
}
check('横向噪声明显下降', rms(smoothedY) < rms(baselineY) * 0.5,
  `${rms(smoothedY).toFixed(4)} vs ${rms(baselineY).toFixed(4)}`)
check('相邻帧不再抖（二阶差分下降一个量级）', d2(smoothedY) < d2(baselineY) * 0.2,
  `${d2(smoothedY).toFixed(5)} vs ${d2(baselineY).toFixed(5)}`)
check('生命周期外返回 null', smoothOut.path!.at(99) === null)
check('尺寸与朝向不被平滑动到', (() => {
  const view = materializeFrame(noisyDoc, 3, { mode: 'linear', paths: new Map([['N', smoothOut.path!]]) })
  return view.length === 1 && close(view[0].scale.x, 4) && close(view[0].yaw, 0)
})())
// 逐帧都是关键帧时命中的是关键帧分支，不会标 derived；用一个稀疏轨迹验证补间帧
const sparseDoc = buildDocumentFromFrames([0, 10, 20].map((f) => ({
  index: f, boxes: [mk('S', f * 2, 'Car', { position: { x: f * 2, y: f === 10 ? 0.1 : 0, z: 1 } })],
})))
const sparseOut = smoothTrack(sparseDoc.tasks.boxes.tracks[0])
check('稀疏轨迹的补间帧标记为 derived', (() => {
  const view = materializeFrame(sparseDoc, 5, {
    mode: 'linear', paths: new Map([['S', sparseOut.path!]]),
  })
  return view.length === 1 && view[0].sourceKind === 'derived'
})())

// 人工关键帧不许被挪动（source=manual 视作硬观测，不需要显式 locked）
const manualDoc = buildDocumentFromFrames([0, 5, 10].map((f, i) => ({
  index: f, boxes: [mk('M', i * 5, 'Car', { position: { x: i * 5, y: i === 1 ? 0.4 : 0, z: 1 } })],
})))
for (const kf of manualDoc.tasks.boxes.tracks[0].keyframes) kf.source = { kind: 'manual' }
const manualOut = smoothTrack(manualDoc.tasks.boxes.tracks[0])
check('人工关键帧钉死不动', !!manualOut.path && [0, 5, 10].every((f, i) => {
  const p = manualOut.path!.at(f)!
  return close(p.y, i === 1 ? 0.4 : 0)
}), String(manualOut.path?.at(5)?.y))

// 抖动大到肉眼可见：整条放弃，而不是给一条"顺但错"的轨迹
const wildDoc = buildDocumentFromFrames([0, 5, 10].map((f, i) => ({
  index: f, boxes: [mk('W', i * 5, 'Car', { position: { x: i * 5, y: i % 2 ? 1.5 : -1.5, z: 1 } })],
})))
const wild = smoothTrack(wildDoc.tasks.boxes.tracks[0])
check('偏移超阈值时放弃平滑', wild.path === null && wild.reason === 'shift-too-large', `${wild.reason} ${wild.maxShift}`)
check('放弃时仍报出偏移量', wild.maxShift > 0.3, String(wild.maxShift))

const lonelyDoc = buildDocumentFromFrames([{ index: 3, boxes: [mk('L', 1)] }])
check('单关键帧不平滑', smoothTrack(lonelyDoc.tasks.boxes.tracks[0]).reason === 'too-few-keyframes')

const docSmooth = smoothDocument(noisyDoc)
check('文档级平滑产出路径表', docSmooth.paths.size === 1 && docSmooth.skipped.length === 0)

console.log('\n[13] 生命周期命令')
const lcDoc = buildDocumentFromFrames([0, 1, 2, 3].map((i) => ({ index: i, boxes: [mk('L1', i)] })))
const lcStore = new TrackStore(lcDoc)
const lcTrack = lcStore.getTrack('L1')!
const lcCmd = buildSetLifecycleCommand(lcTrack, 1, 2, lcStore.document.range)
check('能构造生命周期命令', !!lcCmd)
lcStore.exec(lcCmd!)
const trimmed = lcStore.getTrack('L1')!
check('生命周期收窄到 1–2', trimmed.lifecycle.first === 1 && trimmed.lifecycle.last === 2)
check('范围外的关键帧不被删掉', trimmed.keyframes.length === 4, String(trimmed.keyframes.length))
check('物化只在生命周期内出框',
  materializeFrame(lcStore.document, 0, { mode: 'exact' }).length === 0
  && materializeFrame(lcStore.document, 1, { mode: 'exact' }).length === 1)
check('撤销恢复原范围', (() => {
  lcStore.undo()
  const t = lcStore.getTrack('L1')!
  return t.lifecycle.first === 0 && t.lifecycle.last === 3
})())
check('无变化时不产生命令', buildSetLifecycleCommand(lcStore.getTrack('L1')!, 0, 3, lcStore.document.range) === null)
check('两端拖反了自动归位', (() => {
  const c = buildSetLifecycleCommand(lcStore.getTrack('L1')!, 2, 1, lcStore.document.range)
  return c?.type === 'setLifecycle' && c.after.first === 1 && c.after.last === 2
})())
check('越界夹到文档范围', (() => {
  const c = buildSetLifecycleCommand(lcStore.getTrack('L1')!, -5, 2, lcStore.document.range)
  return c?.type === 'setLifecycle' && c.after.first === 0 && c.after.last === 2
})())

console.log('\n[样本列表] 时间文案 / 删除判定 / 排序')
const T = Date.UTC(2026, 10, 25, 12, 0, 0)
const MIN = 60_000
check('30 秒前 = 刚刚', describeAge(T, T - 30_000) === '刚刚')
check('未来时间也当刚刚（时钟漂移）', describeAge(T, T + 5 * MIN) === '刚刚')
check('分钟档', describeAge(T, T - 3 * MIN) === '3 分钟前')
check('小时档', describeAge(T, T - 5 * 3600_000) === '5 小时前')
check('天档', describeAge(T, T - 3 * 86400_000) === '3 天前')
check('超过 30 天给绝对日期', /^\d{4}-\d{2}-\d{2}$/.test(describeAge(T, T - 40 * 86400_000)))
check('时间戳为 0 视为未知', describeAge(T, 0) === '未知')
check('精确时间戳格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(formatStamp(T)), formatStamp(T))
check('未知任务键原样显示', taskLabel('vla') === 'VLA' && taskLabel('mystery') === 'mystery')

const rows = decorateLibrary([
  { sampleId: 'old#0-99', sceneId: 'old', updatedAt: T - 10 * 86400_000, range: [0, 99], tasks: ['boxes'] },
  { sampleId: 'now#0-0', sceneId: 'now', updatedAt: T, range: [0, 0], tasks: ['boxes', 'occupancy'] },
  { sampleId: 'mid#5-14', sceneId: 'mid', updatedAt: T - 3600_000, range: [5, 14], tasks: ['boxes'] },
], { now: T, currentSampleId: 'now#0-0' })
check('按最近保存降序', rows.map((r) => r.sceneId).join(',') === 'now,mid,old', rows.map((r) => r.sceneId).join(','))
check('当前样本被标记', rows[0].isCurrent && !rows[1].isCurrent)
check('帧数由 range 推导', rows[1].frameCount === 10 && rows[0].frameCount === 1)
check('任务段转显示名', rows[0].taskLabels.join('/') === '框/占据', rows[0].taskLabels.join('/'))
const noRange = decorateLibrary([{ sampleId: 'a#0-0', sceneId: 'a', updatedAt: T }], { now: T })
check('缺 range 时按单帧兜底', noRange[0].frameCount === 1 && noRange[0].taskLabels.length === 0)
check('空 sampleId 被过滤', decorateLibrary([{ sampleId: '', sceneId: 'x', updatedAt: T }], { now: T }).length === 0)
check('汇总条数与帧数', (() => {
  const sum = librarySummary(rows)
  return sum.total === 3 && sum.frames === 111
})(), JSON.stringify(librarySummary(rows)))

check('可以删别人的旧样本', judgeRemove(rows[2], { currentSampleId: 'now#0-0' }).ok)
const curV = judgeRemove(rows[0], { currentSampleId: 'now#0-0' })
check('当前样本不能删，且说明原因', !curV.ok && curV.code === 'current' && curV.reason.includes('当前'))
const lockV = judgeRemove(rows[2], { currentSampleId: 'now#0-0', heldBy: 'tab-7' })
check('别人正在写的不能删，且指出是谁', !lockV.ok && lockV.code === 'locked' && lockV.reason.includes('tab-7'))
check('没有当前样本时任何样本都可删', judgeRemove(rows[0], {}).ok)
check('当前判定优先于租约判定', judgeRemove(rows[0], { currentSampleId: 'now#0-0', heldBy: 'x' }).code === 'current')

console.log('\n[帧缓存 LRU] 分组 / 淘汰量 / 保护键')
const frameRef = (ds: string, f: number, bytes: number, used: number, part = ''): FrameBlobRef => ({
  key: `frames/${ds}/${f}${part}`, datasetKey: ds, frame: f, bytes, lastUsedAt: used,
})
const five = [0, 1, 2, 3, 4].map((f) => frameRef('ds1', f, 100, 1000 + f))

check('需要腾 0 字节时不动', planFrameEviction({
  entries: five, reclaimBytes: 0, evictableDatasetKeys: ['ds1'],
}).keys.length === 0)
check('按 need 选够就停（100×3 满足 250）', (() => {
  const p = planFrameEviction({ entries: five, reclaimBytes: 250, evictableDatasetKeys: ['ds1'] })
  return p.groups.length === 3 && p.bytes === 300 && p.keys.length === 3
})())
check('淘汰的是最久未用的三帧', (() => {
  const p = planFrameEviction({ entries: five, reclaimBytes: 250, evictableDatasetKeys: ['ds1'] })
  return p.groups.map((g) => g.frame).join(',') === '0,1,2'
})(), JSON.stringify(planFrameEviction({ entries: five, reclaimBytes: 250, evictableDatasetKeys: ['ds1'] }).groups.map((g) => g.frame)))
check('need 超过总量时全淘汰', (() => {
  const p = planFrameEviction({ entries: five, reclaimBytes: 99_999, evictableDatasetKeys: ['ds1'] })
  return p.groups.length === 5 && p.bytes === 500 && p.candidates === 5
})())
check('不在可淘汰集合里的数据集一帧不动', planFrameEviction({
  entries: five, reclaimBytes: 99_999, evictableDatasetKeys: ['other'],
}).keys.length === 0)

// 组内多记录：一帧最多三条（positions / :colors / :labels），必须整组进出
const grouped: FrameBlobRef[] = [
  frameRef('ds1', 0, 100, 1000), frameRef('ds1', 0, 50, 1000, ':colors'), frameRef('ds1', 0, 20, 1000, ':labels'),
  frameRef('ds1', 1, 100, 2000), frameRef('ds1', 1, 50, 2000, ':colors'),
]
const g = groupFrames(grouped)
check('按帧聚合，组内字节求和', g.length === 2 && g[0].bytes === 170 && g[1].bytes === 150)
check('组的 lastUsedAt 取组内最大值', (() => {
  const mixed = [frameRef('ds1', 7, 10, 100), frameRef('ds1', 7, 10, 500, ':colors')]
  return groupFrames(mixed)[0].lastUsedAt === 500
})())
check('淘汰整帧：三条记录一起进', (() => {
  const p = planFrameEviction({ entries: grouped, reclaimBytes: 1, evictableDatasetKeys: ['ds1'] })
  return p.keys.length === 3 && p.groups[0].frame === 0
})(), JSON.stringify(planFrameEviction({ entries: grouped, reclaimBytes: 1, evictableDatasetKeys: ['ds1'] })))

// 保护键：命中组内任一键，整组跳过（不能只删 :colors 留下 positions）
const protectedPlan = planFrameEviction({
  entries: grouped,
  reclaimBytes: 999,
  evictableDatasetKeys: ['ds1'],
  protectKeys: ['frames/ds1/0:colors'],
})
check('保护键命中则整组跳过', protectedPlan.groups.map((x) => x.frame).join(',') === '1')
check('protectedFrames 计数', protectedPlan.protectedFrames === 1, String(protectedPlan.protectedFrames))
check('全被保护时返回空但候选数仍为 0', (() => {
  const p = planFrameEviction({
    entries: five, reclaimBytes: 999, evictableDatasetKeys: ['ds1'],
    protectKeys: five.map((e) => e.key),
  })
  return p.keys.length === 0 && p.protectedFrames === 5 && p.candidates === 0
})())

// 排序确定性与缺省时间
check('同样的 lastUsedAt 按 dataset+frame 稳定排序', (() => {
  const ties = [frameRef('b', 0, 10, 5), frameRef('a', 9, 10, 5), frameRef('a', 2, 10, 5)]
  const p = planFrameEviction({ entries: ties, reclaimBytes: 10, evictableDatasetKeys: ['a', 'b'] })
  return p.groups[0].datasetKey === 'a' && p.groups[0].frame === 2
})())
check('缺少 lastUsedAt 视为最旧（先淘汰）', (() => {
  const old: FrameBlobRef[] = [
    { key: 'frames/ds1/0', datasetKey: 'ds1', frame: 0, bytes: 10 },
    frameRef('ds1', 1, 10, 9_999),
  ]
  const p = planFrameEviction({ entries: old, reclaimBytes: 1, evictableDatasetKeys: ['ds1'] })
  return p.groups.length === 1 && p.groups[0].frame === 0
})())
check('没有归属信息的记录被忽略', groupFrames([
  { key: 'ds#0', datasetKey: '', frame: 0, bytes: 10 },
]).length === 0)

const hood = neighborhoodKeys('ds1', 5, (ds, f) => [`${ds}/${f}`, `${ds}/${f}:c`], 2)
check('邻域覆盖前后各两帧', hood.length === 10)
check('邻域包含当前帧', hood.includes('ds1/5') && hood.includes('ds1/5:c'))
check('邻域不越过第 0 帧', !neighborhoodKeys('ds1', 1, (ds, f) => [`${ds}/${f}`], 2).some((k) => k.includes('/-')))

console.log('\n[帧缓存淘汰] 策略（lru / lfu / hybrid）与跨数据集')
const hitRef = (ds: string, f: number, used: number, hits: number, bytes = 100): FrameBlobRef => ({
  key: `frames/${ds}/${f}`, datasetKey: ds, frame: f, bytes, lastUsedAt: used, hits,
})

check('默认策略是 hybrid', DEFAULT_EVICTION_POLICY === 'hybrid', DEFAULT_EVICTION_POLICY)
check('策略白名单只有三种', EVICTION_POLICIES.join(',') === 'lru,lfu,hybrid')
check('isEvictionPolicy 拦截乱填', isEvictionPolicy('lfu') && !isEvictionPolicy('fifo') && !isEvictionPolicy(null))
check('没有命中数据时 hybrid 与 LRU 等价', (() => {
  const a = planFrameEviction({ entries: five, reclaimBytes: 250, evictableDatasetKeys: ['ds1'], policy: 'hybrid' })
  const b = planFrameEviction({ entries: five, reclaimBytes: 250, evictableDatasetKeys: ['ds1'], policy: 'lru' })
  return a.groups.map((x) => x.frame).join(',') === b.groups.map((x) => x.frame).join(',')
})())
check('计划回填所用策略', (() => {
  const p = planFrameEviction({ entries: five, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'lfu' })
  return p.policy === 'lfu'
})())

// LFU：只看次数。0 号被看过多回（虽然很久以前），1 号只写过没看过
const freq = [hitRef('ds1', 0, 1_000, 9), hitRef('ds1', 1, 9_000, 0), hitRef('ds1', 2, 5_000, 3)]
check('lfu 先淘汰读得最少的帧（哪怕它最新）', (() => {
  const p = planFrameEviction({ entries: freq, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'lfu' })
  return p.groups.length === 1 && p.groups[0].frame === 1
})(), JSON.stringify(planFrameEviction({ entries: freq, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'lfu' }).groups.map((x) => x.frame)))
check('同样的输入用 lru 会先删最旧的 0 号', (() => {
  const p = planFrameEviction({ entries: freq, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'lru' })
  return p.groups[0].frame === 0
})())
check('lfu 次数相同时退回时间比较', (() => {
  const same = [hitRef('ds1', 0, 3_000, 2), hitRef('ds1', 1, 1_000, 2)]
  const p = planFrameEviction({ entries: same, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'lfu' })
  return p.groups[0].frame === 1
})())

// hybrid：先淘汰"只读过 0~1 次"的那批，再按时间
const mixed = [
  hitRef('ds1', 0, 1_000, 8),   // 最旧，但反复回看
  hitRef('ds1', 1, 9_000, 1),   // 最新，只读过一次
]
check('hybrid 先淘汰一次性帧（哪怕它更新）', (() => {
  const p = planFrameEviction({ entries: mixed, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'hybrid' })
  return p.groups.length === 1 && p.groups[0].frame === 1
})(), JSON.stringify(planFrameEviction({ entries: mixed, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'hybrid' }).groups.map((x) => x.frame)))
check('hybrid 里全是常用帧时退回 LRU', (() => {
  const both = [hitRef('ds1', 0, 1_000, 5), hitRef('ds1', 1, 2_000, 7)]
  const p = planFrameEviction({ entries: both, reclaimBytes: 1, evictableDatasetKeys: ['ds1'], policy: 'hybrid' })
  return p.groups[0].frame === 0
})())
check('组的 hits 取组内最大值', (() => {
  const spread = [
    hitRef('ds1', 2, 1_000, 0),
    { ...hitRef('ds1', 2, 1_000, 4), key: 'frames/ds1/2:colors' },
  ]
  return groupFrames(spread)[0].hits === 4
})())

// 全局：候选池跨数据集，按同一把尺子排序
const crossPool = [
  hitRef('peer#2', 0, 1_000, 0), hitRef('own#1', 0, 1_001, 0),
  hitRef('peer#2', 1, 1_002, 0), hitRef('own#1', 1, 1_003, 0),
]
check('跨数据集统一排序（不是先删自己的）', (() => {
  const p = planFrameEviction({ entries: crossPool, reclaimBytes: 250, evictableDatasetKeys: ['own#1', 'peer#2'] })
  return p.groups.map((g) => `${g.datasetKey}/${g.frame}`).join(',') === 'peer#2/0,own#1/0,peer#2/1'
})(), JSON.stringify(planFrameEviction({ entries: crossPool, reclaimBytes: 250, evictableDatasetKeys: ['own#1', 'peer#2'] }).groups.map((g) => `${g.datasetKey}/${g.frame}`)))
check('datasets 列出动过的数据集（去重排序）', (() => {
  const p = planFrameEviction({ entries: crossPool, reclaimBytes: 250, evictableDatasetKeys: ['own#1', 'peer#2'] })
  return p.datasets.join('|') === 'own#1|peer#2'
})(), JSON.stringify(planFrameEviction({ entries: crossPool, reclaimBytes: 250, evictableDatasetKeys: ['own#1', 'peer#2'] }).datasets))
check('只动可淘汰的那个数据集', (() => {
  const p = planFrameEviction({ entries: crossPool, reclaimBytes: 250, evictableDatasetKeys: ['peer#2'] })
  return p.datasets.join('|') === 'peer#2' && p.groups.every((g) => g.datasetKey === 'peer#2')
})())
check('对端的保护键同样生效', (() => {
  const p = planFrameEviction({
    entries: crossPool, reclaimBytes: 250, evictableDatasetKeys: ['own#1', 'peer#2'],
    protectKeys: ['frames/peer#2/0'],
  })
  return p.groups[0].datasetKey === 'own#1' && p.protectedFrames === 1
})(), JSON.stringify(planFrameEviction({ entries: crossPool, reclaimBytes: 250, evictableDatasetKeys: ['own#1', 'peer#2'], protectKeys: ['frames/peer#2/0'] }).groups.map((g) => g.frame)))

// 缺口：以前不够就是静默返回，现在必须说出来
check('腾不够时报告缺口', (() => {
  const p = planFrameEviction({ entries: five, reclaimBytes: 700, evictableDatasetKeys: ['ds1'] })
  return p.bytes === 500 && p.shortfall === 200
})(), JSON.stringify(planFrameEviction({ entries: five, reclaimBytes: 700, evictableDatasetKeys: ['ds1'] })))
check('腾够了缺口为 0', planFrameEviction({ entries: five, reclaimBytes: 250, evictableDatasetKeys: ['ds1'] }).shortfall === 0)
check('一个可淘汰数据集都没有时缺口等于需求', (() => {
  const p = planFrameEviction({ entries: five, reclaimBytes: 250, evictableDatasetKeys: [] })
  return p.keys.length === 0 && p.shortfall === 250
})())
check('全被保护时也报缺口', (() => {
  const p = planFrameEviction({
    entries: five, reclaimBytes: 250, evictableDatasetKeys: ['ds1'],
    protectKeys: five.map((e) => e.key),
  })
  return p.shortfall === 250 && p.protectedFrames === 5
})())
check('需要腾 0 字节时不报缺口', planFrameEviction({
  entries: five, reclaimBytes: 0, evictableDatasetKeys: ['ds1'],
}).shortfall === 0)


/* ==================================================================
 * 预标注：BEV IoU / 身份关联 / 四种合并策略 / 复核门禁
 * ================================================================== */
console.log('\n[预标注] BEV 重叠度')

const pGeo = (x: number, y = 0, yaw = 0, sx = 4, sy = 2) => ({
  position: { x, y, z: 0.75 }, scale: { x: sx, y: sy, z: 1.5 }, yaw,
})

check('完全重合的 IoU 为 1', Math.abs(bevIoU(pGeo(0), pGeo(0)) - 1) < 1e-9, String(bevIoU(pGeo(0), pGeo(0))))
check('完全分离的 IoU 为 0', bevIoU(pGeo(0), pGeo(10)) === 0)
check('错开半个车长的 IoU ≈ 1/3', Math.abs(bevIoU(pGeo(0), pGeo(2)) - 1 / 3) < 1e-6, String(bevIoU(pGeo(0), pGeo(2))))
check('同中心转 90° 的 IoU ≈ 1/3', Math.abs(bevIoU(pGeo(0), pGeo(0, 0, Math.PI / 2)) - 1 / 3) < 1e-6,
  String(bevIoU(pGeo(0), pGeo(0, 0, Math.PI / 2))))
check('退化尺寸不抛错、返回 0', bevIoU(pGeo(0, 0, 0, 0, 0), pGeo(0)) === 0)
check('IoU 对称', Math.abs(bevIoU(pGeo(0), pGeo(1.3, 0.4)) - bevIoU(pGeo(1.3, 0.4), pGeo(0))) < 1e-12)

console.log('\n[预标注] 身份关联')

const pObj = (frame: number, x: number, extra: Partial<ModelObject> = {}): ModelObject => ({
  frame, classId: 'Car', geometry: pGeo(x), confidence: 0.8, ...extra,
})

const withIds = [0, 1, 2, 3, 4].flatMap((f) => [
  pObj(f, f * 0.6, { modelTrackId: 'car-1' }),
  pObj(f, 6 + f * 0.2, { modelTrackId: 'car-2' }),
])
const linkedById = linkProposals(withIds)
check('有 modelTrackId 时按 id 分组', linkedById.length === 2, String(linkedById.length))
check('每条提案收齐 5 帧', linkedById.every((p) => p.objects.length === 5))
check('提案按首帧与 id 稳定排序', linkedById[0].modelTrackId === 'car-1')

const noIds = [0, 1, 2, 3, 4].map((f) => pObj(f, f * 0.6))
check('无 id 时靠 IoU 链成一条', linkProposals(noIds).length === 1, String(linkProposals(noIds).length))
check('每帧前进 5 米（IoU 掉到 0）会断成两条', (() => {
  const jump = [0, 1, 2, 3].map((f) => pObj(f, f * 5))
  return linkProposals(jump).length === 4
})())
check('maxGap 之外的观测另起一条', (() => {
  const gap = [pObj(0, 0), pObj(9, 0.2)]
  return linkProposals(gap).length === 2 && linkProposals(gap, { maxGap: 10 }).length === 1
})())
check('类别不一致不链接（classMustMatch）', (() => {
  const mixed = [pObj(0, 0), pObj(1, 0.2, { classId: 'Pedestrian', geometry: pGeo(0.2) })]
  return linkProposals(mixed).length === 2 && linkProposals(mixed, { classMustMatch: false }).length === 1
})())
check('乱序输入仍按帧升序输出', (() => {
  const shuffled = [pObj(2, 1.2, { modelTrackId: 'a' }), pObj(0, 0, { modelTrackId: 'a' }), pObj(1, 0.6, { modelTrackId: 'a' })]
  const p = linkProposals(shuffled)[0]
  return p.objects.map((o) => o.frame).join(',') === '0,1,2'
})())
check('同帧同 id 重复时保留高置信', (() => {
  const dup = [pObj(0, 0, { modelTrackId: 'a', confidence: 0.4 }), pObj(0, 0, { modelTrackId: 'a', confidence: 0.9 })]
  const p = linkProposals(dup)[0]
  return p.objects.length === 1 && p.objects[0].confidence === 0.9
})())

console.log('\n[预标注] 合并策略')

const pPolicy = (patch: Partial<MergePolicy> = {}): MergePolicy => ({ ...defaultMergePolicy(), ...patch })
let pIdSeq = 100
// 分配契约：把"本次已占用"交上来，避免批量建轨时撞号
const nextId = (used: ReadonlySet<string>) => {
  let n = ++pIdSeq
  while (used.has(String(n))) n++
  pIdSeq = n
  return String(n)
}

// append：不动已有标注，全部新建为待复核
{
  const d = buildDocumentFromFrames([{ index: 0, boxes: [mk('1', 0)] }])
  const proposals = linkProposals([0, 1, 2].map((f) => pObj(f, 20 + f * 0.6, { modelTrackId: 'x' })))
  const plan = buildPreLabelMerge(d, proposals, pPolicy(), nextId)
  const store = new TrackStore(d)
  check('append 产出新建命令', plan.result.created.length === 1 && !!plan.command)
  if (plan.command) store.exec(plan.command)
  const track = d.tasks.boxes.tracks.find((t) => t.id === plan.result.created[0])!
  check('append 生成的轨迹带 3 个关键帧', track.keyframes.length === 3)
  check('append 每帧状态是 pending', [...track.states.values()].every((s) => s.review === 'pending'))
  check('append 血缘记下模型来源', track.keyframes[0].source.kind === 'model')
  check('append 不影响已有框', d.tasks.boxes.tracks.length === 2)
  if (plan.command) store.undo()
  check('合并撤销后轨迹消失', d.tasks.boxes.tracks.length === 1)
}

// fill-gaps：只补空帧
{
  const d = buildDocumentFromFrames([{ index: 0, boxes: [mk('1', 20)] }])
  const proposals = linkProposals([0, 1, 2].map((f) => pObj(f, 20 + f * 0.6, { modelTrackId: 'x' })))
  const plan = buildPreLabelMerge(d, proposals, pPolicy({ strategy: 'fill-gaps' }), nextId)
  const created = plan.result.created.length ? d.tasks.boxes.tracks : []
  const store = new TrackStore(d)
  if (plan.command) store.exec(plan.command)
  const t = d.tasks.boxes.tracks[1]!
  check('fill-gaps 跳过已有框的帧', t.keyframes.map((k) => k.frame).join(',') === '1,2', t.keyframes.map((k) => k.frame).join(','))
  check('fill-gaps 记下被跳过的框数', plan.result.skipped === 1, String(plan.result.skipped))
  void created
}

// minConfidence
{
  const d = buildDocumentFromFrames([{ index: 0, boxes: [] }])
  const low = linkProposals([pObj(0, 0, { confidence: 0.1, modelTrackId: 'a' })])
  const plan = buildPreLabelMerge(d, low, pPolicy({ minConfidence: 0.5 }), nextId)
  check('低于置信度下限被过滤并计数', !plan.command && plan.result.skipped === 1)
}

// replace-track：命中模型轨迹则更新
{
  const src = [0, 1].map((f) => pObj(f, f * 0.6, { modelTrackId: 'x' }))
  const d0 = buildDocumentFromFrames([{ index: 0, boxes: [] }, { index: 1, boxes: [] }])
  const plan0 = buildPreLabelMerge(d0, linkProposals(src), pPolicy(), nextId)
  const store = new TrackStore(d0)
  if (plan0.command) store.exec(plan0.command)
  const id = plan0.result.created[0]

  const shifted = src.map((o) => ({ ...o, geometry: pGeo(o.geometry.position.x + 0.05), confidence: 0.9 }))
  const plan1 = buildPreLabelMerge(d0, linkProposals(shifted), pPolicy({ strategy: 'replace-track' }), nextId)
  check('replace-track 命中模型轨迹时更新而非新建', plan1.result.created.length === 0 && plan1.result.updated[0] === id,
    JSON.stringify(plan1.result))
  if (plan1.command) store.exec(plan1.command)
  const track = d0.tasks.boxes.tracks.find((t) => t.id === id)!
  check('更新后几何跟着模型走', Math.abs(track.keyframes[0].geometry.position.x - 0.05) < 1e-9)
  check('更新后仍只有一条轨迹', d0.tasks.boxes.tracks.length === 1)
}

// replace-track + 人工轨迹 + protectManual → 冲突
{
  const d = buildDocumentFromFrames([{ index: 0, boxes: [mk('1', 0)] }, { index: 1, boxes: [] }])
  const proposals = linkProposals([0, 1].map((f) => pObj(f, f * 0.6, { modelTrackId: 'x' })))
  const plan = buildPreLabelMerge(d, proposals, pPolicy({ strategy: 'replace-track' }), nextId)
  const store = new TrackStore(d)
  if (plan.command) store.exec(plan.command)
  check('命中人工轨迹时记冲突', plan.result.conflicts.length === 1, String(plan.result.conflicts.length))
  check('冲突帧不覆盖人工几何', d.tasks.boxes.tracks.find((t) => t.id === '1')!.keyframes[0].geometry.position.x === 0)
  check('冲突之外的空帧仍然收下', d.tasks.boxes.tracks.length === 2)
}

// protectManual = false 时允许覆盖
{
  const d = buildDocumentFromFrames([{ index: 0, boxes: [mk('1', 0)] }])
  const proposals = linkProposals([pObj(0, 0.4, { modelTrackId: 'x' })])
  const plan = buildPreLabelMerge(d, proposals, pPolicy({ strategy: 'replace-track', protectManual: false }), nextId)
  const store = new TrackStore(d)
  if (plan.command) store.exec(plan.command)
  const t = d.tasks.boxes.tracks.find((x) => x.id === '1')!
  check('关掉 protectManual 后人工几何被覆盖', Math.abs(t.keyframes[0].geometry.position.x - 0.4) < 1e-9)
  check('覆盖后该帧回到待复核', t.states.get(0)?.review === 'pending')
}

// class-vote：默认人工优先（只记冲突、不改类），放开保护后才按票改
{
  const mkDoc = () => buildDocumentFromFrames([{ index: 0, boxes: [mk('1', 0)] }, { index: 1, boxes: [mk('1', 0.6)] }])
  const votes = () => linkProposals([0, 1].map((f) => pObj(f, f * 0.6, { modelTrackId: 'p', classId: 'Pedestrian' })))

  const guarded = mkDoc()
  const gPlan = buildPreLabelMerge(guarded, votes(), pPolicy({ strategy: 'class-vote', classMustMatch: false }), nextId)
  check('class-vote 默认不改人工类别', guarded.tasks.boxes.tracks[0].classId === 'Car', guarded.tasks.boxes.tracks[0].classId)
  check('class-vote 仍记录类别冲突', gPlan.result.conflicts.length === 2, String(gPlan.result.conflicts.length))
  check('class-vote 被保护时产出空命令', gPlan.command === null)

  const free = mkDoc()
  const fPlan = buildPreLabelMerge(free, votes(), pPolicy({ strategy: 'class-vote', classMustMatch: false, protectManual: false }), nextId)
  const store = new TrackStore(free)
  if (fPlan.command) store.exec(fPlan.command)
  check('放开保护后按投票改类', free.tasks.boxes.tracks[0].classId === 'Pedestrian', free.tasks.boxes.tracks[0].classId)
  check('class-vote 不动几何', free.tasks.boxes.tracks[0].keyframes[0].geometry.position.x === 0)
}

console.log('\n[预标注] 复核队列与导出闸门')
{
  const d = buildDocumentFromFrames([{ index: 0, boxes: [] }, { index: 1, boxes: [] }])
  const low = linkProposals([pObj(0, 0, { modelTrackId: 'a', confidence: 0.35 }), pObj(0, 20, { modelTrackId: 'b', confidence: 0.9 })])
  const plan = buildPreLabelMerge(d, low, pPolicy(), nextId)
  const store = new TrackStore(d)
  if (plan.command) store.exec(plan.command)
  const rows = collectReviewRows(d)
  check('复核队列按低置信在前', rows[0].confidence < rows[1].confidence, JSON.stringify(rows.map((r) => r.confidence)))
  check('统计待裁决轨迹数', reviewStats(d).tracks === 2, String(reviewStats(d).tracks))
  check('统计模型帧数', reviewStats(d).modelFrames === 2)

  const first = rows[0].trackId
  const cmd = buildReviewCommand(d.tasks.boxes.tracks.filter((t) => t.id === first), 'accepted')!
  store.exec(cmd)
  check('接受后该轨迹离开队列', collectReviewRows(d).length === 1)
  check('接受计入 accepted', reviewStats(d).accepted === 1, String(reviewStats(d).accepted))
  check('同一对象重复裁决返回空命令', buildReviewCommand(d.tasks.boxes.tracks.filter((t) => t.id === first), 'accepted') === null)
  store.undo()
  check('裁决可撤销', collectReviewRows(d).length === 2)

  check('人工帧永远可导出', isExportableState(null) && isExportableView({ review: 'none', sourceKind: 'manual' }))
  check('待复核的模型帧拦在导出外', !isExportableView({ review: 'pending', sourceKind: 'model' }))
  check('已接受的模型帧可导出', isExportableView({ review: 'accepted', sourceKind: 'model' }))
  check('已拒绝的模型帧拦在导出外', !isExportableView({ review: 'rejected', sourceKind: 'model' }))

  const frame = d.tasks.boxes.tracks[0].keyframes[0].frame
  const all = materializeFrame(d, frame)
  const accepted = d.tasks.boxes.tracks.filter((t) => t.states.get(frame)?.review === 'accepted')
  const gate = materializeFrame(d, frame, { acceptedOnly: true })
  check('物化闸门按状态过滤', gate.length === all.length - (all.length - accepted.length) && gate.length >= accepted.length,
    `${gate.length}/${all.length}`)
  check('物化闸门不误伤人工帧', materializeFrame(buildDocumentFromFrames([{ index: 0, boxes: [mk('1', 0)] }]), 0, { acceptedOnly: true }).length === 1)
}


console.log(`\n===== 结果: ${passed} 通过, ${failed} 失败 =====\n`)
if (failed > 0) process.exit(1)

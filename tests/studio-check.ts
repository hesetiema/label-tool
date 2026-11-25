/**
 * 状态层集成自检 —— 不需要浏览器：
 *   pnpm test:studio
 *
 * domain 测试验证的是"内核自己对不对"；这里验证"内核接进现有 UI 状态后还对不对"：
 *   - 装载 5 帧演示序列 → 迁移成文档 → boxes 是物化视图
 *   - 老调用点（setBoxProp / deleteSelected / createBoxFromRect）不改一行，仍能产生可撤销命令
 *   - 切帧不再清空历史，跨帧撤销回到正确帧
 *   - 插值 / 拆分 / 合并 走命令，一次撤销全退
 *
 * 这层测试的价值：双写期最容易出错的不是算法，是"哪条路径忘了同步 frames 镜像"。
 */
import { createStudioCore } from '../src/state/studioCore.ts'
import { useSequence } from '../src/state/useSequence.ts'
import { useAnnotation } from '../src/state/useAnnotation.ts'
import { generateDemoSequence } from '../src/core/sequence/sequence.ts'
import { cloneBoxes } from '../src/core/history.ts'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}  ${detail}`) }
}

function loadSequence(frameCount = 5) {
  const core = createStudioCore()
  const seq = generateDemoSequence(frameCount)
  core.frames.value = seq
  core.currentFrame.value = 0
  core.cloud.value = seq[0].cloud
  core.boxes.value = cloneBoxes(seq[0].boxes)
  core.rebuildDocument()
  return { core, seq }
}

console.log('\n[1] 装载与真值迁移')
const { core } = loadSequence(5)
const ann = useAnnotation(core)
check('装载后 boxes 是物化视图', core.boxes.value.length === 6)
check('store 建立', !!core.store.value && core.store.value.trackCount === 6)
check('文档范围 0–4', core.doc.value?.range[0] === 0 && core.doc.value?.range[1] === 4)
check('初始无历史', !core.canUndo.value)
check('帧内轨迹查询', core.store.value!.tracksInFrame(0).length === 6)

console.log('\n[2] 老编辑路径 → 命令 → 撤销')
core.selectedId.value = '1'
ann.setBoxProp('x', 30)
check('属性面板改坐标生效', core.boxes.value.find((b) => b.id === '1')?.position.x === 30)
check('产生可撤销命令', core.canUndo.value)
check('命令写进真值', core.store.value!.getTrack('1')?.keyframes[0].geometry.position.x === 30)
check('frames 镜像同步', core.frames.value[0].boxes.find((b) => b.id === '1')?.position.x === 30)
ann.doUndo()
check('撤销回到原坐标', core.boxes.value.find((b) => b.id === '1')?.position.x === 18)
check('撤销后仍可重做', core.canRedo.value)
ann.doRedo()
check('重做回到 30', core.boxes.value.find((b) => b.id === '1')?.position.x === 30)
ann.doUndo()

console.log('\n[3] 新建 / 删除 走命令')
const beforeCount = core.boxes.value.length
ann.createBoxFromRect({ cx: 0, cy: 0, length: 2, width: 2 })
check('画框后多一个', core.boxes.value.length === beforeCount + 1)
check('画框后自动选中', !!core.selectedId.value)
const newId = core.selectedId.value!
check('新框进入真值', !!core.store.value!.getTrack(newId))
ann.deleteSelected()
check('删除后少一个', core.boxes.value.length === beforeCount)
check('删除后真值也没有', !core.store.value!.getTrack(newId))
ann.doUndo()
check('撤销删除后真值恢复', !!core.store.value!.getTrack(newId))
ann.doUndo()
check('再撤销回到画框前', core.boxes.value.length === beforeCount)

console.log('\n[4] 切帧不清空历史')
const { core: c2 } = loadSequence(5)
const seq2 = useSequence(c2)
const ann2 = useAnnotation(c2)
c2.selectedId.value = '2'
ann2.setBoxProp('x', 40)
check('第 0 帧产生一步历史', c2.canUndo.value)
seq2.gotoFrame(2)
check('切到第 2 帧', c2.currentFrame.value === 2)
check('切帧后历史仍在', c2.canUndo.value)
check('第 2 帧只有前 3 条轨迹（后 3 条只标首末帧）', c2.boxes.value.length === 3)
ann2.doUndo()
check('在第 2 帧撤销第 0 帧的编辑', c2.store.value!.getTrack('2')?.keyframes[0].geometry.position.x === 6)
check('第 2 帧视图未被误改', Math.abs((c2.boxes.value.find((b) => b.id === '2')?.position.x ?? 0) - 11) < 1e-6)
seq2.gotoFrame(0)
check('回到第 0 帧看到撤销结果', c2.boxes.value.find((b) => b.id === '2')?.position.x === 6)

console.log('\n[5] 插值命令与整段撤销')
const { core: c3 } = loadSequence(5)
const seq3 = useSequence(c3)
const sparseBefore = c3.store.value!.getTrack('4')!.keyframes.length
check('稀疏轨迹初始 2 个关键帧', sparseBefore === 2)
seq3.doInterpolate()
check('插值后补满 5 帧', c3.store.value!.getTrack('4')!.keyframes.length === 5)
seq3.gotoFrame(2)
check('第 2 帧能看到补出的框', c3.boxes.value.some((b) => b.id === '4'))
seq3.gotoFrame(0)
c3.store.value!.undo()
check('一次撤销回退全部插值', c3.store.value!.getTrack('4')!.keyframes.length === 2)

console.log('\n[6] 拆分 / 合并命令')
const { core: c4 } = loadSequence(5)
const seq4 = useSequence(c4)
c4.selectedId.value = '1'
seq4.splitSelectedAt(2)
check('拆分后轨迹数 +1', c4.store.value!.trackCount === 7)
const newTrackId = c4.store.value!.tracks.find((t) => t.id !== '1' && t.keyframes[0].frame === 2)?.id
check('新轨迹从第 2 帧开始', !!newTrackId)
check('原轨迹只保留前半段', c4.store.value!.getTrack('1')!.keyframes.length === 2)
c4.store.value!.undo()
check('撤销拆分恢复', c4.store.value!.trackCount === 6 && c4.store.value!.getTrack('1')!.keyframes.length === 5)

c4.selectMany(['5', '6'])
seq4.mergeSelectedTracks()
check('合并后轨迹数 -1', c4.store.value!.trackCount === 5)
check('合并保留 keep 的 id', !!c4.store.value!.getTrack('5') && !c4.store.value!.getTrack('6'))
c4.store.value!.undo()
check('撤销合并恢复两条', c4.store.value!.trackCount === 6 && !!c4.store.value!.getTrack('6'))

console.log('\n[7] 跨帧传播')
const { core: c5 } = loadSequence(5)
const seq5 = useSequence(c5)
c5.selectedId.value = '1'
// 记录基准后再改，模拟"选中 → 拖动 → 传播"
c5.origin.value = cloneBoxes([c5.boxes.value.find((b) => b.id === '1')!])[0]
const ann5 = useAnnotation(c5)
ann5.setBoxProp('x', 25)
const thirdBefore = c5.store.value!.getTrack('1')!.keyframes[2].geometry.position.x
seq5.doPropagate()
check('传播后第 3 帧同目标也偏移', c5.store.value!.getTrack('1')!.keyframes[2].geometry.position.x !== 12)
check('传播命令可撤销', c5.canUndo.value)
c5.store.value!.undo()
check('撤销传播后第 3 帧还原', Math.abs((c5.store.value!.getTrack('1')!.keyframes[2].geometry.position.x) - thirdBefore) < 1e-6)

console.log('\n[8] 懒加载切帧（点云按需解码）')
const c6 = createStudioCore()
const seq6 = generateDemoSequence(3)
c6.frames.value = [
  { index: 0, cloud: seq6[0].cloud, boxes: cloneBoxes(seq6[0].boxes) },
  { index: 1, cloud: seq6[1].cloud, boxes: cloneBoxes(seq6[1].boxes) },
  // 第 3 帧模拟未解码：空点云 + lazy 标记
  { index: 2, cloud: { positions: new Float32Array(0), count: 0 }, boxes: cloneBoxes(seq6[2].boxes), lazy: true },
]
c6.currentFrame.value = 0
c6.cloud.value = seq6[0].cloud
c6.boxes.value = cloneBoxes(seq6[0].boxes)
c6.rebuildDocument()

let fetchCount = 0
c6.setFrameLoader({
  get: async (f) => { fetchCount++; return seq6[f].cloud },
  prefetch: () => { /* noop */ },
  cached: () => undefined,
  stats: () => ({ hits: 0, misses: 0, evictions: 0, rejected: 0, inflight: 0, cachedBytes: 0, budgetBytes: 0 }),
  dispose: () => { /* noop */ },
})
const seq6Api = useSequence(c6)

async function runLazyChecks() {
  seq6Api.gotoFrame(2)
  check('懒加载切帧先清空点云（避免上一帧点配这一帧框）', c6.cloud.value === null)
  await new Promise((r) => setTimeout(r, 15))
  // cloud 是 ref，取出来是响应式代理，不能与原始对象比引用；比内容
  check('解码完成后回填当前帧点云', c6.cloud.value?.count === seq6[2].cloud.count)
  check('frames 里的点云也已回填', c6.frames.value[2].cloud.count > 0)
  check('lazy 标记被清除', c6.frames.value[2].lazy === false)
  check('只解码一次', fetchCount === 1)

  // 竞态：请求第 3 帧后立刻切回第 2 帧，迟到的解码结果必须被丢弃
  seq6Api.gotoFrame(0)
  c6.frames.value[2].cloud = { positions: new Float32Array(0), count: 0 }
  c6.frames.value[2].lazy = true
  seq6Api.gotoFrame(2)
  seq6Api.gotoFrame(1)
  await new Promise((r) => setTimeout(r, 15))
  check('迟到结果不覆盖当前帧点云', c6.cloud.value === c6.frames.value[1].cloud)
  check('切到有缓存的帧不触发解码', fetchCount === 2)

  console.log(`\n===== 结果: ${passed} 通过, ${failed} 失败 =====\n`)
  if (failed > 0) process.exit(1)
}

void runLazyChecks()

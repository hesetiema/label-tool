/**
 * P2 预标注自检 —— 不需要浏览器：
 *   pnpm test:p2
 *
 * 覆盖三块"纯逻辑 + 适配器"的部分：
 *   1. mock provider：确定性（同种子同结果）、可中断、进度
 *   2. http provider：NDJSON 流解析、错误码、超长行
 *   3. file provider：两种格式、帧范围过滤、坏文件
 *   4. 与 TrackStore 的接线：合入 → 导出闸门 → 接受 → 放行
 *
 * 真界面的走查在 `scripts/browser/p2.mjs`（快捷键、面板、撤销）。
 */
import { createMockProvider } from '../src/adapters/preAnnotate/mockProvider.ts'
import { createFileProvider } from '../src/adapters/preAnnotate/fileProvider.ts'
import { createHttpProvider } from '../src/adapters/preAnnotate/httpProvider.ts'
import { parsePreObject } from '../src/adapters/preAnnotate/parse.ts'
import { buildMergeCommand, defaultMergePolicy, linkProposals } from '../src/domain/ops/mergePreLabel.ts'
import { buildReviewCommand, reviewStats } from '../src/domain/ops/review.ts'
import { TrackStore } from '../src/domain/store/trackStore.ts'
import { buildDocumentFromFrames } from '../src/domain/io/legacyDocument.ts'
import type { Box3D, } from '../src/core/types.ts'
import type { PreAnnotateChunk } from '../src/ports/preAnnotation.ts'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name}${detail ? `  → ${detail}` : ''}`)
  }
}

async function collect(gen: AsyncGenerator<PreAnnotateChunk>): Promise<PreAnnotateChunk[]> {
  const out: PreAnnotateChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

const REQ = { sampleId: 'demo#0-4', frameRange: [0, 4] as [number, number], sensors: ['lidar'] }

console.log('\n[1] mock provider')
{
  const a = await collect(createMockProvider({ seed: 3 }).run(REQ))
  const b = await collect(createMockProvider({ seed: 3 }).run(REQ))
  const c = await collect(createMockProvider({ seed: 4 }).run(REQ))
  check('同种子产出完全一致的框', JSON.stringify(a) === JSON.stringify(b))
  check('不同种子产出不同', JSON.stringify(a) !== JSON.stringify(c))
  check('5 帧都收到了', a.length === 5 && a.map((x) => x.frame).join(',') === '0,1,2,3,4')
  check('进度单调到 1', a[a.length - 1].progress === 1 && a.every((x, i) => i === 0 || x.progress >= a[i - 1].progress))
  check('每帧对象数不超过 perFrame', a.every((x) => x.objects.length <= 4))
  check('对象都带 modelTrackId', a.every((x) => x.objects.every((o) => !!o.modelTrackId)))
  check('置信度在 (0,1]', a.every((x) => x.objects.every((o) => o.confidence > 0 && o.confidence <= 1)))

  const noDrop = await collect(createMockProvider({ seed: 3, dropRate: 0 }).run(REQ))
  check('dropRate=0 时每帧满员', noDrop.every((x) => x.objects.length === 4))
  const noIds = await collect(createMockProvider({ seed: 3, withTrackIds: false }).run(REQ))
  check('可关闭 modelTrackId（测降级链路）', noIds.every((x) => x.objects.every((o) => !o.modelTrackId)))

  // 中断：拿到第一帧就 break，不应继续产出
  const controller = new AbortController()
  const gen = createMockProvider({ seed: 3, delayMs: 1 }).run(REQ, controller.signal)
  const first = await gen.next()
  controller.abort()
  let threw = ''
  try {
    for (;;) {
      const r = await gen.next()
      if (r.done) break
    }
  } catch (err) {
    threw = (err as Error).name
  }
  check('中断后抛出 AbortError', threw === 'AbortError', threw)
  check('中断前已拿到第一帧', first.done === false)
}

console.log('\n[2] http provider')
{
  const ndjson = [
    JSON.stringify({ frame: 0, objects: [{ classId: 'Car', position: { x: 1, y: 2, z: 0.75 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0, confidence: 0.8, modelTrackId: 't1' }], progress: 0.5 }),
    'not json',
    JSON.stringify({ frame: 1, objects: [], progress: 1 }),
  ].join('\n') + '\n'

  const fakeFetch = (async () => new Response(ndjson, { status: 200 })) as unknown as typeof fetch
  const chunks = await collect(createHttpProvider({ url: 'http://x/pre', fetchImpl: fakeFetch }).run(REQ))
  check('NDJSON 解析出 2 个 chunk（坏行跳过）', chunks.length === 2, String(chunks.length))
  check('字段进入 BoxGeometry', Math.abs(chunks[0].objects[0].geometry.position.x - 1) < 1e-9)
  check('modelTrackId 透传', chunks[0].objects[0].modelTrackId === 't1')
  check('进度透传', chunks[0].progress === 0.5 && chunks[1].progress === 1)

  const errFetch = (async () => new Response('model not loaded', { status: 503 })) as unknown as typeof fetch
  let errMsg = ''
  try {
    await collect(createHttpProvider({ url: 'http://x/pre', fetchImpl: errFetch }).run(REQ))
  } catch (err) {
    errMsg = (err as Error).message
  }
  check('非 2xx 抛出带状态码的错误', errMsg.includes('503') && errMsg.includes('model not loaded'), errMsg)

  let retryNote = ''
  try {
    await collect(createHttpProvider({ url: 'http://x/pre', fetchImpl: fakeFetch }).run(REQ, AbortSignal.abort()))
  } catch (err) {
    retryNote = (err as Error).name
  }
  check('已中断的信号在请求前就退出', retryNote === 'AbortError', retryNote)
}

console.log('\n[3] file provider')
{
  const sequence = {
    format: 'pcl-label-studio/sequence',
    model: { id: 'offline', version: '2' },
    frames: [
      { index: 0, objects: [{ label: 'Car', position: { x: 0, y: 0, z: 0.75 }, scale: { x: 4, y: 2, z: 1.5 }, yaw: 0 }] },
      { index: 2, objects: [{ label: 'Truck', position: { x: 5, y: 0, z: 1 }, scale: { x: 8, y: 2.5, z: 3 }, yaw: 0.1 }] },
    ],
  }
  const p = createFileProvider(sequence, { name: 'offline.json' })
  const all = await collect(p.run(REQ))
  check('文件 provider 读出 2 帧', all.length === 2)
  check('capabilities 汇总类别', JSON.stringify(p.capabilities().classes) === JSON.stringify(['Car', 'Truck']))
  const ranged = await collect(p.run({ ...REQ, frameRange: [2, 4] }))
  check('按请求范围过滤帧', ranged.length === 1 && ranged[0].frame === 2)
  check('模型身份来自文件', all[0].model.id === 'offline')

  const sustec = {
    frames: [{ index: 0, objects: [{ psr: { position: { x: 1, y: 2, z: 0.5 }, scale: { x: 4, y: 2, z: 1 }, rotation: { z: 0.5 } }, obj_type: 'Car', obj_id: '7', score: 0.66 }] }],
  }
  const sustecChunks = await collect(createFileProvider(sustec).run(REQ))
  check('SUSTechPOINTS psr 格式可读', sustecChunks[0].objects.length === 1)
  check('obj_id 当作跨帧身份', sustecChunks[0].objects[0].modelTrackId === '7')
  check('score 当置信度', Math.abs(sustecChunks[0].objects[0].confidence - 0.66) < 1e-9)
  check('rotation.z 当 yaw', Math.abs(sustecChunks[0].objects[0].geometry.yaw - 0.5) < 1e-9)

  let bad = ''
  try {
    createFileProvider({ nope: 1 })
  } catch (err) {
    bad = (err as Error).message
  }
  check('没有帧的文件被拒绝', bad.includes('没有可用的帧'), bad)

  check('脏对象被剔除而不是整帧失败', parsePreObject({ classId: 'Car', position: { x: NaN, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }) === null)
  check('缺类别被剔除', parsePreObject({ position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }) === null)
}

console.log('\n[4] 接线：合入 → 闸门 → 接受 → 放行')
{
  const mkBox = (id: string, x: number): Box3D => ({
    id, label: 'Car', position: { x, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 2 }, yaw: 0,
  })
  const doc = buildDocumentFromFrames([
    { index: 0, boxes: [mkBox('1', 40)] },
    { index: 1, boxes: [] },
    { index: 2, boxes: [] },
  ])
  const store = new TrackStore(doc)
  const chunks = await collect(createMockProvider({ seed: 9, dropRate: 0 }).run({ ...REQ, frameRange: [0, 2] }))
  const objects = chunks.flatMap((c) => c.objects.map((o) => ({ ...o, frame: c.frame, model: c.model })))
  const proposals = linkProposals(objects)
  check('mock 的 4 个目标链成 4 条提案', proposals.length === 4, String(proposals.length))

  let seq = 100
  const plan = buildMergeCommand(doc, proposals, defaultMergePolicy(), (used) => {
    let n = ++seq
    while (used.has(String(n))) n++
    seq = n
    return String(n)
  })
  check('合并产出命令', !!plan.command)
  if (plan.command) store.exec(plan.command)
  check('4 条待复核轨迹入库', plan.result.created.length === 4, String(plan.result.created.length))
  check('一次合并不会分配重复 id', new Set(plan.result.created).size === 4, plan.result.created.join(','))
  check('新轨迹 id 与已有轨迹不撞号', !plan.result.created.includes('1'), plan.result.created.join(','))

  const visible = store.materialize(1).length
  const exportable = store.materialize(1, { acceptedOnly: true }).length
  check('待复核的帧不进导出', exportable === 0 && visible === 4, `${exportable}/${visible}`)

  const stats = reviewStats(doc)
  check('复核统计：4 条 / 12 帧', stats.tracks === 4 && stats.frames === 12, JSON.stringify(stats))
  const cmd = buildReviewCommand(doc.tasks.boxes.tracks, 'accepted')!
  store.exec(cmd)
  check('全部接受后导出放行', store.materialize(1, { acceptedOnly: true }).length === 4)
  check('接受后队列清空', reviewStats(doc).tracks === 0)
  store.undo()
  check('撤销后又回到待复核', reviewStats(doc).tracks === 4)
  check('人工帧不受闸门影响', store.materialize(0, { acceptedOnly: true }).some((b) => b.id === '1'))
}

console.log(`\n===== 结果: ${passed} 通过, ${failed} 失败 =====\n`)
if (failed > 0) process.exit(1)

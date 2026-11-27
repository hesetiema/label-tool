/**
 * P0 适配层测试 —— 不需要浏览器：
 *   pnpm test -- p0
 *
 * 覆盖四块：
 *   1. 文件名排序与 (点云, 标注) 配对
 *   2. localFileSource：懒加载句柄、逐帧解码（Node 下走主线程兜底）
 *   3. FrameLoader：并发折叠、缓存命中、预算拒绝、预取
 *   4. IndexedDB 文档编解码：Track.states(Map) 往返、v1 快照迁移
 *
 * 为什么 IndexedDB 本身不测：
 *   Node 没有实现。真正会出错的是"存进去的字节取出来还是不是同一份数据"，
 *   也就是 encode/decode，这部分是纯函数，可以完整覆盖。
 *   事务与游标只能靠浏览器手测，文档 17.4 给了手测清单。
 */
import { it } from 'vitest'
import { createChecker } from './harness.ts'
import type { Box3D, PointCloud } from '../src/core/types.ts'
import type { SampleHandle } from '../src/ports/dataSource.ts'
import {
  createLocalFileSource,
  isPlaceholder,
  pairLocalFiles,
  placeholderCloud,
  sortCloudFiles,
} from '../src/adapters/localFileSource.ts'
import { createFrameLoader } from '../src/adapters/frameLoader.ts'
import { PriorityQueue } from '../src/adapters/jobQueue.ts'
import { sequenceBlob, serializeSequenceChunks } from '../src/adapters/sequenceExport.ts'
import { TrackStore } from '../src/domain/store/trackStore.ts'
import { planDocumentRestore } from '../src/domain/store/restorePlan.ts'
import { parsePcdAsync } from '../src/adapters/pcdParser.ts'
import {
  decodeDocument,
  decodeTrack,
  encodeDocument,
  encodeTrack,
  mergeDocHead,
  migrateLegacySnapshot,
  taskKey,
} from '../src/adapters/indexedDbStore.ts'
import type { StoredDocHead } from '../src/adapters/indexedDbStore.ts'
import type { TaskKey } from '../src/domain/model/document.ts'
import type { SampleId } from '../src/domain/model/ids.ts'
import { frameBlobKey, legacyFrameBlobKey } from '../src/adapters/blobKeys.ts'
import { buildDocumentFromFrames } from '../src/domain/io/legacyDocument.ts'
import type { SessionSnapshot } from '../src/core/io/session.ts'

const { check, finish } = createChecker()
function close(a: number, b: number, tol = 1e-6) {
  return Math.abs(a - b) < tol
}

function mkBox(id: string, x: number, label = 'Car'): Box3D {
  return { id, label, position: { x, y: 0, z: 1 }, scale: { x: 4, y: 2, z: 2 }, yaw: 0 }
}

const PCD_ASCII = `# .PCD v0.7 - Point Cloud Data file format
VERSION 0.7
FIELDS x y z
SIZE 4 4 4
TYPE F F F
COUNT 1 1 1
WIDTH 2
HEIGHT 1
VIEWPOINT 0 0 0 1 0 0 0
POINTS 2
DATA ascii
1 2 3
4 5 6
`

function pcdFile(name: string): File {
  return new File([PCD_ASCII], name)
}

function cloudOf(n: number): PointCloud {
  const positions = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) {
    positions[i * 3] = i
    positions[i * 3 + 1] = i + 1
    positions[i * 3 + 2] = 0
  }
  return { positions, count: n }
}

function fakeHandle(opts: { frames: number; onFrame?: (i: number, priority: string) => void }): SampleHandle {
  const meta = {
    id: 'fake',
    name: 'fake',
    sensors: [{ id: 'lidar_top', kind: 'lidar' as const }],
    nominalHz: 10,
    calibrationVersion: 'none',
  }
  return {
    meta: () => meta,
    async frame(i, req) {
      opts.onFrame?.(i, req?.priority ?? 'high')
      // 模拟 5ms 解码，才能测出"并发请求是否被折叠"
      await new Promise((r) => setTimeout(r, 5))
      const cloud = cloudOf(4)
      return { ref: { index: i, ts: i / 10, data: { lidar_top: { kind: 'inline', cloud } } }, cloud }
    },
    async calibrations() {
      return {}
    },
    close() {
      /* noop */
    },
  }
}

async function main() {
  console.log('\n[1] 文件名排序与配对')
  const unsorted = [pcdFile('10.pcd'), pcdFile('2.pcd'), pcdFile('1.pcd')]
  const sorted = sortCloudFiles(unsorted)
  check('自然排序：2 在 10 之前', sorted.map((f) => f.name).join(',') === '1.pcd,2.pcd,10.pcd')

  const pairs = pairLocalFiles([
    pcdFile('000002.pcd'),
    pcdFile('000001.pcd'),
    new File(['{"objects":[]}'], '000001.json'),
  ])
  check('只保留 PCD，按名排序', pairs.length === 2 && pairs[0].cloud.name === '000001.pcd')
  check('同名 JSON 配到对应帧', pairs[0].labels?.name === '000001.json')
  check('没有同名 JSON 的帧不带标注', pairs[1].labels === undefined)
  check('没有 PCD 时配对为空', pairLocalFiles([new File(['{}'], 'a.json')]).length === 0)

  console.log('\n[2] 占位点云')
  const ph = placeholderCloud()
  check('占位点云 count 为 0', ph.count === 0)
  check('占位点云被识别为未加载', isPlaceholder(ph))
  check('真实点云不被误判', !isPlaceholder(cloudOf(3)))

  console.log('\n[3] parsePcdAsync（Node 无 Worker → 主线程兜底）')
  const parsed = await parsePcdAsync(new TextEncoder().encode(PCD_ASCII).buffer)
  check('兜底路径解析出 2 个点', parsed.count === 2)
  check('坐标正确', close(parsed.positions[0], 1) && close(parsed.positions[5], 6))

  console.log('\n[4] localFileSource')
  const source = createLocalFileSource(pairs, { name: '测试序列' })
  const summaryList = await source.listSamples()
  check('只列一个样本', summaryList.length === 1)
  check('帧范围覆盖全部文件', summaryList[0].frameRange[0] === 0 && summaryList[0].frameRange[1] === 1)
  check('统计字节数', (summaryList[0].bytes ?? 0) > 0)

  const handle = await source.openSample(summaryList[0].sampleId)
  const payload = await handle.frame(1)
  check('按帧解码成功', payload.cloud.count === 2)
  check('FrameRef 带时间戳', payload.ref.ts === 1 / handle.meta().nominalHz)
  check('没有标注时返回空数组', (await handle.labels(0)).length === 0)
  handle.primeLabels([[], [mkBox('1', 1)]])
  check('primeLabels 后能取到框', (await handle.labels(1)).length === 1)
  check(
    '越界帧抛错',
    await handle
      .frame(9)
      .then(() => false)
      .catch(() => true),
  )

  console.log('\n[5] FrameLoader')
  let calls = 0
  const loader = createFrameLoader(
    fakeHandle({
      frames: 30,
      onFrame: () => {
        calls++
      },
    }),
  )
  const [a, b] = await Promise.all([loader.get(3), loader.get(3)])
  check('同一帧并发请求只解码一次', calls === 1)
  check('两个调用拿到同一引用', a === b)
  await loader.get(3)
  check('再次读取命中缓存，不再解码', calls === 1)
  check('cached 能同步读到', loader.cached(3) === a)

  loader.prefetch(3, 1)
  await new Promise((r) => setTimeout(r, 20))
  check('预取相邻帧（只取存在的 2/4）', loader.cached(2) !== undefined && loader.cached(4) !== undefined)
  check('stats 记录命中与缓存字节', loader.stats().hits >= 1 && loader.stats().cachedBytes > 0)

  // 预算比单帧还小：应该拒绝缓存，而不是把别的帧全挤掉
  const tight = createFrameLoader(fakeHandle({ frames: 5 }), { budgetBytes: 8 })
  const first = await tight.get(0)
  await tight.get(0)
  const firstAgain = await tight.get(0)
  check('单帧超预算时不缓存', tight.stats().rejected === 3 && first.count === firstAgain.count)
  check('超预算仍能返回数据', firstAgain.count === 4)

  loader.dispose()
  check(
    '释放后拒绝新请求',
    await loader
      .get(1)
      .then(() => false)
      .catch(() => true),
  )

  console.log('\n[6] 文档编解码')
  const doc = buildDocumentFromFrames([
    { index: 0, boxes: [mkBox('1', 0), mkBox('2', 5)] },
    { index: 1, boxes: [mkBox('1', 3, 'Truck')] },
    { index: 2, boxes: [mkBox('1', 6)] },
  ])
  doc.tasks.boxes.tracks[0].states.set(1, {
    visibility: 'occluded',
    source: { kind: 'manual' },
    review: 'pending',
  })

  const encoded = encodeDocument(doc)
  check('编码后任务清单包含 boxes', encoded.head.tasks.includes('boxes'))
  const boxesPayload = encoded.tasks.find((t) => t.task === 'boxes')!.payload as {
    tracks: Array<Record<string, unknown>>
  }
  check('编码把 states 变成数组', Array.isArray(boxesPayload.tracks[0].states))

  const decoded = decodeDocument(encoded.head, Object.fromEntries(encoded.tasks.map((t) => [t.task, t.payload])))
  check('解码后轨迹数一致', decoded.tasks.boxes.tracks.length === doc.tasks.boxes.tracks.length)
  const track0 = decoded.tasks.boxes.tracks.find((t) => t.id === '1')!
  check('states 还原成 Map', track0.states instanceof Map)
  check(
    '遮挡状态与复核态保留',
    track0.states.get(1)?.visibility === 'occluded' && track0.states.get(1)?.review === 'pending',
  )
  check('关键帧数量与几何保留', track0.keyframes.length === 3 && close(track0.keyframes[2].geometry.position.x, 6))
  check('类别改动保留', decoded.tasks.boxes.tracks.find((t) => t.id === '1')!.classId === 'Car')

  const single = encodeTrack(doc.tasks.boxes.tracks[0])
  check('单条轨迹往返一致', decodeTrack(single).keyframes.length === 3)
  check('taskKey 稳定', taskKey('local#0-9', 'boxes') === 'local#0-9::boxes')
  check('帧键带命名空间且转义了数据集里的 #', frameBlobKey('local#a.pcd#3', 7) === 'frames/local%23a.pcd%233/7')
  check('旧键仍可构造（读取回退用）', legacyFrameBlobKey('local#a.pcd#3', 7) === 'local#a.pcd#3#7')

  console.log('\n[7] v1 快照迁移')
  const stored = { positions: new Float32Array([0, 0, 0]), count: 1 }
  const legacy: SessionSnapshot = {
    version: 1,
    savedAt: 1700000000000,
    datasetName: '老草稿',
    cloud: null,
    frames: [
      { index: 0, cloud: stored, boxes: [mkBox('1', 0)] },
      { index: 1, cloud: stored, boxes: [mkBox('1', 2), mkBox('2', 8)] },
    ],
    currentFrame: 1,
    boxes: [mkBox('1', 2)],
    categories: [],
  }
  const migrated = migrateLegacySnapshot(legacy)
  check('多帧草稿迁移出 2 条轨迹', migrated.tasks.boxes.tracks.length === 2)
  check('同 id 聚合成一条轨迹', migrated.tasks.boxes.tracks.find((t) => t.id === '1')!.keyframes.length === 2)
  check('范围取自首末帧', migrated.range[0] === 0 && migrated.range[1] === 1)

  const singleLegacy: SessionSnapshot = {
    ...legacy,
    frames: [],
    cloud: stored,
    boxes: [mkBox('9', 1)],
  }
  const singleDoc = migrateLegacySnapshot(singleLegacy)
  check('单帧数据集也能迁移', singleDoc.tasks.boxes.tracks.length === 1 && singleDoc.tasks.boxes.tracks[0].id === '9')

  console.log('\n[8] 合并保存（head.tasks 并集）')
  const mkHead = (tasks: TaskKey[], range: [number, number] = [0, 0]): StoredDocHead => ({
    sampleId: 's1' as SampleId,
    sceneId: 'scene',
    range,
    meta: { version: 1, baseVersion: 0, updatedAt: 1, updatedBy: 'u', hashes: {} },
    tasks,
    savedAt: 1,
  })
  // 库里有 boxes + occupancy，这次自动保存只带了 boxes
  const onlyBoxes = mkHead(['boxes'], [0, 9])
  const merged = mergeDocHead(mkHead(['boxes', 'occupancy']), onlyBoxes)
  check('旧任务段不被丢掉', merged.tasks.includes('occupancy'), merged.tasks.join(','))
  check('新任务段也在', merged.tasks.includes('boxes'))
  check('任务清单按 ALL_TASKS 顺序、无重复', merged.tasks.join(',') === 'boxes,occupancy', merged.tasks.join(','))
  check('文档级属性以新文档为准', merged.range[1] === 9 && merged.sceneId === 'scene')

  const noExisting = mergeDocHead(undefined, onlyBoxes)
  check('没有旧头时原样写入', noExisting.tasks.join(',') === 'boxes')

  // 老客户端读到新版本写的段：不能替用户把它抹掉
  const future = mergeDocHead(mkHead(['boxes', 'vla-2' as TaskKey]), onlyBoxes)
  check('未知任务段保留并排在末尾', future.tasks.join(',') === 'boxes,vla-2', future.tasks.join(','))

  // 头合并只解决"登记"，任务段本身的覆盖仍由调用方决定
  const encodedAgain = encodeDocument({ ...singleDoc })
  check('合并后 encode 仍只产出本次段', encodedAgain.tasks.length === 1 && encodedAgain.tasks[0].task === 'boxes')

  console.log('\n[9] 解析优先级')
  const q = new PriorityQueue<string>()
  q.push('low-1', 'low')
  q.push('low-2', 'low')
  q.push('high-1', 'high')
  q.push('high-2', 'high')
  check('高优先级先出队', q.shift() === 'high-1' && q.shift() === 'high-2', '')
  check('高优先级空了才轮到低优先级', q.shift() === 'low-1' && q.shift() === 'low-2')
  check('空队列返回 undefined', q.shift() === undefined)
  check('默认是高优先级', (q.push('dft'), q.highSize === 1 && q.lowSize === 0))
  check('size 统计两条队列', q.size === 1)
  const rest = q.clear()
  check('clear 交还剩余任务供统一 reject', rest.length === 1 && rest[0] === 'dft' && q.size === 0)

  // FrameLoader 必须把优先级传下去：get=high，prefetch=low。
  // 传错的话预取会挤掉用户正在等的帧，这是本轮改动的核心契约。
  const seenPrio: string[] = []
  const prioLoader = createFrameLoader(
    fakeHandle({
      frames: 30,
      onFrame: (i, p) => seenPrio.push(`${i}:${p}`),
    }),
  )
  await prioLoader.get(10)
  prioLoader.prefetch(10, 1)
  await new Promise((r) => setTimeout(r, 30))
  check('当前帧按 high 解码', seenPrio.includes('10:high'), seenPrio.join(','))
  check('预取帧按 low 解码', seenPrio.includes('11:low') && seenPrio.includes('9:low'), seenPrio.join(','))
  check('预取不会重复请求已缓存帧', seenPrio.filter((s) => s.startsWith('10:')).length === 1)
  prioLoader.dispose()

  console.log('\n[10] 流式序列导出')
  const seqDoc = buildDocumentFromFrames([
    { index: 0, boxes: [mkBox('1', 0), mkBox('2', 10)] },
    { index: 1, boxes: [] }, // 中间帧故意留空：exact 不补、linear 要补
    { index: 2, boxes: [mkBox('1', 4)] },
  ])
  const seqStore = new TrackStore(seqDoc)
  const chunks = [...serializeSequenceChunks(seqStore, { framesPerChunk: 2 })]
  const text = chunks.join('')
  const exported = JSON.parse(text) as {
    format: string
    version: number
    frameCount: number
    frames: { index: number; objects: unknown[] }[]
  }
  check(
    '拼起来是合法 JSON 且格式头正确',
    exported.format === 'pcl-label-studio/sequence' && exported.version === 1 && exported.frameCount === 3,
  )
  check('帧数与文档范围一致', exported.frames.length === 3, String(exported.frames.length))
  check('按 framesPerChunk 分块（头 + 2 块 + 尾）', chunks.length === 4, `实际 ${chunks.length} 块`)
  check('单块远小于整体，避免整段字符串常驻', Math.max(...chunks.map((c) => c.length)) < text.length * 0.75)
  check('exact 模式不给中间帧造框', exported.frames[1].objects.length === 0)

  const linear = JSON.parse(
    [
      ...serializeSequenceChunks(seqStore, {
        materialize: { mode: 'linear' },
        framesPerChunk: 2,
      }),
    ].join(''),
  ) as { frames: { index: number; objects: { psr: { position: { x: number } } }[] }[] }
  check('linear 模式给中间帧补出框', linear.frames[1].objects.length === 1)
  const midX = linear.frames[1].objects[0].psr.position.x
  check('补帧位置落在两端之间', midX > 0 && midX < 4, String(midX))

  const blob = sequenceBlob(seqStore, { framesPerChunk: 2 })
  check(
    'sequenceBlob 与拼接结果等长',
    blob.size === new TextEncoder().encode(text).length,
    `${blob.size} vs ${new TextEncoder().encode(text).length}`,
  )

  console.log('\n[11] doc-first 恢复计划')
  const restoreDoc = buildDocumentFromFrames(
    Array.from({ length: 5 }, (_, i) => ({
      index: i,
      // 只在前三帧有框：中间帧缺框正是"exact 不补间"的表现
      boxes: i < 3 ? [mkBox('1', i * 2)] : [],
    })),
  )
  const layoutHint = {
    frames: [
      { index: 0, hasCloud: true },
      { index: 1, hasCloud: false },
      { index: 2, hasCloud: false },
      { index: 3, hasCloud: false },
      { index: 4, hasCloud: true },
    ],
    currentFrame: 4,
    hasSingleCloud: false,
  }
  const plan = planDocumentRestore(restoreDoc, layoutHint)
  check('多帧计划可用', plan.ok && !plan.singleFrame)
  check('帧布局取自快照', plan.layout.join(',') === '0,1,2,3,4', plan.layout.join(','))
  check('有内联点云的帧单独列出', plan.cloudFrames.join(',') === '0,4', plan.cloudFrames.join(','))
  check('其余帧标为待解码', plan.lazyFrames.join(',') === '1,2,3', plan.lazyFrames.join(','))
  check('当前帧沿用快照', plan.current === 4, String(plan.current))
  check('框总数按布局统计', plan.totalBoxes === 3, String(plan.totalBoxes))

  const clamped = planDocumentRestore(restoreDoc, { ...layoutHint, currentFrame: 99 })
  check('当前帧越界夹到末帧', clamped.current === 4, String(clamped.current))

  // 快照丢了但文档还在：range 就是帧布局，不能当单帧处理
  const orphanPlan = planDocumentRestore(restoreDoc, { frames: [], currentFrame: 0, hasSingleCloud: false })
  check(
    '快照无帧但文档跨 5 帧 → 按 range 展开',
    orphanPlan.ok && !orphanPlan.singleFrame && orphanPlan.layout.join(',') === '0,1,2,3,4',
    orphanPlan.layout.join(','),
  )
  check(
    '无快照时全部标懒加载',
    orphanPlan.lazyFrames.length === 5 && orphanPlan.cloudFrames.length === 0,
    `${orphanPlan.lazyFrames.length}/${orphanPlan.cloudFrames.length}`,
  )
  check('无快照时框数按全范围统计', orphanPlan.totalBoxes === 3, String(orphanPlan.totalBoxes))

  const oneFrameDoc = buildDocumentFromFrames([{ index: 0, boxes: [mkBox('1', 0)] }])
  const singlePlan = planDocumentRestore(oneFrameDoc, {
    frames: [],
    currentFrame: 0,
    hasSingleCloud: true,
  })
  check('单帧文档 → 单帧模式', singlePlan.ok && singlePlan.singleFrame && singlePlan.layout.length === 0)
  check('单帧模式统计首帧框数', singlePlan.totalBoxes === 1, String(singlePlan.totalBoxes))

  const mismatch = planDocumentRestore(restoreDoc, {
    frames: [
      { index: 0, hasCloud: true },
      { index: 9, hasCloud: true },
    ],
    currentFrame: 0,
    hasSingleCloud: false,
  })
  check(
    '帧落在文档区间外 → 拒绝（防撞号串样本）',
    !mismatch.ok && mismatch.reason === 'range-mismatch',
    mismatch.reason,
  )

  const widerDoc = buildDocumentFromFrames([
    { index: 0, boxes: [mkBox('1', 0)] },
    { index: 9, boxes: [mkBox('1', 9)] },
  ])
  const partial = planDocumentRestore(widerDoc, {
    frames: [
      { index: 0, hasCloud: true },
      { index: 5, hasCloud: false },
    ],
    currentFrame: 1,
    hasSingleCloud: false,
  })
  check('文档区间是快照的超集 → 可用', partial.ok, partial.reason)
  check('超集时框数只算布局内帧', partial.totalBoxes === 1, String(partial.totalBoxes))
}

it('p0：文件配对/FrameLoader/文档编解码/恢复计划 全部断言通过', async () => {
  await main()
  finish()
})

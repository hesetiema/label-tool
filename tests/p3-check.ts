/**
 * P3 自检（无需浏览器）：blob 引用、计数器、回收计划、清扫与去重存储
 *   pnpm test:p3
 *
 * 这一层最容易出的错是"删多了"而不是"删少了"：
 *   - 撤销后重做还要用同一份 blob
 *   - 文档自己引用的 blob 不受历史影响
 *   - 内容寻址让多个命令指向同一个键
 * 所以断言集中在"该留的必须留"，其次才是"该删的删掉了"。
 *
 * IndexedDB 本身仍然不测（Node 没有实现）。真正会错的是判定逻辑，
 * 这部分是纯函数 + 端口接口，用假 store 可以完整覆盖。
 */
import type { BlobMeta, BlobStore } from '../src/ports/blobStore.ts'
import {
  classifyBlobKey, frameBlobKey, frameZonePrefix, legacyFrameBlobKey, parseFrameBlobKey,
} from '../src/adapters/blobKeys.ts'
import {
  BlobRefCounter, collectRefsDeep, commandBlobRefs, documentBlobRefs, isPayloadRef,
} from '../src/domain/store/blobRefs.ts'
import { makeCommand, type Command } from '../src/domain/model/command.ts'
import { CommandHistory } from '../src/domain/store/commandHistory.ts'
import { TrackStore } from '../src/domain/store/trackStore.ts'
import { createEmptyDocument } from '../src/domain/model/document.ts'
import { planBlobGc, BlobReclaimer, sweepBlobs } from '../src/adapters/blobGc.ts'
import { gcBlobStore } from '../src/adapters/studioGc.ts'
import { fnv1a64, payloadRefOf, putPayload, getPayload } from '../src/adapters/blobPayload.ts'
import {
  LEASE_TTL_MS, judgeLease, mergePeerProtection, pushCapped, type PeerState,
} from '../src/domain/store/tabLease.ts'
import { TabBus, type StorageLike } from '../src/adapters/tabBus.ts'
import {
  GC_AUDIT_KEY, GC_AUDIT_LIMIT, clearGcAudit, listGcAudit, recordGcAudit, summarizeGcAudit,
  type GcAuditEntry,
} from '../src/adapters/gcAudit.ts'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`) }
  else { failed++; console.log(`  ✗ ${name}  ${detail}`) }
}

/* ---------------- 假 BlobStore ---------------- */

class FakeBlobs implements BlobStore {
  map = new Map<string, {
    bytes: number; savedAt: number; lastUsedAt: number; hits: number; data: ArrayBuffer
  }>()
  putCalls = 0
  deleteCalls = 0

  seed(key: string, bytes = 100, savedAt = 1, lastUsedAt = savedAt, hits = 0): void {
    this.map.set(key, { bytes, savedAt, lastUsedAt, hits, data: new ArrayBuffer(bytes) })
  }

  async put(key: string, buf: ArrayBuffer): Promise<void> {
    this.putCalls++
    this.map.set(key, { bytes: buf.byteLength, savedAt: 2, lastUsedAt: 2, hits: 0, data: buf })
  }
  async get(key: string): Promise<ArrayBuffer> {
    const rec = this.map.get(key)
    if (!rec) throw new Error(`missing ${key}`)
    return rec.data
  }
  async has(key: string): Promise<boolean> { return this.map.has(key) }
  async delete(key: string): Promise<void> { this.map.delete(key) }
  async deletePrefix(prefix: string): Promise<number> {
    let n = 0
    for (const key of [...this.map.keys()]) {
      if (key.startsWith(prefix)) { this.map.delete(key); n++ }
    }
    return n
  }
  async list(prefix = ''): Promise<BlobMeta[]> {
    return [...this.map.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, v]) => ({
        key, bytes: v.bytes, savedAt: v.savedAt, lastUsedAt: v.lastUsedAt, hits: v.hits,
      }))
  }
  async deleteMany(keys: string[]): Promise<number> {
    this.deleteCalls++
    for (const key of keys) this.map.delete(key)
    return keys.length
  }
  async touchMany(keys: string[], at = Date.now()): Promise<number> {
    let n = 0
    for (const key of keys) {
      const rec = this.map.get(key)
      if (!rec) continue
      rec.lastUsedAt = at
      rec.hits++
      n++
    }
    return n
  }
  async usage(): Promise<{ used: number; quota: number }> { return { used: 0, quota: 0 } }
}

function payloadCmd(ref: string | null): Command {
  return makeCommand({
    type: 'setTaskPayload',
    task: 'flow',
    before: null,
    after: ref ? { pointFlowRef: ref } : null,
    beforeRef: null,
    afterRef: ref,
  }, { label: '写载荷' })
}

function classCmd(id: string, after = 'Car'): Command {
  return makeCommand({ type: 'setClass', trackId: id, before: 'Van', after }, { label: '改类别' })
}

async function main() {
  console.log('\n[1] 键规范')
  check('帧键用命名空间 + 转义', frameBlobKey('local#a/b.pcd#3', 7) === 'frames/local%23a%2Fb.pcd%233/7')
  check('颜色分量键', frameBlobKey('ds', 2, 'colors') === 'frames/ds/2:colors')
  const parts = parseFrameBlobKey(frameBlobKey('local#a/b.pcd#3', 7))
  check('键可反解出数据集', !!parts && parts.datasetKey === 'local#a/b.pcd#3' && parts.frame === 7)
  check('颜色键反解', parseFrameBlobKey(frameBlobKey('ds', 2, 'labels'))?.part === 'labels')
  check('payload 键不是帧键', parseFrameBlobKey('payload/abcd') === null)
  check('旧键也反解不出来（歧义无法消除）', parseFrameBlobKey(legacyFrameBlobKey('ds#1', 9)) === null)
  check('分类：payload', classifyBlobKey('payload/ab12').zone === 'payload')
  check('分类：frames 带数据集', classifyBlobKey('frames/ds/3').datasetKey === 'ds')
  check('分类：旧键', classifyBlobKey('local#a.pcd#3#7').zone === 'legacy')
  check('分类：未知', classifyBlobKey('whatever').zone === 'unknown')
  check('前缀与键一致', frameBlobKey('ds', 4).startsWith(frameZonePrefix('ds')))

  console.log('\n[2] 引用抽取')
  check('isPayloadRef 只认前缀', isPayloadRef('payload/x') && !isPayloadRef('frames/x/1') && !isPayloadRef(42))
  const deep = collectRefsDeep({
    a: 'payload/one',
    b: [{ nested: 'payload/two' }, 'noise'],
    c: new Float32Array(4),
    d: new Map([['k', 'payload/three']]),
    e: { notRef: 'hello' },
  })
  check('深度收集三类容器', deep.size === 3 && deep.has('payload/two') && deep.has('payload/three'))
  const cyc: Record<string, unknown> = { ref: 'payload/cyc' }
  cyc.self = cyc
  const budget = { left: 50 }
  check('自引用不会无限递归（预算耗尽即停）', collectRefsDeep(cyc, new Set(), budget).has('payload/cyc'))

  check('几何命令不持有 blob', commandBlobRefs(classCmd('1')).length === 0)
  const pc = payloadCmd('payload/aaa')
  check('载荷命令持有 afterRef', commandBlobRefs(pc).includes('payload/aaa'))
  const both = makeCommand({
    type: 'setTaskPayload', task: 'flow',
    before: { pointFlowRef: 'payload/old' }, after: { pointFlowRef: 'payload/new' },
    beforeRef: 'payload/old', afterRef: 'payload/new',
  }, { label: '替换' })
  const bothRefs = commandBlobRefs(both)
  check('替换命令同时持有 before 与 after', bothRefs.length === 2 && bothRefs.includes('payload/new'))
  const batched = makeCommand({ type: 'batch', commands: [pc, both, classCmd('1')] }, { label: '批' })
  check('batch 递归收集', commandBlobRefs(batched).length === 3)

  const doc = createEmptyDocument({ sampleId: 's1', sceneId: 'sc', range: [0, 9] })
  doc.tasks.occupancy = { frames: [{ frame: 0, ref: 'payload/aaa' }] }
  doc.tasks.flow = { pointFlowRef: 'payload/bbb' }
  const docRefs = documentBlobRefs(doc)
  check('文档直引两个载荷', docRefs.size === 2 && docRefs.has('payload/bbb'))
  doc.tasks.boxes.tracks.push({
    id: '1', classId: 'Car', attributes: {}, keyframes: [{ frame: 0, geometry: { position: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 }, yaw: 0 }, source: { kind: 'manual' } }], states: new Map(),
    lifecycle: { first: 0, last: 0, state: 'active' },
  } as never)
  check('boxes 不参与扫描（轨迹里没有 blob）', documentBlobRefs(doc).size === 2)

  console.log('\n[3] 引用计数器')
  const counter = new BlobRefCounter()
  counter.retain(['payload/a', 'payload/a', 'payload/b'])
  check('重复 retain 计数为 2', counter.count('payload/a') === 2)
  const freed = counter.release(['payload/a'])
  check('释放一次不掉到 0', freed.length === 0 && counter.count('payload/a') === 1)
  check('释放到 0 才通知', counter.release(['payload/a']).includes('payload/a'))
  check('多余 release 不会变负', counter.release(['payload/a']).length === 0 && counter.count('payload/a') === 0)
  const guard = new BlobRefCounter()
  for (const c of [payloadCmd('payload/x'), payloadCmd('payload/x'), classCmd('1')]) guard.retain(commandBlobRefs(c))
  check('计数器与重算一致', guard.verify([payloadCmd('payload/x'), payloadCmd('payload/x'), classCmd('1')]).length === 0)
  check('漂移能被发现', guard.verify([payloadCmd('payload/x')]).length > 0)

  console.log('\n[4] 历史丢弃信号')
  const dropped: string[] = []
  const history = new CommandHistory({ limit: 2, onCommandDropped: (c) => dropped.push(...commandBlobRefs(c)) })
  history.commit(payloadCmd('payload/h1'))
  history.commit(payloadCmd('payload/h2'))
  history.commit(payloadCmd('payload/h3'))
  check('超过上限淘汰最旧一条', dropped.includes('payload/h1') && history.undoCount === 2)
  check('超限后只剩 2 条', history.commands().length === 2)
  history.undo()
  check('撤销只是搬到 redo，不丢引用', dropped.filter((r) => r === 'payload/h3').length === 0 && history.commands().length === 2)
  history.commit(payloadCmd('payload/h4'))
  check('新分支清空 redo 并发出释放', dropped.includes('payload/h3'))
  dropped.length = 0
  history.clear()
  check('clear 释放全部', dropped.length === 2)

  console.log('\n[5] TrackStore 存活引用')
  const storeDoc = createEmptyDocument({ sampleId: 's2', sceneId: 'sc', range: [0, 9] })
  storeDoc.tasks.occupancy = { frames: [{ frame: 0, ref: 'payload/docref' }] }
  const store = new TrackStore(storeDoc)
  const droppedByStore: string[] = []
  store.onCommandDropped((refs) => droppedByStore.push(...refs))

  store.exec(payloadCmd('payload/cmdref'))
  let live = store.liveBlobRefs()
  check('文档引用与命令引用都在', live.has('payload/docref') && live.has('payload/cmdref'))
  check('文档里能读到载荷描述', storeDoc.tasks.flow?.pointFlowRef === 'payload/cmdref')
  store.undo()
  check('撤销后仍存活（还能重做）', store.liveBlobRefs().has('payload/cmdref'))
  check('撤销后文档不再引用它', !('flow' in (storeDoc.tasks as Record<string, unknown>)))
  store.exec(payloadCmd('payload/other'))
  check('新分支清 redo 时释放 cmdref', droppedByStore.includes('payload/cmdref'))
  check('释放后不再存活', !store.liveBlobRefs().has('payload/cmdref'))
  check('文档引用始终不受历史影响', store.liveBlobRefs().has('payload/docref'))

  const boxesGuard = makeCommand({
    type: 'setTaskPayload', task: 'boxes', before: null, after: { tracks: [] }, beforeRef: null, afterRef: 'payload/x',
  }, { label: '非法写 boxes' })
  store.exec(boxesGuard)
  check('setTaskPayload 不会劫持 boxes 任务', Array.isArray(storeDoc.tasks.boxes.tracks))
  store.undo()
  check('非法命令撤销也不破坏 boxes', Array.isArray(storeDoc.tasks.boxes.tracks))

  console.log('\n[6] 回收计划（纯函数）')
  const entries: BlobMeta[] = [
    { key: 'payload/live', bytes: 1000, savedAt: 1 },
    { key: 'payload/dead', bytes: 2000, savedAt: 1 },
    { key: frameBlobKey('dsA', 0), bytes: 3000, savedAt: 1 },
    { key: frameBlobKey('dsA', 1, 'colors'), bytes: 500, savedAt: 1 },
    { key: frameBlobKey('dsB', 0), bytes: 4000, savedAt: 1 },
    { key: legacyFrameBlobKey('dsA', 2), bytes: 600, savedAt: 1 },
    { key: legacyFrameBlobKey('dsOld', 2), bytes: 700, savedAt: 1 },
    { key: 'mystery/record', bytes: 800, savedAt: 1 },
  ]
  const plan = planBlobGc({
    entries,
    livePayloadRefs: new Set(['payload/live']),
    liveDatasetKeys: ['dsA'],
  })
  const reason = (key: string) => plan.verdicts.find((v) => v.key === key)?.reason
  check('活载荷保留', reason('payload/live') === 'live-payload')
  check('死载荷待删', reason('payload/dead') === 'dead-payload')
  check('活数据集帧保留', reason(frameBlobKey('dsA', 1, 'colors')) === 'live-dataset')
  check('死数据集帧待删', reason(frameBlobKey('dsB', 0)) === 'evicted-dataset')
  check('旧键按前缀保留', reason(legacyFrameBlobKey('dsA', 2)) === 'legacy-live')
  check('旧键孤儿待删', reason(legacyFrameBlobKey('dsOld', 2)) === 'legacy-orphan')
  check('未知命名空间默认保留', reason('mystery/record') === 'unknown-kept')
  check('待删合计正确', plan.remove.length === 3 && plan.removeBytes === 2000 + 4000 + 700)
  check('保留合计正确', plan.keepBytes === 1000 + 3000 + 500 + 600 + 800)
  const aggressive = planBlobGc({
    entries, livePayloadRefs: [], liveDatasetKeys: [], dropUnknown: true,
  })
  check('可显式清未知命名空间', aggressive.remove.length === 8)

  console.log('\n[7] 清扫（假 store）')
  const blobs = new FakeBlobs()
  for (const e of entries) blobs.seed(e.key, e.bytes)
  const dry = await sweepBlobs({
    blobs, livePayloadRefs: ['payload/live'], liveDatasetKeys: ['dsA'], dryRun: true,
  })
  check('dryRun 不写库', blobs.map.size === 8 && dry.released === 0)
  check('dryRun 仍然给出报告', dry.remove.length === 3 && dry.scanned === 8)
  const real = await sweepBlobs({ blobs, livePayloadRefs: ['payload/live'], liveDatasetKeys: ['dsA'] })
  check('清扫删掉三条', real.released === 3 && blobs.map.size === 5)
  check('活载荷还在', blobs.map.has('payload/live'))
  check('活数据集缓存还在', blobs.map.has(frameBlobKey('dsA', 0)))
  check('死数据集缓存已删', !blobs.map.has(frameBlobKey('dsB', 0)))

  const many = new FakeBlobs()
  for (let i = 0; i < 7; i++) many.seed(`payload/p${i}`, 10)
  const batched2 = await sweepBlobs({
    blobs: many, livePayloadRefs: [], liveDatasetKeys: [], batchSize: 3,
  })
  check('按 batch 分多次事务', batched2.released === 7 && many.deleteCalls === 3)

  const gcDirect = await gcBlobStore(many, { liveDatasetKeys: ['x'] })
  check('直接对 store 清扫可复用', gcDirect.scanned === 0 && gcDirect.released === 0)

  console.log('\n[8] 增量回收器')
  const rBlobs = new FakeBlobs()
  rBlobs.seed('payload/kept', 10)
  rBlobs.seed('payload/lost', 10)
  const liveSet = new Set(['payload/kept'])
  const events: Array<{ candidates: number; released: number; kept: number }> = []
  const reclaimer = new BlobReclaimer(rBlobs, {
    liveRefs: () => new Set(liveSet),
    debounceMs: 0,
    onReclaimed: (info) => events.push(info),
  })
  reclaimer.noteDropped(['payload/kept', 'frames/x/1', 'payload/lost'])
  check('只接受 payload 引用', reclaimer.pendingCount === 2)
  const flushed = await reclaimer.flush()
  check('活引用不删、死引用删掉', flushed.released === 1 && rBlobs.map.has('payload/kept') && !rBlobs.map.has('payload/lost'))
  check('回调带统计', events.length === 1 && events[0].kept === 1)

  liveSet.add('payload/lost')
  rBlobs.seed('payload/lost', 10)
  rBlobs.seed('payload/lost2', 10)
  reclaimer.noteDropped(['payload/lost', 'payload/lost2'])
  const again = await reclaimer.flush()
  check('删除前用现算的存活集复核（复活的不删）', again.kept === 1 && rBlobs.map.has('payload/lost'))
  reclaimer.dispose()

  const debounced = new BlobReclaimer(new FakeBlobs(), {
    liveRefs: () => new Set(),
    debounceMs: 5,
  })
  debounced.noteDropped(['payload/a'])
  debounced.noteDropped(['payload/a', 'payload/b'])
  check('同一键在窗口内去重', debounced.pendingCount === 2)
  debounced.dispose()

  console.log('\n[9] 内容寻址载荷')
  const pBlobs = new FakeBlobs()
  const buf = new Uint8Array([1, 2, 3, 4, 5]).buffer
  const ref1 = await putPayload(pBlobs, buf, { mode: 'fnv1a' })
  const ref2 = await putPayload(pBlobs, buf, { mode: 'fnv1a' })
  check('同一内容得到同一引用并去重', ref1 === ref2 && pBlobs.putCalls === 1)
  check('引用带 payload 前缀', ref1.startsWith('payload/'))
  const other = await putPayload(pBlobs, new Uint8Array([1, 2, 3, 4, 6]).buffer, { mode: 'fnv1a' })
  check('不同内容得到不同引用', other !== ref1)
  check('fnv1a 稳定且 16 位十六进制', fnv1a64(new Uint8Array([9])) === fnv1a64(new Uint8Array([9])) && /^[0-9a-f]{16}$/.test(fnv1a64(new Uint8Array([9]))))
  const readBack = new Uint8Array(await getPayload(pBlobs, ref1))
  check('读回字节一致', readBack.length === 5 && readBack[4] === 5)
  let threw = false
  try { await getPayload(pBlobs, 'frames/ds/1') } catch { threw = true }
  check('非载荷引用直接报错', threw)
  const subtleRef = await payloadRefOf(buf, 'auto')
  check('auto 模式产出统一前缀', subtleRef.startsWith('payload/'))

  console.log('\n[10] 跨标签页：租约判定')
  const T0 = 1_000_000
  check('无记录 = free', judgeLease(null, 'A', T0).state === 'free')
  check('自己的记录 = mine（时间戳旧也算自己）',
    judgeLease({ tabId: 'A', at: T0 - 99_999 }, 'A', T0).state === 'mine')
  const heldV = judgeLease({ tabId: 'B', at: T0 - 1000 }, 'A', T0)
  check('别人的新鲜记录 = held',
    heldV.state === 'held' && heldV.tabId === 'B' && heldV.ageMs === 1000)
  check('别人的过期记录 = free',
    judgeLease({ tabId: 'B', at: T0 - LEASE_TTL_MS - 1 }, 'A', T0).state === 'free')
  check('恰好到 TTL 仍算持有（严格大于才过期）',
    judgeLease({ tabId: 'B', at: T0 - LEASE_TTL_MS }, 'A', T0).state === 'held')
  check('时间戳在未来不当作过期',
    judgeLease({ tabId: 'B', at: T0 + 5000 }, 'A', T0).state === 'held')
  check('空 tabId 记录 = free', judgeLease({ tabId: '', at: T0 }, 'A', T0).state === 'free')

  console.log('\n[11] 对端引用合并')
  const peersState: PeerState[] = [
    { tabId: 'B', payloadRefs: ['payload/a', 'frames/x/1', 'payload/b'], datasetKey: 'ds1', sampleId: 's1' },
    { tabId: 'C', payloadRefs: ['payload/a', 'payload/c'], datasetKey: 'ds1', sampleId: 's1' },
  ]
  const prot = mergePeerProtection(peersState)
  check('载荷去重', prot.payloadRefs.length === 3)
  check('非 payload 键被过滤', !prot.payloadRefs.includes('frames/x/1'))
  check('数据集去重（两个标签页看同一个数据集）', prot.datasetKeys.length === 1)
  check('样本 id 去重', prot.sampleIds.length === 1)
  check('responders 计数', prot.responders === 2)
  check('空输入不报错', mergePeerProtection([]).responders === 0)

  // 清扫集成：对端引用的载荷与数据集必须活下来，本端判死的照删
  const peerBlobs = new FakeBlobs()
  const peerDs = 'peer-ds#7'
  const deadDs = 'dead-ds#7'
  peerBlobs.seed('payload/peer-only', 100)
  peerBlobs.seed('payload/mine', 100)
  peerBlobs.seed(`frames/${encodeURIComponent(peerDs)}/0`, 100)
  peerBlobs.seed(`frames/${encodeURIComponent(deadDs)}/0`, 100)
  const peerReport = await gcBlobStore(peerBlobs, {
    livePayloadRefs: ['payload/mine'],
    liveDatasetKeys: [],
    peerPayloadRefs: ['payload/peer-only', 'frames/not-a-payload'],
    peerDatasetKeys: [peerDs],
  })
  check('对端引用的载荷被保留', peerBlobs.map.has('payload/peer-only'))
  check('对端开着的帧缓存被保留', peerBlobs.map.has(`frames/${encodeURIComponent(peerDs)}/0`))
  check('本端判死的帧缓存照删', !peerBlobs.map.has(`frames/${encodeURIComponent(deadDs)}/0`))
  check('本端自己的载荷被保留', peerBlobs.map.has('payload/mine'))
  check('peerProtected 计数 = 2', peerReport.peerProtected === 2, String(peerReport.peerProtected))
  check('peers 报告 = 1', peerReport.peers === 1, String(peerReport.peers))

  // 没有对端时的基线：同样的数据会被删干净
  const soloBlobs = new FakeBlobs()
  soloBlobs.seed('payload/peer-only', 100)
  soloBlobs.seed(`frames/${encodeURIComponent(peerDs)}/0`, 100)
  const soloReport = await gcBlobStore(soloBlobs, { livePayloadRefs: [], liveDatasetKeys: [] })
  check('无对端时同样的键会被回收',
    !soloBlobs.map.has('payload/peer-only') && soloReport.peerProtected === 0)

  console.log('\n[12] TabBus 协议（localStorage + BroadcastChannel）')

  class FakeStorage implements StorageLike {
    map = new Map<string, string>()
    get length(): number { return this.map.size }
    key(i: number): string | null { return [...this.map.keys()][i] ?? null }
    getItem(k: string): string | null { return this.map.get(k) ?? null }
    setItem(k: string, v: string): void { this.map.set(k, v) }
    removeItem(k: string): void { this.map.delete(k) }
  }

  const shared = new FakeStorage()
  const channelName = `lt-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const busA = new TabBus({ storage: shared, id: 'A', channelName, claimWaitMs: 10 })
  const busB = new TabBus({ storage: shared, id: 'B', channelName, claimWaitMs: 10 })
  const busC = new TabBus({ storage: shared, id: 'C', channelName, claimWaitMs: 0 })
  busA.start(() => ({ sampleId: 's1', datasetKey: 'dsA', payloadRefs: ['payload/a1'] }))
  busB.start(() => ({ sampleId: 's2', datasetKey: 'dsB', payloadRefs: ['payload/b1'] }))

  const claimA = await busA.claim('s1')
  check('A 拿到租约', claimA.ok && claimA.supported)
  const claimB = await busB.claim('s1')
  check('B 抢同一份被拒并知道持有者', !claimB.ok && claimB.holder === 'A')
  const claimC = await busC.claim('s1')
  check('第三个标签页同样被拒', !claimC.ok && claimC.holder === 'A')

  let lostReason: string | null = null
  busA.onLeaseLost((r) => { lostReason = r })
  busB.takeover('s1')
  await new Promise((r) => setTimeout(r, 60))
  check('接管广播让原持有者收到通知', lostReason === 'takeover', String(lostReason))
  check('接管后持有者变成 B', busB.leaseOf('s1')?.tabId === 'B')
  const reclaim = await busA.claim('s1')
  check('被夺权的一方重新申请仍被拒', !reclaim.ok && reclaim.holder === 'B')

  busB.release()
  check('释放后别的标签页可以接手', (await busC.claim('s1')).ok)
  busC.release()

  check('peers 能列出另一个标签页', busA.peers().some((p) => p.tabId === 'B'))
  check('peers 不包含自己', !busA.peers().some((p) => p.tabId === 'A'))

  const peerRefs = await busA.collectPeerRefs(150)
  check('广播收到对端载荷引用', peerRefs.payloadRefs.includes('payload/b1'), JSON.stringify(peerRefs))
  check('广播收到对端数据集', peerRefs.datasetKeys.includes('dsB'))
  check('广播 reported responders ≥ 1', peerRefs.responders >= 1, String(peerRefs.responders))
  check('广播 supported 标记', peerRefs.supported)

  const noStorage = new TabBus({ storage: null, id: 'D', channelName, claimWaitMs: 0 })
  const degraded = await noStorage.claim('s1')
  check('没有 localStorage 时放行写入（降级）', degraded.ok && !degraded.supported)
  noStorage.stop()

  busA.stop()
  busB.stop()
  busC.stop()
  check('stop 后清理自己的 presence', !shared.getItem('lt:tab:A'))

  console.log('\n[13] 回收审计环')
  const auditStore = new FakeStorage()
  const entry = (i: number): GcAuditEntry => ({
    at: 1000 + i,
    tabId: i % 2 ? 'A' : 'B',
    trigger: 'manual',
    dryRun: false,
    scanned: 10,
    released: 1,
    removeBytes: 100,
    byReason: { 'dead-payload': { count: 1, bytes: 100 } },
    peers: 0,
    keptByPeers: 0,
  })
  for (let i = 0; i < 35; i++) recordGcAudit(entry(i), auditStore)
  const audit = listGcAudit(auditStore)
  check('环形缓冲只留上限条数', audit.length === GC_AUDIT_LIMIT, String(audit.length))
  check('最新的一条在最前', audit[0].at === 1034, String(audit[0].at))
  const auditSum = summarizeGcAudit(audit)
  check('汇总条数与字节', auditSum.entries === 30 && auditSum.removeBytes === 3000, String(auditSum.removeBytes))
  check('按标签页分组', auditSum.byTab.length === 2)
  check('最近时间戳', auditSum.lastAt === 1034)
  clearGcAudit(auditStore)
  check('清空后为空', listGcAudit(auditStore).length === 0)
  auditStore.setItem(GC_AUDIT_KEY, '{"oops":1}')
  check('脏数据不抛错且当空处理', listGcAudit(auditStore).length === 0)
  check('pushCapped 保留新项并截断', pushCapped([1, 2], 3, 2).length === 2 && pushCapped([1, 2], 3, 2)[0] === 3)

  console.log('\n[14] 配额压力下的帧淘汰（LRU）')
  const lruDs = 'live#1'
  const lruEnc = encodeURIComponent(lruDs)
  const lruKey = (f: number, part = '') => `frames/${lruEnc}/${f}${part}`

  function seedLiveFrames(blobs: FakeBlobs, count = 4): void {
    for (let f = 0; f < count; f++) {
      // lastUsedAt 递增：0 号最久没被看
      blobs.seed(lruKey(f), 100, 10, 1000 + f)
      blobs.seed(lruKey(f, ':colors'), 50, 10, 1000 + f)
    }
  }

  const lruBlobs = new FakeBlobs()
  seedLiveFrames(lruBlobs)
  lruBlobs.seed(`frames/${encodeURIComponent('dead#2')}/0`, 100, 10, 9999) // 死数据集，不参与 LRU

  const lruReport = await gcBlobStore(lruBlobs, {
    liveDatasetKeys: [lruDs],
    budget: {
      reclaimBytes: 320,
      evictableDatasetKeys: [lruDs],
      protectKeys: [lruKey(3)],
    },
  })
  check('淘汰最久未用的三帧', !lruBlobs.map.has(lruKey(0)) && !lruBlobs.map.has(lruKey(1)) && !lruBlobs.map.has(lruKey(2)))
  check('受保护的当前帧一帧都不动', lruBlobs.map.has(lruKey(3)) && lruBlobs.map.has(lruKey(3, ':colors')))
  check('颜色记录跟着一起走（不留孤儿）', !lruBlobs.map.has(lruKey(0, ':colors')))
  check('死数据集照旧整段删，不占 LRU 预算', !lruBlobs.map.has(`frames/${encodeURIComponent('dead#2')}/0`))
  check('LRU 只统计活数据集里的帧', lruReport.lru?.groups.length === 3, String(lruReport.lru?.groups.length))
  check('LRU 计划字节数 = 3 帧 × 150', lruReport.lru?.bytes === 450, String(lruReport.lru?.bytes))
  check('byReason 记下 lru-evicted 的 6 条', lruReport.byReason['lru-evicted']?.count === 6,
    JSON.stringify(lruReport.byReason['lru-evicted']))
  check('keepBytes 只剩受保护的那一帧', lruReport.keepBytes === 150, String(lruReport.keepBytes))
  check('removeBytes 含淘汰字节', lruReport.removeBytes === 450 + 100, String(lruReport.removeBytes))

  // 额度不够也至少淘汰一帧：帧是原子的，删半帧没有意义
  const tiny = new FakeBlobs()
  seedLiveFrames(tiny)
  const tinyReport = await gcBlobStore(tiny, {
    liveDatasetKeys: [lruDs],
    budget: { reclaimBytes: 1, evictableDatasetKeys: [lruDs] },
  })
  check('need 很小时仍淘汰整帧', tinyReport.lru?.groups.length === 1 && !tiny.map.has(lruKey(0)))

  // 不在可淘汰集合里：一帧都不能动（恢复草稿的缓存句柄走这条路）
  const keepAll = new FakeBlobs()
  seedLiveFrames(keepAll)
  const keepReport = await gcBlobStore(keepAll, {
    liveDatasetKeys: [lruDs],
    budget: { reclaimBytes: 9999, evictableDatasetKeys: [] },
  })
  check('数据集不可重解码时一帧不删', keepAll.map.size === 8 && keepReport.lru?.keys.length === 0)

  // dryRun：计划照出，键一个不删
  const dryBlobs = new FakeBlobs()
  seedLiveFrames(dryBlobs)
  const dryReport = await gcBlobStore(dryBlobs, {
    liveDatasetKeys: [lruDs],
    budget: { reclaimBytes: 200, evictableDatasetKeys: [lruDs] },
    dryRun: true,
  })
  check('预演给出相同计划', dryReport.lru?.groups.length === 2 && dryReport.released === 0)
  check('预演不删任何键', dryBlobs.map.size === 8)

  // 读路径记账 → 淘汰顺序的闭环：touch 过的帧从"最旧"变成"最新"
  const touched = new FakeBlobs()
  seedLiveFrames(touched)
  await touched.touchMany([lruKey(0)], 50_000)
  const touchedReport = await gcBlobStore(touched, {
    liveDatasetKeys: [lruDs],
    budget: { reclaimBytes: 200, evictableDatasetKeys: [lruDs] },
  })
  check('刚读过的帧不再被优先淘汰', touched.map.has(lruKey(0)), JSON.stringify(touchedReport.lru?.groups.map((g) => g.frame)))
  check('转而淘汰次旧的帧', !touched.map.has(lruKey(1)) && !touched.map.has(lruKey(2)))
  check('touch 不存在的键不报错', (await touched.touchMany(['frames/nope/0'])) === 0)
  check('touch 会累加命中次数', touched.map.get(lruKey(0))?.hits === 1, String(touched.map.get(lruKey(0))?.hits))

  console.log('\n[15] 全局淘汰（跨数据集）与 LFU')
  const own = 'own#1'
  const peer = 'peer#2'
  const ownKey = (f: number, part = '') => frameBlobKey(own, f) + part
  const peerKey = (f: number, part = '') => frameBlobKey(peer, f) + part

  /** 两个活数据集交替使用：own 比 peer 更旧一档，便于验证"统一排序" */
  function seedTwoDatasets(blobs: FakeBlobs): void {
    for (let f = 0; f < 2; f++) {
      blobs.seed(ownKey(f), 100, 10, 1000 + f * 2)
      blobs.seed(ownKey(f, ':colors'), 50, 10, 1000 + f * 2)
      blobs.seed(peerKey(f), 100, 10, 1001 + f * 2)
      blobs.seed(peerKey(f, ':colors'), 50, 10, 1001 + f * 2)
    }
  }

  // 1) 只有对端的数据集可淘汰：本端一帧都不能动
  const onlyPeer = new FakeBlobs()
  seedTwoDatasets(onlyPeer)
  const onlyPeerReport = await gcBlobStore(onlyPeer, {
    liveDatasetKeys: [own],
    peerDatasetKeys: [peer],
    budget: { reclaimBytes: 300, evictableDatasetKeys: [peer] },
  })
  check('只动对端数据集：本端帧一条不少',
    onlyPeer.map.has(ownKey(0)) && onlyPeer.map.has(ownKey(1)) && onlyPeer.map.has(ownKey(0, ':colors')))
  check('对端最久未用的两帧被淘汰', !onlyPeer.map.has(peerKey(0)) && !onlyPeer.map.has(peerKey(1)))
  check('对端的颜色记录一起走', !onlyPeer.map.has(peerKey(0, ':colors')))
  check('计划只涉及对端数据集', onlyPeerReport.lru?.datasets.join('|') === peer,
    JSON.stringify(onlyPeerReport.lru?.datasets))
  check('理由记 lru-evicted（含颜色共 4 条）', onlyPeerReport.byReason['lru-evicted']?.count === 4,
    JSON.stringify(onlyPeerReport.byReason['lru-evicted']))

  // 2) 两个数据集都可淘汰：跨数据集统一按时间排序，而不是"先删自己的"
  const bothDs = new FakeBlobs()
  seedTwoDatasets(bothDs)
  const bothReport = await gcBlobStore(bothDs, {
    liveDatasetKeys: [own],
    peerDatasetKeys: [peer],
    budget: { reclaimBytes: 450, evictableDatasetKeys: [own, peer] },
  })
  check('跨数据集统一排序：own/0 → peer/0 → own/1',
    bothReport.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`).join(',') === `${own}/0,${peer}/0,${own}/1`,
    JSON.stringify(bothReport.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`)))
  check('datasets 记下两个数据集', bothReport.lru?.datasets.length === 2,
    JSON.stringify(bothReport.lru?.datasets))
  check('被淘汰的键真的删了（跨数据集）',
    !bothDs.map.has(ownKey(0)) && !bothDs.map.has(peerKey(0)) && bothDs.map.has(peerKey(1)))

  // 3) 对端的保护键：本端淘汰对端数据集时要避开对端的当前帧邻域
  const guarded = new FakeBlobs()
  seedTwoDatasets(guarded)
  const guardedReport = await gcBlobStore(guarded, {
    liveDatasetKeys: [own],
    peerDatasetKeys: [peer],
    budget: {
      reclaimBytes: 450,
      evictableDatasetKeys: [own, peer],
      protectKeys: [peerKey(0)],
    },
  })
  check('对端保护键命中的帧整组跳过', guarded.map.has(peerKey(0)) && guarded.map.has(peerKey(0, ':colors')))
  check('于是淘汰顺延到下一帧', !guarded.map.has(ownKey(0)) && !guarded.map.has(ownKey(1)) && !guarded.map.has(peerKey(1)),
    JSON.stringify(guardedReport.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`)))

  // 4) 策略透传到判定：同样的数据，lfu 与 lru 删的不是同一帧
  const freqDs = 'freq#1'
  const freqKey = (f: number) => frameBlobKey(freqDs, f)
  const mkFreq = () => {
    const b = new FakeBlobs()
    b.seed(freqKey(0), 100, 10, 9000, 0) // 最新，但从没被回看
    b.seed(freqKey(1), 100, 10, 1000, 4) // 最旧，却反复回看
    b.seed(freqKey(2), 100, 10, 5000, 2)
    return b
  }
  const lfuStore = mkFreq()
  const lfuReport = await gcBlobStore(lfuStore, {
    liveDatasetKeys: [freqDs],
    budget: { reclaimBytes: 1, evictableDatasetKeys: [freqDs], policy: 'lfu' },
  })
  check('lfu 先淘汰读得最少的帧', !lfuStore.map.has(freqKey(0)) && lfuStore.map.has(freqKey(1)),
    JSON.stringify(lfuReport.lru?.groups.map((g) => g.frame)))
  check('计划回填 policy=lfu', lfuReport.lru?.policy === 'lfu', String(lfuReport.lru?.policy))
  const lruOnly = mkFreq()
  const lruReport2 = await gcBlobStore(lruOnly, {
    liveDatasetKeys: [freqDs],
    budget: { reclaimBytes: 1, evictableDatasetKeys: [freqDs], policy: 'lru' },
  })
  check('lru 在同样数据上先淘汰最旧的', !lruOnly.map.has(freqKey(1)),
    JSON.stringify(lruReport2.lru?.groups.map((g) => g.frame)))
  const plainBlobs = new FakeBlobs()
  for (let f = 0; f < 3; f++) plainBlobs.seed(frameBlobKey('plain#1', f), 100, 10, 1000 + f)
  const plainReport = await gcBlobStore(plainBlobs, {
    liveDatasetKeys: ['plain#1'],
    budget: { reclaimBytes: 1, evictableDatasetKeys: ['plain#1'] },
  })
  check('默认策略为 hybrid 且淘汰最旧的帧', plainReport.lru?.policy === 'hybrid' && !plainBlobs.map.has(frameBlobKey('plain#1', 0)),
    String(plainReport.lru?.policy))

  // 5) 腾不够时报告缺口（以前是静默返回，调用方以为清干净了）
  const tooSmall = new FakeBlobs()
  seedTwoDatasets(tooSmall)
  const shortReport = await gcBlobStore(tooSmall, {
    liveDatasetKeys: [own],
    peerDatasetKeys: [peer],
    budget: { reclaimBytes: 99_999, evictableDatasetKeys: [peer] },
  })
  check('可淘汰的只有 4 帧时报告缺口', (shortReport.lru?.shortfall ?? 0) > 0,
    String(shortReport.lru?.shortfall))
  check('缺口 = 需求 − 已腾字节',
    shortReport.lru?.shortfall === 99_999 - (shortReport.lru?.bytes ?? 0),
    `${shortReport.lru?.shortfall} vs ${shortReport.lru?.bytes}`)

  // 6) 对端状态合并：可淘汰声明与保护键都来自对端自报
  const merged = mergePeerProtection([
    { tabId: 't1', datasetKey: 'peer#2', evictable: true, protectKeys: ['k1', 'k2'] } as PeerState,
    { tabId: 't2', datasetKey: 'peer#3', evictable: false, protectKeys: ['k2', 'k3'] } as PeerState,
    { tabId: 't3', datasetKey: '', evictable: true } as PeerState,
  ])
  check('只收集声明可淘汰的数据集', merged.evictableDatasetKeys.join('|') === 'peer#2',
    JSON.stringify(merged.evictableDatasetKeys))
  check('没有 datasetKey 的 evictable 被忽略', merged.evictableDatasetKeys.length === 1)
  check('对端保护键去重合并', merged.protectKeys.join('|') === 'k1|k2|k3', JSON.stringify(merged.protectKeys))
  const spam = mergePeerProtection([
    { tabId: 't9', datasetKey: 'x', protectKeys: Array.from({ length: 400 }, (_, i) => `key#${i}`) },
  ])
  check('保护键数量有上限（防协议出错刷爆内存）', spam.protectKeys.length === 256, String(spam.protectKeys.length))

  console.log(`\n===== 结果: ${passed} 通过, ${failed} 失败 =====\n`)
  if (failed > 0) process.exit(1)
}

void main()

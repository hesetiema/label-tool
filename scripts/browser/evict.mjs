// 浏览器手测：全局淘汰（跨数据集 / 跨标签页）与 LFU 策略
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/evict.mjs，或设 APP_URL 指向已起实例
//
// 【为什么要单独一支，且必须开两个真标签页】
//   第九批把候选池从"当前数据集"扩到"所有可重解码的数据集"，其中对端的数据集
//   来自 BroadcastChannel 上的自报（evictable + protectKeys），删完还要反向广播
//   "我把你的帧删了"让对方撤回记账。这三件事在 Node 里一件都测不到：
//   广播、localStorage presence、真实 IndexedDB 事务都只在浏览器里存在。
//
// 【为什么不用配额阈值驱动】85% 的阈值要写满几个 GB 才触发。
//   这里用 runBlobGc({ reclaimBytes }) 直接指定"腾多少"，走的仍是同一条判定链
//   （可重解码门禁 → 保护键 → 整帧进出 → 记账撤回），只是跳过了水位计算。
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const DB = 'point-cloud-label-studio'
const POS = 100 * 1024
const COL = 50 * 1024
const FRAME = POS + COL

// 唯一键前缀：不清库也能与上一次运行的残留隔离（两个标签页开着时清库会打断它们的连接）
const stamp = Date.now().toString(36)
const OWN = `own#${stamp}`
const PEER = `peer#${stamp}`
const encOwn = encodeURIComponent(OWN)
const encPeer = encodeURIComponent(PEER)
const FRAMES = 6

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ← ' + detail}`)
}

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const errors = []
const watchErrors = (page, tag) => {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${tag}] ${m.text()}`)
  })
  page.on('pageerror', (e) => errors.push(`[${tag}] pageerror: ${e.message}`))
}

/** 等应用把库建出来（store 惰性创建，早于它 open 会自建一个 v1 空库并把升级挡住） */
async function ensureDb(p) {
  await p.waitForFunction(
    async (name) => {
      const list = await indexedDB.databases?.().catch(() => null)
      if (list) {
        const hit = list.find((d) => d.name === name)
        return !!hit && (hit.version ?? 0) >= 3
      }
      return false
    },
    DB,
    { timeout: 20000 },
  )
}

/**
 * 造帧缓存。rows = [[enc, frame, lastUsedAt, hits], ...]
 * 每帧两条记录（positions + colors），使用时间与命中次数写进 blobUsage ——
 * 与真实读路径（`noteFrameUsed` → `touchMany`）产生的是同一种记录。
 */
async function seed(p, rows) {
  await p.evaluate(
    async ({ rows, pos, col, name }) => {
      const db = await new Promise((res) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => res(r.result)
      })
      const tx = db.transaction(['blobs', 'blobUsage'], 'readwrite')
      const blobs = tx.objectStore('blobs')
      const usage = tx.objectStore('blobUsage')
      for (const [enc, frame, used, hits] of rows) {
        const posKey = `frames/${enc}/${frame}`
        blobs.put({ data: new ArrayBuffer(pos), bytes: pos, savedAt: used - 1 }, posKey)
        blobs.put({ data: new ArrayBuffer(col), bytes: col, savedAt: used - 1 }, `${posKey}:colors`)
        usage.put({ at: used, hits }, posKey)
        usage.put({ at: used, hits }, `${posKey}:colors`)
      }
      await new Promise((r, j) => {
        tx.oncomplete = r
        tx.onerror = () => j(tx.error)
      })
      db.close()
    },
    { rows, pos: POS, col: COL, name: DB },
  )
}

/** 每帧的位置/颜色是否还在 */
async function frameFlags(p, enc, count) {
  return p.evaluate(
    async ({ enc, count, name }) => {
      const db = await new Promise((res) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => res(r.result)
      })
      const tx = db.transaction(['blobs'], 'readonly')
      const all = await new Promise((res) => {
        const r = tx.objectStore('blobs').getAllKeys()
        r.onsuccess = () => res(r.result.map(String))
      })
      db.close()
      const out = []
      for (let f = 0; f < count; f++) {
        out.push({
          pos: all.includes(`frames/${enc}/${f}`),
          col: all.includes(`frames/${enc}/${f}:colors`),
        })
      }
      return out
    },
    { enc, count, name: DB },
  )
}

/** 两侧都铺满 12 帧：peer 整体更旧（用于验证"跨数据集统一排序"） */
const base = Date.now() - 1_000_000
function bothRows(ownHits = null) {
  const rows = []
  for (let f = 0; f < FRAMES; f++) {
    rows.push([encPeer, f, base + f * 1000, 0])
    rows.push([encOwn, f, base + 100_000 + f * 1000, 0])
  }
  if (ownHits) for (let f = 0; f < ownHits.length; f++) rows.push([encOwn, f, ownHits[f][0], ownHits[f][1]])
  return rows
}

const pageA = await ctx.newPage()
watchErrors(pageA, 'A')
const pageB = await ctx.newPage()
watchErrors(pageB, 'B')

// ---- A：工作台（自己这份数据集，可重解码）----
await pageA.goto(APP + '?data=demo', { waitUntil: 'load' })
await pageA.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await pageA.waitForTimeout(2400) // 让启动清扫先跑完，别和手动调用抢
await pageA.evaluate(() => window.studio.persistNow(true))
await ensureDb(pageA)
await pageA.evaluate((ds) => {
  window.studio.datasetKey.value = ds
  window.studio.currentFrame.value = 5 // 保护邻域 = 3..7，0/1/2 可淘汰
  window.studio.framesReloadable.value = true
}, OWN)

// ---- B：另一个标签页，开着 peer 数据集（默认不可重解码）----
await pageB.goto(APP + '?data=sequence', { waitUntil: 'load' })
await pageB.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await pageB.waitForTimeout(2400)
await pageB.evaluate((ds) => {
  window.studio.datasetKey.value = ds
  window.studio.currentFrame.value = 0 // 保护邻域 = 0..2
}, PEER)

check(
  'A 与 B 是不同的标签页身份',
  (await pageA.evaluate(() => window.studio.tabBus.tabId)) !== (await pageB.evaluate(() => window.studio.tabBus.tabId)),
)

await seed(pageA, bothRows())
const seeded = await frameFlags(pageA, encOwn, FRAMES)
const seededPeer = await frameFlags(pageA, encPeer, FRAMES)
check('两侧各铺 6 帧（位置 + 颜色）', seeded.every((f) => f.pos && f.col) && seededPeer.every((f) => f.pos && f.col))

// ------------------------------------------------------------------
// 1. 对端未声明可淘汰：候选池只有本端
// ------------------------------------------------------------------
const phase1 = await pageA.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: bytes })
  return {
    groups: rep?.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`) ?? null,
    datasets: rep?.lru?.datasets ?? null,
    candidates: rep?.lru?.candidates ?? -1,
    protectedFrames: rep?.lru?.protectedFrames ?? -1,
    policy: rep?.lru?.policy ?? null,
  }
}, FRAME * 2)
check(
  '对端不可淘汰时只动本端',
  JSON.stringify(phase1.datasets) === JSON.stringify([OWN]),
  JSON.stringify(phase1.datasets),
)
check(
  '本端淘汰的是最旧的两帧（0、1 号；3..5 在保护邻域里）',
  JSON.stringify(phase1.groups) === JSON.stringify([`${OWN}/0`, `${OWN}/1`]),
  JSON.stringify(phase1.groups),
)
check('候选数只算本端未被保护的 3 帧', phase1.candidates === 3, String(phase1.candidates))
check('默认策略为 hybrid', phase1.policy === 'hybrid', String(phase1.policy))

// ------------------------------------------------------------------
// 2. 对端声明可重解码：候选池跨数据集，按同一把尺子排序
// ------------------------------------------------------------------
await pageB.evaluate(() => {
  window.studio.framesReloadable.value = true
})
await pageB.waitForTimeout(120)
check('对端已声明可淘汰', await pageB.evaluate(() => window.studio.canEvictFrames() === true))

const phase2 = await pageA.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: bytes })
  return {
    groups: rep?.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`) ?? null,
    datasets: rep?.lru?.datasets ?? null,
    candidates: rep?.lru?.candidates ?? -1,
    protectedFrames: rep?.lru?.protectedFrames ?? -1,
  }
}, FRAME * 2)
check('候选池扩到对端数据集（3 + 3 = 6）', phase2.candidates === 6, String(phase2.candidates))
check('两边各自的当前帧邻域都被保护（共 6 帧）', phase2.protectedFrames === 6, String(phase2.protectedFrames))
check(
  '对端更旧，于是先淘汰对端的 3、4 号',
  JSON.stringify(phase2.groups) === JSON.stringify([`${PEER}/3`, `${PEER}/4`]),
  JSON.stringify(phase2.groups),
)
check(
  '计划只涉及对端数据集',
  JSON.stringify(phase2.datasets) === JSON.stringify([PEER]),
  JSON.stringify(phase2.datasets),
)
check(
  '预演一条都没删',
  (await frameFlags(pageA, encPeer, FRAMES)).every((f) => f.pos),
)

// ------------------------------------------------------------------
// 3. 真跑：删对端的帧 + 反向广播通知对端撤回记账
// ------------------------------------------------------------------
const phase3 = await pageA.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, reclaimBytes: bytes })
  return {
    groups: rep?.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`) ?? null,
    reasonCount: rep?.byReason?.['lru-evicted']?.count ?? -1,
    status: window.studio.statusText.value,
    audit: window.studio.gcAudit().entries[0] ?? null,
  }
}, FRAME * 2)
await pageB.waitForTimeout(200)

const afterPeer = await frameFlags(pageA, encPeer, FRAMES)
const afterOwn = await frameFlags(pageA, encOwn, FRAMES)
check('对端的 3、4 号从库里消失', !afterPeer[3].pos && !afterPeer[4].pos, JSON.stringify(afterPeer.map((f) => f.pos)))
check('对端的颜色记录一起删（不留孤儿）', !afterPeer[3].col && !afterPeer[4].col)
check(
  '本端一帧未动',
  afterOwn.every((f) => f.pos && f.col),
)
check('理由记 lru-evicted（2 帧 × 2 条 = 4）', phase3.reasonCount === 4, String(phase3.reasonCount))
check(
  'A 的状态栏说明配额淘汰与策略',
  phase3.status.includes('配额淘汰') && phase3.status.includes('策略'),
  phase3.status,
)
check('审计记下策略', phase3.audit?.evictPolicy === 'hybrid', JSON.stringify(phase3.audit?.evictPolicy))
check('审计记下跨了 1 个数据集', phase3.audit?.lruDatasets === 1, String(phase3.audit?.lruDatasets))
check(
  '对端收到"你的帧被淘汰"的通知',
  (await pageB.evaluate(() => window.studio.statusText.value)).includes('另一标签页回收'),
  await pageB.evaluate(() => window.studio.statusText.value),
)
check('审计记下淘汰字节', phase3.audit?.lruBytes === FRAME * 2, String(phase3.audit?.lruBytes))

// ------------------------------------------------------------------
// 4. 广播只对"自己的数据集"生效：别的 datasetKey 不该有任何反应
// ------------------------------------------------------------------
const beforeBogus = await pageB.evaluate(() => window.studio.statusText.value)
await pageA.evaluate(() => {
  window.studio.tabBus.announceFramesEvicted('bogus#none', [{ frame: 0, bytes: 1 }], 1)
})
await pageB.waitForTimeout(200)
check('无关数据集的淘汰通知被忽略', (await pageB.evaluate(() => window.studio.statusText.value)) === beforeBogus)

// ------------------------------------------------------------------
// 5. 对端的保护键随它自己的当前帧挪动
// ------------------------------------------------------------------
await seed(pageA, bothRows())
// B 是 5 帧演示序列，最后一帧是 4：邻域 2..4，于是 0、1 号重新变成候选
await pageB.evaluate(() => {
  window.studio.currentFrame.value = 4
})
await pageB.waitForTimeout(120)
const phase5 = await pageA.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: bytes })
  return {
    groups: rep?.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`) ?? null,
    candidates: rep?.lru?.candidates ?? -1,
    protectedFrames: rep?.lru?.protectedFrames ?? -1,
  }
}, FRAME * 2)
check(
  '对端当前帧挪走后 0、1 号重新变成候选',
  JSON.stringify(phase5.groups) === JSON.stringify([`${PEER}/0`, `${PEER}/1`]),
  JSON.stringify(phase5.groups),
)
// A 护自己的 3..7 → 3/4/5；B 护它的 2..6 → 2/3/4/5。两侧各按自己的当前帧算
check('保护范围各按自己的当前帧算（3 + 4 = 7）', phase5.protectedFrames === 7, String(phase5.protectedFrames))

// ------------------------------------------------------------------
// 6. LFU：同样的数据，按"读得最少"与按"最久未用"删的不是同一帧
// ------------------------------------------------------------------
await pageB.evaluate(() => {
  window.studio.framesReloadable.value = false
}) // 先排除对端干扰
await pageA.evaluate(() => {
  window.studio.currentFrame.value = 5
})
await seed(
  pageA,
  bothRows([
    [base + 900_000, 0], // 最新，但从没被回看
    [base + 10_000, 5], // 最旧，却反复回看
    [base + 500_000, 2],
  ]),
)
const byLru = await pageA.evaluate(async (bytes) => {
  window.studio.setEvictionPolicy('lru')
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: bytes })
  return rep?.lru?.groups.map((g) => g.frame) ?? null
}, FRAME)
const byLfu = await pageA.evaluate(async (bytes) => {
  window.studio.setEvictionPolicy('lfu')
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: bytes })
  return rep?.lru?.groups.map((g) => g.frame) ?? null
}, FRAME)
check('lru 先淘汰最旧的 1 号', JSON.stringify(byLru) === JSON.stringify([1]), JSON.stringify(byLru))
check('lfu 先淘汰从没回看的 0 号', JSON.stringify(byLfu) === JSON.stringify([0]), JSON.stringify(byLfu))
check('策略写进 localStorage', (await pageA.evaluate(() => localStorage.getItem('lt:evict-policy'))) === 'lfu')
check('页面上的策略状态同步', (await pageA.evaluate(() => window.studio.evictionPolicy.value)) === 'lfu')

const lfuReal = await pageA.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, reclaimBytes: bytes })
  return {
    groups: rep?.lru?.groups.map((g) => g.frame) ?? null,
    policy: rep?.lru?.policy ?? null,
    audit: window.studio.gcAudit().entries[0] ?? null,
  }
}, FRAME)
check('真跑按 lfu 删掉 0 号', JSON.stringify(lfuReal.groups) === JSON.stringify([0]), JSON.stringify(lfuReal.groups))
check('报告回填 policy=lfu', lfuReal.policy === 'lfu', String(lfuReal.policy))
check('审计记下 evictPolicy=lfu', lfuReal.audit?.evictPolicy === 'lfu', JSON.stringify(lfuReal.audit?.evictPolicy))
const afterLfu = await frameFlags(pageA, encOwn, FRAMES)
check('0 号已删、1 号（高频）保留', !afterLfu[0].pos && afterLfu[1].pos, JSON.stringify(afterLfu.map((f) => f.pos)))

// ------------------------------------------------------------------
// 7. 一次计划跨两个数据集 → 审计记 lruDatasets = 2
// ------------------------------------------------------------------
await pageB.evaluate(() => {
  window.studio.framesReloadable.value = true
  window.studio.currentFrame.value = 4
})
await pageA.evaluate(() => window.studio.setEvictionPolicy('hybrid'))
await seed(pageA, bothRows())
await pageB.waitForTimeout(120)
const cross = await pageA.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, reclaimBytes: bytes })
  return {
    groups: rep?.lru?.groups.map((g) => `${g.datasetKey}/${g.frame}`) ?? null,
    datasets: rep?.lru?.datasets ?? null,
    audit: window.studio.gcAudit().entries[0] ?? null,
  }
}, FRAME * 4)
check(
  '一次淘汰跨两个数据集',
  JSON.stringify(cross.datasets) === JSON.stringify([OWN, PEER].sort()),
  JSON.stringify(cross.datasets),
)
check(
  '先删对端的 0/1 号，再轮到本端 0/1 号（peer 整体更旧）',
  cross.groups?.length === 4 &&
    cross.groups.filter((g) => g.startsWith(PEER)).length === 2 &&
    cross.groups.filter((g) => g.startsWith(OWN)).length === 2,
  JSON.stringify(cross.groups),
)
check('审计记下 lruDatasets=2', cross.audit?.lruDatasets === 2, String(cross.audit?.lruDatasets))
check('审计记下淘汰帧数 4', cross.audit?.lruFrames === 4, String(cross.audit?.lruFrames))

// ------------------------------------------------------------------
// 8. URL 覆盖：?evict=lru 只影响本次会话，不写回存储
// ------------------------------------------------------------------
const storedBefore = await pageA.evaluate(() => localStorage.getItem('lt:evict-policy'))
const pageC = await ctx.newPage()
watchErrors(pageC, 'C')
await pageC.goto(APP + '?data=demo&evict=lru', { waitUntil: 'load' })
await pageC.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
check('?evict=lru 覆盖本次策略', (await pageC.evaluate(() => window.studio.evictionPolicy.value)) === 'lru')
check(
  'URL 覆盖不写回存储',
  (await pageC.evaluate(() => localStorage.getItem('lt:evict-policy'))) === storedBefore,
  String(storedBefore),
)
await pageC.close()

check('页面无 console 报错', errors.length === 0, errors.slice(0, 6).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

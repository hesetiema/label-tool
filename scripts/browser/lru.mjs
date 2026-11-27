// 浏览器手测：帧缓存 LRU 淘汰（配额压力下的第二阶段清扫）
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/lru.mjs，或设 APP_URL 指向已起实例
//
// 【为什么要单独一支】配额阈值是 85%，正常机器要写满几个 GB 才触发，
// 回归里造不出来。这里用 `runBlobGc({ reclaimBytes })` 直接指定"腾这么多"，
// 走的仍是同一条判定链（保护当前帧邻域、只碰可重解码的数据集、整帧进出）。
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const DB = 'point-cloud-label-studio'
const DATASET = 'lru#1'
const enc = encodeURIComponent(DATASET)
const FRAMES = 8
const POS_BYTES = 300 * 1024
const COL_BYTES = 100 * 1024
const FRAME_BYTES = POS_BYTES + COL_BYTES

const results = []

/** 等应用把 v3 库建出来：store 是惰性创建的，早于它 open 会自己建出一个 v1 空库 */
async function ensureDb(p) {
  await p.waitForFunction(
    async (name) => {
      const list = await indexedDB.databases?.().catch(() => null)
      if (list) {
        const hit = list.find((d) => d.name === name)
        return !!hit && (hit.version ?? 0) >= 3
      }
      return await new Promise((res) => {
        const r = indexedDB.open(name)
        r.onsuccess = () => {
          const ok = r.result.objectStoreNames.contains('blobUsage')
          r.result.close()
          res(ok)
        }
        r.onerror = () => res(false)
      })
    },
    DB,
    { timeout: 20000 },
  )
}

/** 造 count 帧缓存（位置 + 颜色），i 越大使用时间越新 */
async function seedFrames(p, enc, count) {
  await p.evaluate(
    async ({ enc, count, posBytes, colBytes }) => {
      const db = await new Promise((res) => {
        const r = indexedDB.open('point-cloud-label-studio')
        r.onsuccess = () => res(r.result)
      })
      const tx = db.transaction(['blobs', 'blobUsage'], 'readwrite')
      const blobs = tx.objectStore('blobs')
      const usage = tx.objectStore('blobUsage')
      const base = Date.now() - count * 10_000
      for (let i = 0; i < count; i++) {
        const posKey = `frames/${enc}/${i}`
        blobs.put({ data: new ArrayBuffer(posBytes), bytes: posBytes, savedAt: base }, posKey)
        blobs.put({ data: new ArrayBuffer(colBytes), bytes: colBytes, savedAt: base }, `${posKey}:colors`)
        usage.put({ at: base + i * 1000 }, posKey)
        usage.put({ at: base + i * 1000 }, `${posKey}:colors`)
      }
      await new Promise((r, j) => {
        tx.oncomplete = r
        tx.onerror = () => j(tx.error)
      })
      db.close()
    },
    { enc, count, posBytes: POS_BYTES, colBytes: COL_BYTES },
  )
}

/** 读某数据集的 0..4 帧是否还在库里。库名硬编码，避免参数传递带来的歧义 */
async function frameFlags(p, enc) {
  return p.evaluate(async (e) => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('point-cloud-label-studio')
      r.onsuccess = () => res(r.result)
    })
    const tx = db.transaction(['blobs'], 'readonly')
    const all = await new Promise((res) => {
      const r = tx.objectStore('blobs').getAllKeys()
      r.onsuccess = () => res(r.result.map(String))
    })
    db.close()
    return [0, 1, 2, 3, 4].map((f) => all.includes(`frames/${e}/${f}`))
  }, enc)
}
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

await page.goto(APP + '?data=sequence', { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(2200) // 让启动清扫先跑完，避免手动调用排到它后面
// 让应用先把库建出来（store 是惰性创建的）：否则下面自己 open() 会建出一个 v1 空库，
// 应用的 v3 升级反而被这条连接阻塞
await page.evaluate(() => window.studio.persistNow(true))
await ensureDb(page)

// 清库：断言的是精确键集合
await page.evaluate(async (name) => {
  const db = await new Promise((res) => {
    const r = indexedDB.open(name)
    r.onsuccess = () => res(r.result)
  })
  const tx = db.transaction(['blobs', 'session', 'documents', 'docTasks', 'blobUsage'], 'readwrite')
  for (const n of ['blobs', 'session', 'documents', 'docTasks', 'blobUsage']) tx.objectStore(n).clear()
  await new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
  db.close()
}, DB)

// 造帧缓存：位置 + 颜色两条记录，外加使用时间（i 越大越新，0 号最久没被看）
await seedFrames(page, enc, FRAMES)

async function keysNow() {
  return page.evaluate(async (name) => {
    const db = await new Promise((res) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => res(r.result)
    })
    const tx = db.transaction(['blobs', 'blobUsage'], 'readonly')
    const blobs = await new Promise((res) => {
      const r = tx.objectStore('blobs').getAllKeys()
      r.onsuccess = () => res(r.result ?? [])
    })
    const usage = await new Promise((res) => {
      const r = tx.objectStore('blobUsage').getAllKeys()
      r.onsuccess = () => res(r.result ?? [])
    })
    db.close()
    return { blobs: blobs.map(String), usage: usage.map(String) }
  }, DB)
}

// 建库检查：v3 必须有 blobUsage，否则使用时间无处存、LRU 退化成按写入时间淘汰
const schema = await page.evaluate(async (name) => {
  const db = await new Promise((res) => {
    const r = indexedDB.open(name)
    r.onsuccess = () => res(r.result)
  })
  const out = { version: db.version, stores: [...db.objectStoreNames] }
  db.close()
  return out
}, DB)
check('数据库版本为 3', schema.version === 3, String(schema.version))
check('包含 blobUsage（LRU 的使用时间）', schema.stores.includes('blobUsage'), schema.stores.join(','))

const seeded = await keysNow()
check('已写入 8 帧 × 2 条记录', seeded.blobs.length === FRAMES * 2, String(seeded.blobs.length))
check('使用时间也一并写入', seeded.usage.length === FRAMES * 2, String(seeded.usage.length))

// 把当前数据集指向造出来的这一份，并把当前帧放在 0 号
// （保护邻域 = 0/1/2，于是 3 号是可淘汰里最旧的）
await page.evaluate(
  ({ dataset, frame }) => {
    window.studio.datasetKey.value = dataset
    window.studio.currentFrame.value = frame
    // 强制入口（reclaimBytes）也走同一条判定链，所以要显式声明可重解码 ——
    // 否则测的是一条生产里不存在的旁路
    window.studio.framesReloadable.value = true
  },
  { dataset: DATASET, frame: 0 },
)

// ---- 1. 预演：给出计划但不删 ----
const dryRun = await page.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: bytes })
  return {
    lruGroups: rep?.lru?.groups.map((g) => g.frame) ?? null,
    lruBytes: rep?.lru?.bytes ?? -1,
    protectSkipped: rep?.lru?.protectedFrames ?? -1,
    released: rep?.released ?? -1,
    status: window.studio.statusText.value,
  }
}, FRAME_BYTES * 2)
check('预演淘汰两帧', dryRun.lruGroups?.length === 2, JSON.stringify(dryRun.lruGroups))
check(
  '预演淘汰的是 3、4 号（最久未用且不在保护邻域）',
  dryRun.lruGroups?.join(',') === '3,4',
  JSON.stringify(dryRun.lruGroups),
)
check('预演统计被保护跳过的帧数', dryRun.protectSkipped === 3, String(dryRun.protectSkipped))
check('预演淘汰字节 = 2 × 400KB', dryRun.lruBytes === FRAME_BYTES * 2, String(dryRun.lruBytes))
check('预演不提交删除', dryRun.released === 0, String(dryRun.released))
check('预演不删键', (await keysNow()).blobs.length === FRAMES * 2)

// ---- 2. 真跑 ----
const real = await page.evaluate(async (bytes) => {
  const rep = await window.studio.runBlobGc({ manual: true, reclaimBytes: bytes })
  const audit = window.studio.gcAudit().entries[0] ?? null
  return {
    lruGroups: rep?.lru?.groups.map((g) => g.frame) ?? null,
    removed: rep?.remove.filter((v) => v.reason === 'lru-evicted').length ?? -1,
    byReason: rep?.byReason?.['lru-evicted'] ?? null,
    released: rep?.released ?? -1,
    status: window.studio.statusText.value,
    audit,
  }
}, FRAME_BYTES * 2)

check('真跑淘汰两帧', real.lruGroups?.length === 2, JSON.stringify(real.lruGroups))
check('判定理由记为 lru-evicted（4 条记录）', real.byReason?.count === 4, JSON.stringify(real.byReason))
check('提交删除 4 条', real.released === 4, String(real.released))
check('状态栏说明配额淘汰', real.status.includes('配额淘汰') && real.status.includes('2 帧'), real.status)
check('审计记住 lruFrames', real.audit?.lruFrames === 2, JSON.stringify(real.audit))
check('审计记住 lruBytes', real.audit?.lruBytes === FRAME_BYTES * 2, String(real.audit?.lruBytes))

const after = await keysNow()
const has = (f, part = '') => after.blobs.includes(`frames/${enc}/${f}${part}`)
check('3、4 号的位置记录被删', !has(3) && !has(4))
check('3、4 号的颜色记录一起删（不留孤儿）', !has(3, ':colors') && !has(4, ':colors'))
check('当前帧邻域 0/1/2 完整保留', has(0) && has(0, ':colors') && has(1) && has(2) && has(2, ':colors'))
check('比保护邻域新的 5/6/7 也保留', has(5) && has(6) && has(7))
check('删除后只剩 12 条', after.blobs.length === 12, String(after.blobs.length))
check(
  '使用时间跟着删掉（不留元数据孤儿）',
  !after.usage.includes(`frames/${enc}/3`) && after.usage.length === 12,
  String(after.usage.length),
)

// ---- 3. 保护键优先于 LRU：把当前帧移到 5，最旧的 0 号就该被淘汰 ----
const movedProtect = await page.evaluate(async (bytes) => {
  window.studio.currentFrame.value = 5
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: bytes })
  return { lruGroups: rep?.lru?.groups.map((g) => g.frame) ?? null, skipped: rep?.lru?.protectedFrames ?? -1 }
}, FRAME_BYTES)
check('当前帧移到 5 后，0 号变成可淘汰', movedProtect.lruGroups?.[0] === 0, JSON.stringify(movedProtect.lruGroups))
// 3、4 已被删，剩下的 5/6/7 落在 3..7 的邻域里，所以被跳过的是 3 帧
check('保护范围随之挪到 3..7（跳过 5/6/7）', movedProtect.skipped === 3, String(movedProtect.skipped))

// ---- 4. 候选池不含受保护的帧 ----
const nothing = await page.evaluate(async () => {
  // 当前帧 6 → 邻域 4..8，护住 5/6/7；剩下 0/1/2 才是候选
  window.studio.currentFrame.value = 6
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: 1 })
  return {
    groups: rep?.lru?.groups.length ?? -1,
    candidates: rep?.lru?.candidates ?? -1,
    skipped: rep?.lru?.protectedFrames ?? -1,
  }
})
check('候选池只数没被保护的帧（3 帧可淘汰）', nothing.candidates === 3, JSON.stringify(nothing))
check('保护帧数与候选数分开统计', nothing.skipped === 3 && nothing.groups === 1, JSON.stringify(nothing))

// ---- 5. 数据集为空时不触发 ----
const noDataset = await page.evaluate(async () => {
  window.studio.datasetKey.value = ''
  const rep = await window.studio.runBlobGc({ manual: true, dryRun: true, reclaimBytes: 1000 })
  return { lru: rep?.lru ?? null }
})
check('没有当前数据集时不进入 LRU 阶段', noDataset.lru === null || noDataset.lru === undefined)

// ------------------------------------------------------------------
// 6. 生产路径：配额超过 85% 时自动进入 LRU（不靠 reclaimBytes 强制）
// ------------------------------------------------------------------
// 真实配额阈值要写满几个 GB 才能触发，所以把 storage.estimate 换成 95%。
// 这条走的是 `buildLruBudget()` —— 强制入口绕过的东西正是在这里被验。
// 不导入文件：只要把 `framesReloadable` 打开，判定链与真实导入完全一致，
// 而导入 + 逐帧解码会与自动保存的清扫抢时序，测出来的东西反而不稳定。
const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page2 = await ctx2.newPage()
page2.on('pageerror', (e) => consoleErrors.push('pageerror(quota): ' + e.message))
await page2.addInitScript(() => {
  const fake = {
    estimate: async () => ({ usage: 950_000_000, quota: 1_000_000_000 }),
    persist: async () => true,
    persisted: async () => true,
  }
  try {
    Object.defineProperty(navigator, 'storage', { configurable: true, get: () => fake })
  } catch {
    /* 覆盖失败时下面的断言会直接暴露 */
  }
})

await page2.goto(APP + '?data=demo', { waitUntil: 'load' })
await page2.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
// 等启动清扫（mount + 1500ms）先跑完：它按"当前数据集"判定，
// 早于我们把 datasetKey 改到 quota#1 的话，会把刚种下的帧当垃圾删掉
await page2.waitForTimeout(2400)
check(
  '配额替身生效（95%）',
  await page2.evaluate(async () => {
    const est = await navigator.storage.estimate()
    return est.usage / est.quota > 0.9
  }),
)

await page2.evaluate(() => window.studio.persistNow(true))
await ensureDb(page2)
await page2.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result)
  })
  const tx = db.transaction(['blobs', 'session', 'documents', 'docTasks', 'blobUsage'], 'readwrite')
  for (const n of ['blobs', 'session', 'documents', 'docTasks', 'blobUsage']) tx.objectStore(n).clear()
  await new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
  db.close()
})

const QUOTA_DS = 'quota#1'
const quotaEnc = encodeURIComponent(QUOTA_DS)
// 先把当前数据集指向它，再种帧：反过来的话，任何一次并发清扫都会把新帧当孤儿删掉
await page2.evaluate(
  ({ ds }) => {
    window.studio.datasetKey.value = ds
    window.studio.currentFrame.value = 0
    window.studio.framesReloadable.value = true
  },
  { ds: QUOTA_DS },
)
await seedFrames(page2, quotaEnc, FRAMES)
check('可重解码标志已生效', await page2.evaluate(() => window.studio.canEvictFrames() === true))

const beforeQuota = await frameFlags(page2, quotaEnc)
check('配额场景已铺好 8 帧', beforeQuota.every(Boolean), JSON.stringify(beforeQuota))

// 不传 reclaimBytes：走 buildLruBudget()，由 95% 用量自己算出要腾多少
const autoLru = await page2.evaluate(async () => {
  const rep = await window.studio.runBlobGc({ manual: true })
  return {
    groups: rep?.lru?.groups.map((g) => g.frame) ?? null,
    candidates: rep?.lru?.candidates ?? -1,
    status: window.studio.statusText.value,
    audit: window.studio.gcAudit().entries[0] ?? null,
  }
})
check('配额超限时自动进入 LRU（无需强制参数）', (autoLru.groups?.length ?? 0) >= 2, JSON.stringify(autoLru.groups))
check('自动 LRU 只动保护邻域之外的帧', autoLru.groups?.every((f) => f > 2) === true, JSON.stringify(autoLru.groups))
check('候选池只包含可淘汰的 5 帧', autoLru.candidates === 5, String(autoLru.candidates))
check('状态栏说明淘汰', autoLru.status.includes('配额淘汰'), autoLru.status)
check('审计记下淘汰帧数', (autoLru.audit?.lruFrames ?? 0) >= 2, JSON.stringify(autoLru.audit?.lruFrames))

const afterQuota = await frameFlags(page2, quotaEnc)
check('被淘汰的帧确实从库里消失', afterQuota[3] === false && afterQuota[4] === false, JSON.stringify(afterQuota))
check('保护帧仍在', afterQuota[0] && afterQuota[1] && afterQuota[2], JSON.stringify(afterQuota))

// 反向：把"可重解码"关掉（等价于恢复草稿的缓存句柄），同样 95% 配额也不该动一帧
await seedFrames(page2, quotaEnc, FRAMES)
await page2.evaluate(() => {
  window.studio.framesReloadable.value = false
})
check('关闭可重解码后标志为 false', await page2.evaluate(() => window.studio.canEvictFrames() === false))
const frozen = await page2.evaluate(async () => {
  const rep = await window.studio.runBlobGc({ manual: true })
  return { lru: rep?.lru ?? null }
})
check(
  '不可重解码的数据集一帧不删（即使超配额）',
  frozen.lru === null || frozen.lru.keys.length === 0,
  JSON.stringify(frozen.lru),
)
const survivor = await frameFlags(page2, quotaEnc)
check('恢复型会话的缓存完好', survivor.every(Boolean), JSON.stringify(survivor))

await ctx2.close()

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

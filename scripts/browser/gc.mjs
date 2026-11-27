// 浏览器手测：GC 判定矩阵：控制台入口、dryRun、四类判定、启动清扫
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/gc.mjs，或设 APP_URL 指向已起实例
// Edge 手测：控制台入口 studio.runBlobGc() + 真实 IndexedDB 清扫
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const results = []
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
await page.waitForTimeout(2600) // 等启动清扫（1500ms 后触发）

check('window.studio 已挂载', await page.evaluate(() => typeof window.studio === 'object'))
check('runBlobGc 可调用', await page.evaluate(() => typeof window.studio.runBlobGc === 'function'))

// 清库：这支用例断言的是"精确扫到 8 条"，上一次运行留下的键会让计数全错。
// 放在第一次手动清扫之前，顺便把"空库也能跑"一起验了。
await page.evaluate(async () => {
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
await page.waitForTimeout(300)

// ---- 1. 空库/正常库手动清扫 ----
const first = await page.evaluate(async () => {
  const r = await window.studio.runBlobGc({ manual: true })
  return { status: window.studio.statusText.value, hasReport: !!r, scanned: r?.scanned ?? -1 }
})
check('手动清扫返回报告', first.hasReport, JSON.stringify(first))
check('状态栏有反馈', /已回收|已是最简/.test(first.status), first.status)

// ---- 2. 造一批 blob，验证四类判定 ----
const DS = 'test#live'
const seed = await page.evaluate(async (ds) => {
  const enc = encodeURIComponent(ds)
  const entries = [
    [`frames/${enc}/0`, 1000], // 活数据集（草稿指针指向）→ 留
    [`frames/${enc}/1:colors`, 500], // 同上 → 留
    ['frames/dead%23001/0', 2000], // 死数据集 → 删
    ['frames/dead%23001/1:colors', 400], // 死数据集 → 删
    ['payload/deadbeefdeadbeef', 700], // 无人引用的载荷 → 删
    [`${ds}#0`, 300], // 旧键，前缀匹配活数据集 → 留
    ['old-ds#3', 400], // 旧键，匹配不上 → 删
    ['misc/unknown-thing', 100], // 未知命名空间 → 留
  ]
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const tx = db.transaction(['blobs', 'session'], 'readwrite')
  const blobs = tx.objectStore('blobs')
  for (const [key, bytes] of entries) {
    blobs.put({ data: new ArrayBuffer(bytes), bytes, savedAt: Date.now() }, key)
  }
  // 草稿指针：让 GC 知道 frames/test%23live/ 还活着
  tx.objectStore('session').put({ datasetKey: ds, datasetName: '手测数据集', savedAt: Date.now() }, 'draft-meta')
  await new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
  db.close()
  return entries.map(([k]) => k)
}, DS)
check('已写入 8 条测试 blob + 草稿指针', seed.length === 8, seed.join(', '))

const keysNow = () =>
  page.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('point-cloud-label-studio')
      r.onsuccess = () => res(r.result)
      r.onerror = () => rej(r.error)
    })
    const tx = db.transaction(['blobs'], 'readonly')
    const keys = await new Promise((res, rej) => {
      const req = tx.objectStore('blobs').getAllKeys()
      req.onsuccess = () => res(req.result)
      req.onerror = () => rej(req.error)
    })
    db.close()
    return keys.map(String)
  })

// ---- 3. dryRun 不删 ----
const dry = await page.evaluate(async () => {
  const r = await window.studio.runBlobGc({ manual: true, dryRun: true })
  return {
    status: window.studio.statusText.value,
    remove: r?.remove.map((v) => v.key) ?? [],
    released: r?.released ?? -1,
  }
})
const afterDry = await keysNow()
check('dryRun 状态栏是预演文案', /预演/.test(dry.status), dry.status)
check('dryRun 列出应删 4 条', dry.remove.length === 4, JSON.stringify(dry.remove))
check('dryRun released=0', dry.released === 0, String(dry.released))
check('dryRun 一条都没删', afterDry.length === 8, `剩 ${afterDry.length} 条`)

// ---- 4. 真扫 ----
const real = await page.evaluate(async () => {
  const r = await window.studio.runBlobGc({ manual: true })
  const reason = {}
  for (const v of r?.verdicts ?? []) reason[v.key] = `${v.reason}${v.keep ? '/keep' : '/drop'}`
  return {
    status: window.studio.statusText.value,
    released: r?.released ?? -1,
    removeBytes: r?.removeBytes ?? -1,
    reason,
  }
})
const afterReal = await keysNow()
const has = (k) => afterReal.includes(k)
const enc = encodeURIComponent(DS)
check('状态栏报已回收', /已回收/.test(real.status), real.status)
check('release 4 条', real.released === 4, String(real.released))
check('回收字节 = 3500', real.removeBytes === 3500, String(real.removeBytes))
check('活数据集帧保留', has(`frames/${enc}/0`) && has(`frames/${enc}/1:colors`), afterReal.join(' | '))
check('死数据集帧已删', !has('frames/dead%23001/0') && !has('frames/dead%23001/1:colors'))
check('死载荷已删', !has('payload/deadbeefdeadbeef'))
check('旧键活前缀保留', has(`${DS}#0`), real.reason[`${DS}#0`])
check('旧键孤儿已删', !has('old-ds#3'), real.reason['old-ds#3'])
check('未知命名空间保留', has('misc/unknown-thing'), real.reason['misc/unknown-thing'])
check(
  '判定理由齐全',
  real.reason[`frames/dead%23001/0`] === 'evicted-dataset/drop' &&
    real.reason['payload/deadbeefdeadbeef'] === 'dead-payload/drop' &&
    real.reason['misc/unknown-thing'] === 'unknown-kept/keep',
  JSON.stringify(real.reason, null, 1),
)

// ---- 5. 重复清扫幂等 ----
const again = await page.evaluate(async () => {
  const r = await window.studio.runBlobGc({ manual: true })
  return { status: window.studio.statusText.value, released: r?.released ?? -1, scanned: r?.scanned ?? -1 }
})
check('重复清扫无副作用', again.released === 0 && /已是最简/.test(again.status), JSON.stringify(again))

// ---- 6. 切走数据集后，旧帧缓存会被收掉 ----
// 注意：这里显式调 runBlobGc，而不是等"刷新后 1.5s 的启动清扫"。
// 启动清扫与自动保存是两条独立的定时器（1.5s vs 1.2s），机器一忙顺序就会翻，
// 断言会随机失败。切数据集这件事本身是确定的，就用确定的方式验：
//   先等指针真的指向演示序列，再扫，看旧数据集是否被收掉。
// 启动清扫的那条路径由第 7 步（恢复草稿后不清帧缓存）覆盖。
// 离开页面前先落一次盘：`beforeunload` 里也会 persistNow，
// 但它是异步的、会被导航打断，时序不定 —— 先同步存好，导航就没什么可抢救的。
await page.evaluate(() => window.studio.persistNow())
await page.reload({ waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page
  .waitForFunction(
    async () => {
      const ptr = await new Promise((res) => {
        const r = indexedDB.open('point-cloud-label-studio')
        r.onsuccess = () => {
          const q = r.result.transaction(['session'], 'readonly').objectStore('session').get('draft-meta')
          q.onsuccess = () => {
            res(q.result)
            r.result.close()
          }
        }
      })
      return ptr && ptr.datasetKey !== 'test#live'
    },
    null,
    { timeout: 15000 },
  )
  .catch(() => {})
// 等启动清扫（挂载后 1500ms）先跑完再动手。
// 它和手动清扫判的是同一批垃圾：谁先跑谁收，"released>0"就变成看运气 ——
// 实测在快机器上就是启动清扫先收完，手动清扫如实报 0，白白失败一次。
await page.waitForTimeout(2500)
// 再注入一条新垃圾（死数据集的帧键）：此后没有别的清扫会跑（换数据集触发的清扫只在
// 保存路径上），手动清扫要收的就只有它一条 —— 这样"报数是否如实"才是确定的断言。
await page.evaluate(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result)
  })
  const tx = db.transaction(['blobs'], 'readwrite')
  tx.objectStore('blobs').put(
    { data: new ArrayBuffer(256), bytes: 256, savedAt: Date.now() },
    'frames/e2e-dead%23002/0',
  )
  await new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
  db.close()
})
const switched = await page.evaluate(async () => {
  const r = await window.studio.runBlobGc({ manual: true })
  return { released: r?.released ?? -1, status: window.studio.statusText.value }
})
const afterSwitch = await keysNow()
check('切走数据集后旧帧缓存被回收', !afterSwitch.includes(`frames/${enc}/0`), afterSwitch.join(' | '))
check(
  '回收时如实报数',
  switched.released === 1 && !afterSwitch.includes('frames/e2e-dead%23002/0'),
  JSON.stringify(switched),
)

// ---- 7. 恢复草稿后启动清扫必须保住该数据集的帧缓存 ----
// 关键：草稿快照里帧是 lazy 的（真实懒加载导入就是这样），恢复时会重建加载器，
// 启动清扫要能从"当前数据集"这一路认出这些帧还活着。
// 先把当前页存干净，再注入：否则离开页面时 beforeunload 的 persistNow
// 会把刚注入的快照/指针覆盖回演示序列。
await page.evaluate(() => window.studio.persistNow())
await page.evaluate(async (ds) => {
  const enc2 = encodeURIComponent(ds)
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const tx = db.transaction(['blobs', 'session'], 'readwrite')
  const blobs = tx.objectStore('blobs')
  blobs.put({ data: new ArrayBuffer(1000), bytes: 1000, savedAt: Date.now() }, `frames/${enc2}/0`)
  blobs.put({ data: new ArrayBuffer(800), bytes: 800, savedAt: Date.now() }, `frames/${enc2}/1`)
  const empty = { positions: new Float32Array(0), count: 0 }
  tx.objectStore('session').put(
    {
      version: 1,
      savedAt: Date.now(),
      datasetName: '手测数据集',
      datasetKey: ds,
      cloud: null,
      frames: [
        { index: 0, cloud: empty, boxes: [], lazy: true },
        { index: 1, cloud: empty, boxes: [], lazy: true },
      ],
      currentFrame: 0,
      boxes: [],
      categories: [],
    },
    'current',
  )
  tx.objectStore('session').put(
    { datasetKey: ds, datasetName: '手测数据集', savedAt: Date.now(), frameCount: 2 },
    'draft-meta',
  )
  await new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
  db.close()
}, DS)

await page.goto(APP, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(2800)
const restoredGc = await page.evaluate(() => ({
  key: window.studio.datasetKey.value,
  frames: window.studio.frames.value.length,
  hasLoader: !!window.studio.frameLoader.value,
  status: window.studio.statusText.value,
}))
const afterRestore = await keysNow()
check('无 ?data 时按草稿恢复', restoredGc.frames === 2 && restoredGc.key === 'test#live', JSON.stringify(restoredGc))
check(
  '恢复后启动清扫保住帧缓存',
  afterRestore.includes(`frames/${enc}/0`) && afterRestore.includes(`frames/${enc}/1`),
  afterRestore.join(' | '),
)

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

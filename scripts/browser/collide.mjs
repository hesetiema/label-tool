// 浏览器手测：两个同帧数数据集不撞号（sampleId 唯一性）
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/collide.mjs，或设 APP_URL 指向已起实例
// 两个帧数相同的数据集不能共用一份文档（sampleId 撞号会让 A 的框安到 B 上）
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'
import { ensureSequence } from './fixtures.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const A = ensureSequence('A', 21)
const B = ensureSequence('B', 21)
const filesOf = (tag) => (tag === 'A' ? A.files : B.files)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ← ' + detail}`)
}

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
const page = await ctx.newPage()
const errs = []
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message))

const docsNow = () => page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('point-cloud-label-studio')
  r.onsuccess = () => {
    const q = r.result.transaction(['documents'], 'readonly').objectStore('documents').getAll()
    q.onsuccess = () => { res(q.result.map((d) => ({ sampleId: d.sampleId, sceneId: d.sceneId, range: d.range }))); r.result.close() }
    q.onerror = () => { res([]); r.result.close() }
  }
}))

await page.goto(APP, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio)
await page.waitForTimeout(1500)
await page.evaluate(async () => {
  const db = await new Promise((res) => { const r = indexedDB.open('point-cloud-label-studio'); r.onsuccess = () => res(r.result) })
  const tx = db.transaction(['blobs', 'session', 'documents', 'docTasks', 'blobUsage'], 'readwrite')
  for (const n of ['blobs', 'session', 'documents', 'docTasks', 'blobUsage']) tx.objectStore(n).clear()
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  db.close()
})

// A：导入 + 把第一条轨迹裁剪到 2–15
await page.setInputFiles('input[type=file][accept=".pcd"]', filesOf('A'))
await page.waitForFunction(() => /已导入 21 帧|解析失败/.test(window.studio.statusText.value), null, { timeout: 90000 })
await page.evaluate(() => {
  const s = window.studio
  s.setTrackLifecycle(s.doc.value.tasks.boxes.tracks[0].id, 2, 15)
  s.markDirty()
})
await page.waitForFunction(() => window.studio.saveState.value === 'saved', null, { timeout: 30000 })
await page.waitForTimeout(400)
const idA = await page.evaluate(() => window.studio.doc.value.sampleId)
const docsA = await docsNow()

// B：导入另一组 21 帧，同样裁剪但换成 5–12
await page.setInputFiles('input[type=file][accept=".pcd"]', filesOf('B'))
await page.waitForFunction(() => /已导入 21 帧|解析失败/.test(window.studio.statusText.value), null, { timeout: 90000 })
await page.evaluate(() => {
  const s = window.studio
  s.setTrackLifecycle(s.doc.value.tasks.boxes.tracks[0].id, 5, 12)
  s.markDirty()
})
await page.waitForFunction(() => window.studio.saveState.value === 'saved', null, { timeout: 30000 })
await page.waitForTimeout(400)
const idB = await page.evaluate(() => ({ sampleId: window.studio.doc.value.sampleId, key: window.studio.datasetKey.value }))
const docsB = await docsNow()

check('两个数据集的 sampleId 不同', idA !== idB.sampleId, `${idA} vs ${idB.sampleId}`)
check('sampleId 带上了数据集键', idB.sampleId.startsWith(idB.key), idB.sampleId)
check('两份文档同时存在（A 没被覆盖）', docsB.length === 2, JSON.stringify(docsB))
check('A 的文档还在', docsA.some((d) => d.sampleId === idA), docsA.map((d) => d.sampleId).join(' | '))

// 重开：应恢复 B（当前指针），不能拿到 A 的生命周期
await page.goto(APP, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio)
await page.waitForTimeout(2800)
const restored = await page.evaluate(() => ({
  sampleId: window.studio.doc.value?.sampleId,
  lifecycle: { ...window.studio.doc.value.tasks.boxes.tracks[0].lifecycle },
  key: window.studio.datasetKey.value,
  status: window.studio.statusText.value,
}))
check('恢复的是 B 的文档', restored.sampleId === idB.sampleId, JSON.stringify(restored))
check('生命周期是 B 的 5–12（不是 A 的 2–15）',
  restored.lifecycle.first === 5 && restored.lifecycle.last === 12, JSON.stringify(restored.lifecycle))
check('无 console 报错', errs.length === 0, errs.slice(0, 3).join(' || '))

await browser.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

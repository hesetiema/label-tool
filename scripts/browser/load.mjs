// 浏览器手测：懒加载端到端：21 帧导入、逐帧落盘、刷新恢复
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/load.mjs，或设 APP_URL 指向已起实例
// Edge 端到端：21 帧懒加载导入 → 帧缓存落盘 → 刷新按草稿恢复 → GC 保留
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'
import { ensureSequence } from './fixtures.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'

const { files } = ensureSequence('A', 21)

const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

const keysNow = () => page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const tx = db.transaction(['blobs'], 'readonly')
  const keys = await new Promise((res, rej) => {
    const req = tx.objectStore('blobs').getAllKeys()
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error)
  })
  db.close()
  return keys.map(String)
})

await page.goto(APP, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(2000)

// 清掉上一个脚本可能留下的测试指针，保证从干净状态开始
await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const tx = db.transaction(['blobs', 'session', 'documents', 'docTasks', 'blobUsage'], 'readwrite')
  for (const name of ['blobs', 'session', 'documents', 'docTasks']) tx.objectStore(name).clear()
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  db.close()
})

// ---- 1. 21 帧导入（触发懒加载阈值） ----
await page.setInputFiles('input[type=file][accept=".pcd"]', files)
await page.waitForFunction(
  () => /已导入 21 帧|解析失败|请选择/.test(window.studio.statusText.value),
  null, { timeout: 90000 },
)
const afterImport = await page.evaluate(() => ({
  status: window.studio.statusText.value,
  key: window.studio.datasetKey.value,
  frames: window.studio.frames.value.length,
  lazy: window.studio.frames.value.filter((f) => f.lazy).length,
  firstCount: window.studio.frames.value[0]?.cloud.count ?? 0,
}))
check('21 帧导入成功且走懒加载', afterImport.frames === 21 && afterImport.lazy === 20, JSON.stringify(afterImport))
check('数据集键符合 local#file#n', afterImport.key === 'local#000001.pcd#21', afterImport.key)

const enc = encodeURIComponent(afterImport.key)
await page.waitForFunction(
  (k) => new Promise((res) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => {
      const tx = r.result.transaction(['blobs'], 'readonly')
      const req = tx.objectStore('blobs').getAllKeys()
      req.onsuccess = () => { res(req.result.map(String).includes(k)); r.result.close() }
      req.onerror = () => res(false)
    }
    r.onerror = () => res(false)
  }),
  `frames/${enc}/0`, { timeout: 20000 },
).catch(() => {})
const keys1 = await keysNow()
check('首帧点云已按新键落盘', keys1.includes(`frames/${enc}/0`), keys1.join(' | '))
check('帧键用 encodeURIComponent 转义 #', keys1.some((k) => k.startsWith('frames/local%23000001.pcd%2321/')), keys1.join(' | '))

// ---- 2. 翻到第 2 帧，验证按需解码 + 落盘 ----
await page.evaluate(() => window.studio.setFrame(1))
await page.waitForFunction(
  () => window.studio.frames.value[1]?.cloud.count > 0,
  null, { timeout: 30000 },
)
await page.waitForTimeout(1200)
const keys2 = await keysNow()
const frame1 = await page.evaluate(() => window.studio.frames.value[1].cloud.count)
check('第 2 帧已解码', frame1 > 0, String(frame1))
check('第 2 帧点云已落盘', keys2.includes(`frames/${enc}/1`), keys2.filter((k) => k.includes('/1')).join(','))

// ---- 3. 手动 GC 不误删当前数据集 ----
const gc = await page.evaluate(async () => {
  const r = await window.studio.runBlobGc({ manual: true })
  return { status: window.studio.statusText.value, released: r?.released ?? -1, scanned: r?.scanned ?? -1 }
})
const keys3 = await keysNow()
check('GC 后当前数据集帧缓存仍在', keys3.includes(`frames/${enc}/0`) && keys3.includes(`frames/${enc}/1`), JSON.stringify(gc))
check('GC 未误删（released=0）', gc.released === 0, gc.status)

// ---- 4. 等自动保存写完草稿，刷新后恢复 ----
await page.evaluate(() => window.studio.markDirty())
await page.waitForTimeout(2500)
const saved = await page.evaluate(() => ({
  state: window.studio.saveState.value,
  status: window.studio.statusText.value,
}))
check('自动保存完成', saved.state === 'saved', JSON.stringify(saved))

await page.reload({ waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(3000)
const restored = await page.evaluate(() => ({
  key: window.studio.datasetKey.value,
  frames: window.studio.frames.value.length,
  name: window.studio.datasetName.value,
  lazy: window.studio.frames.value.filter((f) => f.lazy).length,
  f0: window.studio.frames.value[0]?.cloud.count ?? 0,
  hasLoader: !!window.studio.frameLoader.value,
  status: window.studio.statusText.value,
}))
check('刷新后草稿恢复 21 帧', restored.frames === 21, JSON.stringify(restored))
check('刷新后首帧点云是真实数据', restored.f0 > 10000, String(restored.f0))
check('刷新后懒加载加载器已重建', restored.hasLoader, String(restored.hasLoader))

// 恢复后翻一帧：应从 IndexedDB 读回，不提示"待解码失败"
await page.evaluate(() => window.studio.setFrame(1))
await page.waitForFunction(() => window.studio.frames.value[1]?.cloud.count > 0, null, { timeout: 20000 })
const restored1 = await page.evaluate(() => window.studio.frames.value[1].cloud.count)
check('刷新后第 2 帧从 IndexedDB 回读成功', restored1 > 10000, String(restored1))

// ---- 5. 换数据集后旧帧缓存被回收 ----
const oldKeys = (await keysNow()).filter((k) => k.startsWith('frames/')).length
await page.evaluate(() => {
  // 直接把指针指到一个不存在的数据集，模拟"用户切走了"
  return new Promise((res) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => {
      const tx = r.result.transaction(['session'], 'readwrite')
      tx.objectStore('session').put({ datasetKey: 'other#set#3', datasetName: '另一个数据集', savedAt: Date.now() }, 'draft-meta')
      tx.oncomplete = () => { r.result.close(); res(true) }
    }
  })
})
const gc2 = await page.evaluate(async () => {
  window.studio.datasetKey.value = 'other#set#3'
  const r = await window.studio.runBlobGc({ manual: true })
  return { status: window.studio.statusText.value, released: r?.released ?? -1, reasons: r?.byReason ?? {} }
})
const keys4 = await keysNow()
const remainFrames = keys4.filter((k) => k.startsWith('frames/'))
check('切数据集后旧帧缓存被清空', remainFrames.length === 0 && oldKeys > 0, `原 ${oldKeys} 条 → 剩 ${remainFrames.length} 条；${gc2.status}`)

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))

await browser.close()
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

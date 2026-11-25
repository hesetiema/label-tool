// 浏览器手测：本地样本列表（浏览 / 删除判定 / 删除落盘 / 跨标签页持有）
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/library.mjs，或设 APP_URL 指向已起实例
//
// 这份用例针对 21.6 的取舍：文档不自动 prune（是真值不是缓存），
// 所以必须验"手动删除这条路真的能删、且删不掉不该删的"。
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const DB = 'point-cloud-label-studio'
const results = []
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail })

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

/** 清库：用例断言精确条数，上一次运行的残留会让计数全错 */
async function wipeDb(p) {
  await p.evaluate(async (name) => {
    const db = await new Promise((res) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => res(r.result)
    })
    const tx = db.transaction(['blobs', 'session', 'documents', 'docTasks', 'blobUsage'], 'readwrite')
    for (const n of ['blobs', 'session', 'documents', 'docTasks', 'blobUsage']) tx.objectStore(n).clear()
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    db.close()
  }, DB)
}

/**
 * 直接往库里造一份"旧文档"。
 *
 * 为什么不用 API 造：`save()` 用的是 `Date.now()`，造不出"三个月前"这种时间戳；
 * 而样本列表存在的意义就是让用户按时间认出旧的。直接写库同时也验证了
 * 读端能吃历史格式的头（这正是升级后第一次打开列表的真实情况）。
 */
async function seedOldDocs(p, list) {
  return p.evaluate(async ({ name, docs }) => {
    const db = await new Promise((res) => {
      const r = indexedDB.open(name)
      r.onsuccess = () => res(r.result)
    })
    const tx = db.transaction(['documents', 'docTasks'], 'readwrite')
    const heads = tx.objectStore('documents')
    const tasks = tx.objectStore('docTasks')
    for (const d of docs) {
      heads.put({
        sampleId: d.sampleId,
        sceneId: d.sceneId,
        range: d.range,
        meta: { version: 1, baseVersion: 0, updatedAt: d.savedAt, updatedBy: 'test', hashes: {} },
        tasks: d.tasks ?? ['boxes'],
        savedAt: d.savedAt,
      }, d.sampleId)
      tasks.put({ tracks: [] }, `${d.sampleId}::boxes`)
    }
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
    db.close()
  }, { name: DB, docs: list })
}

const DAY = 86400_000

await page.goto(APP + '?data=sequence', { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(1200)
await wipeDb(page)
await page.evaluate(() => window.studio.persistNow(true))
await page.waitForTimeout(600)

const current = await page.evaluate(() => window.studio.doc.value?.sampleId ?? '')
check('当前样本已落盘', !!current, current)

// 造两份旧样本：一份 3 天前（带占据段），一份 40 天前
await seedOldDocs(page, [
  { sampleId: 'yard-old#0-199', sceneId: 'yard-old', range: [0, 199], savedAt: Date.now() - 3 * DAY, tasks: ['boxes', 'occupancy'] },
  { sampleId: 'lot-legacy#10-18', sceneId: 'lot-legacy', range: [10, 18], savedAt: Date.now() - 40 * DAY },
])

// ---- 1. 列表读取 ----
const listed = await page.evaluate(async () => {
  await window.studio.openList()
  return {
    open: window.studio.open.value,
    rows: window.studio.rows.value.map((r) => ({
      id: r.sampleId, scene: r.sceneId, cur: r.isCurrent,
      frames: r.frameCount, tasks: r.taskLabels, age: r.ageText,
    })),
    total: window.studio.summary().total,
    error: window.studio.error.value,
  }
})
check('弹层已打开', listed.open)
check('列出全部 3 份文档', listed.total === 3, JSON.stringify(listed.rows.map((r) => r.id)))
check('排序：最新在前', listed.rows[0].cur === true, JSON.stringify(listed.rows))
check('当前样本只标记一个', listed.rows.filter((r) => r.cur).length === 1)
const oldRow = listed.rows.find((r) => r.id === 'yard-old#0-199')
check('读到帧范围', oldRow?.frames === 200, String(oldRow?.frames))
check('读到任务段', oldRow?.tasks.join('/') === '框/占据', oldRow?.tasks.join('/'))
check('相对时间文案', oldRow?.age === '3 天前', String(oldRow?.age))
check('旧样本（>30 天）显示绝对日期', /\d{4}-\d{2}-\d{2}/.test(listed.rows.find((r) => r.id === 'lot-legacy#10-18')?.age ?? ''))
check('打开列表无错误', listed.error === '')

// ---- 2. 当前样本不可删 ----
const refuseCurrent = await page.evaluate(() => {
  const row = window.studio.rows.value.find((r) => r.isCurrent)
  const ok = window.studio.requestRemove(row)
  return { ok, error: window.studio.error.value, pending: window.studio.pendingId.value }
})
check('当前样本拒绝进入删除确认', refuseCurrent.ok === false)
check('拒绝原因说明是当前样本', refuseCurrent.error.includes('当前'), refuseCurrent.error)
check('拒绝时不会留下待确认态', refuseCurrent.pending === '')

// ---- 3. 二次确认：第一次只标记，第二次才删 ----
const armed = await page.evaluate(() => {
  const row = window.studio.rows.value.find((r) => r.sampleId === 'yard-old#0-199')
  const ok = window.studio.requestRemove(row)
  return { ok, pending: window.studio.pendingId.value, still: window.studio.rows.value.length }
})
check('可删样本进入待确认', armed.ok && armed.pending === 'yard-old#0-199')
check('待确认阶段还没删', armed.still === 3)

const cancelled = await page.evaluate(() => {
  window.studio.cancelRemove()
  return { pending: window.studio.pendingId.value, still: window.studio.rows.value.length }
})
check('取消后退出待确认', cancelled.pending === '')
check('取消不改变列表', cancelled.still === 3)

const removed = await page.evaluate(async () => {
  const row = window.studio.rows.value.find((r) => r.sampleId === 'yard-old#0-199')
  window.studio.requestRemove(row)
  const ok = await window.studio.confirmRemove('yard-old#0-199')
  // 直接从库里查，而不是信列表：删没删要看存储
  const db = await new Promise((res) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result)
  })
  const tx = db.transaction(['documents', 'docTasks'], 'readonly')
  const head = await new Promise((res) => {
    const r = tx.objectStore('documents').get('yard-old#0-199')
    r.onsuccess = () => res(r.result)
  })
  const seg = await new Promise((res) => {
    const r = tx.objectStore('docTasks').get('yard-old#0-199::boxes')
    r.onsuccess = () => res(r.result)
  })
  db.close()
  return {
    ok,
    headGone: head === undefined,
    segGone: seg === undefined,
    rows: window.studio.rows.value.map((r) => r.sampleId),
    status: window.studio.statusText.value,
    error: window.studio.error.value,
  }
})
check('确认后删除成功', removed.ok === true, removed.error)
check('文档头已从库中消失', removed.headGone)
check('任务段一起清掉（不留孤儿）', removed.segGone)
check('列表立刻减少一行', removed.rows.length === 2 && !removed.rows.includes('yard-old#0-199'), JSON.stringify(removed.rows))
check('状态栏报出删除结果', removed.status.includes('已删除'), removed.status)

// ---- 4. 另一个标签页持有的样本不能删 ----
const pageB = await ctx.newPage()
pageB.on('pageerror', (e) => consoleErrors.push('pageerror(B): ' + e.message))
await pageB.goto(APP + '?data=demo', { waitUntil: 'load' })
await pageB.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await pageB.waitForTimeout(500)
const holder = await pageB.evaluate(async () => {
  await window.studio.tabBus.claim('lot-legacy#10-18')
  return window.studio.tabBus.tabId
})

const lockedTry = await page.evaluate(async () => {
  await window.studio.refresh()
  const row = window.studio.rows.value.find((r) => r.sampleId === 'lot-legacy#10-18')
  const ok = window.studio.requestRemove(row)
  return { ok, error: window.studio.error.value, rows: window.studio.rows.value.length }
})
check('对端持有租约时拒绝删除', lockedTry.ok === false, JSON.stringify(lockedTry))
check('拒绝原因指出持有者', lockedTry.error.includes(holder), `${lockedTry.error} / ${holder}`)
check('拒绝时不改变列表', lockedTry.rows === 2)

await pageB.evaluate(() => window.studio.tabBus.release())
const unlocked = await page.evaluate(() => {
  const row = window.studio.rows.value.find((r) => r.sampleId === 'lot-legacy#10-18')
  return { ok: window.studio.requestRemove(row), pending: window.studio.pendingId.value }
})
check('对端释放后可以删', unlocked.ok && unlocked.pending === 'lot-legacy#10-18')
await page.evaluate(() => window.studio.cancelRemove())
await pageB.close()

// ---- 5. 新标签页看到的列表是库里的真值 ----
const pageC = await ctx.newPage()
pageC.on('pageerror', (e) => consoleErrors.push('pageerror(C): ' + e.message))
await pageC.goto(APP, { waitUntil: 'load' })
await pageC.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await pageC.waitForTimeout(800)
const fresh = await pageC.evaluate(async () => {
  await window.studio.openList()
  return {
    rows: window.studio.rows.value.map((r) => ({ id: r.sampleId, cur: r.isCurrent })),
    error: window.studio.error.value,
  }
})
check('新标签页看到删除后的结果', fresh.rows.length === 2 && !fresh.rows.some((r) => r.id === 'yard-old#0-199'),
  JSON.stringify(fresh.rows))
check('删除结果跨标签页一致（不是内存里的假象）', fresh.rows.some((r) => r.id === 'lot-legacy#10-18'))
await pageC.close()

// ---- 6. 弹层关闭 ----
const closed = await page.evaluate(() => {
  window.studio.closeList()
  return { open: window.studio.open.value, error: window.studio.error.value }
})
check('关闭弹层并清掉错误', closed.open === false && closed.error === '')

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

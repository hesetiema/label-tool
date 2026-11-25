// 浏览器手测：跨标签页协调（租约只读 / 接管 / 引用广播 / 回收审计）
// 运行：pnpm dev（另一终端）+ node scripts/browser/crosstab.mjs
//
// 这支用例必须开两个真标签页：localStorage / BroadcastChannel / Web Locks
// 的行为（后台节流、跨页广播、同源共享）在 Node 里一个都测不到。
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ← ' + detail}`)
}

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })

const errorsOf = (page) => {
  const list = []
  page.on('console', (m) => { if (m.type() === 'error') list.push(m.text()) })
  page.on('pageerror', (e) => list.push('pageerror: ' + e.message))
  return list
}

const pageA = await ctx.newPage()
const errorsA = errorsOf(pageA)

// 清库 + 清 localStorage：上一次运行留下的租约/presence 会让"谁是持有者"直接错
await pageA.goto(APP, { waitUntil: 'load' })
await pageA.evaluate(async () => {
  localStorage.clear()
  const db = await new Promise((res) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result)
  })
  const tx = db.transaction(['blobs', 'session', 'documents', 'docTasks', 'blobUsage'], 'readwrite')
  for (const n of ['blobs', 'session', 'documents', 'docTasks', 'blobUsage']) tx.objectStore(n).clear()
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error) })
  db.close()
})

// A 用 5 帧演示序列：有 doc / 有 sampleId，且不需要选文件
await pageA.goto(APP + '?data=sequence', { waitUntil: 'load' })
await pageA.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
// 等自动保存落地（1200ms 防抖）+ 启动清扫（1500ms）
await pageA.waitForTimeout(2800)

const stateA = await pageA.evaluate(() => ({
  sampleId: window.studio.doc.value?.sampleId ?? '',
  readOnly: window.studio.readOnly.value,
  saveState: window.studio.saveState.value,
  tabId: window.studio.tabBus.tabId,
  lease: window.studio.doc.value ? window.studio.tabBus.leaseOf(window.studio.doc.value.sampleId) : null,
  supported: window.studio.tabBus.supported,
}))
check('A 有文档与 sampleId', !!stateA.sampleId, JSON.stringify(stateA))
check('A 拿到写权（租约持有者是自己）',
  stateA.lease?.tabId === stateA.tabId, JSON.stringify(stateA.lease))
check('A 不是只读', stateA.readOnly === false && stateA.saveState !== 'readonly', stateA.saveState)

// ---- 第二个标签页：同一样本，应转只读 ----
const pageB = await ctx.newPage()
const errorsB = errorsOf(pageB)
await pageB.goto(APP, { waitUntil: 'load' })
await pageB.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await pageB.waitForFunction(() => window.studio.frames.value.length > 1, null, { timeout: 15000 })
await pageB.waitForTimeout(600)

const stateB = await pageB.evaluate(() => ({
  sampleId: window.studio.doc.value?.sampleId ?? '',
  readOnly: window.studio.readOnly.value,
  saveState: window.studio.saveState.value,
  note: window.studio.readOnlyNote.value,
  holder: window.studio.doc.value ? window.studio.tabBus.leaseOf(window.studio.doc.value.sampleId)?.tabId : '',
  tabId: window.studio.tabBus.tabId,
}))
check('B 恢复的是同一份样本', stateB.sampleId === stateA.sampleId, `${stateB.sampleId} vs ${stateA.sampleId}`)
check('B 转只读', stateB.readOnly === true, JSON.stringify(stateB))
check('B 的租约持有者是 A', stateB.holder === stateA.tabId, `${stateB.holder} vs ${stateA.tabId}`)
check('B 的保存状态是 readonly', stateB.saveState === 'readonly', stateB.saveState)
check('B 状态栏有只读 chip', (await pageB.locator('.status-chip.readonly').count()) === 1)

// 只读必须真的挡住编辑：走 mutate 这条唯一入口
const editBlocked = await pageB.evaluate(() => {
  const before = window.studio.boxes.value.length
  window.studio.mutate('跨标签页探针', () => { window.studio.boxes.value = [] })
  const after = window.studio.boxes.value.length
  // 撤销入口也要挡：否则"看一眼再撤销"就能改坏文档
  const undo = window.studio.doUndo()
  return { before, after, undoReturned: undo !== undefined, status: window.studio.statusText.value }
})
check('只读时 mutate 不生效', editBlocked.after === editBlocked.before, JSON.stringify(editBlocked))
check('只读时提示可见', /只读/.test(editBlocked.status), editBlocked.status)

// 只读页的自动保存必须一声不响地跳过，而不是覆盖对方的文档
const saveSkipped = await pageB.evaluate(async () => {
  await window.studio.persistNow(true)
  return { saveState: window.studio.saveState.value, status: window.studio.statusText.value }
})
check('只读时手动保存被跳过', saveSkipped.saveState === 'readonly', JSON.stringify(saveSkipped))
check('只读时保存提示说明原因', /只读/.test(saveSkipped.status), saveSkipped.status)

// ---- 引用广播：对端能报出自己开着什么 ----
const refsFromB = await pageB.evaluate(async () => {
  const r = await window.studio.tabBus.collectPeerRefs(400)
  return { responders: r.responders, sampleIds: r.sampleIds, payloads: r.payloadRefs.length, supported: r.supported }
})
// B 自己也在广播范围内，所以至少 1 个响应（A 的应答可能因为 A 在后台而稍慢）
check('广播通道可用', refsFromB.supported === true, JSON.stringify(refsFromB))
check('收到对端样本 id', refsFromB.sampleIds.includes(stateA.sampleId), JSON.stringify(refsFromB))

const peersSeen = await pageB.evaluate(() => window.studio.tabBus.peers().map((p) => p.tabId))
check('presence 能看到 A', peersSeen.includes(stateA.tabId), peersSeen.join(','))

// ---- 接管：B 抢回写权，A 收到通知转只读 ----
const takeover = await pageB.evaluate(() => window.studio.takeoverScene())
check('B 接管成功', takeover === true, String(takeover))
check('接管后 B 可写', (await pageB.evaluate(() => window.studio.readOnly.value)) === false)
await pageA.waitForFunction(() => window.studio.readOnly.value === true, null, { timeout: 4000 }).catch(() => {})
const stateAAfter = await pageA.evaluate(() => ({
  readOnly: window.studio.readOnly.value,
  saveState: window.studio.saveState.value,
  note: window.studio.readOnlyNote.value,
  chip: !!document.querySelector('.status-chip.readonly'),
}))
check('A 收到夺权通知转只读', stateAAfter.readOnly === true, JSON.stringify(stateAAfter))
check('A 的保存状态同步', stateAAfter.saveState === 'readonly', stateAAfter.saveState)
check('A 状态栏出现只读 chip', stateAAfter.chip === true)

// ---- 回收审计：谁在什么时候删了多少 ----
// 启动清扫（mount+1500ms）可能正跑着，重入会返回 null；轮询等它让开
const runGc = async (opts) => {
  for (let i = 0; i < 12; i++) {
    const r = await pageB.evaluate(async (o) => {
      const rep = await window.studio.runBlobGc(o)
      if (!rep) return null
      const { entries, summary } = window.studio.gcAudit()
      return { released: rep.released, peers: rep.peers, top: entries[0] ?? null, summary }
    }, opts)
    if (r) return r
    await pageB.waitForTimeout(300)
  }
  return null
}
const ran = await runGc({ manual: true, trigger: 'manual' })
const audit = ran ?? { released: -1, peers: -1, top: null, summary: { byTab: [] } }
check('清扫报告带对端数', audit.peers >= 1, `peers=${audit.peers}`)
check('审计记下这次清扫', !!audit.top && audit.top.trigger === 'manual' && audit.top.at > 0, JSON.stringify(audit.top))
check('审计按标签页归集', audit.summary.byTab.some((t) => t.tabId === stateB.tabId), JSON.stringify(audit.summary.byTab))
check('dryRun 也进审计', (await runGc({ manual: true, dryRun: true }))?.top?.dryRun === true)

// ---- 刷新不自杀：写者 F5 之后必须还能写 ----
// 旧实现换页会换 tabId，于是"6 秒前的自己"成了租约持有者，刷新后直接变只读。
await pageB.reload({ waitUntil: 'load' })
await pageB.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await pageB.waitForTimeout(2200)
const afterReload = await pageB.evaluate(() => ({
  readOnly: window.studio.readOnly.value,
  saveState: window.studio.saveState.value,
  sampleId: window.studio.doc.value?.sampleId ?? '',
}))
check('刷新后仍是同一份样本', afterReload.sampleId === stateA.sampleId, afterReload.sampleId)
check('刷新后仍可写（tabId 会随 sessionStorage 延续）',
  afterReload.readOnly === false && afterReload.saveState !== 'readonly', JSON.stringify(afterReload))

check('A 无 console 报错', errorsA.length === 0, errorsA.slice(0, 5).join(' || '))
check('B 无 console 报错', errorsB.length === 0, errorsB.slice(0, 5).join(' || '))

await browser.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

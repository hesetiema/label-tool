// 浏览器手测：doc-first 恢复：点云外置、生命周期保真、只剩文档、清草稿
// 运行：pnpm dev --port 5199（另一终端）+ node scripts/browser/docfirst.mjs，或设 APP_URL 指向已起实例
// Edge 端到端：doc-first 恢复 + 点云外置（spill）
// 21 帧懒加载导入 → 改生命周期 → 保存 → 刷新 → 生命周期仍在、点云按需回读
import { loadPlaywright, LAUNCH_OPTS } from './_pw.mjs'
import { ensureSequence } from './fixtures.mjs'

const { chromium } = await loadPlaywright()

const APP = process.env.APP_URL || 'http://127.0.0.1:5199/'

const { files } = ensureSequence('A', 21)

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : '  ← ' + detail}`)
}

const browser = await chromium.launch(LAUNCH_OPTS)
const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
const page = await ctx.newPage()
const consoleErrors = []
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text())
})
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message))

const dbRead = (store, key) =>
  page.evaluate(
    ([st, k]) =>
      new Promise((res) => {
        const r = indexedDB.open('point-cloud-label-studio')
        r.onsuccess = () => {
          const tx = r.result.transaction([st], 'readonly')
          const req = tx.objectStore(st).get(k)
          req.onsuccess = () => {
            res(req.result ?? null)
            r.result.close()
          }
          req.onerror = () => {
            res(null)
            r.result.close()
          }
        }
        r.onerror = () => res(null)
      }),
    [store, key],
  )

await page.goto(APP, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(1500)

await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('point-cloud-label-studio')
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  })
  const tx = db.transaction(['blobs', 'session', 'documents', 'docTasks', 'blobUsage'], 'readwrite')
  for (const name of ['blobs', 'session', 'documents', 'docTasks']) tx.objectStore(name).clear()
  await new Promise((res, rej) => {
    tx.oncomplete = res
    tx.onerror = () => rej(tx.error)
  })
  db.close()
})

// ---- 1. 导入 21 帧，翻到第 4 帧 ----
await page.setInputFiles('input[type=file][data-role="cloud-input"]', files)
await page.waitForFunction(() => /已导入 21 帧|解析失败/.test(window.studio.statusText.value), null, { timeout: 90000 })
await page.evaluate(() => window.studio.setFrame(3))
await page.waitForFunction(() => window.studio.frames.value[3]?.cloud.count > 0, null, { timeout: 30000 })
await page.waitForTimeout(1500)

// ---- 2. 改一条轨迹的生命周期（模拟拖拽结果），再补一个关键帧 ----
const editInfo = await page.evaluate(() => {
  const s = window.studio
  const first = s.doc.value.tasks.boxes.tracks[0]
  s.setTrackLifecycle(first.id, 2, 15)
  s.addKeyframeAt(first.id, 9)
  return {
    id: first.id,
    lifecycle: { ...s.doc.value.tasks.boxes.tracks[0].lifecycle },
    keyframes: s.doc.value.tasks.boxes.tracks[0].keyframes.length,
    tracks: s.doc.value.tasks.boxes.tracks.length,
  }
})
check(
  '生命周期已裁剪到 2–15',
  editInfo.lifecycle.first === 2 && editInfo.lifecycle.last === 15,
  JSON.stringify(editInfo.lifecycle),
)

// ---- 3. 保存后检查快照与指针 ----
await page.evaluate(() => window.studio.markDirty())
await page.waitForFunction(() => window.studio.saveState.value === 'saved', null, { timeout: 30000 })
await page.waitForTimeout(600)

const snapshot = await dbRead('session', 'current')
const pointer = await dbRead('session', 'draft-meta')
const withCloud = snapshot.frames.filter((f) => f.cloud && f.cloud.count > 0).map((f) => f.index)
check('快照标记为点云外置', snapshot.cloudMode === 'spill', String(snapshot.cloudMode))
check('快照只留封面帧与当前帧', withCloud.join(',') === '0,3', withCloud.join(','))
check(
  '其余帧标 lazy 且点云为空',
  snapshot.frames.filter((f) => f.lazy).length === 19 && snapshot.frames.filter((f) => !f.lazy).length === 2,
  `${snapshot.frames.filter((f) => f.lazy).length} lazy`,
)
check(
  '快照带 sampleId',
  typeof snapshot.sampleId === 'string' && snapshot.sampleId.length > 0,
  String(snapshot.sampleId),
)
check(
  '指针带 sampleId 与帧数',
  pointer.sampleId === snapshot.sampleId && pointer.frameCount === 21,
  JSON.stringify(pointer),
)
// 注意不能用 JSON.stringify 量：TypedArray 会被展开成 {"0":..,"1":..}，体积虚高十几倍
const snapBytes = snapshot.frames.reduce(
  (n, f) => n + (f.cloud?.positions?.byteLength ?? 0) + (f.cloud?.colors?.byteLength ?? 0),
  0,
)
check(
  '快照只承担两帧点云（全量内联约 50MB）',
  snapBytes > 0 && snapBytes < 8 * 1024 * 1024,
  `${(snapBytes / 1048576).toFixed(1)}MB`,
)

// ---- 4. 刷新：doc-first 恢复 ----
await page.reload({ waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(3000)

const after = await page.evaluate(() => {
  const s = window.studio
  const t = s.doc.value.tasks.boxes.tracks[0]
  return {
    status: s.statusText.value,
    frames: s.frames.value.length,
    lazy: s.frames.value.filter((f) => f.lazy).length,
    f0: s.frames.value[0]?.cloud.count ?? 0,
    f3: s.frames.value[3]?.cloud.count ?? 0,
    lifecycle: { ...t.lifecycle },
    keyframes: t.keyframes.length,
    tracks: s.doc.value.tasks.boxes.tracks.length,
    current: s.currentFrame.value,
    key: s.datasetKey.value,
    docVersion: s.docVersion.value,
  }
})
check('刷新后帧数恢复 21', after.frames === 21, JSON.stringify(after))
check(
  '生命周期原样保留（v1 快照恢复不出来）',
  after.lifecycle.first === 2 && after.lifecycle.last === 15,
  JSON.stringify(after.lifecycle),
)
check('关键帧数量保留', after.keyframes === editInfo.keyframes, `${after.keyframes} vs ${editInfo.keyframes}`)
check('轨迹数量保留', after.tracks === editInfo.tracks, `${after.tracks} vs ${editInfo.tracks}`)
check('当前帧回到第 4 帧', after.current === 3, String(after.current))
check('封面帧点云真实', after.f0 > 10000, String(after.f0))
check('当前帧点云真实', after.f3 > 10000, String(after.f3))
check('帧缓存键恢复', after.key === 'local#000001.pcd#21', after.key)
check('状态栏说明是文档恢复', /已恢复.*个框/.test(after.status), after.status)

// ---- 5. 从没解码过的帧：如实提示未缓存（而不是空场景） ----
await page.evaluate(() => window.studio.setFrame(1))
await page.waitForTimeout(1800)
const miss = await page.evaluate(() => ({
  status: window.studio.statusText.value,
  count: window.studio.frames.value[1]?.cloud.count ?? -1,
}))
check('从没解码过的帧提示未缓存', /未缓存/.test(miss.status) && miss.count === 0, `${miss.count} · ${miss.status}`)

// 预取过的帧（第 3 帧 → 预取 2/4）应从 IndexedDB 回读
await page.evaluate(() => window.studio.setFrame(2))
await page.waitForFunction(() => window.studio.frames.value[2]?.cloud.count > 0, null, { timeout: 30000 })
const readBack = await page.evaluate(() => window.studio.frames.value[2].cloud.count)
check('预取过的帧从 IndexedDB 回读成功', readBack > 10000, String(readBack))

// ---- 6. 恢复后编辑仍能存住（文档与历史都正常） ----
// 这一步只看"改完能存"：改动本身由下面的 edit3 在刷新之后回来核对
await page.evaluate(() => {
  const s = window.studio
  const id = s.doc.value.tasks.boxes.tracks[0].id
  s.setTrackLifecycle(id, 5, 12)
})
await page.evaluate(() => window.studio.markDirty())
await page.waitForFunction(() => window.studio.saveState.value === 'saved', null, { timeout: 30000 })
await page.reload({ waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(2600)
const edit3 = await page.evaluate(() => ({
  lifecycle: { ...window.studio.doc.value.tasks.boxes.tracks[0].lifecycle },
  status: window.studio.statusText.value,
}))
check('二次编辑后刷新仍是 5–12', edit3.lifecycle.first === 5 && edit3.lifecycle.last === 12, JSON.stringify(edit3))

// ---- 6.5 只剩文档（快照丢失）：按文档 range 展开，点云从帧缓存回读 ----
await page.evaluate(
  () =>
    new Promise((res, rej) => {
      const r = indexedDB.open('point-cloud-label-studio')
      r.onsuccess = () => {
        const tx = r.result.transaction(['session'], 'readwrite')
        tx.objectStore('session').delete('current')
        tx.oncomplete = () => {
          r.result.close()
          res(true)
        }
        tx.onerror = () => {
          r.result.close()
          rej(tx.error)
        }
      }
    }),
)
await page.goto(APP, { waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio)
await page.waitForTimeout(3000)
const orphan = await page.evaluate(() => ({
  frames: window.studio.frames.value.length,
  lifecycle: { ...window.studio.doc.value.tasks.boxes.tracks[0].lifecycle },
  f0: window.studio.frames.value[0]?.cloud.count ?? 0,
  key: window.studio.datasetKey.value,
  status: window.studio.statusText.value,
}))
check('快照丢失时按文档 range 展开 21 帧', orphan.frames === 21, JSON.stringify({ ...orphan, status: undefined }))
check(
  '仅剩文档时生命周期仍在',
  orphan.lifecycle.first === 5 && orphan.lifecycle.last === 12,
  JSON.stringify(orphan.lifecycle),
)
check('首帧点云从帧缓存异步回读', orphan.f0 > 10000, String(orphan.f0))
check('数据集键从指针恢复', orphan.key === 'local#000001.pcd#21', orphan.key)

// ---- 7. 清除草稿：文档也必须消失，否则刷新后框会复活 ----
const cleared = await page.evaluate(async () => {
  await window.studio.clearDraft()
  return { state: window.studio.saveState.value, status: window.studio.statusText.value }
})
check('清除草稿成功', /已清除/.test(cleared.status), cleared.status)
const afterClear = await page.evaluate(
  () =>
    new Promise((res) => {
      const r = indexedDB.open('point-cloud-label-studio')
      r.onsuccess = () => {
        const tx = r.result.transaction(['documents', 'session'], 'readonly')
        const a = tx.objectStore('documents').getAllKeys()
        const b = tx.objectStore('session').getAllKeys()
        let docs = null,
          sess = null
        const done = () => {
          if (docs && sess) {
            res({ docs, sess })
            r.result.close()
          }
        }
        a.onsuccess = () => {
          docs = a.result
          done()
        }
        b.onsuccess = () => {
          sess = b.result
          done()
        }
      }
    }),
)
check(
  '清除后文档与草稿都不在了',
  afterClear.docs.length === 0 && afterClear.sess.length === 0,
  JSON.stringify(afterClear),
)

await page.reload({ waitUntil: 'load' })
await page.waitForFunction(() => !!window.studio, null, { timeout: 30000 })
await page.waitForTimeout(2000)
const fresh = await page.evaluate(() => ({
  status: window.studio.statusText.value,
  tracks: window.studio.doc.value?.tasks.boxes.tracks.length ?? -1,
  name: window.studio.datasetName.value,
}))
check('清除后刷新不再恢复旧标注', !/已恢复/.test(fresh.status), JSON.stringify(fresh))

check('页面无 console 报错', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' || '))

await browser.close()
const failed = results.filter((r) => !r.ok)
for (const r of results) console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '  ← ' + r.detail}`)
console.log(`\n===== ${results.length - failed.length} 通过, ${failed.length} 失败 =====`)
process.exit(failed.length ? 1 : 0)

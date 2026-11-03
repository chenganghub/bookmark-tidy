#!/usr/bin/env node
// 二期离线校准（accept K1）：定「收藏即整理」自动放进目录的把握下限。
// 临时 Chrome 配置 + 真实书签副本 + 真实 DeepSeek：先跑一期的抓取、写说明、生成方案、应用，
// 再把整理后每条书签当成新收藏，让二期的同一套逻辑（后台的 suggest，不给当前文件夹、不读标签页、不带正文片段）给建议，
// 和方案里的位置比，按把握分段算准确率，取「阈值以上准确率 ≥ 85%」的最低阈值。
// 用法：DEEPSEEK_API_KEY=… node tools/e2e/calibrate.mjs --bookmarks <Bookmarks 文件> [--ext .output/chrome-mv3-e2e] [--out 目录]
// 真实配置一个字节不动：书签文件只复制进临时目录。证据里只有 id、目录路径和数字，没有标题和网址。
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launch } from './browser.mjs'

const { values } = parseArgs({
  options: {
    bookmarks: { type: 'string' },
    ext: { type: 'string', default: '.output/chrome-mv3-e2e' },
    out: { type: 'string', default: path.join(process.env.TEMP || '.', 'bt-e2e') },
    target: { type: 'string', default: '0.85' }
  }
})
const KEY = process.env.DEEPSEEK_API_KEY || ''
if (!values.bookmarks || !KEY) {
  console.error('要 --bookmarks <书签文件> 和环境变量 DEEPSEEK_API_KEY')
  process.exit(2)
}
const TARGET = Number(values.target)
fs.mkdirSync(values.out, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const W = (body) => `(async () => { const w = window.__bt.workflow; ${body} })()`

const browser = await launch({ extPath: values.ext, bookmarksFile: values.bookmarks })
const evidence = { startedAt: new Date().toISOString(), version: browser.version }
let code = 0
try {
  const page = await browser.open('manager.html')
  await page.waitFor('!!window.__bt?.state?.ready', 30000)
  await page.evaluate(W(`await w.saveSettings({ ai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: ${JSON.stringify(KEY)}, disableThinking: true } }); return true`))
  // 自动整理先关掉：应用过程中不让它插手（校准只用 suggest，不动书签）
  await page.evaluate(W(`await w.saveSettings({ autoFile: false }); return true`))

  // ---- 一期：抓取 → 说明 → 方案 → 应用
  const t0 = Date.now()
  await page.evaluate(W(`const p = await w.planFetch(); const r = w.startFetch(p, () => {}); await r.done; return true`), 15 * 60000)
  console.log(`抓取完成，${Math.round((Date.now() - t0) / 1000)} 秒`)
  const d = await page.evaluate(W(`const r = await w.describe(() => {}); return { failed: r.failedIds.length, usage: r.usage, cost: w.estimateCost(r.usage) }`), 30 * 60000)
  console.log(`说明完成：没写成 ${d.failed} 条，约 $${d.cost.toFixed(4)}`)
  const p = await page.evaluate(
    W(`const s = await w.getSettings(); const { flat } = await w.loadTree()
    const bar = flat.roots.find((r) => r.rootType === 'bookmarks-bar')
    const locked = s.lockedFolderIds.length ? s.lockedFolderIds : flat.folders.filter((f) => f.parentId === bar.id && s.defaultLockedNames.includes(f.title)).map((f) => f.id)
    const options = { maxTop: s.maxTop, emoji: s.emoji, ruleTitles: s.ruleTitles, lockedFolderIds: locked, keepLooseBarItems: s.keepLooseBarItems }
    const r = await w.buildPlan(options, () => {})
    const log = await w.apply(r.plan, () => {})
    return { status: log.status, usage: r.usage, cost: w.estimateCost(r.usage), locked }`),
    30 * 60000
  )
  console.log(`方案并应用：${p.status}，约 $${p.cost.toFixed(4)}`)
  evidence.phase1 = { describeCost: d.cost, planCost: p.cost, applyStatus: p.status }

  // ---- 整理后的位置：书签栏下、不在锁定文件夹里、不是散放的
  const items = await page.evaluate(
    W(`const { flat } = await w.loadTree()
    const bar = flat.roots.find((r) => r.rootType === 'bookmarks-bar')
    const locked = new Set(${JSON.stringify(p.locked)})
    const seg = (t) => t.replace(/\\//g, '／').trim()
    return flat.bookmarks
      .filter((b) => b.rootId === bar.id && b.depth > 1 && b.depth <= 3 && !b.folderIds.some((id) => locked.has(id)) && /^https?:/i.test(b.url))
      .map((b) => ({ id: b.id, actual: b.path.map(seg).join('/') }))`)
  )
  console.log(`参与校准 ${items.length} 条，开始逐条问建议`)

  // ---- 逐条问 A 的建议（后台 suggest，并发 6）
  const rows = []
  let next = 0
  let n = 0
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++]
      let r
      for (let attempt = 0; attempt < 2 && !r; attempt++) {
        const res = await page.evaluate(`chrome.runtime.sendMessage({ type: 'e2e:suggest', bookmarkId: ${JSON.stringify(it.id)} })`, 120000).catch(() => null)
        r = res?.ok ? res.value : undefined
        if (!r) await sleep(1000)
      }
      rows.push({ ...it, predicted: r?.path ?? null, confidence: r?.confidence ?? null })
      if (++n % 50 === 0) console.log(`  ${n} / ${items.length}`)
    }
  }
  const t1 = Date.now()
  await Promise.all(Array.from({ length: 6 }, worker))
  evidence.suggestSeconds = Math.round((Date.now() - t1) / 1000)

  // ---- 分段统计
  const answered = rows.filter((r) => r.confidence !== null)
  const correct = (r) => r.predicted === r.actual
  const buckets = [
    [0.9, 1.01],
    [0.8, 0.9],
    [0.7, 0.8],
    [0.6, 0.7],
    [0, 0.6]
  ].map(([lo, hi]) => {
    const xs = answered.filter((r) => r.confidence >= lo && r.confidence < hi)
    return { range: `[${lo}, ${Math.min(hi, 1)}${hi > 1 ? ']' : ')'}`, n: xs.length, correct: xs.filter(correct).length, accuracy: xs.length ? +(xs.filter(correct).length / xs.length).toFixed(3) : null }
  })
  // 候选阈值从 0.5 起：AI 自己给的把握不到一半，等于它认为更可能放错。只看「阈值以上」的总一致率会被大量高把握的条目
  // 带着，把低把握的也放进去，因此按把握分段单独核对。
  const thresholds = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95].map((t) => {
    const xs = answered.filter((r) => r.confidence >= t)
    return { threshold: t, covered: xs.length, coverage: +(xs.length / rows.length).toFixed(3), accuracy: xs.length ? +(xs.filter(correct).length / xs.length).toFixed(3) : null }
  })
  const chosen = thresholds.find((x) => x.accuracy !== null && x.accuracy >= TARGET && x.covered >= 30)
  Object.assign(evidence, {
    total: rows.length,
    answered: answered.length,
    overallAccuracy: +(answered.filter(correct).length / Math.max(1, answered.length)).toFixed(3),
    buckets,
    thresholds,
    target: TARGET,
    chosen: chosen ?? null,
    rows
  })
  console.log('分段：')
  for (const b of buckets) console.log(`  ${b.range}：${b.n} 条，对 ${b.correct}，准确率 ${b.accuracy}`)
  console.log('阈值：')
  for (const t of thresholds) console.log(`  ≥ ${t.threshold}：覆盖 ${t.covered} 条（${(t.coverage * 100).toFixed(1)}%），准确率 ${t.accuracy}`)
  console.log(chosen ? `选定阈值 ${chosen.threshold}：阈值以上 ${chosen.covered} 条，准确率 ${chosen.accuracy}` : `没有哪个阈值能到 ${TARGET}`)
  if (!chosen) code = 1
} catch (e) {
  code = 1
  console.error(e)
  evidence.error = e instanceof Error ? e.message : String(e)
} finally {
  await browser.close()
}
evidence.finishedAt = new Date().toISOString()
const file = path.join(values.out, `calibrate-${Date.now()}.json`)
fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
console.log(`证据：${file}`)
process.exit(code)

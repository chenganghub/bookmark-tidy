#!/usr/bin/env node
// 真实端到端验证：accept 里要真浏览器、真网络、真 DeepSeek 的部分（A1 A2 B1 B3 C1–C4 D1–D5 E1 E3–E8 F2 F3）。
// 在临时 Chrome 配置里装 e2e 构建，放一份真实书签文件的副本；真实配置一个字节都不碰。
// 跑完删掉临时配置（里面有书签副本、网页信息和 API key）。
// 终端只打印数字和是否通过，不打印书签标题和网址；证据另存 JSON（同样只有数字和 AI 设计的目录名）。
//
// 用法：npm run build && npm run build:e2e
//       node tools/e2e/real-run.mjs --bookmarks "<Chrome 配置目录>\Bookmarks" [--ext .output/chrome-mv3-e2e] [--no-ai] [--out <证据目录>]
// 真调 DeepSeek 要环境变量 DEEPSEEK_API_KEY：只经 CDP 管道写进临时配置，不打印。

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { launch, redact } from './browser.mjs'
import { startServer } from './server.mjs'

const { values } = parseArgs({
  options: {
    bookmarks: { type: 'string' },
    ext: { type: 'string', default: '.output/chrome-mv3-e2e' },
    'no-ai': { type: 'boolean', default: false },
    out: { type: 'string', default: path.join(os.tmpdir(), 'bt-e2e') }
  }
})
if (!values.bookmarks) {
  console.error('用法：node tools/e2e/real-run.mjs --bookmarks <Bookmarks 文件> [--ext .output/chrome-mv3-e2e] [--no-ai] [--out <目录>]')
  process.exit(2)
}

const KEY = values['no-ai'] ? '' : process.env.DEEPSEEK_API_KEY || ''
const KEY8 = KEY.slice(0, 8)
const safe = (s) => {
  let t = redact(String(s))
  if (KEY) t = t.split(KEY).join('***')
  if (KEY8) t = t.split(KEY8).join('***')
  return t
}

// ---------------------------------------------------------------- 记录

const results = []
const evidence = { startedAt: new Date().toISOString() }
function record(id, ok, detail = '', data) {
  results.push({ id, ok, detail: safe(detail) })
  if (data !== undefined) evidence[id] = data
  console.log(`${ok ? '✓' : '✗'} ${id} ${safe(detail)}`)
}
const info = (s) => console.log(`  ${safe(s)}`)

// ---------------------------------------------------------------- 书签树指纹（id、parentId、index、title、url）

const TREE = `new Promise((r) => chrome.bookmarks.getTree((t) => { const out = []; const walk = (n, p) => { out.push([n.id, p ?? null, n.index ?? null, n.title, n.url ?? null]); for (const c of n.children || []) walk(c, n.id) }; for (const x of t) walk(x); r(out) }))`
/** 和顺序无关的指纹：去掉根节点 0，按 id 排序后取 sha256 */
const fingerprint = (tuples) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(tuples.filter((t) => t[0] !== '0').map((t) => t.map((v) => (v === undefined ? null : v))).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))))
    .digest('hex')
    .slice(0, 16)
const byId = (tuples) => new Map(tuples.map((t) => [t[0], t]))

/** 节点的路径：[根 id, 文件夹名…]（不含它自己） */
function pathOf(map, id) {
  const names = []
  let p = map.get(id)?.[1]
  while (p && map.get(p)?.[1] && map.get(p)[1] !== '0') {
    names.unshift(map.get(p)[3])
    p = map.get(p)[1]
  }
  return [p, ...names]
}

function countInFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  let n = 0
  const walk = (x) => {
    if (x.type === 'url') n++
    for (const c of x.children || []) walk(c)
  }
  for (const root of Object.values(data.roots || {})) if (root && typeof root === 'object') walk(root)
  return n
}

function diffPaths(a, b, prefix = '') {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix]
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix]
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  return [...keys].flatMap((k) => diffPaths(a[k], b[k], prefix ? `${prefix}.${k}` : k))
}

// ---------------------------------------------------------------- 页面里用的片段

/** 包一层：页面里拿到 workflow（w）和界面状态（st） */
const W = (body) => `(async () => { const w = window.__bt.workflow; const st = window.__bt.state; ${body} })()`

/** 锁定的文件夹和里面的书签（和 effectiveLockedIds 同一规则） */
const LOCKED = `(async (w) => {
  const s = await w.getSettings()
  const { flat } = await w.loadTree()
  const bar = flat.roots.find((r) => r.rootType === 'bookmarks-bar')
  const other = flat.roots.find((r) => r.rootType === 'other')
  const ids = s.lockedFolderIds.length ? s.lockedFolderIds : flat.folders.filter((f) => f.parentId === bar.id && s.defaultLockedNames.includes(f.title)).map((f) => f.id)
  const inLocked = (b) => b.folderIds.some((id) => ids.includes(id))
  const bms = flat.bookmarks.filter(inLocked)
  // 锁定文件夹外面也有同标题 / 同网址的副本时，那份副本本来就会发出去，不算泄露
  const outside = flat.bookmarks.filter((b) => !inLocked(b))
  const outTitles = new Set(outside.map((b) => b.title.trim()))
  const outUrls = new Set(outside.map((b) => b.url))
  const names = flat.folders.filter((f) => ids.includes(f.id)).map((f) => f.title)
  return {
    ids, names, bookmarkIds: bms.map((b) => b.id),
    titles: bms.map((b) => b.title.trim()).filter((t) => !outTitles.has(t)),
    urls: bms.map((b) => b.url).filter((u) => !outUrls.has(u)),
    barId: bar.id, otherId: other.id
  }
})`

/** 记下页面发出的请求：AI 请求的请求体（有没有 Authorization 头），网页请求的并发和 credentials */
const PATCH_FETCH = `(() => {
  if (window.__net) return true
  const net = (window.__net = { ai: [], inflight: 0, maxInflight: 0, pages: 0, credentials: [] })
  const orig = window.fetch.bind(window)
  window.fetch = async (input, init = {}) => {
    const url = String(input instanceof Request ? input.url : input)
    const isAi = url.endsWith('/chat/completions')
    if (isAi) net.ai.push({ body: String(init.body || ''), auth: !!(init.headers && (init.headers.Authorization || init.headers.authorization)) })
    else {
      net.pages++
      net.inflight++
      net.maxInflight = Math.max(net.maxInflight, net.inflight)
      if (!net.credentials.includes(String(init.credentials))) net.credentials.push(String(init.credentials))
    }
    try {
      return await orig(input, init)
    } finally {
      if (!isAi) net.inflight--
    }
  }
  return true
})()`

const READY = 'window.__bt && document.querySelector(".content .grid, .content .list, .content .stats, .content .panel, .content .empty")'
/**
 * 无头 Chrome 的 UA 和 Client Hints 带 HeadlessChrome，不少网站因此直接回 403。
 * 抓网页的页面换成普通桌面 Chrome 的 UA（和用户自己的浏览器一样），抓取结果才接近真实情况。
 */
async function useDesktopUA(page, version) {
  const major = /Chrome\/(\d+)/.exec(version)?.[1] || '156'
  await page.send('Emulation.setUserAgentOverride', {
    userAgent: `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
    acceptLanguage: 'zh-CN,zh;q=0.9',
    platform: 'Win32',
    userAgentMetadata: {
      brands: [
        { brand: 'Google Chrome', version: major },
        { brand: 'Chromium', version: major },
        { brand: 'Not=A?Brand', version: '24' }
      ],
      platform: 'Windows',
      platformVersion: '10.0.0',
      architecture: 'x86',
      model: '',
      mobile: false
    }
  })
}

/** 点文字等于 text 的按钮；找不到就抛错（免得后面空等到超时） */
async function click(page, sel, text) {
  const ok = await page.evaluate(`(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find((x) => x.textContent.trim() === ${JSON.stringify(text)}); if (!b) return false; b.click(); return true })()`)
  if (!ok) throw new Error(`找不到按钮「${text}」（${sel}）`)
}

/** 等页面里的异步任务（window[name].result / .error），每 15 秒打印一次进度 */
async function waitTask(page, name, timeoutMs, progressExpr) {
  const deadline = Date.now() + timeoutMs
  let lastPrint = 0
  for (;;) {
    const s = await page.evaluate(`(() => { const t = window.${name}; return t ? { done: !!t.result, error: t.error || '', progress: ${progressExpr} } : null })()`)
    if (s?.done) return
    if (s?.error) throw new Error(`${name} 出错：${s.error}`)
    if (Date.now() > deadline) throw new Error(`${name} 超时（${Math.round(timeoutMs / 60000)} 分钟）`)
    if (Date.now() - lastPrint > 15000) {
      lastPrint = Date.now()
      if (s?.progress) info(s.progress)
    }
    await sleep(1000)
  }
}

// ---------------------------------------------------------------- 开始

fs.mkdirSync(values.out, { recursive: true })
const consoleTexts = []
const watchConsole = (page) => page.on('Runtime.consoleAPICalled', (p) => consoleTexts.push(p.args.map((a) => (a.value === undefined ? a.description || '' : String(a.value))).join(' ')))

// A2：正式构建的 manifest（e2e 构建为了自动化多给了全部网址权限，不算）。
// 二期（bookmark-auto accept P1）在一期的三个之外只多 scripting、notifications、alarms、unlimitedStorage 和地址栏关键字 s，主机权限不变
const PERMISSIONS = ['alarms', 'bookmarks', 'favicon', 'notifications', 'scripting', 'storage', 'unlimitedStorage']
const manifest = JSON.parse(fs.readFileSync('.output/chrome-mv3/manifest.json', 'utf8'))
{
  const m = manifest
  const ok =
    JSON.stringify([...m.permissions].sort()) === JSON.stringify(PERMISSIONS) &&
    JSON.stringify(m.host_permissions) === JSON.stringify(['https://api.deepseek.com/*']) &&
    JSON.stringify([...(m.optional_host_permissions || [])].sort()) === JSON.stringify(['http://*/*', 'https://*/*']) &&
    m.omnibox?.keyword === 's'
  // 详情里不写网址：redact 会把网址连同后面的字一起换掉
  record('A2', ok, `必需权限 ${m.permissions.join('、')}；必需主机权限 ${m.host_permissions.length} 条（DeepSeek 接口）；可选主机权限 ${(m.optional_host_permissions || []).length} 条（http、https 全部网址）；地址栏关键字「${m.omnibox?.keyword ?? ''}」`)
}

const expectedTotal = countInFile(values.bookmarks)
const server = await startServer()
const browser = await launch({ extPath: values.ext, bookmarksFile: values.bookmarks })
let exitCode = 0
try {
  info(`${browser.version}，扩展 ${browser.extId}`)
  const page = await browser.open('manager.html')
  watchConsole(page)
  await useDesktopUA(page, browser.version)
  await page.waitFor(READY, 30000)
  await sleep(500)

  // ---------------------------------------------------------------- A1
  {
    const shown = Number(await page.evaluate(`document.querySelector('.sidebar .side-row .n')?.textContent.trim()`))
    // 后台 service worker 起来了；二期起点工具栏图标打开弹窗（manifest 的 default_popup），弹窗底部的「管理页」打开管理页
    const { targetInfos } = await browser.cdp.send('Target.getTargets')
    const sw = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${browser.extId}/`))
    const popupFile = manifest.action?.default_popup ?? ''
    const pop = await browser.open(popupFile || 'popup.html')
    const hasManagerLink = await pop
      .waitFor(`[...document.querySelectorAll('.pop-foot button')].some((b) => b.textContent.trim() === '管理页')`, 15000)
      .then(() => true, () => false)
    await pop.close?.().catch(() => {})
    record('A1', shown === expectedTotal && !!sw && popupFile === 'popup.html' && hasManagerLink,
      `管理页显示书签 ${shown}，书签文件里 ${expectedTotal}；后台 service worker ${sw ? '在跑' : '没找到'}；点工具栏图标打开的是「${popupFile}」，弹窗里有「管理页」：${hasManagerLink}`)
  }

  // ---------------------------------------------------------------- B1：体检数字和命令行工具对账
  {
    const ext = await page.evaluate(W('return await w.audit()'))
    const tool = JSON.parse(execFileSync(process.execPath, ['tools/audit-bookmarks.mjs', '--json', values.bookmarks], { encoding: 'utf8' }))
    delete tool.file
    const diffs = diffPaths(tool, ext.summary)
    const s = ext.summary
    record(
      'B1',
      diffs.length === 0,
      diffs.length ? `不一致的字段：${diffs.join('、')}` : `整份汇总一致：书签 ${s.bookmarks}、文件夹 ${s.folders}、空文件夹 ${s.folderIssues.empty}、同名嵌套 ${s.folderIssues.nestedSameName}、默认名 ${s.folderIssues.defaultName}、重复 ${s.duplicates.normalized.groups} 组、消息数前缀 ${s.titles.messagePrefix}、站名后缀 ${s.titles.siteSuffix}、可清理标题 ${s.titles.cleanable}、冷门 ${s.usage.cold}`,
      { diffs, summary: { bookmarks: s.bookmarks, folders: s.folders, cleanable: s.titles.cleanable, cold: s.usage.cold, duplicateGroups: s.duplicates.normalized.groups } }
    )
  }

  // ---------------------------------------------------------------- B3：打开体检页、浏览页没有对外请求
  {
    const net = await browser.newPage()
    const external = []
    net.on('Network.requestWillBeSent', (p) => {
      if (!/^(chrome-extension|data|blob|about|chrome):/.test(p.request.url)) external.push(p.request.url)
    })
    await net.send('Network.enable')
    await net.goto(`chrome-extension://${browser.extId}/manager.html?view=audit`)
    await net.waitFor('document.querySelector(".stats .stat")', 20000)
    await sleep(2000)
    await net.goto(`chrome-extension://${browser.extId}/manager.html`)
    await net.waitFor('document.querySelector(".content .grid")', 20000)
    await sleep(3000)
    record('B3', external.length === 0, `体检页和浏览页的对外请求 ${external.length} 个`)
    await net.close()
  }

  // ---------------------------------------------------------------- E1 基准
  const fp0 = fingerprint(await page.evaluate(TREE))
  evidence.fp0 = fp0

  // ---------------------------------------------------------------- C1 C3 C4：真抓网页
  await page.evaluate(PATCH_FETCH)
  {
    const p = await page.evaluate(
      W(`const p = await w.planFetch(); window.__plan = p
      const by = {}; for (const s of p.skipped) by[s.reason] = (by[s.reason] || 0) + s.bookmarkIds.length
      return { urls: p.toFetch.length, bookmarks: p.toFetch.reduce((s, x) => s + x.bookmarkIds.length, 0), cached: p.cached.length, skipped: by }`)
    )
    const skippedTotal = Object.values(p.skipped).reduce((a, b) => a + b, 0)
    record('C1', p.urls > 0 && p.bookmarks + skippedTotal === expectedTotal, `将抓取 ${p.urls} 个网址（${p.bookmarks} 条书签），跳过 ${skippedTotal} 条：${Object.entries(p.skipped).map(([k, n]) => `${k} ${n}`).join('、')}`, p)

    await page.evaluate(
      W(`window.__fetch = { maxRunning: 0, last: null, result: null, error: '', t0: performance.now(), t1: 0, pausedMs: 0 }
      const run = w.startFetch(window.__plan, (x) => { window.__fetch.last = x; window.__fetch.maxRunning = Math.max(window.__fetch.maxRunning, x.running) })
      window.__run = run
      run.done.then((x) => { window.__fetch.result = x; window.__fetch.t1 = performance.now() })
      return true`)
    )
    // C4：抓到 30 条时暂停 4 秒：暂停期间不再开新的请求（已开始的 = 完成 + 进行中，不变）
    await page.waitFor('window.__fetch.result || (window.__fetch.last && window.__fetch.last.done >= 30)', 180000)
    const pause = await page.evaluate(`(async () => {
      const f = window.__fetch
      if (f.result) return { skipped: true }
      window.__run.pause()
      const t = performance.now()
      const started = (x) => x.done + x.running
      const a = started(window.__run.progress())
      await new Promise((r) => setTimeout(r, 4000))
      const pausedFlag = window.__run.progress().paused
      const b = started(window.__run.progress())
      window.__run.resume()
      f.pausedMs = performance.now() - t
      const done0 = window.__run.progress().done
      await new Promise((r) => setTimeout(r, 3000))
      return { a, b, pausedFlag, resumedMoved: window.__run.progress().done > done0 || !!f.result }
    })()`)
    if (pause.skipped) record('C4', false, '抓得太快，没来得及测暂停')
    else record('C4', pause.a === pause.b && pause.pausedFlag && pause.resumedMoved, `暂停后已开始的请求 ${pause.a} → ${pause.b}（不变才对），继续后有进展：${pause.resumedMoved}；进度回调带 完成数 / 总数 / 失败数`)

    await waitTask(page, '__fetch', 10 * 60000, `t.last ? '抓取 ' + t.last.done + ' / ' + t.last.total + '，失败 ' + t.last.failed : ''`)
    const r = await page.evaluate(
      W(`const f = window.__fetch; const infos = await w.getPageInfos()
      const status = {}; let missing = 0
      for (const t of window.__plan.toFetch) { const i = infos[t.url]; if (!i) missing++; else status[i.status] = (status[i.status] || 0) + 1 }
      return { total: f.result.total, done: f.result.done, failed: f.result.failed, maxRunning: f.maxRunning, maxInflight: window.__net.maxInflight, credentials: window.__net.credentials, seconds: Math.round((f.t1 - f.t0 - f.pausedMs) / 1000), status, missing }`)
    )
    evidence.fetch = r
    info(`抓完 ${r.done} / ${r.total}，失败 ${r.failed}，用时 ${r.seconds} 秒（不含暂停）；状态：${Object.entries(r.status).map(([k, n]) => `${k} ${n}`).join('、')}`)
    record('C1-status', r.missing === 0 && r.done === r.total, `每个抓取的网址都有状态（缺 ${r.missing}）`)
    record('C3-concurrency', r.maxRunning <= 6 && r.maxInflight <= 6, `最大并发：队列 ${r.maxRunning}、实际请求 ${r.maxInflight}（≤ 6）；fetch 的 credentials：${r.credentials.join('、')}`)
    record('C3-time', r.seconds <= 180, `用时 ${r.seconds} 秒（≤ 180）`)

    // C3 缓存：关掉页面再开一个，7 天内抓过的不重抓
    const p2 = await browser.open('manager.html')
    await p2.waitFor(READY, 30000)
    const again = await p2.evaluate(W('const p = await w.planFetch(); return { toFetch: p.toFetch.length, cached: p.cached.length }'))
    record('C3-cache', again.toFetch === 0 && again.cached === p.urls, `重新打开后：要抓 ${again.toFetch}，用缓存 ${again.cached}`)

    // F3：浏览页筛选的数量和体检、抓取结果一致
    await p2.goto(`chrome-extension://${browser.extId}/manager.html`)
    await p2.waitFor(READY, 30000)
    await sleep(500)
    const f3 = await p2.evaluate(
      W(`const { issues } = await w.audit(); const infos = await w.getPageInfos(); const { flat } = await w.loadTree()
      const st2 = (b) => infos[b.url]?.status
      const want = {
        冷门: issues.cold.length,
        重复: new Set(issues.duplicateGroups.flatMap((g) => g.slice(1))).size,
        要登录: flat.bookmarks.filter((b) => st2(b) === 'login').length,
        失效: flat.bookmarks.filter((b) => ['dead', 'unreachable'].includes(st2(b))).length
      }
      const chips = Object.fromEntries([...document.querySelectorAll('.view-tools .chip')].map((c) => [c.childNodes[0].textContent.trim(), Number(c.querySelector('.n').textContent)]))
      return { want, chips }`)
    )
    const f3ok = Object.entries(f3.want).every(([k, n]) => (f3.chips[k] ?? 0) === n)
    record('F3', f3ok, `筛选：${Object.entries(f3.want).map(([k, n]) => `${k} ${f3.chips[k] ?? 0}/${n}`).join('、')}（界面/预期）`, f3)
    await p2.close()
  }

  // ---------------------------------------------------------------- C2：抓网页不带 Cookie
  // 用 127.0.0.1：Chrome 不会把回环地址交给系统代理，本机开着代理也测得到
  {
    const base = `http://127.0.0.1:${server.port}`
    await browser.cdp.send('Storage.setCookies', { cookies: [{ name: 'bt_e2e', value: 'should-not-be-sent', url: `${base}/` }] })
    const control = await page.evaluate(`fetch(${JSON.stringify(`${base}/control`)}, { credentials: 'include' }).then((r) => r.status).catch((e) => String(e))`)
    await page.evaluate(W(`const r = w.startFetch({ toFetch: [{ url: ${JSON.stringify(`${base}/c2`)}, bookmarkIds: [] }], cached: [], skipped: [] }, () => {}); await r.done; return true`))
    const c = server.requests.find((x) => x.path === '/control')
    const t = server.requests.find((x) => x.path === '/c2')
    record(
      'C2',
      !!t && !t.headers.cookie,
      `抓取请求${t ? '' : '没到服务器，'}带 Cookie：${!!t?.headers.cookie}；对照请求（credentials: include，状态 ${control}）带 Cookie：${!!c?.headers.cookie}`
    )
  }

  // ---------------------------------------------------------------- D：真调 DeepSeek
  if (!KEY) {
    console.log('没有 DEEPSEEK_API_KEY（或给了 --no-ai），跳过 D 和 E')
  } else {
    await page.evaluate(W(`await w.saveSettings({ ai: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', apiKey: ${JSON.stringify(KEY)}, disableThinking: true } }); return true`))
    const t = await page.evaluate(W('return await w.testAi()'))
    record('D0', t.ok, `测试连接：${t.message}`)
    if (!t.ok) throw new Error('DeepSeek 连不上，后面的 AI 步骤不跑了')

    // 第一段：说明
    await page.evaluate(
      W(`window.__desc = { last: null, result: null, error: '', t0: performance.now() }
      w.describe((p) => (window.__desc.last = p)).then((r) => { window.__desc.result = r; window.__desc.t1 = performance.now() }, (e) => { window.__desc.error = String((e && e.message) || e) })
      return true`)
    )
    await waitTask(page, '__desc', 30 * 60000, `t.last ? '说明 ' + t.last.doneBatches + ' / ' + t.last.totalBatches + ' 批' : ''`)
    const d1 = await page.evaluate(
      W(`const L = await (${LOCKED})(w); const { flat } = await w.loadTree(); const meta = await w.getMeta()
      const target = flat.bookmarks.filter((b) => (b.rootId === L.barId || b.rootId === L.otherId) && !L.bookmarkIds.includes(b.id))
      const isGood = (b) => { const m = meta[b.id]; return !!m && !!m.desc && [...m.desc].length <= 40 && m.tags.length >= 1 && m.tags.length <= 3 }
      const good = target.filter(isGood)
      const r = window.__desc.result
      return {
        target: target.length, good: good.length, withDesc: target.filter((b) => meta[b.id]?.desc).length,
        lockedWithMeta: L.bookmarkIds.filter((id) => meta[id]).length, locked: L.bookmarkIds.length, failed: r.failedIds.length,
        // 逐条判定用：分母、锁定、不合格的书签 id（只有 id，不含标题网址）
        ids: { target: target.map((b) => b.id), locked: L.bookmarkIds, notGood: target.filter((b) => !isGood(b)).map((b) => b.id), failed: r.failedIds },
        usage: r.usage, cost: w.estimateCost(r.usage), seconds: Math.round((window.__desc.t1 - window.__desc.t0) / 1000)
      }`)
    )
    evidence.describe = d1
    const pct = (d1.good / d1.target) * 100
    record('D1', pct >= 95 && d1.lockedWithMeta === 0, `${d1.good} / ${d1.target} 条（${pct.toFixed(1)}%）有 ≤ 40 字说明和 1～3 个标签；没写成 ${d1.failed} 条；锁定的 ${d1.locked} 条里有说明的 ${d1.lockedWithMeta} 条；用时 ${d1.seconds} 秒`)
    record('D4-describe', d1.usage.promptTokens > 0, `说明：${d1.usage.requests} 次请求，输入 ${d1.usage.promptTokens} token（缓存命中 ${d1.usage.cacheHitTokens}），输出 ${d1.usage.completionTokens} token，按高峰价约 $${d1.cost.toFixed(4)}`)

    // 第二、三段：目录和归类，生成方案
    await page.evaluate(
      W(`const L = await (${LOCKED})(w); const s = await w.getSettings()
      const options = { maxTop: s.maxTop, emoji: s.emoji, ruleTitles: s.ruleTitles, lockedFolderIds: L.ids, keepLooseBarItems: s.keepLooseBarItems }
      window.__planRun = { last: null, result: null, error: '', t0: performance.now() }
      w.buildPlan(options, (p) => (window.__planRun.last = p)).then((r) => { window.__planRun.result = r; window.__planRun.t1 = performance.now() }, (e) => { window.__planRun.error = String((e && e.message) || e) })
      return true`)
    )
    await waitTask(page, '__planRun', 30 * 60000, `t.last ? t.last.stage + ' ' + t.last.doneBatches + ' / ' + t.last.totalBatches + ' 批' : ''`)
    const d5 = await page.evaluate(
      W(`const r = window.__planRun.result; const plan = r.plan; const L = await (${LOCKED})(w)
      const counts = {}; for (const it of plan.items) if (it.enabled) counts[it.target] = (counts[it.target] || 0) + 1
      const leaves = plan.folders.flatMap((f) => (f.children.length ? f.children.map((c) => c.key) : [f.key]))
      const sizes = leaves.map((k) => counts[k] || 0)
      return {
        top: plan.folders.length, maxTop: plan.options.maxTop,
        deep: plan.folders.some((f) => f.children.some((c) => c.children && c.children.length)),
        leaves: leaves.length, leafMin: Math.min(...sizes), leafMax: Math.max(...sizes), outOfRange: sizes.filter((n) => n < 3 || n > 40).length,
        items: plan.items.length, inbox: counts.inbox || 0, cleanup: counts.cleanup || 0,
        lowConf: plan.items.filter((i) => i.reason === 'low-confidence').length,
        lowConfElsewhere: plan.items.filter((i) => (i.reason === 'low-confidence' || i.reason === 'not-in-tree') && i.target !== 'inbox').length,
        lockedInPlan: plan.items.filter((i) => L.bookmarkIds.includes(i.bookmarkId)).length,
        lockedNameAsFolder: plan.folders.some((f) => L.names.includes(f.name)),
        folders: plan.folders.map((f) => (f.children.length ? f.name + '（' + f.children.map((c) => c.name + ' ' + (counts[c.key] || 0)).join('、') + '）' : f.name + ' ' + (counts[f.key] || 0))),
        issues: r.issues, usage: r.usage, cost: w.estimateCost(r.usage), seconds: Math.round((window.__planRun.t1 - window.__planRun.t0) / 1000)
      }`)
    )
    evidence.plan = d5
    info(`方案：顶层 ${d5.top} 个 → ${d5.folders.join('；')}`)
    info(`待整理 ${d5.inbox}、待清理 ${d5.cleanup}、低置信度 ${d5.lowConf}；提示 ${d5.issues.length} 条${d5.issues.length ? '：' + d5.issues.slice(0, 6).join('；') : ''}`)
    record(
      'D5',
      d5.top <= d5.maxTop && !d5.deep && d5.outOfRange === 0 && d5.lowConfElsewhere === 0 && d5.lockedInPlan === 0 && !d5.lockedNameAsFolder,
      `顶层 ${d5.top}（≤ ${d5.maxTop}），两层以内：${!d5.deep}，末级 ${d5.leaves} 个、每个 ${d5.leafMin}～${d5.leafMax} 条（超出 3～40 的 ${d5.outOfRange} 个），低置信度不在待整理的 ${d5.lowConfElsewhere} 条，锁定的进方案 ${d5.lockedInPlan} 条`
    )
    record('D4-plan', d5.usage.promptTokens > 0, `目录 + 归类：${d5.usage.requests} 次请求，输入 ${d5.usage.promptTokens} token，输出 ${d5.usage.completionTokens} token，约 $${d5.cost.toFixed(4)}；用时 ${d5.seconds} 秒`)

    // D2：检查真实发给 DeepSeek 的每个请求体
    {
      const bodies = await page.evaluate('window.__net.ai')
      const L = await page.evaluate(W(`return await (${LOCKED})(w)`))
      const lockedIds = new Set(L.bookmarkIds)
      const lockedTitles = L.titles.map((x) => x.trim()).filter((x) => [...x].length >= 6)
      const lockedPaths = L.urls
        .map((u) => {
          try {
            const x = new URL(u)
            return x.pathname.length > 6 ? x.hostname.replace(/^www\./, '') + x.pathname : ''
          } catch {
            return ''
          }
        })
        .filter(Boolean)
      const out = { requests: bodies.length, describe: 0, taxonomy: 0, classify: 0, split: 0, maxDescribe: 0, maxClassify: 0, badLines: 0, urlWithQuery: 0, longDesc: 0, lockedIds: 0, lockedTitles: 0, lockedUrls: 0, lockedPathField: 0, emails: 0, phones: 0, tokens: 0, keyInBody: 0, noAuth: 0, extraKeys: 0, thinkingOff: 0 }
      const ALLOWED = new Set(['model', 'messages', 'response_format', 'temperature', 'stream', 'thinking'])
      for (const r of bodies) {
        if (!r.auth) out.noAuth++
        if (r.body.includes(KEY) || r.body.includes(KEY8)) out.keyInBody++
        const body = JSON.parse(r.body)
        if (Object.keys(body).some((k) => !ALLOWED.has(k))) out.extraKeys++
        if (body.thinking?.type === 'disabled') out.thinkingOff++
        const [sys, user] = body.messages.map((m) => m.content)
        const lines = user.split('\n').slice(1)
        const kind = sys.includes('desc：一句话说明')
          ? 'describe'
          : sys.includes('重新设计')
            ? 'taxonomy'
            : sys.includes('更细的目录')
              ? 'split'
              : sys.includes('放进最合适的一个目录')
                ? 'classify'
                : 'other'
        if (kind !== 'other') out[kind]++
        for (const line of lines) {
          const f = line.split(' | ')
          if (kind === 'describe') {
            if (f.length !== 5) out.badLines++
            if (/[?#]/.test(f[2] || '')) out.urlWithQuery++
            if ([...(f[3] || '')].length > 200) out.longDesc++
            if (lockedIds.has(f[0])) out.lockedIds++
            if (L.names.some((n) => (f[4] || '').split('/').includes(n))) out.lockedPathField++
          } else if (kind === 'classify') {
            if (f.length !== 5) out.badLines++
            if (lockedIds.has(f[0])) out.lockedIds++
          } else if (kind === 'split') {
            if (f.length !== 4) out.badLines++
            if (lockedIds.has(f[0])) out.lockedIds++
          } else if (kind === 'taxonomy') {
            if (f.length !== 4) out.badLines++
            if (L.names.some((n) => (f[3] || '').split('/').includes(n))) out.lockedPathField++
          }
        }
        if (kind === 'describe') out.maxDescribe = Math.max(out.maxDescribe, lines.length)
        if (kind === 'classify') out.maxClassify = Math.max(out.maxClassify, lines.length)
        out.lockedTitles += lockedTitles.filter((x) => user.includes(x)).length
        out.lockedUrls += lockedPaths.filter((x) => user.includes(x)).length
        out.emails += (user.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).length
        out.phones += (user.match(/(?<!\d)1[3-9]\d{9}(?!\d)/g) || []).length
        out.tokens += (user.match(/[A-Za-z0-9_]{24,}/g) || []).filter((x) => /[A-Za-z]/.test(x) && /\d/.test(x)).length
      }
      out.lockedNameInAny = bodies.filter((r) => L.names.some((n) => r.body.includes(n))).length
      evidence.requests = out
      const ok =
        out.requests === out.describe + out.taxonomy + out.classify + out.split + 1 && // +1 是测试连接
        out.maxDescribe <= 40 && out.maxClassify <= 80 && out.badLines === 0 && out.urlWithQuery === 0 && out.longDesc === 0 &&
        out.lockedIds === 0 && out.lockedTitles === 0 && out.lockedUrls === 0 && out.lockedPathField === 0 &&
        out.emails === 0 && out.phones === 0 && out.tokens === 0 && out.keyInBody === 0 && out.noAuth === 0 && out.extraKeys === 0
      record(
        'D2',
        ok,
        `${out.requests} 个请求（说明 ${out.describe}、目录 ${out.taxonomy}、归类 ${out.classify}、拆分 ${out.split}、测试 1）；每批最多 说明 ${out.maxDescribe} 条 / 归类 ${out.maxClassify} 条；格式不对 ${out.badLines} 行；网址带参数 ${out.urlWithQuery}；简介超 200 字 ${out.longDesc}；锁定书签的 id ${out.lockedIds} / 标题 ${out.lockedTitles} / 网址 ${out.lockedUrls} / 路径 ${out.lockedPathField}；邮箱 ${out.emails}、手机号 ${out.phones}、长随机串 ${out.tokens}；请求体里有 key ${out.keyInBody}；没带 Authorization ${out.noAuth}；多余字段 ${out.extraKeys}；关思考 ${out.thinkingOff}/${out.requests}`
      )
      info(`锁定文件夹的名字出现在请求里：${out.lockedNameInAny} 个请求（锁定书签本身不出现才是硬要求；名字可能出现在别处书签的标题里）`)
    }

    // E1：抓网页、写说明、生成方案都不改书签树
    const fp1 = fingerprint(await page.evaluate(TREE))
    record('E1', fp1 === fp0, `生成方案前后书签树指纹 ${fp0} / ${fp1}`)

    // F2：用说明里才有的中文词搜索
    {
      await page.goto(`chrome-extension://${browser.extId}/manager.html`)
      await page.waitFor(READY, 30000)
      await page.evaluate(PATCH_FETCH)
      const f2 = await page.evaluate(
        W(`const { flat } = await w.loadTree(); const meta = await w.getMeta()
        const hay = flat.bookmarks.map((b) => (b.title + ' ' + b.url).toLowerCase()).join('\\n')
        const freq = new Map()
        for (const m of Object.values(meta)) { const d = m.desc || ''; const seen = new Set(); for (let i = 0; i + 2 <= d.length; i++) { const x = d.slice(i, i + 2); if (/^[\\u4e00-\\u9fff]{2}$/.test(x) && !hay.includes(x) && !seen.has(x)) { seen.add(x); freq.set(x, (freq.get(x) || 0) + 1) } } }
        const word = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
        if (!word) return { word: false }
        st.query = word
        await new Promise((r) => setTimeout(r, 400))
        const count = Number(document.querySelector('.view-count').textContent)
        const ms = window.__btSearchMs
        st.query = ''
        return { word: true, expected: freq.get(word), count, ms, total: flat.bookmarks.length }`)
      )
      record('F2', f2.word && f2.count >= f2.expected && f2.ms < 100, `说明里才有的词：搜到 ${f2.count} 条（说明里含它的 ${f2.expected} 条），过滤 ${f2.ms?.toFixed(2)} ms（${f2.total} 条，< 100 ms）`)
    }

    // ---------------------------------------------------------------- E：应用、撤销（第 1 轮走界面）
    // E8：生成方案后在 Chrome 里又移动了一条
    const victim = await page.evaluate(
      W(`const plan = await w.getPlan(); const L = await (${LOCKED})(w)
      const it = plan.items.find((i) => i.enabled && i.target !== 'inbox' && i.target !== 'cleanup')
      await chrome.bookmarks.move(it.bookmarkId, { parentId: L.otherId })
      return it.bookmarkId`)
    )
    const before = await page.evaluate(TREE)
    const fpBefore = fingerprint(before)
    const plan = await page.evaluate(W('return await w.getPlan()'))
    const L = await page.evaluate(W(`return await (${LOCKED})(w)`))

    const org = await browser.open('manager.html?view=organize')
    watchConsole(org)
    await org.waitFor('document.querySelector(".applybar")', 30000)
    await sleep(800)
    const planLine = await org.evaluate(`document.querySelector('.applybar .grow').textContent.trim()`)
    await org.screenshot(path.join(values.out, 'real-organize.png'))
    await org.screenshot(path.join(values.out, 'real-organize-full.png'), { fullPage: true })
    await org.evaluate(`document.querySelector('.applybar .btn-primary').click()`)
    await org.waitFor('document.querySelector("dialog[open]")', 10000)
    await org.evaluate(`document.querySelector('dialog[open] .btn-primary').click()`)
    await org.waitFor(`document.querySelector('.bar')?.textContent.includes('撤销')`, 5 * 60000)
    await sleep(800)
    const resultLine = await org.evaluate(`document.querySelector('.bar .grow').textContent.trim()`)
    await org.screenshot(path.join(values.out, 'real-applied.png'))
    const log1 = await org.evaluate(W('return await w.getLatestApply()'))
    const after = await org.evaluate(TREE)
    info(`应用前底部条：${planLine}；应用后结果条：${resultLine}`)

    // E3：快照存在扩展里，另外下载了备份文件；备份 = 应用前的树
    {
      let files = []
      for (let i = 0; i < 50; i++) {
        files = fs.readdirSync(browser.downloadsDir).filter((f) => /^书签备份-\d{8}-\d{4}\.json$/.test(f))
        if (files.length) break
        await sleep(100)
      }
      const backup = files.length ? JSON.parse(fs.readFileSync(path.join(browser.downloadsDir, files[0]), 'utf8')) : null
      const fpBackup = backup ? fingerprint(backup.nodes.map((n) => [n.id, n.parentId ?? null, n.index ?? null, n.title, n.url ?? null])) : ''
      const inStore = await org.evaluate(W(`try { return !!(await w.exportSnapshot(${JSON.stringify(log1.snapshotId)})) } catch { return false }`))
      record('E3', !!backup && fpBackup === fpBefore && inStore, `备份文件 ${files.length} 个，指纹 ${fpBackup || '无'} / 应用前 ${fpBefore}；扩展里的快照：${inStore}`)
    }

    // E4 E7 E8：逐条核对
    {
      const m0 = byId(before)
      const m1 = byId(after)
      const nameOf = new Map(plan.folders.flatMap((f) => [[f.key, plan.options.emoji && f.emoji ? `${f.emoji} ${f.name}` : f.name], ...f.children.map((c) => [c.key, plan.options.emoji && c.emoji ? `${c.emoji} ${c.name}` : c.name])]))
      const parentKey = new Map(plan.folders.flatMap((f) => f.children.map((c) => [c.key, f.key])))
      const expectedPath = (target) => {
        if (target === 'inbox') return [L.otherId, '待整理']
        if (target === 'cleanup') return [L.otherId, '待清理']
        const top = parentKey.get(target)
        return top ? [L.barId, nameOf.get(top), nameOf.get(target)] : [L.barId, nameOf.get(target)]
      }
      const finalTitle = (it) => (it.useAiTitle && it.aiTitle ? it.aiTitle : it.useRuleTitle && it.ruleTitle ? it.ruleTitle : it.base.title)
      const skipped = new Map(log1.report.skipped.map((s) => [s.bookmarkId, s.reason]))
      let wrongPlace = 0
      let wrongTitle = 0
      let checked = 0
      for (const it of plan.items.filter((i) => i.enabled && !skipped.has(i.bookmarkId))) {
        checked++
        if (JSON.stringify(pathOf(m1, it.bookmarkId)) !== JSON.stringify(expectedPath(it.target))) wrongPlace++
        if (m1.get(it.bookmarkId)?.[3] !== finalTitle(it)) wrongTitle++
      }
      const victimStayed = m1.get(victim)?.[1] === L.otherId && skipped.get(victim) === 'moved'
      record('E4', wrongPlace === 0 && wrongTitle === 0 && log1.report.mismatches.length === 0 && log1.status === 'done', `核对 ${checked} 条：位置不对 ${wrongPlace}、标题不对 ${wrongTitle}；应用自己读回核对的不一致 ${log1.report.mismatches.length}；状态 ${log1.status}`)
      record('E8', victimStayed && log1.report.skipped.length === 1, `生成方案后被移走的那条：跳过（${skipped.get(victim) || '没跳过'}）、留在原处：${m1.get(victim)?.[1] === L.otherId}；跳过共 ${log1.report.skipped.length} 条`)

      // E7：一条书签、一个文件夹都没删，网址没变
      const bms0 = before.filter((t) => t[4] !== null)
      const lostBm = bms0.filter((t) => !m1.has(t[0]) || m1.get(t[0])[4] !== t[4]).length
      const lostFolder = before.filter((t) => t[4] === null && t[0] !== '0' && !m1.has(t[0])).length
      const holding = after.find((t) => t[1] === L.otherId && t[3] === '整理前的空文件夹')
      const parked = holding ? after.filter((t) => t[1] === holding[0]).length : 0
      record('E7', lostBm === 0 && lostFolder === 0 && after.filter((t) => t[4] !== null).length === bms0.length, `丢失书签 ${lostBm}、丢失文件夹 ${lostFolder}；书签总数 ${bms0.length} → ${after.filter((t) => t[4] !== null).length}；变空的旧文件夹移进「整理前的空文件夹」${parked} 个`)

      // 锁定文件夹：里面的书签和子文件夹原样（自己的 index 会因为前面插了新目录而变）
      const isUnder = (m, id, anc) => {
        for (let p = m.get(id)?.[1]; p; p = m.get(p)?.[1]) if (p === anc) return true
        return false
      }
      const lockedSub = (m) => [...m.values()].filter((t) => L.ids.includes(t[0]) || L.ids.some((id) => isUnder(m, t[0], id))).map((t) => (L.ids.includes(t[0]) ? [t[0], t[1], t[3]] : t))
      const same = JSON.stringify(lockedSub(m0).sort()) === JSON.stringify(lockedSub(m1).sort())
      record('D5-locked', same, `锁定文件夹（${L.ids.length} 个、${L.bookmarkIds.length} 条书签）应用前后内容一样：${same}`)
      evidence.apply1 = { planLine, resultLine, report: { moved: log1.report.moved, renamed: log1.report.renamed, createdFolders: log1.report.createdFolders, movedOldFolders: log1.report.movedOldFolders, skipped: log1.report.skipped.length, mismatches: log1.report.mismatches.length } }
    }

    // E5（第 1 轮）：没有外部改动时撤销，树和应用前完全一样
    await click(org, '.bar .link', '撤销')
    await org.waitFor(`document.querySelector('.bar')?.textContent.includes('已撤销')`, 5 * 60000)
    await sleep(500)
    await org.screenshot(path.join(values.out, 'real-undone.png'))
    const fpUndo = fingerprint(await org.evaluate(TREE))
    record('E5-exact', fpUndo === fpBefore, `撤销后指纹 ${fpUndo}，应用前 ${fpBefore}（每个节点的 id、parentId、index、title、url）`)
    await org.close()

    // E5（第 2 轮，走接口）：应用后在别处删一条、在新目录里加一条，再撤销
    {
      const ids0 = before.map((t) => t[0])
      const r = await page.evaluate(
        W(`const plan = await w.getPlan(); const pre = new Set(${JSON.stringify(ids0)})
        const log = await w.apply(plan, () => {})
        const skipped = new Set(log.report.skipped.map((s) => s.bookmarkId))
        const gone = plan.items.find((i) => i.enabled && !skipped.has(i.bookmarkId))
        await chrome.bookmarks.remove(gone.bookmarkId)
        // 方案新建的目录（没有的话放进其他书签，只验证书签保留）
        const newFolder = Object.values(log.createdFolders).find((id) => !pre.has(id)) || ''
        const extra = await chrome.bookmarks.create({ parentId: newFolder || ${JSON.stringify(L.otherId)}, title: 'e2e 应用后新建', url: 'https://example.com/e2e-after-apply' })
        const undone = await w.undo(log.applyId, () => {})
        const u = undone.undoReport
        return { status: undone.status, gone: gone.bookmarkId, extra: extra.id, newFolder, rebuilt: u.rebuilt.map((x) => [x.snapshotId, x.newId]), keptExtras: u.keptExtras, keptFolders: u.keptFolders }`),
        10 * 60000
      )
      const now = await page.evaluate(TREE)
      const m = byId(now)
      const rebuiltId = r.rebuilt.find(([sid]) => sid === r.gone)?.[1]
      const old = byId(before).get(r.gone)
      const rebuiltOk = !!rebuiltId && JSON.stringify(m.get(rebuiltId)?.slice(1)) === JSON.stringify(old.slice(1))
      // 其余快照节点原样；多出来的只有新建的那条、它所在的新目录、重建的那条
      const extraIds = new Set([r.extra, rebuiltId, ...r.keptFolders].filter(Boolean))
      const restSame = before.filter((t) => t[0] !== r.gone).every((t) => JSON.stringify(m.get(t[0])) === JSON.stringify(t))
      const onlyExpectedExtras = now.filter((t) => !byId(before).has(t[0])).every((t) => extraIds.has(t[0]))
      const extraKept = r.keptExtras.includes(r.extra) && m.has(r.extra)
      const folderKept = !r.newFolder || r.keptFolders.includes(r.newFolder)
      record(
        'E5-external',
        r.status === 'undone' && rebuiltOk && extraKept && folderKept && restSame && onlyExpectedExtras,
        `被删的按快照重建（新 id，位置、标题、网址一样）：${rebuiltOk}；新建的保留：${extraKept}，它所在的新目录保留：${r.newFolder ? folderKept : '（方案没有新目录，没测）'}；其余节点和应用前一样：${restSame}；没有别的多余节点：${onlyExpectedExtras}`
      )
    }

    // E6（第 3 轮）：应用到三分之一时关掉管理页；再打开，提示上次没完成，点「撤销」回到应用前
    {
      const pre3 = await page.evaluate(TREE)
      const fp3 = fingerprint(pre3)
      const crash = await browser.open('manager.html')
      await crash.waitFor(READY, 30000)
      await crash.evaluate(W(`const plan = await w.getPlan(); window.__ap = [0, 0]; w.apply(plan, (d, t) => (window.__ap = [d, t])); return true`))
      await crash.waitFor('window.__ap[1] > 0 && window.__ap[0] >= window.__ap[1] / 3', 120000)
      const at = await crash.evaluate('window.__ap')
      await crash.close()
      await sleep(1500)
      const rec = await browser.open('manager.html')
      watchConsole(rec)
      await rec.waitFor(`document.querySelector('.bar')?.textContent.includes('上次应用未完成')`, 30000)
      const notice = await rec.evaluate(`document.querySelector('.bar .grow').textContent.trim()`)
      await rec.screenshot(path.join(values.out, 'real-interrupted.png'))
      await click(rec, '.bar .link', '撤销')
      await rec.waitFor(`document.querySelector('.bar')?.textContent.includes('已撤销')`, 5 * 60000)
      const fpAfter = fingerprint(await rec.evaluate(TREE))
      record('E6', fpAfter === fp3, `应用到第 ${at[0]} / ${at[1]} 步时关掉页面；再打开提示「${notice}」；撤销后指纹 ${fpAfter}，应用前 ${fp3}`)
      await rec.close()
    }

    // E6（第 4 轮）：应用到三分之一时关掉页面；再打开点「继续」，做完、和方案一致
    // E5（接着）：撤销到三分之一时关掉页面；再打开点「继续撤销」，结果和一次撤完一样
    {
      // 第 2 轮（E5-外部）新建过一个书签，书签总数要和这一轮开始时比，不能和最初的 before 比
      const pre4 = await page.evaluate(TREE)
      const fp4 = fingerprint(pre4)
      const crash = await browser.open('manager.html')
      await crash.waitFor(READY, 30000)
      await crash.evaluate(W(`const plan = await w.getPlan(); window.__ap = [0, 0]; w.apply(plan, (d, t) => (window.__ap = [d, t])); return true`))
      await crash.waitFor('window.__ap[1] > 0 && window.__ap[0] >= window.__ap[1] / 3', 120000)
      const at = await crash.evaluate('window.__ap')
      await crash.close()
      await sleep(1500)
      const rec = await browser.open('manager.html')
      watchConsole(rec)
      await rec.waitFor(`document.querySelector('.bar')?.textContent.includes('上次应用未完成')`, 30000)
      await click(rec, '.bar .link', '继续')
      await rec.waitFor(`window.__bt.state.notice?.kind === 'applied' && !window.__bt.state.busy`, 5 * 60000)
      const done = await rec.evaluate(W('return await w.getLatestApply()'))
      const afterResume = await rec.evaluate(TREE)
      const n4 = pre4.filter((t) => t[4] !== null).length
      const nResume = afterResume.filter((t) => t[4] !== null).length
      record(
        'E6-继续',
        done.status === 'done' && done.report.mismatches.length === 0 && nResume === n4,
        `应用到第 ${at[0]} / ${at[1]} 步时关掉页面；再打开点「继续」：状态 ${done.status}，读回核对不一致 ${done.report.mismatches.length}，跳过 ${done.report.skipped.length}；书签总数 ${nResume}，这轮应用前 ${n4}`
      )
      await rec.close()

      const u = await browser.open('manager.html')
      await u.waitFor(READY, 30000)
      await u.evaluate(W(`window.__up = [0, 0]; w.undo(${JSON.stringify(done.applyId)}, (d, t) => (window.__up = [d, t])); return true`))
      await u.waitFor('window.__up[1] > 0 && window.__up[0] >= window.__up[1] / 3', 120000)
      const ut = await u.evaluate('window.__up')
      await u.close()
      await sleep(1500)
      const rec2 = await browser.open('manager.html')
      watchConsole(rec2)
      await rec2.waitFor(`document.querySelector('.bar')?.textContent.includes('上次撤销未完成')`, 30000)
      await click(rec2, '.bar .link', '继续撤销')
      await rec2.waitFor(`window.__bt.state.notice?.kind === 'undone' && !window.__bt.state.busy`, 5 * 60000)
      const fpUndo2 = fingerprint(await rec2.evaluate(TREE))
      record('E5-中断重跑', fpUndo2 === fp4, `撤销到第 ${ut[0]} / ${ut[1]} 步时关掉页面；再打开点「继续撤销」：指纹 ${fpUndo2}，这轮应用前 ${fp4}`)
      await rec2.close()
    }

    // D3：key 不在 console、Chrome 输出、快照、计划、日志、导出的备份里
    {
      const inStorage = await page.evaluate(`chrome.storage.local.get(null).then((all) => { delete all.settings; return JSON.stringify(all).includes(${JSON.stringify(KEY8)}) })`)
      const inConsole = consoleTexts.some((t) => t.includes(KEY8)) || [...page.errors].some((t) => t.includes(KEY8))
      const inLogs = browser.logs(50).some((t) => t.includes(KEY8))
      const inFiles = fs.readdirSync(browser.downloadsDir).some((f) => fs.readFileSync(path.join(browser.downloadsDir, f), 'utf8').includes(KEY8))
      record('D3', !inStorage && !inConsole && !inLogs && !inFiles, `key 前 8 位出现在：存储（除设置外）${inStorage}、console ${inConsole}、Chrome 输出 ${inLogs}、备份文件 ${inFiles}`)
    }
  }

  const errs = page.errors.filter((e) => !/Failed to load resource/.test(e))
  record('页面报错', errs.length === 0, `${errs.length} 条${errs.length ? '：' + errs.slice(0, 2).join(' | ') : ''}`)
} catch (e) {
  exitCode = 1
  console.error(`✗ 中断：${safe(e.stack || e.message)}`)
  const logs = browser.logs(10)
  if (logs.length) console.error(['Chrome 输出的最后几行：', ...logs.map((l) => `  ${safe(l)}`)].join('\n'))
} finally {
  await browser.close()
  await server.close()
}

const bad = results.filter((r) => !r.ok)
evidence.results = results
evidence.finishedAt = new Date().toISOString()
const file = path.join(values.out, `evidence-${Date.now()}.json`)
fs.writeFileSync(file, safe(JSON.stringify(evidence, null, 2)))
console.log(`\n${bad.length || exitCode ? `不通过 ${bad.length} 项${exitCode ? '（中途中断）' : ''}` : '全部通过'}；证据：${file}`)
console.log(`临时配置${fs.existsSync(browser.userDataDir) ? '没删掉：' + browser.userDataDir : '已删除'}`)
process.exitCode = bad.length || exitCode ? 1 : 0

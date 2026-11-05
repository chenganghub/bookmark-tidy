#!/usr/bin/env node
// 像用户一样在有界面的 Chrome 里走一遍（用正式构建 .output/chrome-mv3，不是 e2e 构建）：
// 扩展管理页的卡片 → 点工具栏图标打开管理页 → 设置里填 key、测试连接 → 第一次抓网页时弹授权、点「允许」→ 抓取 →
// 生成方案（先写说明再分目录）→ 点「应用」→ 点「撤销」→ 再应用一次，用设置里的「从备份恢复」选下载的备份文件恢复。
// 跑在临时配置里，书签是真实书签文件的副本，跑完删掉临时配置；真实配置不碰。
// 浏览器自己的界面（工具栏图标、授权对话框）用 tools/e2e/window.ps1 点；页面里用 CDP 发真的鼠标点击。
// 终端只打印数字；窗口截图存 %TEMP%\bt-e2e\ui-*.png（里面有书签标题，只留在本机）。
// 用法：npm run build && node tools/e2e/real-ui.mjs --bookmarks "<Chrome 配置目录>\Bookmarks"（读环境变量 DEEPSEEK_API_KEY）

import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { launch, redact } from './browser.mjs'

const { values } = parseArgs({
  options: {
    bookmarks: { type: 'string' },
    ext: { type: 'string', default: '.output/chrome-mv3' },
    out: { type: 'string', default: path.join(os.tmpdir(), 'bt-e2e') }
  }
})
const KEY = process.env.DEEPSEEK_API_KEY || ''
if (!values.bookmarks || !KEY) {
  console.error('用法：node tools/e2e/real-ui.mjs --bookmarks <Bookmarks 文件>（还要环境变量 DEEPSEEK_API_KEY）')
  process.exit(2)
}
const safe = (s) => redact(String(s)).split(KEY).join('***')
fs.mkdirSync(values.out, { recursive: true })

const results = []
const record = (id, ok, detail = '') => {
  results.push({ id, ok, detail: safe(detail) })
  console.log(`${ok ? '✓' : '✗'} ${id} ${safe(detail)}`)
}
const info = (s) => console.log(`  ${safe(s)}`)

// ---------------------------------------------------------------- 浏览器自己的界面

const PS = path.resolve('tools/e2e/window.ps1')
function win(pid, action, extra = []) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS, '-ProcessId', String(pid), '-Action', action, ...extra], { encoding: 'utf8', timeout: 60000 })
    return JSON.parse(out.trim().split('\n').pop())
  } catch (e) {
    const text = String(e.stdout || '').trim().split('\n').pop() || ''
    try {
      return JSON.parse(text)
    } catch {
      return { ok: false, error: safe(String(e.stderr || e.message).slice(0, 300)) }
    }
  }
}

// ---------------------------------------------------------------- 页面里用的片段

const TREE = `new Promise((r) => chrome.bookmarks.getTree((t) => { const out = []; const walk = (n, p) => { out.push([n.id, p ?? null, n.index ?? null, n.title, n.url ?? null]); for (const c of n.children || []) walk(c, n.id) }; for (const x of t) walk(x); r(out) }))`
const fingerprint = (tuples) =>
  crypto
    .createHash('sha256')
    .update(JSON.stringify(tuples.filter((t) => t[0] !== '0').sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))))
    .digest('hex')
    .slice(0, 16)
const countBookmarks = (tuples) => tuples.filter((t) => t[4] !== null).length
const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.checkVisibility())`
const READY = 'window.__bt && document.querySelector(".content .grid, .content .list, .content .stats, .content .panel, .content .empty")'

/** chrome://extensions 里这个扩展的卡片（WebUI 全是 shadow DOM，挨层找） */
const CARD = (id) => `(() => {
  const all = []
  const walk = (root) => { for (const el of root.querySelectorAll('*')) { all.push(el); if (el.shadowRoot) walk(el.shadowRoot) } }
  walk(document)
  const dev = all.find((el) => el.id === 'devMode')
  const item = all.find((el) => el.tagName === 'EXTENSIONS-ITEM' && el.id === ${JSON.stringify(id)})
  const sr = item?.shadowRoot
  const errBtn = sr?.querySelector('#errors-button')
  return {
    devMode: !!dev?.checked,
    found: !!item,
    name: sr?.querySelector('#name')?.textContent.trim() || '',
    errorsShown: !!errBtn && !errBtn.hidden && getComputedStyle(errBtn).display !== 'none',
    enabled: !!sr?.querySelector('#enableToggle')?.checked,
    views: (sr?.querySelector('#inspect-views')?.textContent || '').replace(/\\s+/g, ' ').trim()
  }
})()`

// ---------------------------------------------------------------- 跑

const browser = await launch({ extPath: values.ext, bookmarksFile: values.bookmarks, headless: false, args: ['--window-size=1440,960', '--window-position=40,40', '--lang=zh-CN'] })
const pid = browser.pid
const shot = (name) => {
  const r = win(pid, 'shot', ['-Out', path.join(values.out, `ui-${name}.png`)])
  if (!r.ok) info(`截图 ${name} 没成：${r.error || ''}`)
}
let exitCode = 0
try {
  info(`${browser.version}，扩展 ${browser.extId}，Chrome 主进程 ${pid}（有界面，临时配置）`)
  await sleep(1500)

  // ---------------------------------------------------------------- A1：扩展管理页的卡片
  const ext = await browser.newPage('chrome://extensions/')
  await sleep(800)
  await ext.evaluate(`chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })`)
  await sleep(1200)
  const card = await ext.evaluate(CARD(browser.extId))
  shot('extensions')
  record(
    'A1-卡片',
    card.found && card.enabled && !card.errorsShown && card.devMode && !/无效|inactive/i.test(card.views),
    `chrome://extensions（开发者模式 ${card.devMode ? '开' : '关'}）：卡片「${card.name}」已启用 ${card.enabled}，「错误」按钮 ${card.errorsShown ? '有' : '没有'}；检查视图「${card.views}」`
  )

  // 固定到工具栏：等于用户在拼图菜单里点图钉；没固定时从拼图菜单点进去是同一个点击事件
  const pinned = await ext.evaluate(`chrome.developerPrivate.updateExtensionConfiguration({ extensionId: ${JSON.stringify(browser.extId)}, pinnedToToolbar: true }).then(() => true, () => false)`)
  await sleep(800)

  // ---------------------------------------------------------------- A1：点工具栏图标
  const tabsBefore = (await browser.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').length
  const click = win(pid, 'invoke', ['-Name', '^打开书签整理$', '-TimeoutMs', '10000'])
  let target
  for (let i = 0; i < 50 && !target; i++) {
    target = (await browser.cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'page' && t.url === `chrome-extension://${browser.extId}/manager.html`)
    if (!target) await sleep(200)
  }
  if (!target) throw new Error(`点工具栏图标没有打开管理页（点击结果 ${JSON.stringify(click)}，已固定 ${pinned}）`)
  const mgr = await browser.attach(target.targetId)
  await mgr.send('Page.bringToFront')
  await mgr.waitFor(READY, 30000)
  await sleep(1000)
  const shown = Number(await mgr.evaluate(`document.querySelector('.sidebar .side-row .n')?.textContent.trim()`))
  const tabsAfter = (await browser.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page').length
  shot('toolbar-opened')
  const expectedShown = countBookmarks(await mgr.evaluate(TREE))
  record('A1-工具栏', click.ok && shown === expectedShown, `点工具栏上的「打开书签整理」（${click.how}）：新开了 ${tabsAfter - tabsBefore} 个标签页，是管理页，显示书签 ${shown}`)

  const before0 = await mgr.evaluate(TREE)
  const fp0 = fingerprint(before0)

  // ---------------------------------------------------------------- 设置：填 key、测试连接
  await mgr.click(`document.querySelector('[aria-label="设置"]')`)
  await mgr.waitFor('document.querySelector("dialog[open] #api-key")')
  await mgr.click(`document.querySelector('#api-key')`)
  await mgr.send('Input.insertText', { text: KEY })
  await mgr.click(button('测试连接'))
  const test = await mgr.waitFor(`(() => { const s = document.querySelector('dialog[open] [role=status]')?.textContent.trim(); return s && s !== '' ? s : '' })()`, 60000)
  shot('settings')
  await mgr.click(button('完成'))
  await mgr.waitFor('!document.querySelector("dialog[open]")')
  record('设置', test === '可用', `在设置里输入 key、点「测试连接」：${test}`)

  // ---------------------------------------------------------------- A2：第一次抓取时弹授权
  const grantedBefore = await mgr.evaluate(`chrome.permissions.contains({ origins: ['https://*/*'] })`)
  // 抓取在整理页第 ① 步（bookmark-ux）
  await mgr.click(button('整理'))
  await mgr.waitFor(button('抓取网页信息'))
  await mgr.click(button('抓取网页信息'))
  await sleep(1200)
  shot('permission')
  const allow = win(pid, 'invoke', ['-Name', '^允许$', '-TimeoutMs', '10000'])
  if (!allow.ok) info(`授权对话框里的按钮：${JSON.stringify(win(pid, 'list').names || [])}`)
  await mgr.waitFor(button('开始'), 30000)
  const grantedAfter = await mgr.evaluate(`chrome.permissions.contains({ origins: ['https://*/*'] })`)
  record('A2-授权', !grantedBefore && allow.ok && grantedAfter, `点「抓取网页信息」之前有网址权限：${grantedBefore}；弹出授权对话框，点「允许」（${allow.how || allow.error}）；之后有网址权限：${grantedAfter}`)
  const planText = await mgr.evaluate(`document.querySelector('.panel .kv')?.textContent.replace(/\\s+/g, ' ').trim()`)
  shot('fetch-plan')

  // ---------------------------------------------------------------- 抓取
  const t0 = Date.now()
  await mgr.click(button('开始'))
  await mgr.waitFor('document.querySelector(".content progress")', 10000)
  await sleep(1500)
  shot('fetching')
  await mgr.waitFor(`!document.querySelector('.content progress') && ${button('抓取网页信息')}`, 10 * 60000)
  const fetched = await mgr.evaluate(`window.__bt.workflow.getPageInfos().then((p) => { const m = {}; for (const x of Object.values(p)) m[x.status] = (m[x.status] || 0) + 1; return { n: Object.keys(p).length, m } })`)
  record('抓取', fetched.n > 300, `清单「${planText}」；点「开始」后 ${Math.round((Date.now() - t0) / 1000)} 秒抓完 ${fetched.n} 个网址：${Object.entries(fetched.m).map(([k, n]) => `${k} ${n}`).join('、')}`)
  shot('fetched')

  // ---------------------------------------------------------------- 生成方案（同一个按钮先写说明、再分目录）
  const t1 = Date.now()
  await mgr.click(button('生成方案'))
  await mgr.waitFor('document.querySelector(".content progress")', 20000)
  await sleep(2000)
  shot('describing')
  await mgr.waitFor('document.querySelector(".applybar")', 30 * 60000)
  await sleep(1000)
  const failNote = await mgr.evaluate(`[...document.querySelectorAll('.content .panel p.secondary')].map((p) => p.textContent.trim()).join(' ')`)
  if (failNote) info(`整理页提示「${failNote}」`)
  const described = await mgr.evaluate(`window.__bt.workflow.getMeta().then((m) => Object.values(m).filter((x) => x.desc).length)`)
  const usage = await mgr.evaluate(`[...document.querySelectorAll('.content .secondary')].map((x) => x.textContent.trim()).find((t) => t.startsWith('token')) || ''`)
  const planLine = await mgr.evaluate(`document.querySelector('.applybar .grow').textContent.trim()`)
  shot('plan')
  record('说明和方案', described >= 380 && !!planLine, `点「生成方案」${Math.round((Date.now() - t1) / 1000)} 秒（先写说明再分目录），${described} 条有说明；底部条「${planLine}」；${usage}`)
  const fp1 = fingerprint(await mgr.evaluate(TREE))
  record('E1', fp1 === fp0, `生成方案前后书签树指纹 ${fp0} / ${fp1}`)

  // ---------------------------------------------------------------- 应用、撤销（全用界面）
  const applyOnce = async (name) => {
    await mgr.click(`document.querySelector('.applybar .btn-primary')`)
    await mgr.waitFor('document.querySelector("dialog[open]")')
    await sleep(400)
    if (name === 'apply-1') shot('confirm')
    await mgr.click(`document.querySelector('dialog[open] .btn-primary')`)
    // 等这一次真的应用完：结果条换成「应用」的结果，而且没有别的书签操作在跑
    await mgr.waitFor(`window.__bt.state.notice?.kind === 'applied' && !window.__bt.state.busy`, 10 * 60000)
    await sleep(800)
    shot(name)
    return mgr.evaluate(`window.__bt.workflow.getLatestApply()`)
  }
  const backups = () => fs.readdirSync(browser.downloadsDir).filter((f) => /^书签备份-\d{8}-\d{4}\.json$/.test(f))
  const waitBackups = async (n) => {
    for (let i = 0; i < 50 && backups().length < n; i++) await sleep(100)
    return backups()
  }

  const log1 = await applyOnce('apply-1')
  const after1 = await mgr.evaluate(TREE)
  const bar1 = await mgr.evaluate(`document.querySelector('.bar .grow').textContent.trim()`)
  const files1 = await waitBackups(1)
  const backup1 = files1.length ? JSON.parse(fs.readFileSync(path.join(browser.downloadsDir, files1[0]), 'utf8')) : null
  const fpBackup1 = backup1 ? fingerprint(backup1.nodes.map((n) => [n.id, n.parentId ?? null, n.index ?? null, n.title, n.url ?? null])) : ''
  record(
    '应用',
    log1.status === 'done' && log1.report.mismatches.length === 0 && countBookmarks(after1) === countBookmarks(before0) && fpBackup1 === fp0 && fingerprint(after1) !== fp0,
    `确认框点「应用」：结果条「${bar1}」；读回核对不一致 ${log1.report.mismatches.length}；书签 ${countBookmarks(before0)} → ${countBookmarks(after1)}；下载了备份 ${files1.length} 个，指纹和应用前一样：${fpBackup1 === fp0}`
  )

  await mgr.click(`[...document.querySelectorAll('.bar .link')].find((b) => b.textContent.trim() === '撤销')`)
  await mgr.waitFor(`window.__bt.state.notice?.kind === 'undone' && !window.__bt.state.busy`, 10 * 60000)
  await sleep(800)
  shot('undone')
  const fpUndo = fingerprint(await mgr.evaluate(TREE))
  record('撤销', fpUndo === fp0, `结果条上点「撤销」：撤销后指纹 ${fpUndo}，应用前 ${fp0}`)

  // ---------------------------------------------------------------- 再应用一次，用备份文件恢复
  await mgr.waitFor('document.querySelector(".applybar")', 10000)
  const log2 = await applyOnce('apply-2')
  const files2 = await waitBackups(2)
  const newest = files2.map((f) => ({ f, t: fs.statSync(path.join(browser.downloadsDir, f)).mtimeMs })).sort((a, b) => b.t - a.t)[0]?.f
  await mgr.click(`document.querySelector('[aria-label="设置"]')`)
  await mgr.waitFor('document.querySelector("dialog[open]")')
  // 选文件：等于用户在文件选择框里选了刚下载的备份
  const { root } = await mgr.send('DOM.getDocument', { depth: -1, pierce: true })
  const { nodeId } = await mgr.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'dialog[open] input[type=file]' })
  await mgr.send('DOM.setFileInputFiles', { nodeId, files: [path.join(browser.downloadsDir, newest)] })
  await mgr.waitFor(`[...document.querySelectorAll('dialog[open]')].some((d) => d.textContent.includes('从备份恢复？'))`, 10000)
  await sleep(400)
  shot('restore-confirm')
  await mgr.click(`[...document.querySelectorAll('dialog[open] .btn-primary')].find((b) => b.textContent.trim() === '恢复')`)
  await mgr.waitFor(`window.__bt.state.notice?.kind === 'restored' && !window.__bt.state.busy`, 10 * 60000)
  await sleep(800)
  shot('restored')
  const fpRestore = fingerprint(await mgr.evaluate(TREE))
  record('从备份恢复', log2.status === 'done' && fpRestore === fp0, `再应用一次（${log2.status}），然后设置 →「从备份恢复」选刚下载的备份 → 确认「恢复」：恢复后指纹 ${fpRestore}，应用前 ${fp0}`)

  const errs = mgr.errors.filter((e) => !/Failed to load resource/.test(e))
  record('页面报错', errs.length === 0, `${errs.length} 条`)
} catch (e) {
  exitCode = 1
  console.error(`✗ 中断：${safe(e.stack || e.message)}`)
  shot('error')
} finally {
  await browser.close()
}
const bad = results.filter((r) => !r.ok)
const file = path.join(values.out, `ui-evidence-${Date.now()}.json`)
fs.writeFileSync(file, safe(JSON.stringify({ finishedAt: new Date().toISOString(), results }, null, 2)))
console.log(`\n${bad.length || exitCode ? `不通过 ${bad.length} 项${exitCode ? '（中途中断）' : ''}` : '全部通过'}；证据：${file}；截图：${values.out}\\ui-*.png`)
console.log(`临时配置${fs.existsSync(browser.userDataDir) ? '没删掉：' + browser.userDataDir : '已删除'}`)
process.exitCode = bad.length || exitCode ? 1 : 0

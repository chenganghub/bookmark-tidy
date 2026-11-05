#!/usr/bin/env node
// 二期端到端：收藏即整理、一键整理、地址栏搜索的规则（accept A1～A7、T1～T4、B1～B3、C1、K2、P2）。
// 临时 Chrome 配置 + e2e 构建（npm run build:e2e）；--host-resolver-rules 把 *.bt-test 映射到本地服务器，
// 本地服务器同时当测试网页和假 AI。不联网、不花钱、不碰用户的真实配置。
// 用法：node tools/e2e/auto-run.mjs [--ext .output/chrome-mv3-e2e] [--out 目录] [--headed]
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { launch } from './browser.mjs'

const { values } = parseArgs({
  options: {
    ext: { type: 'string', default: '.output/chrome-mv3-e2e' },
    out: { type: 'string', default: path.join(process.env.TEMP || '.', 'bt-e2e') },
    headed: { type: 'boolean', default: false }
  }
})
fs.mkdirSync(values.out, { recursive: true })

const KEY = 'sk-e2e-auto-0123456789abcdef'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const record = (id, ok, detail) => {
  results.push({ id, ok: !!ok, detail })
  console.log(`${ok ? '✓' : '✗'} ${id} ${detail}`)
}

// ---------------------------------------------------------------- 本地服务器：测试网页 + 假 AI

const aiRequests = []
const para = (marker, n = 24) => Array.from({ length: n }, (_, i) => `<p>第${i}段：${marker}。讲响应式原理里的依赖收集和派发更新，写组件时常用。</p>`).join('')
const page = (title, inner, desc = '') =>
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>${desc ? `<meta name="description" content="${desc}">` : ''}</head>` +
  `<body><nav>首页 · 导航 · 登录</nav><main><article><h1>${title}</h1>${inner}</article></main><footer>页脚</footer></body></html>`

/** 假 AI：按标题里的词决定去向；记下每个请求体和 Authorization 头 */
function answer(title) {
  if (/不确定/.test(title)) return { path: 'AI 工具', confidence: 0.3 }
  if (/CSS/.test(title)) return { path: '前端/CSS', confidence: 0.95 }
  if (/AI/.test(title)) return { path: 'AI 工具', confidence: 0.95 }
  return { path: '前端/Vue', confidence: 0.92 }
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host || '').split(':')[0]
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'POST' && url.pathname === '/ai/chat/completions') {
    let raw = ''
    for await (const c of req) raw += c
    aiRequests.push({ at: Date.now(), body: raw, auth: req.headers.authorization || '' })
    const json = JSON.parse(raw)
    const line = json.messages[1].content.split('\n')[1] || ''
    const [id, title = ''] = line.split(' | ')
    const content = JSON.stringify({ items: [{ id, desc: `说明：${title}`.slice(0, 40), title: title.slice(0, 30), tags: ['测试'], type: '文章', ...answer(title) }] })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
    return
  }
  if (url.pathname === '/login') {
    res.writeHead(302, { 'set-cookie': 'sid=1; Path=/', location: url.searchParams.get('to') || '/' })
    res.end()
    return
  }
  let html
  if (url.pathname.startsWith('/article/private')) {
    const logged = /(^|;\s*)sid=1/.test(req.headers.cookie || '')
    html = logged ? page('Vue 私密文章', para('私密正文标记')) : page('请登录', '<p>请登录后查看全文</p>')
  } else if (url.pathname.startsWith('/article/public')) {
    const n = url.pathname.split('/').pop()
    html = page(`Vue 响应式原理${n}-CSDN博客`, para(`公开正文标记${n}`), '公开文章的简介')
  } else if (host.endsWith('company.bt-test') || host.startsWith('corp.')) {
    html = page(url.searchParams.get('t') || '公司页面', para('公司正文标记'))
  } else {
    html = page(url.searchParams.get('t') || '普通网页', para(`普通正文标记${url.searchParams.get('t') || ''}`))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(html)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const P = server.address().port
const U = (host, p) => `http://${host}:${P}${p}`

// ---------------------------------------------------------------- 启动

// 系统代理可能把测试域名交给外部解析，导致本地映射失效。
// 这个测试全在本机（网页和假 AI 都在本地服务器上），直接不用代理；--proxy-bypass-list 只对 --proxy-server 生效，管不了系统代理
const browser = await launch({ extPath: values.ext, headless: !values.headed, hostRules: 'MAP *.bt-test 127.0.0.1', args: ['--no-proxy-server'] })
let exitCode = 0
const evidence = { startedAt: new Date().toISOString(), version: browser.version, results }
try {
  const mgr = await browser.open('manager.html')
  await mgr.waitFor('!!window.__bt?.state?.ready', 30000)
  const ev = (code, ms) => mgr.evaluate(code, ms)

  // T4：后台（service worker）的 console 输出和没接住的异常也收下来，最后查里面有没有 key
  const swLogs = []
  const swOf = async () => (await browser.cdp.send('Target.getTargets')).targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${browser.extId}/`))
  const sw0 = await swOf()
  if (sw0) {
    const { sessionId: swSession } = await browser.cdp.send('Target.attachToTarget', { targetId: sw0.targetId, flatten: true })
    browser.cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid === swSession) swLogs.push(p.args.map((a) => (a.value === undefined ? a.description || '' : String(a.value))).join(' '))
    })
    browser.cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid === swSession) swLogs.push(p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '')
    })
    await browser.cdp.send('Runtime.enable', {}, swSession)
  }
  const send = async (type, payload = {}) => {
    const r = await ev(`chrome.runtime.sendMessage(${JSON.stringify({ type, ...payload })})`)
    if (!r?.ok) throw new Error(`${type}：${r?.error ?? '没有回应'}`)
    return r.value
  }
  const node = (id) => ev(`chrome.bookmarks.get(${JSON.stringify(id)}).then((r) => r[0]).catch(() => null)`)
  const parentOf = async (id) => (await node(id))?.parentId
  const create = (parentId, title, url) => ev(`chrome.bookmarks.create(${JSON.stringify({ parentId, title, url })}).then((n) => n.id)`)
  const local = (key) => ev(`chrome.storage.local.get(${JSON.stringify(key)}).then((r) => r[${JSON.stringify(key)}] ?? null)`)
  const requestFor = (id) => aiRequests.filter((r) => JSON.parse(r.body).messages[1].content.split('\n')[1]?.startsWith(`${id} |`))

  // 书签树：书签栏 前端/Vue、前端/CSS、AI 工具、锁定的「受保护资料」（里面一条公司 wiki）
  const ids = await ev(`(async () => {
    const [root] = await chrome.bookmarks.getTree()
    const bar = root.children.find((n) => n.folderType === 'bookmarks-bar') ?? root.children[0]
    const other = root.children.find((n) => n.folderType === 'other') ?? root.children[1]
    const mk = (parentId, title, url) => chrome.bookmarks.create(url ? { parentId, title, url } : { parentId, title })
    const fe = await mk(bar.id, '前端'); const vue = await mk(fe.id, 'Vue'); const css = await mk(fe.id, 'CSS')
    await mk(vue.id, 'Vue 文档', 'https://cn.vuejs.org/'); await mk(css.id, 'CSS 技巧', 'https://css.example/')
    const ai = await mk(bar.id, 'AI 工具'); await mk(ai.id, 'ChatGPT', 'https://chatgpt.com/')
    const lock = await mk(bar.id, '受保护资料'); await mk(lock.id, '公司 wiki', ${JSON.stringify(U('wiki.company.bt-test', '/home'))})
    return { bar: bar.id, other: other.id, vue: vue.id, css: css.id, ai: ai.id, lock: lock.id }
  })()`)
  const organizedLog = (status) => ({ applyId: 'apply-e2e', planId: 'p', snapshotId: 's', status, startedAt: Date.now() - 60000, updatedAt: Date.now(), total: 0, done: 0, createdFolders: {}, undoIdMap: {} })
  await ev(`chrome.storage.local.set(${JSON.stringify({
    settings: { ai: { baseUrl: `http://127.0.0.1:${P}/ai`, apiKey: KEY, model: 'deepseek-flash', disableThinking: true }, textDomains: ['pub.bt-test', 'priv.bt-test'], privateDomains: ['corp.bt-test'] },
    'apply:latest': 'apply-e2e',
    'apply:apply-e2e': organizedLog('done')
  })})`)

  // ---------------------------------------------------------------- 第 1 轮：A 的各种情况一起收藏
  const open = async (url) => {
    const p = await browser.newPage(url)
    return p
  }
  const urls = {
    pub: U('pub.bt-test', '/article/public/1'),
    moved: U('plain.bt-test', '/p?t=气泡里挪过'),
    retitled: U('plain.bt-test', '/p?t=改过标题'),
    dup: U('plain.bt-test', '/p?t=重复收藏'),
    locked: U('plain.bt-test', '/p?t=收藏进锁定'),
    priv: U('priv.bt-test', '/article/private'),
    derived: U('docs.company.bt-test', '/space/1?t=公司文档'),
    corp: U('corp.bt-test', '/x?t=内部系统'),
    unsure: U('plain.bt-test', '/p?t=不确定的页面'),
    noTab: U('plain.bt-test', '/p?t=没开标签页')
  }
  for (const [k, u] of Object.entries(urls)) {
    if (k === 'noTab') continue
    if (k === 'priv') await open(U('priv.bt-test', `/login?to=${encodeURIComponent('/article/private')}`))
    else await open(u)
  }
  const t0 = Date.now()
  const b = {}
  b.pub = await create(ids.other, 'Vue 响应式原理1-CSDN博客', urls.pub)
  b.moved = await create(ids.other, '气泡里挪过', urls.moved)
  b.retitled = await create(ids.other, '改过标题 - 知乎', urls.retitled)
  b.dup1 = await create(ids.other, '重复收藏 第一次', urls.dup)
  b.locked = await create(ids.lock, '收藏进锁定', urls.locked)
  b.priv = await create(ids.other, 'Vue 私密文章', urls.priv)
  b.derived = await create(ids.other, '公司文档', urls.derived)
  b.corp = await create(ids.other, '内部系统', urls.corp)
  b.unsure = await create(ids.other, '不确定的页面', urls.unsure)
  b.noTab = await create(ids.other, '没开标签页', urls.noTab)
  await sleep(2000)
  await ev(`chrome.bookmarks.move(${JSON.stringify(b.moved)}, { parentId: ${JSON.stringify(ids.ai)} })`)
  await ev(`chrome.bookmarks.update(${JSON.stringify(b.retitled)}, { title: '我自己起的名字' })`)
  b.dup2 = await create(ids.other, '重复收藏 第二次', `${urls.dup}#top`)
  await sleep(Math.max(0, 6500 - (Date.now() - t0)))
  const early = await parentOf(b.pub)
  // 等全部处理完：队列空了，并且最后一条（重复的第二次）处理过
  await mgr.waitFor(`chrome.storage.session.get('auto:queue').then((r) => !(r['auto:queue'] ?? []).length)`, 60000)
  await mgr.waitFor(`chrome.bookmarks.get(${JSON.stringify(b.dup2)}).then((r) => r[0].parentId !== ${JSON.stringify(ids.other)})`, 30000)
  await sleep(1000)

  const pubNode = await node(b.pub)
  const pubMeta = await local(`meta:${b.pub}`)
  const pubText = await local(`text:${b.pub}`)
  const pubRec = await local(`autorec:${b.pub}`)
  const pubReq = requestFor(b.pub)
  record('A1', early === ids.other && pubNode.parentId === ids.vue && pubNode.title === 'Vue 响应式原理1' && pubMeta?.desc && pubRec?.status === 'filed' && pubReq.length === 1,
    `6.5 秒时还在原处：${early === ids.other}；之后放进「前端/Vue」：${pubNode.parentId === ids.vue}；标题清理成「${pubNode.title}」；说明「${pubMeta?.desc}」；记录 ${pubRec?.status}；AI 请求 ${pubReq.length} 次`)
  const pubBody = pubReq[0]?.body ?? ''
  record('T1-公开', pubBody.includes('正文开头') && pubBody.includes('公开正文标记1'), `白名单站点、公开版本对得上：请求里有正文片段 ${pubBody.includes('正文开头')}`)
  record('T3', pubText?.text?.includes('公开正文标记1') && pubText.text.length <= 30000, `正文存在本机：${pubText?.text?.length ?? 0} 字`)

  const movedNode = await node(b.moved)
  const retNode = await node(b.retitled)
  record('A2', movedNode.parentId === ids.ai && retNode.title === '我自己起的名字' && retNode.parentId === ids.vue && !!(await local(`meta:${b.moved}`)),
    `等待期里挪到「AI 工具」的：没被挪走 ${movedNode.parentId === ids.ai}，说明照写；改过标题的：标题没被改 ${retNode.title === '我自己起的名字'}，位置照放 ${retNode.parentId === ids.vue}`)

  const noTabReq = requestFor(b.noTab).length
  record('A3', (await parentOf(b.noTab)) === ids.other && noTabReq === 0, `没开标签页的新书签：没处理、没发请求（${noTabReq} 次）`)

  const lockedReq = requestFor(b.locked).length
  const lockName = aiRequests.some((r) => r.body.includes('受保护资料'))
  record('A7', (await parentOf(b.locked)) === ids.lock && lockedReq === 0 && !lockName, `收藏进锁定文件夹的：不动、没发请求（${lockedReq} 次）；任何请求里有「受保护资料」：${lockName}`)

  const notices = await send('e2e:notices')
  // 后台记下的通知原文（e2e 构建才有）：标题、正文、旧位置、按钮
  const noticeLog = await send('e2e:notice-log')
  const noticeOf = (id) => noticeLog.filter((n) => n.id === `bt:${id}`).at(-1)
  const otherTitle = (await node(ids.other))?.title ?? ''
  const dup1Parent = await parentOf(b.dup1)
  const dup2Parent = await parentOf(b.dup2)
  const dupNotice = noticeOf(b.dup2)
  const wantDup = `以前收藏过，在「${otherTitle}」`
  record('A6', dup1Parent === ids.other && dup2Parent === ids.vue && requestFor(b.dup1).length === 0 && dupNotice?.context === wantDup,
    `8 秒内同一网页收藏两次：第一次留在原处 ${dup1Parent === ids.other}，第二次处理了 ${dup2Parent === ids.vue}；第一次没发请求；第二次的通知里写「${dupNotice?.context ?? '（没有）'}」（旧的那条在「${otherTitle}」根下）`)

  const unsureParent = await parentOf(b.unsure)
  const inbox = await ev(`chrome.bookmarks.getChildren(${JSON.stringify(ids.other)}).then((c) => c.find((x) => x.title === '待整理' && !x.url)?.id ?? null)`)
  record('A1-待整理', !!inbox && unsureParent === inbox && (await local(`autorec:${b.unsure}`))?.status === 'inbox', `把握不够的进「其他书签/待整理」：${unsureParent === inbox}`)

  const privBody = requestFor(b.priv)[0]?.body ?? ''
  const privText = await local(`text:${b.priv}`)
  const leaked = aiRequests.some((r) => r.body.includes('私密正文标记'))
  record('T1-登录后', privBody && !privBody.includes('正文开头') && !leaked && privText?.text?.includes('私密正文标记'),
    `只有登录后才看得到的正文：请求里没有正文片段 ${!privBody.includes('正文开头')}，任何请求里都没有私密内容 ${!leaked}；本机存了 ${!!privText}`)

  const derivedLine = JSON.parse(requestFor(b.derived)[0]?.body ?? '{"messages":[{},{"content":""}]}').messages[1].content.split('\n')[1] ?? ''
  const corpLine = JSON.parse(requestFor(b.corp)[0]?.body ?? '{"messages":[{},{"content":""}]}').messages[1].content.split('\n')[1] ?? ''
  const privTexts = [await local(`text:${b.derived}`), await local(`text:${b.corp}`)]
  const companyLeak = aiRequests.some((r) => r.body.includes('公司正文标记'))
  record('T2', derivedLine.split(' | ')[2] === `docs.company.bt-test` && corpLine.split(' | ')[2] === 'corp.bt-test' && privTexts.every((t) => !t) && !companyLeak,
    `私有站点（锁定文件夹里出现过的站点、设置里加的）：请求里网址只有域名「${derivedLine.split(' | ')[2]}」「${corpLine.split(' | ')[2]}」；不存正文；任何请求里有公司正文：${companyLeak}`)

  const plainBody = requestFor(b.unsure)[0]?.body ?? ''
  record('T1-非白名单', plainBody && !plainBody.includes('正文开头'), `不在白名单的网站：请求里没有正文片段`)

  // A5：通知；撤销按钮、改位置按钮。O4：进了待整理的那条点「改位置」打开管理页的待处理，放进目录的打开 Chrome 书签管理器
  const nPub = notices[`bt:${b.pub}`] !== undefined
  const before = await ev(`chrome.bookmarks.get(${JSON.stringify(b.pub)}).then((r) => r[0])`)
  const pageUrls = async () => (await browser.cdp.send('Target.getTargets')).targetInfos.map((t) => t.url)
  // 标签页全程不关：按点之前、之后的个数比，不看「有没有」
  const triageTabs = async () => (await pageUrls()).filter((u) => u === `chrome-extension://${browser.extId}/manager.html?view=triage`).length
  const inboxBmTabs = async () => (await pageUrls()).filter((u) => u.startsWith(`chrome://bookmarks/?id=${inbox}`)).length
  const [tri0, bm0] = [await triageTabs(), await inboxBmTabs()]
  await send('e2e:notice-button', { nid: `bt:${b.unsure}`, button: 1 })
  await sleep(500)
  const [tri1, bm1] = [await triageTabs(), await inboxBmTabs()]
  record('O4', tri1 === tri0 + 1 && bm1 === bm0, `进了待整理的那条点「改位置」：管理页的待处理标签页 ${tri0} → ${tri1}；Chrome 书签管理器里待整理的标签页 ${bm0} → ${bm1}`)
  await send('e2e:notice-button', { nid: `bt:${b.pub}`, button: 1 })
  await sleep(500)
  const bmTab = (await pageUrls()).some((u) => u.startsWith(`chrome://bookmarks/?id=${ids.vue}`))
  await send('e2e:notice-button', { nid: `bt:${b.pub}`, button: 0 })
  await sleep(500)
  const undone = await node(b.pub)
  const afterNotices = await send('e2e:notices')
  const pubNotice = noticeOf(b.pub)
  const noticeOk = pubNotice?.title === '已放进「前端/Vue」' && !!pubMeta?.desc && pubNotice?.message === pubMeta.desc && pubNotice?.buttons.join() === '撤销,改位置'
  record('A5', nPub && noticeOk && undone.parentId === ids.other && undone.title === 'Vue 响应式原理1-CSDN博客' && (await local(`autorec:${b.pub}`))?.status === 'undone' && afterNotices[`bt:${b.pub}`] === undefined && bmTab,
    `通知有：${nPub}；标题「${pubNotice?.title}」，正文「${pubNotice?.message}」= 存下的说明：${pubNotice?.message === pubMeta?.desc}，按钮「${pubNotice?.buttons.join('」「')}」；点「撤销」后回到原处 ${undone.parentId === ids.other}、标题改回「${undone.title}」；通知关掉；放进「前端/Vue」的那条点「改位置」打开了 chrome://bookmarks 里它所在的文件夹：${bmTab}；撤销前在 ${before.parentId === ids.vue ? '前端/Vue' : before.parentId}`)

  // ---------------------------------------------------------------- 第 2 轮：A4 一期操作进行中收藏的、重建的
  // 和真的一样：一期的操作在管理页里拿着同一把锁；应用、撤销进行中，最近一次应用的状态是 running / undoing；从备份恢复不改状态
  const hold = (op) => ev(`window.__hold = new Promise((ok) => { window.__release = ok }); navigator.locks.request('bt-bookmarks', { mode: 'exclusive' }, async () => { await chrome.storage.session.set({ 'bt:op': { op: ${JSON.stringify(op)}, since: Date.now() } }); await window.__hold; await chrome.storage.session.remove('bt:op') }); true`)
  const release = () => ev('window.__release(); true')
  const setLog = (status) => ev(`chrome.storage.local.set({ 'apply:apply-e2e': ${JSON.stringify(organizedLog(status))} })`)
  const reaches = (id, parentId, ms) => mgr.waitFor(`chrome.bookmarks.get(${JSON.stringify(id)}).then((r) => r[0].parentId === ${JSON.stringify(parentId)})`, ms).then(() => true, () => false)
  const queued = async (id) => ((await ev(`chrome.storage.session.get('auto:queue').then((r) => r['auto:queue'] ?? [])`)) || []).some((j) => j.bookmarkId === id)

  // 恢复进行中（状态是「完成」）：提交等锁；重建的（在 autoOwn 里）不动
  const restoreUrl = U('plain.bt-test', '/p?t=恢复中收藏')
  const ownUrl = U('plain.bt-test', '/p?t=撤销重建的')
  await open(restoreUrl)
  await open(ownUrl)
  await hold('restore')
  const restoreId = await create(ids.other, '恢复中收藏', restoreUrl)
  const ownId = await create(ids.other, '撤销重建的', ownUrl)
  await ev(`(async () => { const r = await chrome.storage.local.get('autoOwn'); await chrome.storage.local.set({ autoOwn: [...(r.autoOwn ?? []), ${JSON.stringify(ownId)}] }); return true })()`)
  await sleep(11000)
  const restoreHeld = (await parentOf(restoreId)) === ids.other
  await release()
  const restoreAfter = await reaches(restoreId, ids.vue, 15000)
  const ownStill = (await parentOf(ownId)) === ids.other && requestFor(ownId).length === 0
  record('A4', restoreHeld && restoreAfter && ownStill,
    `从备份恢复拿着锁时 11 秒都没动：${restoreHeld}；放锁后放好了：${restoreAfter}；撤销、恢复重建的（在 autoOwn 里）没动、没发请求：${ownStill}`)

  // 应用进行中（状态 running）：先排着、不发请求；应用完成后放好
  const applyUrl = U('plain.bt-test', '/p?t=应用中收藏')
  await open(applyUrl)
  await setLog('running')
  await hold('apply')
  const applyId = await create(ids.other, '应用中收藏', applyUrl)
  await sleep(11000)
  const applyHeld = (await parentOf(applyId)) === ids.other && requestFor(applyId).length === 0 && (await queued(applyId))
  await setLog('done')
  await release()
  const applyAfter = await reaches(applyId, ids.vue, 15000)
  record('A4-应用', applyHeld && applyAfter, `一期应用进行中收藏的：11 秒里没动、没发请求、还在队列里：${applyHeld}；应用完成、放锁后放好了：${applyAfter}`)

  // 撤销进行中（状态 undoing）：撤销完了（undone）就不处理，和 P2 一致
  const undoUrl = U('plain.bt-test', '/p?t=撤销中收藏')
  await open(undoUrl)
  await setLog('undoing')
  await hold('undo')
  const undoId = await create(ids.other, '撤销中收藏', undoUrl)
  await sleep(11000)
  const undoQueued = await queued(undoId)
  await setLog('undone')
  await release()
  await sleep(6000)
  const undoNever = (await parentOf(undoId)) === ids.other && requestFor(undoId).length === 0 && !(await queued(undoId))
  await setLog('done')
  record('A4-撤销', undoQueued && undoNever, `一期撤销进行中收藏的：撤销中排着 ${undoQueued}；撤销完以后没动、没发请求、出了队列：${undoNever}`)

  // ---------------------------------------------------------------- 第 3 轮：P2 没整理过（最近一次应用不是「完成」）
  await ev(`chrome.storage.local.set({ 'apply:apply-e2e': ${JSON.stringify(organizedLog('undone'))} })`)
  const gateUrl = U('plain.bt-test', '/p?t=撤销后收藏')
  await open(gateUrl)
  const gateId = await create(ids.other, '撤销后收藏', gateUrl)
  await sleep(10000)
  const gateStatus = await send('auto:status')
  record('P2', (await parentOf(gateId)) === ids.other && requestFor(gateId).length === 0 && !gateStatus.organized && gateStatus.unfiled === 0,
    `最近一次应用是「已撤销」时：新收藏不动、不发请求；弹窗状态 organized=${gateStatus.organized}，没放好 ${gateStatus.unfiled}（整理不可用）`)

  // 弹窗里：最近一次应用不是「完成」的三种情况，各自写出原因，没有「整理」按钮
  const popGate = async () => {
    const p = await browser.open('popup.html')
    const r = await p
      .waitFor(`document.querySelector('.pop-gate span') ? { text: document.querySelector('.pop-gate span').textContent.trim(), run: !!document.querySelector('.pop-run') } : null`, 15000)
      .catch(() => ({ text: '（没出来）', run: true }))
    await p.close().catch(() => {})
    return r
  }
  const gates = {}
  gates['已撤销'] = await popGate()
  await ev(`chrome.storage.local.set({ 'apply:apply-e2e': ${JSON.stringify(organizedLog('running'))} })`)
  gates['应用停在一半'] = await popGate()
  await ev(`chrome.storage.local.remove('apply:latest')`)
  gates['从没应用过'] = await popGate()
  await ev(`chrome.storage.local.set({ 'apply:latest': 'apply-e2e' })`)
  const wantGate = { 已撤销: '整理已撤销', 应用停在一半: '上次整理没做完', 从没应用过: '还没整理过' }
  record('P2-弹窗', Object.entries(wantGate).every(([k, v]) => gates[k].text === v && !gates[k].run),
    Object.entries(gates).map(([k, g]) => `${k}：「${g.text}」，整理按钮 ${g.run ? '有' : '没有'}`).join('；'))
  await ev(`chrome.storage.local.set({ 'apply:apply-e2e': ${JSON.stringify(organizedLog('done'))} })`)

  // ---------------------------------------------------------------- 第 4 轮：B 一键整理
  const st0 = await send('auto:status')
  const waitBatch = (phase) => mgr.waitFor(`chrome.storage.session.get('auto:batch').then((r) => r['auto:batch']?.phase === ${JSON.stringify(phase)} ? r['auto:batch'] : null)`, 60000)
  await send('auto:run')
  const done1 = await waitBatch('done')
  const after1 = await send('auto:status')
  // K1：这时只剩待整理里的那条，角标是空的
  const badgeAfter1 = await send('e2e:badge')
  record('K1-角标空', after1.unfiled === 0 && after1.pending >= 1 && badgeAfter1 === '', `只剩待整理里的（待处理 M = ${after1.pending}）：弹窗的 N = ${after1.unfiled}，角标文字「${badgeAfter1}」`)
  const noTabNow = await parentOf(b.noTab)
  // 通知里点过「撤销」的那条（A5）也在其他书签根下，但用户撤销过，不算；待整理里的那条（bookmark-ux K1）不算
  const undoneStays = (await parentOf(b.pub)) === ids.other
  const unsureStays = (await parentOf(b.unsure)) === unsureParent
  record('K1', st0.unfiled === 5 && st0.pending >= 1 && done1.result.filed + done1.result.toInbox === 5 && noTabNow === ids.vue && undoneStays && unsureStays && after1.unfiled === 0,
    `「放好 ${st0.unfiled} 条」= 其他书签根下、AI 还没看过的 5 条：没开标签页收藏的、一期撤销中和撤销后（自动整理停着）收藏的 2 条、8 秒内重复收藏的第一条、撤销或恢复重建出来的。待整理里的那条不算、没被挪：${unsureStays}（待处理 M = ${st0.pending}）；通知里点过「撤销」的那条没算、留在原处：${undoneStays}。放好 ${done1.result.filed}、进待整理 ${done1.result.toInbox}、跳过 ${done1.result.skipped}；没开标签页那条放进了「前端/Vue」：${noTabNow === ids.vue}；之后还剩 ${after1.unfiled}（K2）`)
  const batch1 = after1.lastBatch
  const undoneN = await send('auto:undo-batch', { batchId: batch1 })
  record('B3', undoneN >= 1 && (await parentOf(b.noTab)) === ids.other, `「撤销这次」移回 ${undoneN} 条；没开标签页那条回到原处：${(await parentOf(b.noTab)) === ids.other}`)

  const many = []
  for (let i = 0; i < 12; i++) many.push(await create(ids.other, i === 0 ? `CSS 不确定 ${i}` : `AI 工具 ${i}`, U('plain.bt-test', `/m?i=${i}`)))
  await send('auto:run')
  const preview = await waitBatch('preview')
  // 弹窗里的预览：每条一行，写着去向，默认全勾上
  const pv = await browser.open('popup.html')
  const shownRows = await pv
    .waitFor(`(() => { const rows = [...document.querySelectorAll('.pop-preview li')]; return rows.length ? rows.map((li) => ({ title: li.querySelector('.pop-title')?.textContent.trim(), path: li.querySelector('.pop-sub')?.textContent.trim(), checked: !!li.querySelector('input[type=checkbox]')?.checked })) : null })()`, 15000)
    .catch(() => [])
  await pv.close().catch(() => {})
  const wantPath = new Map(preview.items.map((i) => [i.title, i.path]))
  const listOk = shownRows.length === preview.items.length && shownRows.every((r) => r.path && r.path === wantPath.get(r.title) && r.checked)
  const unmovedDuringPreview = (await Promise.all(many.map(parentOf))).every((p) => p === ids.other)
  // 勾 3 条：拿不准的那条（去向「待整理」）和两条有把握的
  await send('auto:apply-batch', { batchId: preview.id, ids: [many[0], many[1], many[2]] })
  const done2 = await waitBatch('done')
  const moved2 = await Promise.all(many.map(parentOf))
  const after2 = await send('auto:status')
  record('B2', preview.items.length >= 12 && listOk && unmovedDuringPreview && moved2[0] === inbox && moved2[1] === ids.ai && moved2[2] === ids.ai && moved2.slice(3).every((p) => p === ids.other),
    `超过 10 条（${preview.items.length} 条）先出预览；弹窗里列出 ${shownRows.length} 行，每行写着去向（如「${shownRows[0]?.title}」→「${shownRows[0]?.path}」「${shownRows[1]?.title}」→「${shownRows[1]?.path}」）、默认勾上：${listOk}；预览期间一条没动：${unmovedDuringPreview}；只勾 3 条，放好 ${done2.result.filed}、进待整理 ${done2.result.toInbox}、跳过 ${done2.result.skipped}；拿不准的那条进了待整理：${moved2[0] === inbox}；没勾的都没动`)
  // K7：弹窗里的结果写「N 条拿不准，在待整理里」，点「去处理」打开管理页的待处理
  const pr = await browser.open('popup.html')
  const resultText = await pr.waitFor(`document.querySelector('.pop-result')?.textContent.replace(/\\s+/g, ' ').trim() ?? null`, 15000).catch(() => null)
  const tri2 = await triageTabs()
  await pr.evaluate(`([...document.querySelectorAll('.pop-result .link')].find((b) => b.textContent.trim() === '去处理')?.click(), true)`).catch(() => {})
  await sleep(1000)
  const tri3 = await triageTabs()
  record('K7', !!resultText && resultText.includes(`${done2.result.toInbox} 条拿不准，在待整理里`) && done2.result.toInbox === 1 && tri3 === tri2 + 1,
    `弹窗结果「${resultText}」；点「去处理」后管理页的待处理标签页 ${tri2} → ${tri3}`)
  const placed = (await local('handPlaced')) ?? []
  record('K2-预览没勾的', after2.unfiled === 0 && many.slice(3).every((id) => placed.includes(id)),
    `预览里没勾的 ${many.slice(3).length} 条记成你定过位置：${many.slice(3).every((id) => placed.includes(id))}；之后「放好 N 条」的 N = ${after2.unfiled}`)

  // ---------------------------------------------------------------- C1 地址栏
  const sugg = await send('e2e:search', { q: '响应式 原理' })
  await send('e2e:omnibox-enter', { text: '响应式 原理', disposition: 'newForegroundTab' })
  await sleep(800)
  const mgrTab = (await browser.cdp.send('Target.getTargets')).targetInfos.some((t) => t.url.includes('/manager.html?q='))
  await send('e2e:omnibox-enter', { text: sugg[0]?.content ?? '', disposition: 'newBackgroundTab' })
  await sleep(500)
  // 第 1 轮已经开着一个同样网址的标签页，选建议后应该多出一个
  const openedUrl = (await browser.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.url === sugg[0]?.content).length >= 2
  record('C1', sugg.length >= 1 && sugg.length <= 6 && sugg[0].content === urls.pub && /<dim>/.test(sugg[0].description) && mgrTab && openedUrl,
    `「s 响应式 原理」出 ${sugg.length} 条建议，第一条是那篇公开文章；描述「${sugg[0]?.description}」；选建议打开网页：${openedUrl}；直接回车打开管理页带上搜索词：${mgrTab}`)

  // ---------------------------------------------------------------- K8 计数照存、K1 角标 = N、K4 角标开关、T4 key
  await ev(`chrome.bookmarks.move(${JSON.stringify(b.priv)}, { parentId: ${JSON.stringify(ids.css)} })`)
  // 一条没开标签页的新书签散放在其他书签根下：N = 1，角标开关才看得出区别
  await create(ids.other, '没开标签页的新收藏', U('plain.bt-test', '/badge'))
  await sleep(800)
  const st = await send('auto:status')
  const badge = await send('e2e:badge')
  record('K8', st.stats.filed >= 4 && st.stats.toInbox >= 1 && st.stats.undone >= 2 && st.stats.movedAgain === 1 && st.stats.omnibox >= 2,
    `计数照样存在本机（弹窗不显示）：自动放 ${st.stats.filed}、进待整理 ${st.stats.toInbox}、撤销 ${st.stats.undone}、又挪走 ${st.stats.movedAgain}、地址栏 ${st.stats.omnibox}`)
  record('K1-角标', st.unfiled === 1 && badge === '1', `角标「${badge}」= 弹窗的 N ${st.unfiled}`)
  const setBadge = (on) => ev(`chrome.storage.local.get('settings').then((r) => chrome.storage.local.set({ settings: { ...r.settings, badge: ${on} } }))`)
  await setBadge(false)
  const badgeOff = await send('e2e:badge')
  const nOff = (await send('auto:status')).unfiled
  await setBadge(true)
  const badgeOn = await send('e2e:badge')
  record('K4', badgeOff === '' && nOff === 1 && badgeOn === '1', `设置里关掉「工具栏角标」：角标「${badgeOff}」，弹窗的 N 照样是 ${nOff}；打开后角标「${badgeOn}」`)

  const stored = await ev(`Promise.all([chrome.storage.local.get(null), chrome.storage.session.get(null)]).then(([l, s]) => { delete l.settings; return JSON.stringify(l) + JSON.stringify(s) })`)
  const inBodies = aiRequests.some((r) => r.body.includes(KEY))
  const withAuth = aiRequests.every((r) => r.auth === `Bearer ${KEY}`)
  const inErrors = [...mgr.errors].some((e) => e.includes(KEY))
  const inSw = swLogs.some((l) => l.includes(KEY))
  const sw1 = await swOf()
  const swSame = !!sw0 && sw1?.targetId === sw0.targetId
  record('T4', !stored.includes(KEY) && !inBodies && withAuth && !inErrors && !!sw0 && !inSw,
    `key 出现在：存储（除设置外）${stored.includes(KEY)}、请求体 ${inBodies}、管理页的报错和 console.error ${inErrors}、后台的全部 console 和报错 ${inSw}（收到 ${swLogs.length} 条；从头到尾是同一个后台：${swSame}）；${aiRequests.length} 个请求都只在 Authorization 头里带 key：${withAuth}`)

  // 弹窗（真实数据）截图
  const pop = await browser.open('popup.html')
  await pop.waitFor(`!!document.querySelector('.pop-main')`, 15000)
  await sleep(500)
  await pop.screenshot(path.join(values.out, 'auto-popup-real.png'), { width: 360, height: 560 })

  // ---------------------------------------------------------------- C2 弹窗搜索：边输边出结果，点一条打开
  await pop.evaluate(`(() => { const i = document.querySelector('.pop-search input'); i.value = '响应式'; i.dispatchEvent(new Event('input')); return true })()`)
  const rowsShown = await pop.waitFor(`document.querySelectorAll('.pop-row').length`, 5000).catch(() => 0)
  const firstUrl = await pop.evaluate(`document.querySelector('.pop-row')?.title ?? ''`)
  const tabsOf = async (u) => (await browser.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.url === u).length
  const tabsBefore = await tabsOf(firstUrl)
  await pop.evaluate(`(document.querySelector('.pop-row')?.click(), true)`).catch(() => {})
  await sleep(1000)
  const tabsAfter = await tabsOf(firstUrl)
  record('C2', rowsShown >= 1 && firstUrl === urls.pub && tabsAfter === tabsBefore + 1,
    `弹窗搜索框输入「响应式」：出 ${rowsShown} 条，第一条是那篇公开文章 ${firstUrl === urls.pub}；点它后多开了一个它的标签页：${tabsAfter === tabsBefore + 1}（${tabsBefore} → ${tabsAfter}）`)

  // ---------------------------------------------------------------- P1 弹窗里的「管理页」
  const pm = await browser.open('popup.html')
  await pm.waitFor(`[...document.querySelectorAll('.pop-foot button')].some((b) => b.textContent.trim() === '管理页')`, 15000).catch(() => {})
  const managerTabs = async () =>
    (await browser.cdp.send('Target.getTargets')).targetInfos.filter((t) => t.type === 'page' && t.url.startsWith(`chrome-extension://${browser.extId}/manager.html`)).length
  const m0 = await managerTabs()
  await pm.evaluate(`([...document.querySelectorAll('.pop-foot button')].find((b) => b.textContent.trim() === '管理页').click(), true)`).catch(() => {})
  await sleep(1000)
  const m1 = await managerTabs()
  record('P1-弹窗', m1 === m0 + 1, `弹窗里点「管理页」：管理页的标签页 ${m0} → ${m1}`)

  // ---------------------------------------------------------------- K6 弹窗里的「待处理 M」打开管理页的待处理
  const pt = await browser.open('popup.html')
  const pendingText = await pt.waitFor(`document.querySelector('.pop-pending')?.textContent.replace(/\\s+/g, '') ?? null`, 15000).catch(() => null)
  const triage0 = await triageTabs()
  await pt.evaluate(`(document.querySelector('.pop-pending').click(), true)`).catch(() => {})
  await sleep(1000)
  const triage1 = await triageTabs()
  const pendingNow = (await send('auto:status')).pending
  record('K6', pendingText === `待处理${pendingNow}` && pendingNow > 0 && triage1 === triage0 + 1, `弹窗里「${pendingText}」（待处理 M = ${pendingNow}）；点了以后管理页的待处理标签页 ${triage0} → ${triage1}`)
  record('页面报错', ![...mgr.errors, ...pop.errors].length, `${[...mgr.errors, ...pop.errors].length} 条${[...mgr.errors, ...pop.errors].length ? '：' + [...mgr.errors, ...pop.errors].slice(0, 2).join(' | ') : ''}`)
} catch (e) {
  exitCode = 1
  console.error(e)
  record('运行', false, e instanceof Error ? e.message : String(e))
} finally {
  await browser.close()
  server.close()
}
evidence.finishedAt = new Date().toISOString()
evidence.aiRequests = aiRequests.length
const file = path.join(values.out, `auto-evidence-${Date.now()}.json`)
fs.writeFileSync(file, JSON.stringify(evidence, null, 2))
const failed = results.filter((r) => !r.ok)
console.log(failed.length || exitCode ? `有 ${failed.length} 项没过；证据：${file}` : `全部通过（${results.length} 项）；证据：${file}`)
process.exit(failed.length || exitCode ? 1 : 0)

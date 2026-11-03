#!/usr/bin/env node
// accept D2：把接口地址指到本地假服务，逐字段检查发给 AI 的请求体。
// 用合成的书签，不碰真实书签：标题和网页简介里有邮箱、手机号，网址带参数、# 和长随机串，还有一个锁定的「受保护资料」文件夹。
// 打印的样本只含合成数据，可以直接贴进验收材料。
// 用法：npm run build:e2e && node tools/e2e/ai-requests.mjs [--ext .output/chrome-mv3-e2e]
// 退出码：0 全部符合；1 有不符合的项。

import http from 'node:http'
import { parseArgs } from 'node:util'
import { launch } from './browser.mjs'

const { values } = parseArgs({ options: { ext: { type: 'string', default: '.output/chrome-mv3-e2e' } } })
const KEY = 'sk-e2e-fake-key-0000'

// ---------------------------------------------------------------- 假的 OpenAI 兼容接口

/** 收到的请求：路径、Authorization 头、请求体 */
const seen = []
const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const body = JSON.parse(raw || '{}')
  seen.push({ path: req.url, auth: req.headers.authorization || '', body })
  const sys = body.messages?.[0]?.content || ''
  const user = body.messages?.[1]?.content || ''
  const ids = user.split('\n').slice(1).map((l) => l.split(' | ')[0])
  let data = { ok: true } // 测试连接
  if (sys.includes('desc：一句话说明')) data = { items: ids.map((id) => ({ id, desc: `说明 ${id}`, title: `标题 ${id}`, tags: ['前端'], type: '文章' })) }
  else if (sys.includes('重新设计')) data = { folders: [{ name: '前端', desc: '前端资料' }, { name: '杂项', desc: '其他' }] }
  else if (sys.includes('放进最合适的一个目录')) data = { items: ids.map((id, i) => ({ id, path: i % 2 ? '杂项' : '前端', confidence: 0.9 })) }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(data) } }], usage: { prompt_tokens: 100, completion_tokens: 20 } }))
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`

// ---------------------------------------------------------------- 合成书签

const VUE = 'https://cn.vuejs.org/guide/introduction.html?utm_source=x#what-is-vue'
const PHONE = 'https://example.com/p/1'
const ROWS = [
  ['Vue 文档 - 有问题发 dev@example.com', VUE],
  ['手机 13812345678 绑定教程', PHONE],
  ['分享链接', 'https://example.com/share/AbCdEfGhIjKlMnOpQrStUvWx12345678/view'],
  ['搜索结果', 'https://example.com/search?q=vue&page=2'],
  ['CSS 布局', 'https://css.example.com/layout'],
  ['JS 数组方法', 'https://js.example.com/array'],
  ['小程序登录', 'https://mp.example.com/login-guide'],
  ['Vite 配置', 'https://vite.example.com/config']
]
const LOCKED_ROWS = [
  ['受保护资料周报 2026 第 44 周', 'https://corp.example.com/docs/weekly-44'],
  ['OA 审批', 'https://oa.example.com/approve/list']
]
const SEED = `(async () => {
  const mk = (parentId, title, url) => chrome.bookmarks.create({ parentId, title, ...(url ? { url } : {}) })
  const fe = await mk('1', '前端资料')
  for (const [t, u] of ${JSON.stringify(ROWS)}) await mk(fe.id, t, u)
  const corp = await mk('1', '受保护资料')
  const locked = []
  for (const [t, u] of ${JSON.stringify(LOCKED_ROWS)}) locked.push((await mk(corp.id, t, u)).id)
  for (let i = 0; i < 4; i++) await mk('2', '杂项 ' + i, 'https://misc.example.com/' + i)
  // 抓到的网页简介：一条很长（测截到 200 字），一条带邮箱和手机号（测脱敏）
  await chrome.storage.local.set({
    ${JSON.stringify(`page:${VUE}`)}: { url: ${JSON.stringify(VUE)}, status: 'ok', description: '很长的网页简介'.repeat(60), fetchedAt: Date.now() },
    ${JSON.stringify(`page:${PHONE}`)}: { url: ${JSON.stringify(PHONE)}, status: 'ok', description: '有问题联系 admin@corp.example.com 或 13900001111', fetchedAt: Date.now() }
  })
  return { corp: corp.id, locked }
})()`

// ---------------------------------------------------------------- 跑

let bad = 0
const expect = (ok, label, detail = '') => {
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `：${detail}` : ''}`)
}

const browser = await launch({ extPath: values.ext })
try {
  const page = await browser.open('manager.html')
  await page.waitFor('window.__bt && document.querySelector(".content")', 30000)
  const seed = await page.evaluate(SEED)
  await page.evaluate(`(async () => {
    const w = window.__bt.workflow
    await w.saveSettings({ ai: { baseUrl: ${JSON.stringify(base)}, apiKey: ${JSON.stringify(KEY)}, model: 'deepseek-flash', disableThinking: true } })
    const t = await w.testAi()
    if (!t.ok) throw new Error('假接口连不上：' + t.message)
    await w.describe(() => {})
    const s = await w.getSettings()
    await w.buildPlan({ maxTop: s.maxTop, emoji: s.emoji, ruleTitles: s.ruleTitles, lockedFolderIds: [${JSON.stringify(seed.corp)}], keepLooseBarItems: s.keepLooseBarItems }, () => {})
    return true
  })()`)

  const kindOf = (sys) => (sys.includes('desc：一句话说明') ? 'describe' : sys.includes('重新设计') ? 'taxonomy' : sys.includes('放进最合适的一个目录') ? 'classify' : 'other')
  const reqs = seen.map((r) => ({ ...r, kind: kindOf(r.body.messages?.[0]?.content || ''), user: r.body.messages?.[1]?.content || '' }))
  const of = (k) => reqs.filter((r) => r.kind === k)
  const lines = (r) => r.user.split('\n').slice(1)
  const fields = (k) => of(k).flatMap(lines).map((l) => l.split(' | '))
  const all = JSON.stringify(seen.map((r) => r.body))

  console.log(`请求 ${reqs.length} 个：说明 ${of('describe').length}、目录 ${of('taxonomy').length}、归类 ${of('classify').length}、测试连接 ${of('other').length}`)
  expect(reqs.every((r) => r.path === '/chat/completions'), '都发到「接口地址 + /chat/completions」')
  expect(reqs.every((r) => r.auth === `Bearer ${KEY}`), 'key 只在 Authorization 头里')
  expect(!all.includes(KEY), '请求体里没有 key')
  const allowed = new Set(['model', 'messages', 'response_format', 'temperature', 'stream', 'thinking'])
  expect(reqs.every((r) => Object.keys(r.body).every((k) => allowed.has(k))), '请求体顶层只有 model、messages、response_format、temperature、stream、thinking')
  expect(reqs.every((r) => r.body.thinking?.type === 'disabled'), '都关了思考模式')

  const d = fields('describe')
  expect(d.length === ROWS.length + 4 && d.every((f) => f.length === 5), '说明：每行 5 个字段（id | 标题 | 网址 | 简介 | 文件夹）', `${d.length} 行`)
  expect(d.every((f) => !/[?#]/.test(f[2])), '说明：网址没有 ? 参数和 # 后面的部分')
  expect(d.every((f) => [...f[3]].length <= 200), '说明：简介不超过 200 字', `最长 ${Math.max(...d.map((f) => [...f[3]].length))}`)
  const c = fields('classify')
  expect(c.length === ROWS.length + 4 && c.every((f) => f.length === 5), '归类：每行 5 个字段（id | 标题 | 说明 | 标签 | 类型）', `${c.length} 行`)
  const t = fields('taxonomy')
  expect(t.length === ROWS.length + 4 && t.every((f) => f.length === 4), '目录：每行 4 个字段（类型 | 标签 | 说明 | 原文件夹）', `${t.length} 行`)

  const users = reqs.map((r) => r.user).join('\n')
  expect(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(users) && users.includes('{邮箱}'), '邮箱换成了 {邮箱}（标题和网页简介里各有一个）')
  expect(!/(?<!\d)1[3-9]\d{9}(?!\d)/.test(users) && users.includes('{手机号}'), '手机号换成了 {手机号}')
  expect(!users.includes('AbCdEfGhIjKlMnOpQrStUvWx12345678') && users.includes('{随机串}'), '网址路径里的长随机串换成了 {随机串}')
  expect(!users.includes('utm_source') && !users.includes('page=2'), '参数没有发出去')

  const lockedIds = new Set(seed.locked)
  expect(![...d, ...c].some((f) => lockedIds.has(f[0])), '锁定文件夹里的书签 id 不在任何请求里')
  expect(!all.includes('corp.example.com') && !all.includes('oa.example.com') && !all.includes('周报') && !all.includes('OA 审批'), '锁定书签的标题和网址不在任何请求里')
  expect(!all.includes('受保护资料'), '锁定文件夹的名字不在任何请求里（提示词也不写）')

  console.log('\n样本（合成数据）：')
  for (const k of ['describe', 'taxonomy', 'classify']) {
    const r = of(k)[0]
    if (!r) continue
    console.log(`— ${k}：${r.user.split('\n')[0]}`)
    for (const l of lines(r).slice(0, 4)) console.log(`  ${l.length > 160 ? l.slice(0, 160) + '…' : l}`)
  }
  if (page.errors.length) expect(false, '页面没有报错', page.errors.slice(0, 2).join(' | '))
} finally {
  await browser.close()
  server.close()
}
console.log(bad ? `\n不符合 ${bad} 项` : '\n全部符合')
process.exitCode = bad ? 1 : 0

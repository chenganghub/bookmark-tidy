import { describe, expect, it } from 'vitest'
import { createAutoFiler, type AutoNotice, type PageRead } from '../src/core/autofile'
import { createMutationLock } from '../src/core/locks'
import { createFakeBookmarks, folder, link, treeOf } from '../src/core/memory-bookmarks'
import { createStore, memoryKV } from '../src/core/store'
import { flattenTree } from '../src/core/tree'
import type { ApplyLog, ChatMessage } from '../src/core/types'

const T0 = 1_800_000_000_000
const DAY = 86400000

/** 整理过的书签：前端/Vue、前端/CSS、AI 工具；锁定的「受保护资料」 */
const tree = () =>
  treeOf([
    folder('前端', [folder('Vue', [link('Vue 文档', 'https://cn.vuejs.org/guide', {}, 'v1')], 'FV'), folder('CSS', [link('CSS 技巧', 'https://css.com/1', {}, 'c1')], 'FC')], 'FE'),
    folder('AI 工具', [link('ChatGPT', 'https://chatgpt.com/', {}, 'a1')], 'FAI'),
    folder('受保护资料', [link('公司文档', 'https://oa.company.example/doc/1', {}, 'w1')], 'LOCK')
  ])

const doneLog = (status: ApplyLog['status'] = 'done'): ApplyLog => ({
  applyId: 'apply-1',
  planId: 'p',
  snapshotId: 's',
  status,
  startedAt: T0 - DAY,
  updatedAt: T0 - DAY,
  total: 1,
  done: 1,
  createdFolders: {},
  undoIdMap: {}
})

interface Opts {
  organized?: boolean
  tabs?: string[]
  pages?: Record<string, PageRead>
  publicHtml?: Record<string, string>
  answer?: (title: string) => { path: string; confidence: number } | 'fail'
  /** AI 请求发出、还没回来的时候做点什么（模拟用户这时候挪了书签） */
  duringChat?: () => Promise<void>
}

async function setup(o: Opts = {}) {
  let clock = T0
  const bm = createFakeBookmarks(tree())
  const kv = memoryKV()
  const session = memoryKV()
  const store = createStore(kv)
  await store.saveSettings({ ai: { baseUrl: 'https://api.deepseek.com', apiKey: 'k', model: 'deepseek-flash', disableThinking: true } })
  if (o.organized !== false) await store.saveLog(doneLog())
  const tabUrls = o.tabs ?? []
  const prompts: ChatMessage[][] = []
  const notices: AutoNotice[] = []
  const readCalls: number[] = []
  const fetched: string[] = []
  const lock = createMutationLock({ session })
  const deps: Parameters<typeof createAutoFiler>[0] = {
    bookmarks: bm,
    kv,
    session,
    lock,
    tabs: { query: async () => tabUrls.map((url, i) => ({ id: i + 1, url })) },
    readPage: async (tabId) => {
      readCalls.push(tabId)
      return o.pages?.[tabUrls[tabId - 1]]
    },
    hasSitePermission: async () => true,
    notify: (n) => void notices.push(n),
    heartbeatMs: 10,
    fetchImpl: (async (url: string) => {
      fetched.push(url)
      const html = o.publicHtml?.[url]
      if (html === undefined) return new Response('', { status: 404, headers: { 'content-type': 'text/html' } })
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } })
    }) as unknown as typeof fetch,
    chat: async (messages) => {
      prompts.push(messages)
      await o.duringChat?.()
      const line = messages[1].content.split('\n')[1]
      const [id, title] = line.split(' | ')
      const a = o.answer?.(title) ?? { path: '前端/Vue', confidence: 0.95 }
      if (a === 'fail') throw new Error('接口拒绝访问（HTTP 401），检查 API key')
      return { data: { items: [{ id, desc: `说明：${title}`, title: `AI ${title}`, tags: ['t'], type: '文章', ...a }] }, usage: { requests: 1, promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 } }
    },
    now: () => clock
  }
  const filer = createAutoFiler(deps)
  const save = async (title: string, url: string, parentId = '2') => {
    const node = await bm.create({ parentId, title, url })
    return { node, queued: await filer.onCreated(node.id, node) }
  }
  const later = async (ms = 8001) => {
    clock += ms
    await filer.processDue()
  }
  const parentOf = async (id: string) => (await bm.get(id))[0].parentId
  // 后台被浏览器停掉又起来：内存全丢，存储（本地、会话）还在
  const restart = () => createAutoFiler(deps)
  return { bm, kv, session, store, filer, lock, prompts, notices, readCalls, fetched, save, later, parentOf, restart, tick: (ms: number) => (clock += ms) }
}

describe('收藏即整理：入队', () => {
  it('当场收藏（网址开在标签页里）才入队；没开的、没整理过的、锁定文件夹里的不入队', async () => {
    const t = await setup({ tabs: ['https://juejin.cn/post/1#comment'] })
    expect((await t.save('Vue 响应式', 'https://juejin.cn/post/1')).queued).toBe(true)
    expect((await t.save('手机上收藏的', 'https://m.com/x')).queued).toBe(false)
    expect((await t.save('公司', 'https://juejin.cn/post/1', 'LOCK')).queued).toBe(false)
    // 锁定文件夹的子文件夹里也不处理：不入队、不问 AI、不动
    const sub = await t.bm.create({ parentId: 'LOCK', title: '子目录' })
    const inSub = await t.save('子目录里的', 'https://juejin.cn/post/1', sub.id)
    expect(inSub.queued).toBe(false)
    await t.later()
    expect(await t.parentOf(inSub.node.id)).toBe(sub.id)
    expect(t.prompts.map((p) => p[1].content).join('\n')).not.toContain('子目录里的')
    const n = await setup({ organized: false, tabs: ['https://juejin.cn/post/1'] })
    expect((await n.save('Vue 响应式', 'https://juejin.cn/post/1')).queued).toBe(false)
  })

  it('自动整理关掉时不入队', async () => {
    const t = await setup({ tabs: ['https://juejin.cn/post/1'] })
    await t.store.saveSettings({ autoFile: false })
    expect((await t.save('Vue', 'https://juejin.cn/post/1')).queued).toBe(false)
  })

  it('导入期间不入队；导入结束时丢掉导入期间进队的', async () => {
    const t = await setup({ tabs: ['https://a.com/1', 'https://a.com/2'] })
    await t.save('先收藏的', 'https://a.com/1')
    t.tick(1)
    await t.filer.onImportBegan()
    expect((await t.save('导入的', 'https://a.com/2')).queued).toBe(false)
    await t.filer.onImportEnded()
    expect(((await t.session.get('auto:queue'))['auto:queue'] as unknown[]).length).toBe(1)
  })
})

describe('收藏即整理：处理', () => {
  it('8 秒前不动；8 秒后放进建议的目录，标题按规则清理，存说明、正文、记录、计数，并通知', async () => {
    const url = 'https://blog.csdn.net/u/article/details/1'
    const t = await setup({ tabs: [url], pages: { [url]: { url, title: 't', description: '网页简介', text: '正文内容'.repeat(10) } } })
    const { node } = await t.save('Vue 响应式原理-CSDN博客', url)
    await t.later(7000)
    expect(await t.parentOf(node.id)).toBe('2')
    await t.later(1001)
    expect(await t.parentOf(node.id)).toBe('FV')
    expect((await t.bm.get(node.id))[0].title).toBe('Vue 响应式原理')
    expect((await t.store.getMeta())[node.id]).toMatchObject({ desc: '说明：Vue 响应式原理', tags: ['t'], type: '文章' })
    expect((await t.store.getText(node.id))?.text).toContain('正文内容')
    expect(await t.store.getRecord(node.id)).toMatchObject({ status: 'filed', path: '前端/Vue', from: { parentId: '2', title: 'Vue 响应式原理-CSDN博客' }, to: { parentId: 'FV', title: 'Vue 响应式原理' } })
    expect((await t.store.getStats()).filed).toBe(1)
    expect(t.notices).toEqual([{ bookmarkId: node.id, title: '已放进「前端/Vue」', message: '说明：Vue 响应式原理' }])
    // 提示词里：候选目录不含锁定文件夹；没有当前文件夹
    const all = t.prompts.flat().map((m) => m.content).join('\n')
    expect(all).toContain('前端/Vue')
    expect(all).not.toContain('受保护资料')
    expect(all).not.toContain('其他书签')
  })

  it('把握不够：放进「其他书签/待整理」（没有就建）', async () => {
    const t = await setup({ tabs: ['https://x.com/a'], answer: () => ({ path: 'AI 工具', confidence: 0.4 }) })
    const { node } = await t.save('不好说', 'https://x.com/a')
    await t.later()
    const inbox = (await t.bm.getChildren('2')).find((c) => c.title === '待整理')
    expect(inbox).toBeDefined()
    expect(await t.parentOf(node.id)).toBe(inbox!.id)
    expect((await t.store.getRecord(node.id))?.status).toBe('inbox')
    expect(t.notices[0].title).toBe('放进了「待整理」')
  })

  it('等待期里用户挪过：不移动；改过标题：不改标题；说明照写', async () => {
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'] })
    const a = (await t.save('原标题 - 知乎', 'https://x.com/a')).node
    const b = (await t.save('原标题 - 知乎', 'https://x.com/b')).node
    await t.bm.move(a.id, { parentId: 'FAI' })
    await t.bm.update(b.id, { title: '我自己起的名字' })
    await t.later()
    expect(await t.parentOf(a.id)).toBe('FAI')
    expect((await t.bm.get(a.id))[0].title).toBe('原标题')
    expect(await t.parentOf(b.id)).toBe('FV')
    expect((await t.bm.get(b.id))[0].title).toBe('我自己起的名字')
    expect((await t.store.getMeta())[a.id]).toBeDefined()
    // a 只改了标题，不通知；b 挪了位置，通知
    expect(t.notices.map((n) => n.bookmarkId)).toEqual([b.id])
  })

  it('过了 8 秒、AI 还没回来时用户挪过：不移动；每条最多自动移动一次（同一条再来一次收藏事件也不再动、不再问 AI）', async () => {
    let duringChat: (() => Promise<unknown>) | undefined
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'], duringChat: async () => void (await duringChat?.()) })
    const a = (await t.save('等 AI 时挪走', 'https://x.com/a')).node
    duringChat = () => t.bm.move(a.id, { parentId: 'FAI' })
    await t.later()
    duringChat = undefined
    expect(await t.parentOf(a.id)).toBe('FAI')
    const b = (await t.save('放过一次', 'https://x.com/b')).node
    await t.later()
    expect(await t.parentOf(b.id)).toBe('FV')
    await t.bm.move(b.id, { parentId: 'FC' })
    await t.filer.onMoved(b.id, { parentId: 'FC' })
    const asked = t.prompts.length
    expect(await t.filer.onCreated(b.id, (await t.bm.get(b.id))[0])).toBe(true)
    await t.later()
    expect(await t.parentOf(b.id)).toBe('FC')
    expect(t.prompts.length).toBe(asked)
  })

  it('同一网页 8 秒内收藏两次：只处理后一条，通知里写以前收藏过', async () => {
    const t = await setup({ tabs: ['https://x.com/a'] })
    const first = (await t.save('第一次', 'https://x.com/a')).node
    const second = (await t.save('第二次', 'https://x.com/a#top')).node
    await t.later()
    expect(await t.parentOf(first.id)).toBe('2')
    expect(await t.parentOf(second.id)).toBe('FV')
    expect(t.prompts).toHaveLength(1)
    expect(t.notices[0].context).toBe('以前收藏过，在「其他书签」')
  })

  it('撤销、恢复重建的书签不处理；进了锁定文件夹的整条丢弃', async () => {
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'] })
    const a = (await t.save('重建的', 'https://x.com/a')).node
    const b = (await t.save('挪进锁定', 'https://x.com/b')).node
    await t.store.addOwn([a.id])
    await t.bm.move(b.id, { parentId: 'LOCK' })
    await t.later()
    expect(t.prompts).toHaveLength(0)
    expect(await t.parentOf(a.id)).toBe('2')
    expect(await t.parentOf(b.id)).toBe('LOCK')
    expect(await t.store.getText(b.id)).toBeUndefined()
  })

  it('一期的撤销拿着锁时，提交等它做完', async () => {
    const t = await setup({ tabs: ['https://x.com/a'] })
    const { node } = await t.save('等锁', 'https://x.com/a')
    const order: string[] = []
    let release!: () => void
    const held = t.lock.run('undo', () => new Promise<void>((r) => (release = () => (order.push('undo 结束'), r()))))
    const processing = t.later().then(() => order.push('自动整理提交'))
    await new Promise((r) => setTimeout(r, 20))
    expect(await t.parentOf(node.id)).toBe('2')
    release()
    await Promise.all([held, processing])
    expect(order).toEqual(['undo 结束', '自动整理提交'])
    expect(await t.parentOf(node.id)).toBe('FV')
  })

  it('一期的应用正在跑时收藏的：先排着，应用完成后照常放好', async () => {
    const t = await setup({ tabs: ['https://x.com/a'] })
    await t.store.saveLog({ ...doneLog('running'), applyId: 'apply-2', startedAt: T0 })
    const { node, queued } = await t.save('应用中收藏', 'https://x.com/a')
    expect(queued).toBe(true)
    await t.later()
    expect(t.prompts).toHaveLength(0)
    expect(await t.parentOf(node.id)).toBe('2')
    await t.store.saveLog({ ...doneLog('done'), applyId: 'apply-2', startedAt: T0 })
    await t.later(3001)
    expect(await t.parentOf(node.id)).toBe('FV')
  })

  it('撤销正在跑时收藏的：撤销完就不处理；应用停在一半的，等满 10 分钟就不等了', async () => {
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'] })
    const queue = async () => (await t.session.get('auto:queue'))['auto:queue']
    await t.store.saveLog(doneLog('undoing'))
    const a = (await t.save('撤销中收藏', 'https://x.com/a')).node
    await t.later()
    await t.store.saveLog(doneLog('undone'))
    await t.later(3001)
    expect(await t.parentOf(a.id)).toBe('2')
    expect(await queue()).toEqual([])

    await t.store.saveLog({ ...doneLog('running'), applyId: 'apply-2', startedAt: T0 })
    const b = (await t.save('应用停在一半', 'https://x.com/b')).node
    await t.later()
    expect(await queue()).toHaveLength(1)
    t.tick(10 * 60000)
    await t.later(3001)
    expect(await queue()).toEqual([])
    await t.store.saveLog({ ...doneLog('done'), applyId: 'apply-2', startedAt: T0 })
    await t.later(3001)
    expect(t.prompts).toHaveLength(0)
    expect(await t.parentOf(b.id)).toBe('2')
  })

  it('AI 失败：不移动，留给一键整理；记下错误', async () => {
    const t = await setup({ tabs: ['https://x.com/a'], answer: () => 'fail' })
    const { node } = await t.save('失败的', 'https://x.com/a')
    await t.later()
    expect(await t.parentOf(node.id)).toBe('2')
    expect(await t.store.getRecord(node.id)).toBeUndefined()
    expect(((await t.session.get('auto:lastError'))['auto:lastError'] as { message: string }).message).toContain('401')
  })

  it('设置里关掉通知：照样放好，不弹通知', async () => {
    const t = await setup({ tabs: ['https://x.com/a'] })
    await t.store.saveSettings({ autoNotify: false })
    const { node } = await t.save('不通知', 'https://x.com/a')
    await t.later()
    expect(await t.parentOf(node.id)).toBe('FV')
    expect(t.notices).toEqual([])
  })

  it('读到的正文存在本机，每条最多 3 万字', async () => {
    const url = 'https://x.com/long'
    const t = await setup({ tabs: [url], pages: { [url]: { url, title: 't', description: '', text: '长'.repeat(40000) } } })
    const { node } = await t.save('很长的文章', url)
    await t.later()
    expect([...((await t.store.getText(node.id))?.text ?? '')].length).toBe(30000)
  })
})

describe('收藏即整理：正文和隐私', () => {
  const body = Array.from({ length: 30 }, (_, i) => `第${i}段讲的是依赖收集，联系 a${i}@b.com。`).join('')
  const pub = `<html><body><nav>导航</nav><article>${body}</article></body></html>`

  it('白名单站点、公开版本对得上：带正文片段（已脱敏）', async () => {
    const url = 'https://juejin.cn/post/1'
    const t = await setup({ tabs: [url], pages: { [url]: { url, title: 't', description: '', text: body } }, publicHtml: { [url]: pub } })
    await t.save('依赖收集', url)
    await t.later()
    const user = t.prompts[0][1].content
    expect(user).toContain('正文开头')
    expect(user).toContain('{邮箱}')
    expect(user).not.toContain('@b.com')
  })

  it('白名单在设置里能改：删掉的站点不带正文片段，加进去的带；片段最多 1500 字，整篇正文不发', async () => {
    const long = Array.from({ length: 200 }, (_, i) => `第${i}段讲的是依赖收集和派发更新。`).join('')
    const a = 'https://juejin.cn/post/9'
    const b = 'https://my-blog.dev/p/1'
    const page = (url: string) => ({ url, title: 't', description: '', text: long })
    const t = await setup({ tabs: [a, b], pages: { [a]: page(a), [b]: page(b) }, publicHtml: { [a]: `<html><body>${long}</body></html>`, [b]: `<html><body>${long}</body></html>` } })
    await t.store.saveSettings({ textDomains: ['my-blog.dev'] })
    const na = (await t.save('掘金', a)).node
    const nb = (await t.save('自己的博客', b)).node
    await t.later()
    const req = (id: string) => t.prompts.find((p) => p[1].content.split('\n')[1].startsWith(`${id} |`))![1].content
    expect(req(na.id)).not.toContain('正文开头')
    expect(req(nb.id)).toContain('正文开头')
    const excerpt = req(nb.id).split('正文开头：\n')[1]
    expect([...excerpt].length).toBeLessThanOrEqual(1500)
    expect([...long].length).toBeGreaterThan(3000)
    expect(t.prompts.flat().some((m) => m.content.includes('第199段'))).toBe(false)
  })

  it('白名单站点但不带 Cookie 看不到同样的正文（登录后才有）：不带正文片段，私密内容不出现在请求里', async () => {
    const url = 'https://juejin.cn/post/2'
    const secret = '只有登录后才看得到的私密内容'.repeat(20)
    const t = await setup({ tabs: [url], pages: { [url]: { url, title: 't', description: '', text: secret } }, publicHtml: { [url]: '<html><body>请登录后查看全文</body></html>' } })
    await t.save('要登录', url)
    await t.later()
    expect(t.prompts[0].map((m) => m.content).join('\n')).not.toContain('私密内容')
    expect(t.prompts[0][1].content).not.toContain('正文开头')
    // 正文照样存在本机
    expect((await t.store.getText((await t.bm.getChildren('FV')).at(-1)!.id))?.text).toContain('私密内容')
  })

  it('不在白名单：不带正文片段', async () => {
    const url = 'https://example.com/a'
    const t = await setup({ tabs: [url], pages: { [url]: { url, title: 't', description: '', text: body } }, publicHtml: { [url]: pub } })
    await t.save('普通网站', url)
    await t.later()
    expect(t.prompts[0][1].content).not.toContain('正文开头')
  })

  it('私有站点（锁定文件夹里出现过的站点、飞书）：不读页面，请求里只有域名，不存正文', async () => {
    const t = await setup({ tabs: ['https://wiki.company.example/space/123', 'https://abc.feishu.cn/docx/9'] })
    const a = (await t.save('公司 wiki', 'https://wiki.company.example/space/123')).node
    const b = (await t.save('飞书文档', 'https://abc.feishu.cn/docx/9')).node
    await t.later()
    expect(t.readCalls).toEqual([])
    const lines = t.prompts.map((p) => p[1].content.split('\n')[1])
    expect(lines).toEqual([`${a.id} | 公司 wiki | wiki.company.example | `, `${b.id} | 飞书文档 | abc.feishu.cn | `])
    expect(await t.store.getText(a.id)).toBeUndefined()
  })

  it('和一期抓取同样的跳过规则：退订、验证这类操作链接，带凭证参数的，一期里按域名、按文件夹排除的，都不去请求', async () => {
    const urls = ['https://mail.example.com/unsubscribe?u=1', 'https://example.com/verify-email/abc', 'https://example.com/p?token=x', 'https://skip.example.org/a', 'https://normal.example.net/a']
    const t = await setup({ tabs: urls })
    await t.store.saveSettings({ excludeDomains: ['example.org'], excludeFolderIds: ['FC'] })
    for (const [i, u] of urls.entries()) await t.save(`第 ${i} 条`, u, i === 4 ? 'FC' : '2')
    await t.later()
    expect(t.fetched).toEqual([])
    // 照样问 AI（只有标题和去掉参数的网址），照样放好
    expect(t.prompts).toHaveLength(5)
    expect(t.prompts.map((p) => p[1].content).join('\n')).not.toContain('token=x')
  })

  it('简介只用不带 Cookie 抓到的：标签页里读到的（可能是登录后的）不发', async () => {
    const url = 'https://example.com/private-repo'
    const t = await setup({
      tabs: [url],
      pages: { [url]: { url, title: 't', description: '登录后才看得到的简介', text: '' } },
      publicHtml: { [url]: '<html><head><meta name="description" content="公开的简介"></head><body>请登录</body></html>' }
    })
    await t.save('仓库', url)
    await t.later()
    const all = t.prompts[0].map((m) => m.content).join('\n')
    expect(all).toContain('公开的简介')
    expect(all).not.toContain('登录后才看得到的简介')
  })
})

describe('撤销和统计', () => {
  it('撤销：移回原文件夹和位置，标题改回去；用户已经又挪过的不动', async () => {
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'] })
    const a = (await t.save('标题 - 知乎', 'https://x.com/a')).node
    const b = (await t.save('另一条', 'https://x.com/b')).node
    await t.later()
    expect(await t.filer.undo(a.id)).toBe(true)
    expect(await t.parentOf(a.id)).toBe('2')
    expect((await t.bm.get(a.id))[0].title).toBe('标题 - 知乎')
    expect((await t.store.getRecord(a.id))?.status).toBe('undone')
    await t.bm.move(b.id, { parentId: 'FAI' })
    expect(await t.filer.undo(b.id)).toBe(false)
    expect(await t.parentOf(b.id)).toBe('FAI')
    expect((await t.store.getStats()).undone).toBe(1)
  })

  it('撤销：自动放好后用户改过标题的，移回原处，标题不改回', async () => {
    const t = await setup({ tabs: ['https://x.com/a'] })
    const { node } = await t.save('标题 - 知乎', 'https://x.com/a')
    await t.later()
    expect((await t.bm.get(node.id))[0].title).toBe('标题')
    await t.bm.update(node.id, { title: '我后来改的' })
    expect(await t.filer.undo(node.id)).toBe(true)
    expect(await t.parentOf(node.id)).toBe('2')
    expect((await t.bm.get(node.id))[0].title).toBe('我后来改的')
  })

  it('「又挪走」只算自动放好之后 7 天内的', async () => {
    const t = await setup({ tabs: ['https://x.com/a'] })
    const { node } = await t.save('很久以后才挪', 'https://x.com/a')
    await t.later()
    t.tick(7 * DAY + 1)
    await t.bm.move(node.id, { parentId: 'FC' })
    await t.filer.onMoved(node.id, { parentId: 'FC' })
    expect((await t.store.getStats()).movedAgain).toBe(0)
  })

  it('7 天内用户挪走自动放好的：记一次「又挪走」；自己的移动不算', async () => {
    const t = await setup({ tabs: ['https://x.com/a'] })
    const { node } = await t.save('会被挪走', 'https://x.com/a')
    await t.later()
    await t.filer.onMoved(node.id, { parentId: 'FV' })
    expect((await t.store.getStats()).movedAgain).toBe(0)
    await t.bm.move(node.id, { parentId: 'FC' })
    await t.filer.onMoved(node.id, { parentId: 'FC' })
    expect((await t.store.getStats()).movedAgain).toBe(1)
    expect((await t.store.getRecord(node.id))?.status).toBe('moved-by-user')
  })
})

describe('一键整理', () => {
  it('10 条以内直接放；撤销这次全部移回', async () => {
    const t = await setup()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await t.bm.create({ parentId: '2', title: `手机同步的 ${i}`, url: `https://m.com/${i}` })).id)
    expect((await t.filer.status()).unfiled).toBe(3)
    const r = await t.filer.runButton()
    expect(r).toMatchObject({ phase: 'done', result: { filed: 3, toInbox: 0, skipped: 0 } })
    for (const id of ids) expect(await t.parentOf(id)).toBe('FV')
    expect((await t.filer.status()).unfiled).toBe(0)
    const batch = (await t.filer.status()).lastBatch!
    expect(await t.filer.undoBatch(batch)).toBe(3)
    for (const id of ids) expect(await t.parentOf(id)).toBe('2')
  })

  it('撤销这次：还在原处的移回、标题改回；放好之后用户挪走的不挪回，改过标题的不改回；不新建目录', async () => {
    const t = await setup()
    const folders = async () => flattenTree(await t.bm.getTree()).folders.length
    const before = await folders()
    const ids: string[] = []
    for (let i = 0; i < 3; i++) ids.push((await t.bm.create({ parentId: '2', title: `手机同步的 ${i} - 知乎`, url: `https://m.com/${i}` })).id)
    expect((await t.filer.runButton()).result).toEqual({ filed: 3, toInbox: 0, skipped: 0 })
    expect(await folders()).toBe(before)
    expect((await t.bm.get(ids[0]))[0].title).toBe('手机同步的 0')
    await t.bm.move(ids[1], { parentId: 'FAI' })
    await t.bm.update(ids[2], { title: '我自己起的' })
    await t.filer.undoBatch((await t.filer.status()).lastBatch!)
    expect(await t.parentOf(ids[0])).toBe('2')
    expect((await t.bm.get(ids[0]))[0].title).toBe('手机同步的 0 - 知乎')
    // 挪走的：位置不动（标题还是自动改的那个，照样改回）
    expect(await t.parentOf(ids[1])).toBe('FAI')
    expect((await t.bm.get(ids[1]))[0].title).toBe('手机同步的 1 - 知乎')
    // 改过标题的：移回原处，标题留着用户的
    expect(await t.parentOf(ids[2])).toBe('2')
    expect((await t.bm.get(ids[2]))[0].title).toBe('我自己起的')
  })

  it('不新建目录：「其他书签/待整理」已经有了就放进去，不再建；放进现有目录时文件夹数不变', async () => {
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'], answer: (title) => (title.includes('拿不准') ? { path: 'AI 工具', confidence: 0.3 } : { path: 'AI 工具', confidence: 0.9 }) })
    const inbox = await t.bm.create({ parentId: '2', title: '待整理' })
    const folders = async () => flattenTree(await t.bm.getTree()).folders.length
    const before = await folders()
    const a = (await t.save('拿不准', 'https://x.com/a')).node
    const b = (await t.save('拿得准', 'https://x.com/b')).node
    await t.later()
    expect(await t.parentOf(a.id)).toBe(inbox.id)
    expect(await t.parentOf(b.id)).toBe('FAI')
    expect(await folders()).toBe(before)
  })

  it('超过 10 条先出预览，只放勾上的', async () => {
    const t = await setup({ answer: (title) => (title.endsWith('0') ? { path: '前端/CSS', confidence: 0.3 } : { path: 'AI 工具', confidence: 0.9 }) })
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await t.bm.create({ parentId: '2', title: `第 ${i}`, url: `https://m.com/${i}` })).id)
    const p = await t.filer.runButton()
    expect(p.phase).toBe('preview')
    expect(p.items).toHaveLength(12)
    expect(p.items!.find((x) => x.bookmarkId === ids[0])).toMatchObject({ toInbox: true, path: '待整理' })
    for (const id of ids) expect(await t.parentOf(id)).toBe('2')
    const done = await t.filer.applyBatch(p.id, ids.slice(0, 2))
    expect(done.result).toEqual({ filed: 1, toInbox: 1, skipped: 10 })
    expect(await t.parentOf(ids[1])).toBe('FAI')
    expect(await t.parentOf(ids[5])).toBe('2')
  })

  it('预览期间后台被停掉重启：去向从会话存储里拿，照样能放；连点两下只提交一次，提交中点「取消」无效', async () => {
    const t = await setup({ answer: () => ({ path: 'AI 工具', confidence: 0.9 }) })
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await t.bm.create({ parentId: '2', title: `第 ${i}`, url: `https://m.com/${i}` })).id)
    const p = await t.filer.runButton()
    expect(p.phase).toBe('preview')
    const after = t.restart()
    const [a, b] = await Promise.all([after.applyBatch(p.id, ids.slice(0, 3)), after.applyBatch(p.id, ids.slice(0, 3)), after.cancelBatch(p.id)])
    expect(a.result).toEqual({ filed: 3, toInbox: 0, skipped: 9 })
    expect(b.phase).not.toBe('failed')
    for (const id of ids.slice(0, 3)) expect(await t.parentOf(id)).toBe('FAI')
    expect(await t.parentOf(ids[3])).toBe('2')
    expect((await after.status()).batch).toMatchObject({ id: p.id, phase: 'done', result: { filed: 3, toInbox: 0, skipped: 9 } })
    expect((await t.session.get('auto:pending'))['auto:pending']).toBeUndefined()
  })

  it('连点两下「整理」只跑一批', async () => {
    const t = await setup()
    for (let i = 0; i < 3; i++) await t.bm.create({ parentId: '2', title: `手机同步的 ${i}`, url: `https://m.com/${i}` })
    const [a, b] = await Promise.all([t.filer.runButton(), t.filer.runButton()])
    expect(a.id).toBe(b.id)
    expect(t.prompts).toHaveLength(3)
  })

  it('「整理中」2 分钟没有进展（后台中途被停掉）：不再当成在跑，能重新点；过期的也能取消掉', async () => {
    const t = await setup()
    await t.session.set({ 'auto:batch': { id: 'batch-old', phase: 'running', total: 5, done: 2, startedAt: T0, updatedAt: T0 } })
    t.tick(2 * 60000 + 1)
    expect((await t.filer.status()).batch).toBeUndefined()
    await t.filer.cancelBatch('batch-old')
    expect((await t.session.get('auto:batch'))['auto:batch']).toBeUndefined()
    await t.bm.create({ parentId: '2', title: '手机同步的', url: 'https://m.com/x' })
    expect((await t.filer.runButton()).phase).toBe('done')
  })

  it('提交时等一期的锁等了 3 分钟：心跳一直在写，弹窗里还是「整理中」，进度一条条走；放锁后做完', async () => {
    const t = await setup({ answer: () => ({ path: 'AI 工具', confidence: 0.9 }) })
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await t.bm.create({ parentId: '2', title: `第 ${i}`, url: `https://m.com/${i}` })).id)
    const p = await t.filer.runButton()
    let release!: () => void
    const held = t.lock.run('apply', () => new Promise<void>((r) => (release = r)))
    const applying = t.filer.applyBatch(p.id, ids.slice(0, 3))
    await new Promise((r) => setTimeout(r, 20))
    t.tick(3 * 60000)
    await new Promise((r) => setTimeout(r, 40))
    expect((await t.filer.status()).batch).toMatchObject({ id: p.id, phase: 'running', total: 3, done: 0 })
    // 等锁时再点「整理」：不另起一批
    expect((await t.filer.runButton()).id).toBe(p.id)
    release()
    await held
    const done = await applying
    expect(done).toMatchObject({ phase: 'done', result: { filed: 3, toInbox: 0, skipped: 9 } })
    expect((await t.filer.status()).batch).toMatchObject({ id: p.id, phase: 'done' })
  })

  it('提交出错（存储写不进去）：记成失败，原因看得到，不会一直挂着「整理中」', async () => {
    const t = await setup({ answer: () => ({ path: 'AI 工具', confidence: 0.9 }) })
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await t.bm.create({ parentId: '2', title: `第 ${i}`, url: `https://m.com/${i}` })).id)
    const p = await t.filer.runButton()
    const set = t.kv.set.bind(t.kv)
    t.kv.set = async (items) => {
      if ('autoLastBatch' in items) throw new Error('存储写不进去')
      return set(items)
    }
    const r = await t.filer.applyBatch(p.id, ids.slice(0, 3))
    // 失败也保留这批的条数和开始时间
    expect(r).toMatchObject({ phase: 'failed', error: '存储写不进去', total: 3, startedAt: p.startedAt })
    expect((await t.filer.status()).batch).toMatchObject({ id: p.id, phase: 'failed', error: '存储写不进去' })
    for (const id of ids) expect(await t.parentOf(id)).toBe('2')
    expect((await t.session.get('auto:pending'))['auto:pending']).toBeUndefined()
  })

  it('AI 一条能用的结果都没给（缺说明）：不占「最近一批」，上一批照样能「撤销这次」', async () => {
    const t = await setup({ answer: () => ({ path: 'AI 工具', confidence: 0.9 }) })
    const first = (await t.bm.create({ parentId: '2', title: '第一批', url: 'https://m.com/1' })).id
    await t.filer.runButton()
    const lastBefore = (await t.filer.status()).lastBatch
    expect(lastBefore).toBeDefined()
    // 第二批换一个 AI：回的 JSON 里没有这条的说明，parseFile 给 undefined，也不算 aiFailed
    const noDesc = createAutoFiler({
      bookmarks: t.bm,
      kv: t.kv,
      session: t.session,
      lock: t.lock,
      tabs: { query: async () => [] },
      hasSitePermission: async () => true,
      fetchImpl: (async () => new Response('', { status: 404, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
      chat: async () => ({ data: { items: [{ id: 'x', path: 'AI 工具', confidence: 0.9 }] }, usage: { requests: 1, promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 } }),
      now: () => T0 + 1000
    })
    await t.bm.create({ parentId: '2', title: '第二批', url: 'https://m.com/2' })
    expect(await noDesc.runButton()).toMatchObject({ phase: 'done', result: { filed: 0, toInbox: 0, skipped: 1 } })
    expect((await noDesc.status()).lastBatch).toBe(lastBefore)
    expect(await noDesc.undoBatch(lastBefore!)).toBe(1)
    expect(await t.parentOf(first)).toBe('2')
  })

  it('没整理过时没有要整理的', async () => {
    const t = await setup({ organized: false })
    await t.bm.create({ parentId: '2', title: 'x', url: 'https://m.com/x' })
    expect((await t.filer.status()).unfiled).toBe(0)
  })
})

describe('bookmark-ux：角标的 N、待处理的 M', () => {
  it('K1 待整理里的不算进 N，点「放好」也不问 AI；M 数待整理、整理前的空文件夹、待清理里的书签', async () => {
    const t = await setup()
    const inbox = await t.bm.create({ parentId: '2', title: '待整理' })
    for (let i = 0; i < 6; i++) await t.bm.create({ parentId: inbox.id, title: `拿不准 ${i}`, url: `https://in.com/${i}` })
    const holding = await t.bm.create({ parentId: '2', title: '整理前的空文件夹' })
    const old = await t.bm.create({ parentId: holding.id, title: '旧目录' })
    await t.bm.create({ parentId: old.id, title: '旧目录里剩的', url: 'https://old.com/' })
    const cleanup = await t.bm.create({ parentId: '2', title: '待清理' })
    await t.bm.create({ parentId: cleanup.id, title: '失效的', url: 'https://dead.com/' })
    const st = await t.filer.status()
    expect(st.unfiled).toBe(0)
    expect(st.pending).toBe(8)
    expect(await t.filer.runButton()).toMatchObject({ phase: 'done', result: { filed: 0, toInbox: 0, skipped: 0 } })
    expect(t.prompts).toHaveLength(0)
  })

  it('K2 点「放好」后放进目录的、进待整理的都不再算；AI 失败的还算，结果写条数和原因；再点只问失败的那条；计数照样累加', async () => {
    const t = await setup({ answer: (title) => (title.includes('失败') ? 'fail' : title.includes('拿不准') ? { path: 'AI 工具', confidence: 0.3 } : { path: 'AI 工具', confidence: 0.9 }) })
    const ok = (await t.bm.create({ parentId: '2', title: '拿得准', url: 'https://m.com/ok' })).id
    const unsure = (await t.bm.create({ parentId: '2', title: '拿不准', url: 'https://m.com/unsure' })).id
    const failed = (await t.bm.create({ parentId: '2', title: '会失败', url: 'https://m.com/fail' })).id
    expect((await t.filer.status()).unfiled).toBe(3)
    const r = await t.filer.runButton()
    expect(r).toMatchObject({ phase: 'done', result: { filed: 1, toInbox: 1, skipped: 0, failed: 1, error: '接口拒绝访问（HTTP 401），检查 API key' } })
    expect(await t.parentOf(ok)).toBe('FAI')
    expect((await t.store.getRecord(unsure))?.status).toBe('inbox')
    expect(await t.parentOf(failed)).toBe('2')
    expect((await t.filer.status()).unfiled).toBe(1)
    expect(await t.store.getStats()).toMatchObject({ filed: 1, toInbox: 1, buttonRuns: 1 })
    const asked = t.prompts.length
    await t.filer.runButton()
    expect(t.prompts.length - asked).toBe(1)
    expect(t.prompts.at(-1)![1].content).toContain('会失败')
  })

  it('K2 全都放好以后再点「放好」：不再请求 AI', async () => {
    const t = await setup()
    for (let i = 0; i < 3; i++) await t.bm.create({ parentId: '2', title: `手机同步的 ${i}`, url: `https://m.com/${i}` })
    await t.filer.runButton()
    const asked = t.prompts.length
    expect(await t.filer.runButton()).toMatchObject({ phase: 'done', result: { filed: 0, toInbox: 0, skipped: 0 } })
    expect(t.prompts.length).toBe(asked)
  })

  it('K2、K3 预览里没勾的算你定了不动：不再算进 N，AI 的说明照样存，再整理也不挪它；预览里失败的条数并进结果', async () => {
    const t = await setup({ answer: (title) => (title === '第 11' ? 'fail' : { path: 'AI 工具', confidence: 0.9 }) })
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await t.bm.create({ parentId: '2', title: `第 ${i}`, url: `https://m.com/${i}` })).id)
    const p = await t.filer.runButton()
    expect(p).toMatchObject({ phase: 'preview', aiFailed: { count: 1 } })
    const done = await t.filer.applyBatch(p.id, ids.slice(0, 2))
    expect(done.result).toMatchObject({ filed: 2, toInbox: 0, skipped: 9, failed: 1 })
    expect((await t.store.getHandPlaced()).sort()).toEqual(ids.slice(2, 11).sort())
    expect((await t.store.getMeta())[ids[5]]).toMatchObject({ desc: '说明：第 5' })
    // 剩下 AI 失败的那条
    expect((await t.filer.status()).unfiled).toBe(1)
    const asked = t.prompts.length
    await t.filer.runButton()
    expect(t.prompts.length - asked).toBe(1)
    expect(await t.parentOf(ids[5])).toBe('2')
  })

  it('K3 收藏后 8 秒里你在扩展里放好了：后台排着的不再挪；处理前你自己挪过的，记成你定过位置', async () => {
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'] })
    const a = (await t.save('放好了', 'https://x.com/a')).node
    await t.store.addHandPlaced([a.id])
    const b = (await t.save('自己挪了', 'https://x.com/b')).node
    await t.bm.move(b.id, { parentId: 'FC' })
    await t.later()
    expect(await t.parentOf(a.id)).toBe('2')
    expect(await t.store.getRecord(a.id)).toBeUndefined()
    expect(await t.parentOf(b.id)).toBe('FC')
    expect(await t.store.getHandPlaced()).toContain(b.id)
  })

  it('T11 收藏即整理、一键整理（直接放、预览、撤销这次）都不删书签', async () => {
    const t = await setup({ tabs: ['https://x.com/a'], answer: (title) => (title.includes('拿不准') ? { path: 'AI 工具', confidence: 0.3 } : { path: 'AI 工具', confidence: 0.9 }) })
    const removed: string[] = []
    t.bm.beforeWrite((op, id) => void (op === 'remove' && removed.push(id)))
    await t.save('拿不准', 'https://x.com/a')
    await t.later()
    const ids: string[] = []
    for (let i = 0; i < 12; i++) ids.push((await t.bm.create({ parentId: '2', title: `第 ${i}`, url: `https://m.com/${i}` })).id)
    const p = await t.filer.runButton()
    await t.filer.applyBatch(p.id, ids.slice(0, 5))
    await t.filer.undoBatch((await t.filer.status()).lastBatch!)
    expect(removed).toEqual([])
  })

  it('进待整理时记下 AI 猜的目录（在候选里的才记），待处理里预选它', async () => {
    const t = await setup({ tabs: ['https://x.com/a', 'https://x.com/b'], answer: (title) => (title.includes('乱猜') ? { path: '不存在的目录', confidence: 0.3 } : { path: '前端/CSS', confidence: 0.3 }) })
    const a = (await t.save('猜 CSS', 'https://x.com/a')).node
    const b = (await t.save('乱猜', 'https://x.com/b')).node
    await t.later()
    expect(await t.store.getRecord(a.id)).toMatchObject({ status: 'inbox', guess: { folderId: 'FC', path: '前端/CSS' } })
    expect((await t.store.getRecord(b.id))?.status).toBe('inbox')
    expect((await t.store.getRecord(b.id))?.guess).toBeUndefined()
  })
})

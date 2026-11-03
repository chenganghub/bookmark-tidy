import { describe, expect, it, vi } from 'vitest'
import { createFetchQueue, fetchPage, fetchPublicText, parseHead, planFetch, skipReasonOf } from '../src/core/fetcher'
import type { FetchProgress, FlatBookmark, PageInfo } from '../src/core/types'

const bm = (id: string, url: string, folderIds: string[] = []): FlatBookmark => ({
  id,
  parentId: folderIds.at(-1) ?? '1',
  index: 0,
  title: id,
  url,
  path: folderIds,
  folderIds,
  rootId: '1',
  rootType: 'bookmarks-bar',
  depth: folderIds.length + 1,
  dateAdded: 0,
  dateLastUsed: 0
})

/** 造一个假的 Response；url 是只读属性，用 defineProperty 改 */
function response(body: BodyInit | null, init: ResponseInit & { url?: string; contentType?: string } = {}): Response {
  const headers = new Headers(init.headers)
  if (init.contentType !== undefined) headers.set('content-type', init.contentType)
  else if (!headers.has('content-type')) headers.set('content-type', 'text/html; charset=utf-8')
  const res = new Response(body, { status: init.status ?? 200, headers })
  if (init.url) Object.defineProperty(res, 'url', { value: init.url })
  return res
}

const html = (head: string) => `<!doctype html><html lang="zh-CN"><head>${head}</head><body>正文</body></html>`

describe('skipReasonOf', () => {
  it.each([
    ['javascript:void(0)', 'not-http'],
    ['file:///C:/a.html', 'not-http'],
    ['chrome://extensions', 'not-http'],
    ['http://localhost:3000/', 'intranet'],
    ['http://192.168.1.10/admin', 'intranet'],
    ['https://example.com/logout', 'action-word'],
    ['https://example.com/user/delete?id=1', 'action-word'],
    ['https://example.com/logout.php', 'action-word'],
    ['https://example.com/verify-email', 'action-word'],
    ['https://example.com/index.php?action=logout', 'action-word'],
    ['https://example.com/x?token=abc', 'credential-param'],
    ['https://example.com/x?csrf_token=abc', 'credential-param'],
    ['https://example.com/oauth/callback?code=xyz', 'credential-param'],
    ['https://example.com/s/5f4dcc3b5aa765d61d8327deb882cf99', 'random-token'],
    ['https://example.com/view?id=a1b2c3d4e5f6a7b8c9d0e1f2a3', 'random-token']
  ])('%s → %s', (url, reason) => {
    expect(skipReasonOf(url)).toBe(reason)
  })

  it.each([
    'https://blog.csdn.net/qq_41234567/article/details/123456789',
    'https://www.cnblogs.com/someone/p/12345678.html',
    'https://example.com/blog/how-to-delete-git-branch',
    'https://example.com/payment',
    'https://github.com/vuejs/core',
    'https://example.com/search?q=remove+bg',
    'https://juejin.cn/post/7123456789012345678'
  ])('普通网址不跳过：%s', (url) => {
    expect(skipReasonOf(url)).toBeUndefined()
  })
})

describe('planFetch', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  const DAY = 86400000

  it('同网址合并、缓存、锁定、排除、跳过', () => {
    const items = [
      bm('a', 'https://example.com/a'),
      bm('a2', 'https://example.com/a', ['f1']),
      bm('b', 'https://example.com/b'),
      bm('c', 'https://example.com/c'),
      bm('locked', 'https://example.com/l', ['lock', 'sub']),
      bm('ex', 'https://example.com/e', ['exf']),
      bm('dom', 'https://docs.zhihu.com/x'),
      bm('local', 'http://localhost/'),
      bm('js', 'javascript:alert(1)')
    ]
    const cache: Record<string, PageInfo> = {
      'https://example.com/b': { url: 'https://example.com/b', status: 'ok', fetchedAt: now - 2 * DAY },
      'https://example.com/c': { url: 'https://example.com/c', status: 'ok', fetchedAt: now - 8 * DAY }
    }
    const plan = planFetch(items, { cache, now, lockedFolderIds: ['lock'], excludeFolderIds: ['exf'], excludeDomains: ['zhihu.com'] })
    expect(plan.toFetch).toEqual([
      { url: 'https://example.com/a', bookmarkIds: ['a', 'a2'] },
      { url: 'https://example.com/c', bookmarkIds: ['c'] }
    ])
    expect(plan.cached).toEqual([{ url: 'https://example.com/b', bookmarkIds: ['b'] }])
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.bookmarkIds[0], s.reason]))
    expect(reasons).toEqual({ locked: 'locked', ex: 'excluded-folder', dom: 'excluded-domain', local: 'intranet', js: 'not-http' })
  })
})

describe('parseHead', () => {
  it('属性顺序、引号、大小写、实体', () => {
    const h = parseHead(
      html(`<META CONTENT='讲 Vue &amp; Vite &lt;入门&gt; &quot;好&quot; &#39;x&#39; &#20013;&#x6587;' NAME="Description">
      <title>  Vue
        教程&nbsp;- 掘金 </title><meta property="og:site_name" content="稀土掘金">`)
    )
    expect(h.title).toBe('Vue 教程 - 掘金')
    expect(h.description).toBe(`讲 Vue & Vite <入门> "好" 'x' 中文`)
    expect(h.siteName).toBe('稀土掘金')
    expect(h.lang).toBe('zh-CN')
  })

  it('title 为空用 og:title，description 为空用 og:description', () => {
    const h = parseHead(html(`<title></title><meta property="og:title" content="OG 标题"><meta name="description" content=""><meta property="og:description" content="OG 简介">`))
    expect(h.title).toBe('OG 标题')
    expect(h.description).toBe('OG 简介')
  })

  it('charset：meta charset 和 http-equiv', () => {
    expect(parseHead('<head><meta charset="GBK"><title>x</title></head>').charset).toBe('gbk')
    expect(parseHead('<head><meta http-equiv="Content-Type" content="text/html; charset=gb2312"></head>').charset).toBe('gb2312')
  })

  it('只看 <head>，正文里的 title 不算', () => {
    expect(parseHead('<html><head></head><body><title>正文里的</title></body></html>').title).toBeUndefined()
  })
})

describe('fetchPage', () => {
  const opts = (fetchImpl: typeof fetch) => ({ fetchImpl, retryDelayMs: 0, now: () => 1000 })

  it('不带 cookie、跟随跳转，正常页取标题和简介', async () => {
    const fetchImpl = vi.fn(async () => response(html('<title>标题</title><meta name="description" content="简介">'))) as unknown as typeof fetch
    const info = await fetchPage('https://example.com/a', opts(fetchImpl))
    expect(info).toMatchObject({ url: 'https://example.com/a', status: 'ok', httpStatus: 200, title: '标题', description: '简介', lang: 'zh-CN', fetchedAt: 1000 })
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect(init.credentials).toBe('omit')
    expect(init.cache).toBe('no-store')
    expect(init.redirect).toBe('follow')
  })

  it.each([
    [404, 'dead'],
    [410, 'dead'],
    [401, 'login'],
    [403, 'blocked'],
    [429, 'blocked'],
    [400, 'blocked']
  ])('HTTP %i → %s（不重试）', async (status, expected) => {
    const fetchImpl = vi.fn(async () => response('x', { status }))
    const info = await fetchPage('https://example.com/a', opts(fetchImpl as unknown as typeof fetch))
    expect(info.status).toBe(expected)
    expect(info.httpStatus).toBe(status)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('5xx → server-error，重试 1 次', async () => {
    const fetchImpl = vi.fn(async () => response('x', { status: 502 }))
    const info = await fetchPage('https://example.com/a', opts(fetchImpl as unknown as typeof fetch))
    expect(info.status).toBe('server-error')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('连不上 → unreachable；重试成功就用第二次的结果', async () => {
    const fail = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    expect((await fetchPage('https://example.com/a', opts(fail as unknown as typeof fetch))).status).toBe('unreachable')
    expect(fail).toHaveBeenCalledTimes(2)

    let n = 0
    const flaky = vi.fn(async () => {
      if (n++ === 0) throw new TypeError('Failed to fetch')
      return response(html('<title>好了</title>'))
    })
    const info = await fetchPage('https://example.com/a', opts(flaky as unknown as typeof fetch))
    expect(info.status).toBe('ok')
    expect(info.title).toBe('好了')
  })

  it('超时 → timeout', async () => {
    const hang = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })) as unknown as typeof fetch
    const info = await fetchPage('https://example.com/a', { fetchImpl: hang, timeoutMs: 20, retryDelayMs: 0 })
    expect(info.status).toBe('timeout')
  })

  it('跳转：域名或路径变了才算；www、尾斜杠、http→https 不算', async () => {
    const to = (url: string) => (async () => response(html('<title>t</title>'), { url })) as unknown as typeof fetch
    expect((await fetchPage('http://example.com/a/', opts(to('https://www.example.com/a')))).status).toBe('ok')
    const moved = await fetchPage('https://example.com/a', opts(to('https://example.com/b')))
    expect(moved.status).toBe('redirect')
    expect(moved.finalUrl).toBe('https://example.com/b')
  })

  it('跳到登录页，或标题像登录页 → login', async () => {
    const toLogin = (async () => response(html('<title>飞书</title>'), { url: 'https://passport.feishu.cn/accounts/page/login?x=1' })) as unknown as typeof fetch
    expect((await fetchPage('https://xx.feishu.cn/docx/abc', opts(toLogin))).status).toBe('login')
    const loginTitle = (async () => response(html('<title>登录 - GitLab</title>'))) as unknown as typeof fetch
    expect((await fetchPage('https://gitlab.example.com/users/sign_in', opts(loginTitle))).status).toBe('login')
  })

  it('GBK 页面按 charset 解码', async () => {
    const bytes = new Uint8Array([...new TextEncoder().encode('<html><head><title>'), 0xd6, 0xd0, 0xce, 0xc4, ...new TextEncoder().encode('</title></head></html>')])
    const viaHeader = (async () => response(bytes, { contentType: 'text/html; charset=GBK' })) as unknown as typeof fetch
    expect((await fetchPage('https://example.com/a', opts(viaHeader))).title).toBe('中文')
    const metaBytes = new Uint8Array([...new TextEncoder().encode('<html><head><meta charset="gbk"><title>'), 0xd6, 0xd0, 0xce, 0xc4, ...new TextEncoder().encode('</title></head></html>')])
    const viaMeta = (async () => response(metaBytes, { contentType: 'text/html' })) as unknown as typeof fetch
    expect((await fetchPage('https://example.com/a', opts(viaMeta))).title).toBe('中文')
  })

  it('只读 maxBytes，超长的流不读完', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new TextEncoder().encode(pulled === 1 ? '<html><head><title>长页面</title>' : 'x'.repeat(1024)))
        if (pulled > 10000) controller.close()
      }
    })
    const fetchImpl = (async () => response(stream)) as unknown as typeof fetch
    const info = await fetchPage('https://example.com/a', { ...opts(fetchImpl), maxBytes: 8 * 1024 })
    expect(info.title).toBe('长页面')
    expect(pulled).toBeLessThan(50)
  })

  it('读到 </head> 就停', async () => {
    let pulled = 0
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new TextEncoder().encode(pulled === 1 ? '<html><head><title>短</title></head>' : 'x'.repeat(1024)))
      }
    })
    const info = await fetchPage('https://example.com/a', opts((async () => response(stream)) as unknown as typeof fetch))
    expect(info.title).toBe('短')
    expect(pulled).toBeLessThanOrEqual(2)
  })

  it('非 HTML：ok，标题取路径最后一段', async () => {
    const pdf = (async () => response('%PDF', { contentType: 'application/pdf' })) as unknown as typeof fetch
    const info = await fetchPage('https://example.com/files/%E6%89%8B%E5%86%8C.pdf', opts(pdf))
    expect(info.status).toBe('ok')
    expect(info.title).toBe('手册.pdf')
  })
})

describe('createFetchQueue', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ url: `https://example.com/${i}`, bookmarkIds: [`b${i}`] }))

  it('并发不超过上限，结果和进度都对', async () => {
    let active = 0
    let peak = 0
    const results: string[] = []
    const progress: FetchProgress[] = []
    const run = createFetchQueue({
      items,
      concurrency: 3,
      fetchOne: async (url) => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 2))
        active--
        return { url, status: url.endsWith('/5') ? 'dead' : 'ok', fetchedAt: 0 }
      },
      onResult: (info) => {
        results.push(info.url)
      },
      onProgress: (p) => progress.push(p)
    })
    const final = await run.done
    expect(peak).toBe(3)
    expect(results).toHaveLength(20)
    expect(new Set(results).size).toBe(20)
    expect(final).toEqual({ total: 20, done: 20, failed: 1, running: 0, paused: false })
    expect(progress.at(-1)).toEqual(final)
  })

  it('暂停后不再启动新的，继续后做完', async () => {
    const started: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const run = createFetchQueue({
      items: items.slice(0, 6),
      concurrency: 2,
      fetchOne: async (url) => {
        started.push(url)
        await gate
        return { url, status: 'ok', fetchedAt: 0 }
      },
      onResult: () => {},
      onProgress: () => {}
    })
    await new Promise((r) => setTimeout(r, 0))
    run.pause()
    release()
    await new Promise((r) => setTimeout(r, 10))
    expect(started).toHaveLength(2)
    expect(run.progress()).toMatchObject({ done: 2, running: 0, paused: true })
    run.resume()
    const final = await run.done
    expect(final.done).toBe(6)
    expect(started).toHaveLength(6)
  })

  it('停止后在跑的做完就结束，不再启动新的', async () => {
    const started: string[] = []
    const run = createFetchQueue({
      items,
      concurrency: 2,
      fetchOne: async (url) => {
        started.push(url)
        await new Promise((r) => setTimeout(r, 5))
        return { url, status: 'ok', fetchedAt: 0 }
      },
      onResult: () => {},
      onProgress: () => {}
    })
    await new Promise((r) => setTimeout(r, 0))
    run.stop()
    const final = await run.done
    expect(started).toHaveLength(2)
    expect(final.done).toBe(2)
  })

  it('没有条目时立刻结束', async () => {
    const run = createFetchQueue({ items: [], fetchOne: async () => ({ url: '', status: 'ok', fetchedAt: 0 }), onResult: () => {}, onProgress: () => {} })
    expect(await run.done).toEqual({ total: 0, done: 0, failed: 0, running: 0, paused: false })
  })
})

describe('不带 Cookie 抓整页（二期核对公开版本用）', () => {
  it('读完整个 body，转成纯文本；不带 cookie', async () => {
    const page = `<!doctype html><html><head><title>t</title></head><body><article><p>${'正文'.repeat(2000)}</p><p>结尾段落</p></article></body></html>`
    const fetchImpl = vi.fn(async () => response(page))
    const r = await fetchPublicText('https://a.com/p', { fetchImpl: fetchImpl as unknown as typeof fetch })
    expect(r.ok).toBe(true)
    expect(r.text).toContain('结尾段落')
    expect(r.text).not.toContain('<p>')
    const init = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0][1]
    expect(init.credentials).toBe('omit')
    // 不用 HTTP 缓存：缓存里可能是标签页带 Cookie 取回的版本
    expect(init.cache).toBe('no-store')
  })

  it('非 2xx、不是 HTML、网络错误都算没抓到', async () => {
    const f = (res: () => Promise<Response>) => fetchPublicText('https://a.com', { fetchImpl: vi.fn(res) as unknown as typeof fetch })
    expect((await f(async () => response('x', { status: 403 }))).ok).toBe(false)
    expect((await f(async () => response('{}', { contentType: 'application/json' }))).ok).toBe(false)
    expect((await f(async () => Promise.reject(new TypeError('failed')))).ok).toBe(false)
  })
})

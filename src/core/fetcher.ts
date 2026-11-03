// 抓网页标题和简介，顺带判断链接还在不在。在扩展的管理页里跑（有网址权限，跨域不受限）。
// 请求不带 cookie：服务器认不出是谁，退出登录、退订这类和账号绑定的操作就做不成。
import { hostOf, isHttp, isIntranet } from './rules'
import { findRandomTokens } from './sanitize'
import { decodeEntities, htmlToText } from './text'
import type { FetchPlan, FetchProgress, FetchRun, FetchStatus, FlatBookmark, PageInfo, SkipReason } from './types'

const DAY = 86400000
export const FETCH_TTL_MS = 7 * DAY

// ---------------------------------------------------------------- 跳过规则

const ACTION_WORDS = ['logout', 'signout', 'logoff', 'unsubscribe', 'delete', 'remove', 'cancel', 'confirm', 'verify', 'activate', 'reset', 'invite', 'approve', 'pay']
const CREDENTIAL_PARAMS = new Set(['token', 'access_token', 'ticket', 'code', 'key', 'sign', 'signature', 'auth', 'session', 'sid', 'magic', 'otp'])

/**
 * 操作词只在「路径的一段」或「参数名」等于它、或以「它 + 非字母数字」开头时算（参数值要完全相等）：
 * /logout、/user/delete、/logout.php、/verify-email、?action=logout 命中；
 * /blog/how-to-delete-git-branch、/payment 不命中。
 */
function isActionWord(part: string): boolean {
  const p = part.toLowerCase()
  return ACTION_WORDS.some((w) => p === w || (p.startsWith(w) && !/[a-z0-9]/.test(p[w.length])))
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

export function skipReasonOf(url: string): SkipReason | undefined {
  if (!isHttp(url)) return 'not-http'
  if (isIntranet(url)) return 'intranet'
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return 'not-http'
  }
  const segments = u.pathname.split('/').filter(Boolean).map(decodeSafe)
  const params = [...u.searchParams.entries()]
  // 参数值只认完全相等（?action=logout），不认前缀：搜索词「remove bg」不是操作
  const isActionValue = (v: string) => ACTION_WORDS.includes(v.toLowerCase())
  if (segments.some(isActionWord) || params.some(([k, v]) => isActionWord(k) || isActionValue(v))) return 'action-word'
  if (params.some(([k]) => CREDENTIAL_PARAMS.has(k.toLowerCase()) || /(token|ticket|signature)$/i.test(k))) return 'credential-param'
  if (segments.some((s) => findRandomTokens(s).length) || params.some(([, v]) => findRandomTokens(v).length)) return 'random-token'
  return undefined
}

// ---------------------------------------------------------------- 抓取计划

export function planFetch(
  bookmarks: FlatBookmark[],
  opts: {
    cache: Record<string, PageInfo>
    now: number
    ttlMs?: number
    lockedFolderIds?: string[]
    excludeFolderIds?: string[]
    excludeDomains?: string[]
  }
): FetchPlan {
  const ttl = opts.ttlMs ?? FETCH_TTL_MS
  const locked = new Set(opts.lockedFolderIds || [])
  const excluded = new Set(opts.excludeFolderIds || [])
  const domains = (opts.excludeDomains || []).map((d) => d.toLowerCase().replace(/^www\./, ''))
  const under = (b: FlatBookmark, ids: Set<string>) => b.folderIds.some((id) => ids.has(id))

  // 按「类别 + 网址」合并，同一网址的几条书签只抓一次
  const groups = new Map<string, { kind: 'fetch' | 'cached' | SkipReason; url: string; bookmarkIds: string[] }>()
  for (const b of bookmarks) {
    let kind: 'fetch' | 'cached' | SkipReason
    const host = hostOf(b.url)
    if (under(b, locked)) kind = 'locked'
    else if (under(b, excluded)) kind = 'excluded-folder'
    else if (host && domains.some((d) => host === d || host.endsWith(`.${d}`))) kind = 'excluded-domain'
    else {
      const reason = skipReasonOf(b.url)
      if (reason) kind = reason
      else {
        const hit = opts.cache[b.url]
        kind = hit && opts.now - hit.fetchedAt < ttl ? 'cached' : 'fetch'
      }
    }
    const key = `${kind}\n${b.url}`
    const g = groups.get(key)
    if (g) g.bookmarkIds.push(b.id)
    else groups.set(key, { kind, url: b.url, bookmarkIds: [b.id] })
  }

  const plan: FetchPlan = { toFetch: [], cached: [], skipped: [] }
  for (const g of groups.values()) {
    if (g.kind === 'fetch') plan.toFetch.push({ url: g.url, bookmarkIds: g.bookmarkIds })
    else if (g.kind === 'cached') plan.cached.push({ url: g.url, bookmarkIds: g.bookmarkIds })
    else plan.skipped.push({ url: g.url, bookmarkIds: g.bookmarkIds, reason: g.kind })
  }
  return plan
}

// ---------------------------------------------------------------- 解析 <head>

const clean = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined
  const out = decodeEntities(s).replace(/\s+/g, ' ').trim()
  return out || undefined
}

function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const re = /([a-zA-Z_:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? ''
  return attrs
}

/** 正则解析 <head>，不用 DOMParser：service worker 和 node 里都能跑 */
export function parseHead(html: string): { title?: string; description?: string; siteName?: string; lang?: string; charset?: string } {
  const end = html.search(/<\/head\s*>|<body[\s>]/i)
  const head = end > 0 ? html.slice(0, end) : html.slice(0, 200000)

  const metas: Record<string, string> = {}
  let charset: string | undefined
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const a = parseAttrs(tag)
    if (a.charset) charset = a.charset.trim()
    const httpEquiv = (a['http-equiv'] || '').toLowerCase()
    if (httpEquiv === 'content-type' && a.content) {
      const m = /charset\s*=\s*([\w-]+)/i.exec(a.content)
      if (m) charset = m[1]
    }
    const key = (a.property || a.name || '').toLowerCase()
    if (key && a.content !== undefined && metas[key] === undefined) metas[key] = a.content
  }

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]
  const lang = /<html\b[^>]*?\blang\s*=\s*["']?([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)/i.exec(html.slice(0, 4096))?.[1]
  return {
    title: clean(titleTag) ?? clean(metas['og:title']) ?? clean(metas['twitter:title']),
    description: clean(metas.description) ?? clean(metas['og:description']) ?? clean(metas['twitter:description']),
    siteName: clean(metas['og:site_name']) ?? clean(metas['application-name']),
    lang,
    charset: charset?.toLowerCase()
  }
}

// ---------------------------------------------------------------- 抓一个网址

const LOGIN_URL = /(login|signin|sign_in|sign-in|passport|sso|oauth|\/auth\b|accounts?\/)/i
const LOGIN_TITLE = /^(登录|登陆|用户登录|统一身份认证|sign in|log in|login)\b|登录\s*[-|_—]|^log in to /i

/** 只比域名（去 www）和路径（去尾斜杠），协议和参数不算 */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a)
    const y = new URL(b)
    const norm = (u: URL) => `${u.hostname.toLowerCase().replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`
    return norm(x) === norm(y)
  } catch {
    return a === b
  }
}

async function readLimited(res: Response, maxBytes: number, stopAtHead = true): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(await res.arrayBuffer()).slice(0, maxBytes)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    // 只要 <head> 时读到 </head> 就够了；超过上限也停
    const tail = stopAtHead ? new TextDecoder('latin1').decode(value.subarray(Math.max(0, value.byteLength - 4096))) : ''
    if (size >= maxBytes || (stopAtHead && /<\/head\s*>/i.test(tail))) {
      await reader.cancel().catch(() => {})
      break
    }
  }
  const out = new Uint8Array(Math.min(size, maxBytes))
  let offset = 0
  for (const c of chunks) {
    if (offset >= out.length) break
    const part = c.subarray(0, out.length - offset)
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

function decodeBody(bytes: Uint8Array, contentType: string): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1]
  const sniff = new TextDecoder('latin1').decode(bytes.subarray(0, 4096))
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff)?.[1]
  const label = (fromHeader || fromMeta || 'utf-8').toLowerCase()
  try {
    return new TextDecoder(label).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

function lastSegment(url: string): string | undefined {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop()
    return seg ? decodeSafe(seg) : undefined
  } catch {
    return undefined
  }
}

const RETRY_STATUSES = new Set<FetchStatus>(['unreachable', 'timeout', 'server-error'])

export async function fetchPage(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number; now?: () => number; retryDelayMs?: number } = {}
): Promise<PageInfo> {
  const first = await fetchOnce(url, opts)
  if (!RETRY_STATUSES.has(first.status)) return first
  await new Promise((r) => setTimeout(r, opts.retryDelayMs ?? 1000))
  return fetchOnce(url, opts)
}

async function fetchOnce(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number; now?: () => number }
): Promise<PageInfo> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const ctrl = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ctrl.abort()
  }, opts.timeoutMs ?? 8000)
  const base = (status: FetchStatus, extra: Partial<PageInfo> = {}): PageInfo => ({ url, status, fetchedAt: now(), ...extra })
  try {
    const res = await fetchImpl(url, {
      credentials: 'omit',
      // 不用 HTTP 缓存：收藏即整理拿这里的简介当公开版本，缓存里可能是带 Cookie 取回的
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    })
    const httpStatus = res.status
    const finalUrl = res.url || url
    if (httpStatus === 404 || httpStatus === 410) return base('dead', { httpStatus, finalUrl })
    if (httpStatus >= 500) return base('server-error', { httpStatus, finalUrl })
    // 401 明说要登录；403 / 429 和其他 4xx 多半是不带 cookie 被反爬拦了，不知道页面还在不在，不算失效也不算要登录
    if (httpStatus === 401) return base('login', { httpStatus, finalUrl })
    if (httpStatus >= 400) return base('blocked', { httpStatus, finalUrl })

    const contentType = res.headers.get('content-type') || ''
    const redirected = !samePage(url, finalUrl)
    if (!/html|xml/i.test(contentType)) {
      await res.body?.cancel().catch(() => {})
      return base(redirected ? 'redirect' : 'ok', { httpStatus, finalUrl, title: lastSegment(finalUrl) })
    }
    const head = parseHead(decodeBody(await readLimited(res, opts.maxBytes ?? 512 * 1024), contentType))
    const info = { httpStatus, finalUrl, title: head.title, description: head.description, siteName: head.siteName, lang: head.lang }
    const loginLike = (redirected && LOGIN_URL.test(finalUrl)) || LOGIN_TITLE.test(head.title || '')
    return base(loginLike ? 'login' : redirected ? 'redirect' : 'ok', info)
  } catch (e) {
    if (timedOut) return base('timeout', { error: '超时' })
    return base('unreachable', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 二期：不带 Cookie 抓整页，转成纯文本。用来核对「标签页里读到的正文是不是公开版本」：
 * 服务器认不出是谁，拿到的就是没登录的人也能看到的内容。失败、非 HTML、非 2xx 都返回 ok: false。
 */
export async function fetchPublicText(
  url: string,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {}
): Promise<{ ok: boolean; httpStatus?: number; text: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 8000)
  try {
    const res = await fetchImpl(url, {
      credentials: 'omit',
      // 不用 HTTP 缓存：缓存里可能是标签页带着 Cookie 取回的登录后版本
      cache: 'no-store',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8' }
    })
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !/html|xml/i.test(contentType)) {
      await res.body?.cancel().catch(() => {})
      return { ok: false, httpStatus: res.status, text: '' }
    }
    const html = decodeBody(await readLimited(res, opts.maxBytes ?? 2 * 1024 * 1024, false), contentType)
    return { ok: true, httpStatus: res.status, text: htmlToText(html) }
  } catch {
    return { ok: false, text: '' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- 队列

const FAILED = new Set<FetchStatus>(['dead', 'unreachable', 'timeout', 'server-error', 'blocked'])

export function createFetchQueue(opts: {
  items: { url: string; bookmarkIds: string[] }[]
  concurrency?: number
  fetchOne: (url: string) => Promise<PageInfo>
  onResult: (info: PageInfo) => void | Promise<void>
  onProgress: (p: FetchProgress) => void
}): FetchRun {
  const items = opts.items
  const concurrency = opts.concurrency ?? 6
  let next = 0
  let running = 0
  let done = 0
  let failed = 0
  let paused = false
  let stopped = false
  let finished = false
  let resolveDone: (p: FetchProgress) => void = () => {}
  const donePromise = new Promise<FetchProgress>((r) => (resolveDone = r))

  const progress = (): FetchProgress => ({ total: items.length, done, failed, running, paused })
  const emit = () => opts.onProgress(progress())
  const finish = () => {
    if (finished) return
    finished = true
    emit()
    resolveDone(progress())
  }

  const runOne = async (url: string) => {
    let info: PageInfo
    try {
      info = await opts.fetchOne(url)
    } catch (e) {
      info = { url, status: 'unreachable', fetchedAt: Date.now(), error: e instanceof Error ? e.message : String(e) }
    }
    try {
      await opts.onResult(info)
    } catch {
      // 存盘失败不影响继续抓
    }
    running--
    done++
    if (FAILED.has(info.status)) failed++
    emit()
    pump()
  }

  const pump = () => {
    if (finished) return
    while (!stopped && !paused && running < concurrency && next < items.length) {
      running++
      void runOne(items[next++].url)
    }
    if (running === 0 && (stopped || next >= items.length)) finish()
  }

  queueMicrotask(pump)
  return {
    progress,
    pause() {
      paused = true
      emit()
    },
    resume() {
      paused = false
      emit()
      pump()
    },
    stop() {
      stopped = true
      paused = false
      emit()
      pump()
    },
    done: donePromise
  }
}

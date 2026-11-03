// 正文工具（二期）：HTML 转纯文本（正则，service worker 和 node 里都能跑）、取摘录、
// 核对摘录是不是不带 Cookie 也能看到的公开版本里的内容。

/** 发给 AI 的正文片段最长多少字 */
export const EXCERPT_MAX = 1500
/** 本机每条最多存多少字正文 */
export const TEXT_MAX = 30000
/** 摘录短于这个长度时整段比对，否则抽 4 段比对 */
const WINDOW_TOTAL = 120
const WINDOW = 30

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·',
  copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•'
}

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? m
  })
}

const BLOCK_END = /<\/(p|div|li|ul|ol|h[1-6]|tr|table|section|article|header|footer|pre|blockquote|dd|dt)\s*>|<(br|hr)\b[^>]*>/gi

/** 整个页面的可见文字（不是正文抽取，导航、页脚也在里面）：只用来核对摘录 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(BLOCK_END, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v\u00a0\u3000]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

/** 合并空白 */
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** 按字符（码点）截断，不加省略号 */
export function cutChars(s: string, max: number): string {
  const chars = [...s]
  return chars.length <= max ? s : chars.slice(0, max).join('')
}

/** 摘录：合并空白后的前 EXCERPT_MAX 字（还没脱敏，核对公开版本要用原文） */
export const rawExcerpt = (text: string): string => cutChars(collapse(text), EXCERPT_MAX)

// 去掉全部空白和零宽字符再比，两边抽取方式不同造成的换行、空格差异不算
const squash = (s: string): string => s.replace(/[\s\u200b-\u200d\ufeff]+/g, '')

/**
 * 摘录是不是公开版本里的：摘录不到 120 字时整段都要出现在公开正文里；
 * 否则最后 30 字必须出现（登录墙、付费墙多半截掉后半段，只看前面会把摘录末尾的私密内容放过去），
 * 并且在 0、25%、50%、75% 处各取 30 字，至少 3 段出现（容得下两边抽正文的小差异）。
 */
export function isPublicExcerpt(excerpt: string, publicText: string): boolean {
  const e = [...squash(excerpt)]
  const p = squash(publicText)
  if (!e.length || !p) return false
  if (e.length < WINDOW_TOTAL) return p.includes(e.join(''))
  const has = (o: number) => p.includes(e.slice(o, o + WINDOW).join(''))
  if (!has(e.length - WINDOW)) return false
  const hits = [0, 0.25, 0.5, 0.75].map((f) => Math.min(Math.floor(e.length * f), e.length - WINDOW)).filter(has).length
  return hits >= 3
}

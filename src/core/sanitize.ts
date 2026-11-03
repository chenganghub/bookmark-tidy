// 发给 AI 之前的脱敏，抓网页时判断「随机串」也用这里的定义（同一个定义只写一处）。

export const RANDOM_TOKEN_MIN = 24

// 随机串：连续 ≥ 24 个字母数字下划线，并且同时含字母和数字。
// 不含连字符：「how-to-use-vue3-composition-api」这种文章网址的单词串不该算随机串。
const TOKEN_RE = /[A-Za-z0-9_]{24,}/g
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g
// 前后不是数字，避免把更长的数字串（订单号、时间戳）的一段当手机号
const PHONE_RE = /(?<!\d)1[3-9]\d{9}(?!\d)/g

const isRandom = (s: string): boolean => /[A-Za-z]/.test(s) && /\d/.test(s)

export function findRandomTokens(s: string): string[] {
  return (s.match(TOKEN_RE) || []).filter(isRandom)
}

/** 邮箱 → {邮箱}；手机号 → {手机号}；随机串 → {随机串} */
export function sanitizeText(s: string): string {
  return s
    .replace(EMAIL_RE, '{邮箱}')
    .replace(PHONE_RE, '{手机号}')
    .replace(TOKEN_RE, (t) => (isRandom(t) ? '{随机串}' : t))
}

/** 发给 AI 的网址：只留「域名 + 路径」，去掉协议、www、参数和 #；路径也脱敏。非 http(s) 只返回协议 */
export function sanitizeUrlForAi(url: string): string {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return ''
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return u.protocol
  const host = u.hostname.toLowerCase().replace(/^www\./, '')
  let path = u.pathname
  try {
    // 中文路径解码后 AI 才看得懂
    path = decodeURIComponent(path)
  } catch {
    // 不是合法的百分号编码，保留原样
  }
  path = path.replace(/\/+$/, '')
  return sanitizeText(host + path)
}

/** 按字符（码点）截断，超出时末尾加「…」，总长不超过 max */
export function truncate(s: string, max: number): string {
  const chars = [...s]
  if (chars.length <= max) return s
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`
}

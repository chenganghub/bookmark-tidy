// 体检规则：网址规范化、标题清理、各项计数。全项目只有这一份（tools/audit-bookmarks.mjs 也 import 它）。
// 只用可擦除的 TS 语法、只 import 类型，Node 24 能直接导入这个文件。
import type { AuditInput, AuditIssues, AuditSummary } from './types'

// ---------------------------------------------------------------- 网址

/** 追踪参数：规范化时去掉（只用于找重复，不改真实网址） */
const TRACKING_PARAM = /^(utm_|spm|from$|share|source$|ref$|vd_source$|bd_vid$|fbclid$|gclid$)/i

/** 网址规范化：忽略协议、www、#、追踪参数、路径尾部斜杠；非 http(s) 原样返回 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw)
    if (!/^https?:$/.test(u.protocol)) return raw
    u.hash = ''
    for (const key of [...u.searchParams.keys()]) if (TRACKING_PARAM.test(key)) u.searchParams.delete(key)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    const port = u.port ? `:${u.port}` : ''
    return `${host}${port}${u.pathname.replace(/\/+$/, '')}${u.search}`
  } catch {
    return raw
  }
}

export const INTRANET = /^https?:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i

export const isHttp = (url: string): boolean => /^https?:\/\//i.test(url)
export const isIntranet = (url: string): boolean => INTRANET.test(url)

/** 域名（去 www.）；不是合法网址返回 '' */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------- 标题

export const TITLE_RULES = {
  // 消息数前缀：知乎「(3 封私信 / 15 条消息) 标题」、CSDN「(15条消息) 标题」
  messagePrefix: /^\(\s*\d+\s*(封私信|条消息)[^)]*\)\s*/,
  // 网页未读数：「(12) 标题」
  countPrefix: /^\(\d+\+?\)\s*/,
  // CSDN 后缀（作者段单独处理，见 stripCsdn）：「…-CSDN博客」「… - CSDN博客」，后面可能还跟「_关键词」
  csdnSuffix: /(\s+-\s+|-)CSDN博客(?:_.*)?$/,
  // 其他站名后缀，按顺序各试一次
  siteSuffix: [
    // 带作者或专栏段，只认这两个站：「标题 - 作者 - 博客园」「标题 - 个人文章 - SegmentFault 思否」
    /\s*[-_|–—]\s*[^-_|–—]{1,30}?\s+[-_|–—]\s*(?:博客园|SegmentFault 思否)\s*$/,
    // 直接站名：「标题 - 知乎」「标题_哔哩哔哩_bilibili」
    /\s*[-_|–—]\s*(?:CSDN|博客园|简书|稀土掘金|掘金|知乎|SegmentFault 思否|思否|哔哩哔哩(?:_bilibili)?|bilibili|腾讯云开发者社区(?:-腾讯云)?|阿里云开发者社区|开源中国|OSCHINA|InfoQ|51CTO博客)\s*$/i
  ],
  // 说明不了内容的标题
  vague: /^(首页|主页|登录|登陆|欢迎|控制台|管理后台|后台管理|Home|Login|Sign in|Dashboard|Index|Untitled|无标题)(\s|$|[-_|])/i
}

export const LONG_TITLE = 50
export const DEFAULT_FOLDER_NAME = /^(新建文件夹|New folder|未命名|无标题)/i

/**
 * 去 CSDN 后缀。只去能确定的部分，拿不准的宁可留着：
 * - 旧格式「标题 - 博客名 - CSDN博客」：去掉最后一个「 - 」之后的博客名
 * - 新格式「标题_某某的博客-CSDN博客_关键词」：有「的博客」标记才去作者段；
 *   作者名可能带下划线（weixin_39954487、MISTLETOE_WW），左边一段也是纯英文数字时并进作者名
 * - 新格式没有「的博客」标记（「标题_自定义博客名-CSDN博客」）：分不清博客名和标题，只去「-CSDN博客」
 */
export function stripCsdn(title: string): string {
  const m = TITLE_RULES.csdnSuffix.exec(title)
  if (!m) return title
  const head = title.slice(0, m.index)
  if (m[1] !== '-') {
    const i = head.lastIndexOf(' - ')
    return i > 0 ? head.slice(0, i) : head
  }
  if (!head.endsWith('的博客')) return head
  const body = head.slice(0, -'的博客'.length)
  let cut = body.lastIndexOf('_')
  if (cut <= 0) return head
  while (/^[A-Za-z0-9_]+$/.test(body.slice(cut + 1))) {
    const prev = body.lastIndexOf('_', cut - 1)
    if (prev <= 0 || !/^[A-Za-z0-9]+$/.test(body.slice(prev + 1, cut))) break
    cut = prev
  }
  return body.slice(0, cut)
}

/** 规则能判断的标题清理：去消息数前缀、未读数前缀、站名后缀。清理后为空就保留原标题。 */
export function cleanTitle(raw: string): string {
  const original = `${raw || ''}`.trim()
  let title = original.replace(TITLE_RULES.messagePrefix, '').replace(TITLE_RULES.countPrefix, '')
  title = stripCsdn(title)
  for (const rule of TITLE_RULES.siteSuffix) title = title.replace(rule, '')
  title = title.trim()
  return title || original
}

export const hasSiteSuffix = (title: string): boolean =>
  TITLE_RULES.csdnSuffix.test(title) || TITLE_RULES.siteSuffix.some((rule) => rule.test(title))

// ---------------------------------------------------------------- 体检

const DAY = 86400000
/** 冷门：添加超过一年，且没有「最近打开」记录 */
export const COLD_AFTER_MS = 365 * DAY

export function isCold(b: { dateAdded: number; dateLastUsed: number }, now: number): boolean {
  return !b.dateLastUsed && b.dateAdded > 0 && now - b.dateAdded > COLD_AFTER_MS
}

/** 子文件夹和父文件夹同名，或父名以子名开头（如 css框架/css） */
export function isNestedSameName(f: { title: string; parentTitle: string }): boolean {
  if (!f.parentTitle) return false
  const child = f.title.toLowerCase()
  const parent = f.parentTitle.toLowerCase()
  return child === parent || parent.startsWith(child)
}

/** 体检：同时给汇总数字和每项对应的条目 id */
export function audit(input: AuditInput, now: number = Date.now()): { summary: AuditSummary; issues: AuditIssues } {
  const { bookmarks, folders } = input
  const titleOf = (b: { title: string }) => b.title.trim()

  // 三个常设的根总是列出：书签文件里总有它们，Chrome 接口在「移动设备书签」为空时却不返回，两边要对得上
  const roots: AuditSummary['roots'] = {}
  for (const t of ['bookmarks-bar', 'other', 'mobile']) roots[t] = { bookmarks: 0, topFolders: 0, looseBookmarks: 0 }
  for (const r of input.roots) {
    const cur = roots[r.rootType] || { bookmarks: 0, topFolders: 0, looseBookmarks: 0 }
    cur.bookmarks += r.bookmarks
    cur.topFolders += r.topFolders
    cur.looseBookmarks += r.looseBookmarks
    roots[r.rootType] = cur
  }

  // 重复
  const exact = new Map<string, string[]>()
  const normalized = new Map<string, string[]>()
  for (const b of bookmarks) {
    exact.set(b.url, [...(exact.get(b.url) || []), b.id])
    const key = normalizeUrl(b.url)
    normalized.set(key, [...(normalized.get(key) || []), b.id])
  }
  const groupsOf = (m: Map<string, string[]>) => [...m.values()].filter((ids) => ids.length > 1)
  const dupStats = (groups: string[][]) => ({ groups: groups.length, extra: groups.reduce((s, g) => s + g.length - 1, 0) })
  const exactGroups = groupsOf(exact)
  const normGroups = groupsOf(normalized)

  // 文件夹
  const byName = new Map<string, string[]>()
  for (const f of folders) byName.set(f.title, [...(byName.get(f.title) || []), f.id])
  const dupNameGroups = [...byName.values()].filter((ids) => ids.length > 1)

  // 网址
  const protocols: Record<string, number> = {}
  const domains = new Map<string, number>()
  for (const b of bookmarks) {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(b.url)
    const p = m ? m[1].toLowerCase() : '(无)'
    protocols[p] = (protocols[p] || 0) + 1
    if (p === 'http' || p === 'https') {
      const host = hostOf(b.url)
      if (host) domains.set(host, (domains.get(host) || 0) + 1)
    }
  }
  const domainList = [...domains.entries()].sort((a, b) => b[1] - a[1])

  const byYear: Record<string, number> = {}
  for (const b of bookmarks) {
    const y = b.dateAdded ? `${new Date(b.dateAdded).getFullYear()}` : '未知'
    byYear[y] = (byYear[y] || 0) + 1
  }

  const ids = <T extends { id: string }>(arr: T[], fn: (x: T) => boolean) => arr.filter(fn).map((x) => x.id)

  const issues: AuditIssues = {
    emptyFolders: ids(folders, (f) => f.directBookmarks === 0 && f.subFolders === 0),
    singleBookmarkFolders: ids(folders, (f) => f.directBookmarks === 1 && f.subFolders === 0),
    bigFlatFolders: ids(folders, (f) => f.directBookmarks >= 50),
    nestedSameNameFolders: ids(folders, isNestedSameName),
    defaultNameFolders: ids(folders, (f) => DEFAULT_FOLDER_NAME.test(f.title)),
    duplicateNameFolderGroups: dupNameGroups,
    duplicateGroups: normGroups,
    messagePrefix: ids(bookmarks, (b) => TITLE_RULES.messagePrefix.test(titleOf(b))),
    countPrefix: ids(bookmarks, (b) => TITLE_RULES.countPrefix.test(titleOf(b))),
    siteSuffix: ids(bookmarks, (b) => hasSiteSuffix(titleOf(b))),
    cleanable: ids(bookmarks, (b) => cleanTitle(b.title) !== titleOf(b)),
    longTitle: ids(bookmarks, (b) => [...titleOf(b)].length > LONG_TITLE),
    vagueTitle: ids(bookmarks, (b) => TITLE_RULES.vague.test(titleOf(b))),
    emptyTitle: ids(bookmarks, (b) => !titleOf(b)),
    urlAsTitle: ids(bookmarks, (b) => /^https?:\/\//i.test(titleOf(b))),
    notHttp: ids(bookmarks, (b) => !isHttp(b.url)),
    intranet: ids(bookmarks, (b) => isIntranet(b.url)),
    cold: ids(bookmarks, (b) => isCold(b, now))
  }

  const count = <T>(arr: T[], fn: (x: T) => boolean) => arr.filter(fn).length
  const summary: AuditSummary = {
    bookmarks: bookmarks.length,
    folders: folders.length,
    roots,
    maxFolderDepth: Math.max(0, ...folders.map((f) => f.depth)),
    folderIssues: {
      empty: issues.emptyFolders.length,
      singleBookmark: issues.singleBookmarkFolders.length,
      bigFlat50: issues.bigFlatFolders.length,
      nestedSameName: issues.nestedSameNameFolders.length,
      defaultName: issues.defaultNameFolders.length,
      duplicateNameGroups: dupNameGroups.length
    },
    duplicates: { exact: dupStats(exactGroups), normalized: dupStats(normGroups) },
    urls: {
      protocols,
      intranet: issues.intranet.length,
      domains: domainList.length,
      singleUseDomains: domainList.filter(([, n]) => n === 1).length,
      topDomains: domainList.slice(0, 20).map(([domain, n]) => ({ domain, count: n }))
    },
    titles: {
      empty: issues.emptyTitle.length,
      isUrl: issues.urlAsTitle.length,
      messagePrefix: issues.messagePrefix.length,
      countPrefix: issues.countPrefix.length,
      siteSuffix: issues.siteSuffix.length,
      cleanable: issues.cleanable.length,
      long: issues.longTitle.length,
      vague: issues.vagueTitle.length
    },
    usage: {
      hasLastUsed: count(bookmarks, (b) => b.dateLastUsed > 0),
      usedIn30d: count(bookmarks, (b) => b.dateLastUsed > 0 && now - b.dateLastUsed < 30 * DAY),
      usedIn180d: count(bookmarks, (b) => b.dateLastUsed > 0 && now - b.dateLastUsed < 180 * DAY),
      cold: issues.cold.length
    },
    addedByYear: byYear
  }
  return { summary, issues }
}

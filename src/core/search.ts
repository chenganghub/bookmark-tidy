// 搜索（二期）：地址栏关键字 s 和弹窗搜索框共用。按空白切词，每个词都要命中；
// 命中标题记 3 分、标签 2 分、说明 2 分、网址 1 分、目录名 1 分；同分按最近打开、再按添加时间。
import type { BookmarkMeta, FlatTree } from './types'

export interface SearchEntry {
  id: string
  url: string
  title: string
  /** AI 写的干净标题，也按标题算 */
  aiTitle: string
  desc: string
  tags: string[]
  /** 所在目录，如「前端基础/JS 处理」 */
  folder: string
  dateAdded: number
  dateLastUsed: number
}

export function buildIndex(flat: FlatTree, meta: Record<string, BookmarkMeta>): SearchEntry[] {
  return flat.bookmarks.map((b) => {
    const m = meta[b.id]
    return {
      id: b.id,
      url: b.url,
      title: b.title,
      aiTitle: m?.title ?? '',
      desc: m?.desc ?? '',
      tags: m?.tags ?? [],
      folder: b.path.join('/'),
      dateAdded: b.dateAdded,
      dateLastUsed: b.dateLastUsed
    }
  })
}

const FIELDS: [(e: SearchEntry) => string, number][] = [
  [(e) => `${e.title} ${e.aiTitle}`, 3],
  [(e) => e.tags.join(' '), 2],
  [(e) => e.desc, 2],
  [(e) => e.url, 1],
  [(e) => e.folder, 1]
]

export function searchBookmarks(entries: SearchEntry[], query: string, limit = 6): SearchEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!terms.length) return []
  const scored: { e: SearchEntry; score: number }[] = []
  for (const e of entries) {
    const hay = FIELDS.map(([get, w]) => [get(e).toLowerCase(), w] as const)
    let score = 0
    let all = true
    for (const t of terms) {
      const s = hay.reduce((sum, [text, w]) => (text.includes(t) ? sum + w : sum), 0)
      if (!s) {
        all = false
        break
      }
      score += s
    }
    if (all) scored.push({ e, score })
  }
  scored.sort((a, b) => b.score - a.score || b.e.dateLastUsed - a.e.dateLastUsed || b.e.dateAdded - a.e.dateAdded)
  return scored.slice(0, limit).map((x) => x.e)
}

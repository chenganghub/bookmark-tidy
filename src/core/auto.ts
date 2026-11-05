// 收藏即整理的判断（二期），全是纯函数：往哪些目录放、哪些算「没放好」、一条收藏还能不能动、放到哪。
import { normalizeUrl } from './rules'
import { INBOX_NAME, specialFolders } from './plan'
import { descendantFolderIds, isUnderFolders } from './tree'
import type { ApplyLog, AutoJob, AutoRecord, BookmarkMeta, FlatBookmark, FlatTree, Plan } from './types'

/** 收藏后等多久再处理：让用户在 Chrome 的收藏气泡里先挑完文件夹 */
export const AUTO_DELAY_MS = 8000
/** 一键整理不超过这么多条时直接放，多了先让用户确认去向 */
export const BUTTON_DIRECT_MAX = 10
/** 自动放好之后这么久之内被用户挪走，记一次「又挪走」 */
export const MOVED_AGAIN_MS = 7 * 86400000
/**
 * 收藏时一期的应用或撤销正在跑：先排着等它做完，最多等这么久。
 * 做到一半停了、一直没人继续时不一直等；没处理的之后算进一键整理（最近一次应用之后新加的）。
 */
export const WAIT_MAX_MS = 10 * 60000

/** 最近一次应用是「完成」= 目录定下来了，自动整理才开始 */
export const isOrganized = (latest: ApplyLog | undefined): boolean => latest?.status === 'done'

/** 目录路径里用全角斜杠代替名字里的半角斜杠（「UI/UX」→「UI／UX」），和一期方案的路径写法一致 */
const seg = (title: string) => title.replace(/\//g, '／').trim()

export interface Candidates {
  /** 「父/子」或「父」 */
  paths: string[]
  idOf: Record<string, string>
  /** 上次方案里的目录定义（有的话） */
  descs: Record<string, string>
}

/**
 * 自动整理能往里放的目录：书签栏下、不在锁定文件夹里的前两层目录。
 * 有子目录的顶层目录，只有它自己直接放着书签时才算一个去处（和一期方案「子目录太小并回父目录」的结果一致）。
 * 同名的取先出现的那个。
 */
export function candidateFolders(flat: FlatTree, barRootId: string, lockedIds: Set<string>, plan?: Plan): Candidates {
  const locked = descendantFolderIds(flat, [...lockedIds])
  const out: Candidates = { paths: [], idOf: {}, descs: {} }
  const add = (path: string, id: string) => {
    if (!path || out.idOf[path]) return
    out.paths.push(path)
    out.idOf[path] = id
  }
  const tops = flat.folders.filter((f) => f.parentId === barRootId && !locked.has(f.id) && !f.unmodifiable)
  for (const top of tops) {
    const name = seg(top.title)
    const kids = flat.folders.filter((f) => f.parentId === top.id && !locked.has(f.id) && !f.unmodifiable)
    if (!kids.length || top.directBookmarks > 0) add(name, top.id)
    for (const k of kids) add(`${name}/${seg(k.title)}`, k.id)
  }
  if (plan) {
    for (const f of plan.folders) {
      if (out.idOf[f.key] && f.desc) out.descs[f.key] = f.desc
      for (const c of f.children) if (out.idOf[c.key] && c.desc) out.descs[c.key] = c.desc
    }
  }
  return out
}

/** 根下的「其他书签」「移动设备书签」和三个保留目录 */
function scopeOf(flat: FlatTree) {
  const bars = flat.roots.filter((r) => r.rootType === 'bookmarks-bar').map((r) => r.id)
  const others = flat.roots.filter((r) => r.rootType === 'other').map((r) => r.id)
  const mobiles = flat.roots.filter((r) => r.rootType === 'mobile').map((r) => r.id)
  const special = others.map((id) => specialFolders(flat, id))
  return { bars, others, mobiles, special }
}

/**
 * 还没放好的新收藏：工具栏角标和弹窗「放好 N 条」的 N，也是一键整理的范围。
 * 算进来：在其他书签或移动设备书签根下直接放着的；最近一次一期应用之后新加、还没有说明的（撤销、恢复重建出来的不算新加）。
 * 排除：锁定的；「待整理」里的（在管理页「待处理」里处理）；「待清理」「整理前的空文件夹」里的；书签栏上散放的（跟一期设置）；
 * 非 http(s) 的；你定过位置的（placed）；自动整理记录是你撤销过、自己挪走过的。
 * 「有说明」只用来判断新加的：根下散放的有说明也算（整理页生成方案会先补说明，生成了不应用时，散放的不会从 N 里悄悄消失）。
 */
export function unfiledBookmarks(input: {
  flat: FlatTree
  meta: Record<string, BookmarkMeta>
  records: Record<string, AutoRecord>
  lockedIds: Set<string>
  keepLooseBarItems: boolean
  /** 最近一次「完成」的一期应用开始的时间 */
  organizedAt: number
  /** 撤销、恢复重建出来的书签：id 是新的、没有说明，但不是新收藏，不算「新加的」（放在根下的照样算） */
  own?: Set<string>
  /** 你定过位置的（store 的 handPlaced） */
  placed: Set<string>
}): FlatBookmark[] {
  const { flat, meta, records, placed } = input
  const own = input.own ?? new Set<string>()
  const s = scopeOf(flat)
  const locked = descendantFolderIds(flat, [...input.lockedIds])
  const parked = descendantFolderIds(
    flat,
    s.special.flatMap((sp) => [sp.inbox, sp.cleanup, sp.holding]).filter((x): x is string => !!x)
  )
  const roots = new Set([...s.bars, ...s.others, ...s.mobiles])
  return flat.bookmarks.filter((b) => {
    if (!roots.has(b.rootId) || !/^https?:\/\//i.test(b.url) || placed.has(b.id)) return false
    if (isUnderFolders(b, locked) || isUnderFolders(b, parked)) return false
    if (input.keepLooseBarItems && s.bars.includes(b.rootId) && b.depth === 1) return false
    const r = records[b.id]
    if (r && (r.status === 'undone' || r.status === 'moved-by-user')) return false
    const looseInOther = s.others.includes(b.rootId) && b.depth === 1
    const looseInMobile = s.mobiles.includes(b.rootId) && b.depth === 1
    const fresh = !meta[b.id] && b.dateAdded > input.organizedAt && !own.has(b.id)
    return looseInOther || looseInMobile || fresh
  })
}

export type JobCheck =
  | { drop: 'missing' | 'url-changed' | 'locked' | 'parked' | 'done-before' | 'own' }
  | { drop?: undefined; userMoved: boolean; userRetitled: boolean }

/**
 * 一条收藏到处理时还能不能动。丢弃：书签没了、网址变了、进了锁定文件夹或保留目录、自动整理过、是撤销或恢复重建的。
 * 父文件夹和收藏那一刻不同 = 用户在气泡里（或之后）挪过；标题不同 = 改过。
 */
export function checkJob(job: AutoJob, flat: FlatTree, ctx: { lockedIds: Set<string>; records: Record<string, AutoRecord>; own: Set<string> }): JobCheck {
  if (ctx.own.has(job.bookmarkId)) return { drop: 'own' }
  if (ctx.records[job.bookmarkId]) return { drop: 'done-before' }
  const b = flat.bookmarks.find((x) => x.id === job.bookmarkId)
  if (!b) return { drop: 'missing' }
  if (b.url !== job.url) return { drop: 'url-changed' }
  if (isUnderFolders(b, descendantFolderIds(flat, [...ctx.lockedIds]))) return { drop: 'locked' }
  const s = scopeOf(flat)
  const parked = descendantFolderIds(
    flat,
    s.special.flatMap((sp) => [sp.cleanup, sp.holding]).filter((x): x is string => !!x)
  )
  if (isUnderFolders(b, parked)) return { drop: 'parked' }
  return { userMoved: b.parentId !== job.parentId, userRetitled: b.title !== job.title }
}

export type MoveDecision = { kind: 'folder'; folderId: string; path: string } | { kind: 'inbox'; path: string }

/** 把握够、目录在候选里 → 放进去；否则 → 待整理 */
export function decideMove(suggestion: { path: string; confidence: number } | undefined, threshold: number, cands: Candidates): MoveDecision {
  if (suggestion && suggestion.path && cands.idOf[suggestion.path] && suggestion.confidence >= threshold) {
    return { kind: 'folder', folderId: cands.idOf[suggestion.path], path: suggestion.path }
  }
  return { kind: 'inbox', path: INBOX_NAME }
}

/** 同一网页的另一条书签（规范化网址相同），给通知里写「以前收藏过，在哪」 */
export function findDuplicate(flat: FlatTree, bookmarkId: string, url: string): FlatBookmark | undefined {
  const key = normalizeUrl(url)
  return flat.bookmarks.find((b) => b.id !== bookmarkId && normalizeUrl(b.url) === key)
}

/** 标签页网址和书签网址是不是同一页（去 #、跟踪参数、www、尾斜杠后比） */
export const sameUrl = (a: string, b: string): boolean => normalizeUrl(a) === normalizeUrl(b)

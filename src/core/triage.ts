// 管理页「待处理」（bookmark-ux）：拿不准放哪、建议删除、空文件夹。全是纯函数，不碰书签。
import { INBOX, reusedFolders, specialFolders } from './plan'
import { normalizeUrl } from './rules'
import { descendantFolderIds, pickRoot } from './tree'
import type { AutoRecord, CleanupReason, EmptyGroup, FlatBookmark, FlatFolder, FlatTree, FolderChoice, PageInfo, Plan, Triage, TriageEntry } from './types'

/** 每个「其他书签」根下的待整理、整理前的空文件夹、待清理（账号版和本机版各有一个时都算） */
function specialIds(flat: FlatTree) {
  const sp = flat.roots.filter((r) => r.rootType === 'other').map((r) => specialFolders(flat, r.id))
  const ids = (k: 'inbox' | 'holding' | 'cleanup') => new Set(sp.map((x) => x[k]).filter((x): x is string => !!x))
  return { inbox: ids('inbox'), holding: ids('holding'), cleanup: ids('cleanup') }
}

const under = (ids: Set<string>) => (b: FlatBookmark) => b.folderIds.some((id) => ids.has(id))

/** 要你拿主意的书签数（拿不准放哪 + 建议删除）：弹窗的「待处理 M」。空文件夹不算：不影响任何书签，不拿它催你 */
export function pendingCount(flat: FlatTree): number {
  const { inbox, holding, cleanup } = specialIds(flat)
  return flat.bookmarks.filter((b) => b.folderIds.some((id) => inbox.has(id) || holding.has(id) || cleanup.has(id))).length
}

/** 「放到」的选项：书签栏下前两层、不在锁定里、不是管理员配置的文件夹 */
export function folderChoices(flat: FlatTree, lockedIds: Set<string>): FolderChoice[] {
  const bar = pickRoot(flat, 'bookmarks-bar')
  if (!bar) return []
  const locked = descendantFolderIds(flat, [...lockedIds])
  const ok = (f: FlatFolder) => !locked.has(f.id) && !f.unmodifiable
  const out: FolderChoice[] = []
  for (const top of flat.folders.filter((f) => f.parentId === bar.id && ok(f))) {
    out.push({ id: top.id, path: top.title })
    for (const c of flat.folders.filter((f) => f.parentId === top.id && ok(f))) out.push({ id: c.id, path: `${top.title} / ${c.title}` })
  }
  return out
}

export function buildTriage(input: { flat: FlatTree; pages: Record<string, PageInfo>; lockedIds: Set<string>; records: Record<string, AutoRecord>; plan?: Plan }): Triage {
  const { flat, pages, records, plan } = input
  const sp = specialIds(flat)
  const choiceOf = new Map(folderChoices(flat, input.lockedIds).map((c) => [c.id, c]))

  // AI 猜的目录：先看自动整理的记录（进待整理时记的），再看一期方案（进待整理的条目记的方案目录，换成应用后的文件夹）
  const reused = plan ? reusedFolders(plan, flat) : {}
  const planGuess = new Map((plan?.items ?? []).filter((i) => i.target === INBOX && i.guess).map((i) => [i.bookmarkId, reused[i.guess!]]))
  const guessOf = (b: FlatBookmark): FolderChoice | undefined => {
    const r = records[b.id]
    const fromRecord = r?.status === 'inbox' && r.guessFolderId ? choiceOf.get(r.guessFolderId) : undefined
    const fromPlan = planGuess.get(b.id)
    return fromRecord ?? (fromPlan ? choiceOf.get(fromPlan) : undefined)
  }
  const withGuess = (b: FlatBookmark): TriageEntry => {
    const guess = guessOf(b)
    return guess ? { bookmark: b, guess } : { bookmark: b }
  }

  // 建议删除的原因：待清理以外还有同一网址的一条才算重复（只在待清理里互为重复的算「其他」，批量删不会把副本全删光）
  const inCleanup = under(sp.cleanup)
  const cleanupBooks = flat.bookmarks.filter(inCleanup)
  const outside = new Map<string, FlatBookmark>()
  // 待清理是空的（多数时候）就不用给整棵树算规范化网址
  if (cleanupBooks.length)
    for (const b of flat.bookmarks) {
      const k = normalizeUrl(b.url)
      if (!inCleanup(b) && !outside.has(k)) outside.set(k, b)
    }
  const rootTitle = (b: FlatBookmark) => flat.roots.find((r) => r.id === b.rootId)?.title ?? ''
  const reasonOf = (b: FlatBookmark): CleanupReason => {
    const page = pages[b.url]
    if (page?.status === 'dead') return page.httpStatus ? { kind: 'dead', httpStatus: page.httpStatus } : { kind: 'dead' }
    const other = outside.get(normalizeUrl(b.url))
    if (other) return { kind: 'duplicate', otherPath: other.path.join(' / ') || rootTitle(other) }
    if (page?.status === 'unreachable') return { kind: 'unreachable' }
    return { kind: 'other' }
  }

  // 空文件夹：整棵子树没有书签的（不含根、锁定的、管理员配置的），按最上层分组。
  // 「待整理」「待清理」本身不算：扩展还会往里放，空着是正常的（里面的空子文件夹照样列）；「整理前的空文件夹」整个空了连它一起列
  const locked = descendantFolderIds(flat, [...input.lockedIds])
  const kept = (f: FlatFolder) => locked.has(f.id) || !!f.unmodifiable || sp.inbox.has(f.id) || sp.cleanup.has(f.id)
  const emptyIds = new Set(flat.folders.filter((f) => f.totalBookmarks === 0 && !kept(f)).map((f) => f.id))
  const byParent = Map.groupBy(flat.folders, (f) => f.parentId)
  const subtree = (f: FlatFolder): FlatFolder[] => [f, ...(byParent.get(f.id) ?? []).flatMap(subtree)]
  const empty: EmptyGroup[] = flat.folders
    .filter((f) => emptyIds.has(f.id) && !emptyIds.has(f.parentId))
    .map((folder) => ({
      folder,
      ids: subtree(folder)
        .filter((f) => emptyIds.has(f.id))
        .sort((a, b) => b.depth - a.depth)
        .map((f) => f.id)
    }))

  return {
    unsure: [...flat.bookmarks.filter(under(sp.inbox)), ...flat.bookmarks.filter(under(sp.holding))].map(withGuess),
    cleanup: cleanupBooks.map((b) => ({ bookmark: b, reason: reasonOf(b) })),
    empty
  }
}

/** 建议删除里，批量「删除这 N 条」删的那些：原因还成立的（失效、重复、连不上） */
export const batchRemovable = (cleanup: TriageEntry[]): TriageEntry[] => cleanup.filter((e) => e.reason?.kind !== 'other')

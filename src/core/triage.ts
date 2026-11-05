// 管理页「待处理」（bookmark-ux）：拿不准放哪、建议删除、空文件夹。全是纯函数，不碰书签。
import { specialFolders } from './plan'
import type { FlatTree } from './types'

/** 每个「其他书签」根下的待整理、整理前的空文件夹、待清理（账号版和本机版各有一个时都算） */
function specialIds(flat: FlatTree) {
  const sp = flat.roots.filter((r) => r.rootType === 'other').map((r) => specialFolders(flat, r.id))
  const ids = (k: 'inbox' | 'holding' | 'cleanup') => new Set(sp.map((x) => x[k]).filter((x): x is string => !!x))
  return { inbox: ids('inbox'), holding: ids('holding'), cleanup: ids('cleanup') }
}

/** 要你拿主意的书签数（拿不准放哪 + 建议删除）：弹窗的「待处理 M」。空文件夹不算：不影响任何书签，不拿它催你 */
export function pendingCount(flat: FlatTree): number {
  const { inbox, holding, cleanup } = specialIds(flat)
  return flat.bookmarks.filter((b) => b.folderIds.some((id) => inbox.has(id) || holding.has(id) || cleanup.has(id))).length
}

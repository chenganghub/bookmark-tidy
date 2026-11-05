// 待处理和卡片上的手动操作（bookmark-ux）：移动、删书签、删空文件夹，和撤销。
// 只依赖 BookmarksApi；锁、「你定过位置的」、说明这些存储上的事由 workflow.ts 做。
// 位置一律记「执行那一步之前那一刻」的，撤销倒着做：同一个文件夹里移走或删了好几条，也能排回原来的顺序。
import type { BookmarksApi, ManualChange, RemovedNode } from './types'

export function emptyChange(): ManualChange {
  return { moved: [], removed: [], folders: {}, placed: [], records: {}, skipped: 0, rebuilt: {} }
}

/** 文件夹 parentId 下第一个叫 title、不在 locked 里的文件夹；没有就建一个 */
export async function ensureFolder(api: BookmarksApi, parentId: string, title: string, locked: Set<string>): Promise<string> {
  const same = (await api.getChildren(parentId)).find((c) => c.url === undefined && c.title === title && !locked.has(c.id))
  return same?.id ?? (await api.create({ parentId, title })).id
}

/** 移进 folderId。已经在里面的不动也不记；已经不在的、移的时候出错的（期间被别处删了）记 skipped */
export async function moveBookmarks(api: BookmarksApi, ids: string[], folderId: string): Promise<ManualChange> {
  const change = emptyChange()
  for (const id of ids) {
    try {
      const [node] = await api.get(id)
      if (node.parentId === folderId) continue
      await api.move(id, { parentId: folderId })
      change.moved.push({ id, from: { parentId: node.parentId!, index: node.index! }, to: folderId })
    } catch {
      change.skipped++
    }
  }
  return change
}

/** 从 folderId 往上记祖先链（不含根）；已经记过的那一层以上不用再走 */
async function recordAncestors(api: BookmarksApi, folderId: string, out: Record<string, RemovedNode>): Promise<void> {
  for (let id = folderId; !out[id]; ) {
    const [f] = await api.get(id)
    // 根（书签栏、其他书签……）的父是 '0'：根不会被删，不用记
    if (f.parentId === undefined || f.parentId === '0') return
    out[id] = { id, parentId: f.parentId, index: f.index!, title: f.title }
    id = f.parentId
  }
}

/** 删书签。每条记下删之前的位置，和所在文件夹的祖先链 */
export async function removeBookmarks(api: BookmarksApi, ids: string[]): Promise<ManualChange> {
  const change = emptyChange()
  for (const id of ids) {
    try {
      const [node] = await api.get(id)
      await recordAncestors(api, node.parentId!, change.folders)
      await api.remove(id)
      change.removed.push({ id, parentId: node.parentId!, index: node.index!, title: node.title, url: node.url })
    } catch {
      change.skipped++
    }
  }
  return change
}

/** 删空文件夹。ids 要深的在前（子文件夹先删）；删之前里面还有东西的跳过（remove 本来也删不了非空文件夹） */
export async function removeFolders(api: BookmarksApi, ids: string[]): Promise<ManualChange> {
  const change = emptyChange()
  for (const id of ids) {
    try {
      const [node] = await api.get(id)
      if ((await api.getChildren(id)).length) {
        change.skipped++
        continue
      }
      await api.remove(id)
      change.removed.push({ id, parentId: node.parentId!, index: node.index!, title: node.title })
    } catch {
      change.skipped++
    }
  }
  return change
}

const exists = async (api: BookmarksApi, id: string): Promise<boolean> => {
  try {
    await api.get(id)
    return true
  } catch {
    return false
  }
}

/**
 * 撤销。移动：倒着移回原来的位置，已经不在目标文件夹里的（之后又被挪过、删了）不动。
 * 删除：倒着重建到原来的位置；父文件夹也没了就按祖先链（或这次删掉的文件夹）先重建。
 * 能接着做：每建一个就记进 change.rebuilt（旧 id → 新 id），已经回到原处的移动不再移；
 * 书签接口出错的那一条算跳过、接着做别的；onRebuilt 出错（存储写不进去）直接抛出，再调一次从断点接着做，
 * 已经建过的那几条会再调一次 onRebuilt（要求它能重复调）。
 */
export async function revertChange(
  api: BookmarksApi,
  change: ManualChange,
  onRebuilt: (oldId: string, newId: string, isBookmark: boolean) => Promise<void>
): Promise<{ restored: number; skipped: number; movedBack: string[] }> {
  let restored = 0
  let skipped = 0
  const movedBack: string[] = []
  for (const m of [...change.moved].reverse()) {
    try {
      const [node] = await api.get(m.id)
      if (node.parentId === m.from.parentId) {
        // 上次撤销到一半已经移回来了
        movedBack.push(m.id)
        restored++
        continue
      }
      if (node.parentId !== m.to) {
        skipped++
        continue
      }
      await api.move(m.id, { parentId: m.from.parentId, index: m.from.index })
      movedBack.push(m.id)
      restored++
    } catch {
      skipped++
    }
  }

  const folderInfo = (id: string): RemovedNode | undefined => change.folders[id] ?? change.removed.find((r) => r.id === id && r.url === undefined)
  /** 父文件夹：还在就用它；撤销时建过就用新的；都没有就按记录重建（它的父文件夹不在也一样往上补） */
  const ensureParent = async (id: string): Promise<string> => {
    const cur = change.rebuilt[id] ?? id
    if (await exists(api, cur)) return cur
    const info = folderInfo(id)
    if (!info) throw new Error('原来的文件夹找不到了')
    const parent = await ensureParent(info.parentId)
    const made = await api.create({ parentId: parent, index: info.index, title: info.title })
    change.rebuilt[id] = made.id
    return made.id
  }
  for (const r of [...change.removed].reverse()) {
    const isBookmark = r.url !== undefined
    const done = change.rebuilt[r.id]
    if (done && (await exists(api, done))) {
      // 上次撤销到一半已经建过：onRebuilt 可能没做完，再调一次
      await onRebuilt(r.id, done, isBookmark)
      restored++
      continue
    }
    let made: string
    try {
      const parent = await ensureParent(r.parentId)
      made = (await api.create({ parentId: parent, index: r.index, title: r.title, ...(isBookmark ? { url: r.url } : {}) })).id
    } catch {
      skipped++
      continue
    }
    change.rebuilt[r.id] = made
    await onRebuilt(r.id, made, isBookmark)
    restored++
  }
  return { restored, skipped, movedBack }
}

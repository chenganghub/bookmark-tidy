// 拍平 chrome.bookmarks.getTree() 的结果，体检、抓网页、生成方案都用这一份。
// 永久文件夹（书签栏、其他书签……）单独进 roots；Chrome 134+ 同一类可能有多个（账号版和本机版）。
import type { BookmarkNode, FlatBookmark, FlatFolder, FlatTree, RootInfo, RootType } from './types'

// Chrome 134 之前没有 folderType，只能按永久文件夹的固定 id 认
const ROOT_TYPE_BY_ID: Partial<Record<string, RootType>> = { '1': 'bookmarks-bar', '2': 'other', '3': 'mobile' }

const isBookmark = (node: BookmarkNode): boolean => node.url !== undefined

/** 根 '0' 的直接子节点（永久文件夹）是哪一类 */
export function rootTypeOf(node: BookmarkNode): RootType | undefined {
  // 旧版的管理员书签根没有固定 id，靠 unmodifiable 认
  return node.folderType ?? ROOT_TYPE_BY_ID[node.id] ?? (node.unmodifiable === 'managed' ? 'managed' : undefined)
}

/** 输入是 getTree() 的结果：[{ id: '0', children: [永久文件夹…] }] */
export function flattenTree(tree: BookmarkNode[]): FlatTree {
  const flat: FlatTree = { roots: [], bookmarks: [], folders: [] }

  // 拍平 parent 的子孙，返回其中的书签数。parentId / index 按树上的位置取，getTree 的结果里两者一致
  const walk = (parent: BookmarkNode, root: RootInfo, path: string[], folderIds: string[]): number => {
    let total = 0
    for (const [index, node] of (parent.children ?? []).entries()) {
      if (node.url !== undefined) {
        flat.bookmarks.push({
          id: node.id,
          parentId: parent.id,
          index,
          title: node.title,
          url: node.url,
          // 每条一份拷贝，改一条不会连带同文件夹的其他条
          path: [...path],
          folderIds: [...folderIds],
          rootId: root.id,
          rootType: root.rootType,
          depth: path.length + 1,
          dateAdded: node.dateAdded ?? 0,
          dateLastUsed: node.dateLastUsed ?? 0
        })
        total++
        continue
      }
      const children = node.children ?? []
      const directBookmarks = children.filter(isBookmark).length
      const folder: FlatFolder = {
        id: node.id,
        parentId: parent.id,
        index,
        title: node.title,
        path: [...path, node.title],
        rootId: root.id,
        rootType: root.rootType,
        depth: path.length + 1,
        // 父是永久文件夹时 path 为空
        parentTitle: path.at(-1) ?? '',
        directBookmarks,
        subFolders: children.length - directBookmarks,
        totalBookmarks: 0,
        unmodifiable: node.unmodifiable === 'managed'
      }
      flat.folders.push(folder)
      folder.totalBookmarks = walk(node, root, folder.path, [...folderIds, node.id])
      total += folder.totalBookmarks
    }
    return total
  }

  for (const top of tree) {
    for (const node of top.children ?? []) {
      const rootType = rootTypeOf(node)
      // 认不出的根（正常的 getTree 结果里没有）不拍平
      if (!rootType) continue
      const children = node.children ?? []
      const looseBookmarks = children.filter(isBookmark).length
      const root: RootInfo = {
        id: node.id,
        title: node.title,
        rootType,
        // Chrome 134 之前没有这个字段，当本机的算
        syncing: node.syncing ?? false,
        bookmarks: 0,
        topFolders: children.length - looseBookmarks,
        looseBookmarks
      }
      flat.roots.push(root)
      root.bookmarks = walk(node, root, [], [])
    }
  }
  return flat
}

/** 同一类有多个根（账号版 + 本机版）时取书签多的，那是平时在用的；一样多（比如都空）取本机的 */
export function pickRoot(flat: FlatTree, type: RootType): RootInfo | undefined {
  return flat.roots
    .filter((r) => r.rootType === type)
    .sort((a, b) => b.bookmarks - a.bookmarks || Number(a.syncing) - Number(b.syncing))[0]
}

/** 这些文件夹自己加上它们的全部子孙文件夹 */
export function descendantFolderIds(flat: FlatTree, folderIds: string[]): Set<string> {
  const childrenOf = Map.groupBy(flat.folders, (f) => f.parentId)
  const result = new Set(folderIds)
  // Set 遍历时会走到遍历中新加的元素，一直加到最深一层
  for (const id of result) for (const child of childrenOf.get(id) ?? []) result.add(child.id)
  return result
}

/**
 * 书签是否在这些文件夹里（任意深度）。b.folderIds 是整条祖先链，直接传文件夹 id 就能判断子孙；
 * 根文件夹的 id 不算（folderIds 不含根）
 */
export function isUnderFolders(b: FlatBookmark, folderIds: Set<string>): boolean {
  return b.folderIds.some((id) => folderIds.has(id))
}

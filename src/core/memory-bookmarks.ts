// 内存版 chrome.bookmarks（测试和演示模式共用），行为照 Chrome 的 BookmarkModel：
// 根和永久文件夹不能动；同父移动且 index > 旧位置时实际位置 index - 1；index 越界追加；非空文件夹不能 remove。
import type { BookmarkNode, BookmarksApi, RootType } from './types'

interface Rec {
  id: string
  parentId?: string
  title: string
  url?: string
  dateAdded: number
  dateLastUsed?: number
  folderType?: RootType
  syncing?: boolean
  unmodifiable?: 'managed'
  children?: string[]
}

export type FakeBookmarks = BookmarksApi & {
  dump(): BookmarkNode[]
  writes(): number
  failAfter(n: number): void
  /** 每次写操作之前调用（测「应用过程中被外部改了」） */
  beforeWrite(fn: ((op: string, id: string) => void | Promise<void>) | undefined): void
  /** 不经过 failAfter / 计数的外部修改（模拟用户在别处改书签） */
  external: BookmarksApi
}

export const defaultTree = (): BookmarkNode[] => [
  {
    id: '0',
    title: '',
    children: [
      { id: '1', title: '书签栏', folderType: 'bookmarks-bar', syncing: false, children: [] },
      { id: '2', title: '其他书签', folderType: 'other', syncing: false, children: [] },
      { id: '3', title: '移动设备书签', folderType: 'mobile', syncing: false, children: [] }
    ]
  }
]

export function createFakeBookmarks(tree: BookmarkNode[] = defaultTree()): FakeBookmarks {
  const recs = new Map<string, Rec>()
  let nextId = 1
  let clock = 1_700_000_000_000
  let writeCount = 0
  let failAt = Infinity
  let hook: ((op: string, id: string) => void | Promise<void>) | undefined

  const load = (n: BookmarkNode, parentId?: string) => {
    const rec: Rec = { id: n.id, parentId, title: n.title, url: n.url, dateAdded: n.dateAdded ?? clock++, dateLastUsed: n.dateLastUsed }
    if (n.folderType) rec.folderType = n.folderType
    if (n.syncing !== undefined) rec.syncing = n.syncing
    if (n.unmodifiable) rec.unmodifiable = n.unmodifiable
    if (n.url === undefined) rec.children = (n.children ?? []).map((c) => c.id)
    recs.set(n.id, rec)
    nextId = Math.max(nextId, (Number(n.id) || 0) + 1)
    for (const c of n.children ?? []) load(c, n.id)
  }
  for (const root of tree) load(root)

  const must = (id: string): Rec => {
    const r = recs.get(id)
    if (!r) throw new Error("Can't find bookmark for id.")
    return r
  }
  const isFixed = (r: Rec) => r.id === '0' || r.parentId === '0'
  const toNode = (r: Rec, deep: boolean): BookmarkNode => {
    const parent = r.parentId ? recs.get(r.parentId) : undefined
    const node: BookmarkNode = { id: r.id, title: r.title, dateAdded: r.dateAdded }
    if (r.parentId !== undefined) node.parentId = r.parentId
    if (parent) node.index = parent.children!.indexOf(r.id)
    if (r.url !== undefined) node.url = r.url
    if (r.dateLastUsed) node.dateLastUsed = r.dateLastUsed
    if (r.folderType) node.folderType = r.folderType
    if (r.syncing !== undefined) node.syncing = r.syncing
    if (r.unmodifiable) node.unmodifiable = r.unmodifiable
    if (deep && r.children) node.children = r.children.map((c) => toNode(must(c), true))
    return node
  }

  const raw: BookmarksApi = {
    async getTree() {
      return [toNode(must('0'), true)]
    },
    async get(idOrList) {
      const ids = Array.isArray(idOrList) ? idOrList : [idOrList]
      return ids.map((id) => toNode(must(id), false))
    },
    async getChildren(id) {
      const r = must(id)
      return (r.children ?? []).map((c) => toNode(must(c), false))
    },
    async create(b) {
      const parent = must(b.parentId ?? '2')
      if (!parent.children) throw new Error('Parent is not a folder.')
      const rec: Rec = { id: String(nextId++), parentId: parent.id, title: b.title ?? '', dateAdded: clock++ }
      if (b.url !== undefined) rec.url = b.url
      else rec.children = []
      recs.set(rec.id, rec)
      const idx = b.index === undefined || b.index > parent.children.length ? parent.children.length : Math.max(0, b.index)
      parent.children.splice(idx, 0, rec.id)
      return toNode(rec, false)
    },
    async move(id, dest) {
      const r = must(id)
      if (isFixed(r)) throw new Error("Can't modify the root bookmark folders.")
      const oldParent = must(r.parentId!)
      const newParent = must(dest.parentId ?? r.parentId!)
      if (!newParent.children) throw new Error('Parent is not a folder.')
      for (let cur: Rec | undefined = newParent; cur; cur = cur.parentId ? recs.get(cur.parentId) : undefined) {
        if (cur.id === r.id) throw new Error("Can't move a folder into its own descendant.")
      }
      const oldIndex = oldParent.children!.indexOf(r.id)
      let index = dest.index
      if (oldParent === newParent && index !== undefined && index > oldIndex) index--
      oldParent.children!.splice(oldIndex, 1)
      if (index === undefined || index > newParent.children.length) index = newParent.children.length
      newParent.children.splice(Math.max(0, index), 0, r.id)
      r.parentId = newParent.id
      return toNode(r, false)
    },
    async update(id, changes) {
      const r = must(id)
      if (isFixed(r)) throw new Error("Can't modify the root bookmark folders.")
      if (changes.url !== undefined && r.url === undefined) throw new Error("Can't set URL of a bookmark folder.")
      if (changes.title !== undefined) r.title = changes.title
      if (changes.url !== undefined) r.url = changes.url
      return toNode(r, false)
    },
    async remove(id) {
      const r = must(id)
      if (isFixed(r)) throw new Error("Can't modify the root bookmark folders.")
      if (r.children && r.children.length) throw new Error("Can't remove non-empty folder (use recursive to force).")
      const parent = must(r.parentId!)
      parent.children!.splice(parent.children!.indexOf(r.id), 1)
      recs.delete(r.id)
    }
  }

  const write = <A extends unknown[], R>(op: string, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      if (hook) await hook(op, String(args[0] && typeof args[0] === 'object' ? (args[0] as { parentId?: string }).parentId : args[0]))
      if (writeCount >= failAt) throw new Error(`假接口：第 ${writeCount + 1} 次写操作被设定为失败`)
      const r = await fn(...args)
      writeCount++
      return r
    }

  // 外部修改：真改数据，但不计数、不受 failAfter 影响
  const removeTree = async (id: string) => {
    const r = must(id)
    for (const c of [...(r.children ?? [])]) await removeTree(c)
    await raw.remove(id)
  }
  const external: BookmarksApi & { removeTree?: (id: string) => Promise<void> } = { ...raw, remove: (id) => (must(id).children?.length ? removeTree(id) : raw.remove(id)) }

  return {
    getTree: raw.getTree,
    get: raw.get,
    getChildren: raw.getChildren,
    create: write('create', raw.create),
    move: write('move', raw.move),
    update: write('update', raw.update),
    remove: write('remove', raw.remove),
    dump: () => [toNode(must('0'), true)],
    writes: () => writeCount,
    failAfter(n) {
      failAt = writeCount + n
    },
    beforeWrite(fn) {
      hook = fn
    },
    external
  }
}

// ---------------------------------------------------------------- 造树的小工具

let autoId = 1000
export const folder = (title: string, children: BookmarkNode[] = [], id = String(autoId++)): BookmarkNode => ({ id, title, children })
export const link = (title: string, url: string, extra: Partial<BookmarkNode> = {}, id = String(autoId++)): BookmarkNode => ({ id, title, url, ...extra })

/** 用给定的书签栏 / 其他书签内容造一棵完整的树 */
export function treeOf(bar: BookmarkNode[], other: BookmarkNode[] = [], mobile: BookmarkNode[] = []): BookmarkNode[] {
  const t = defaultTree()
  t[0].children![0].children = bar
  t[0].children![1].children = other
  t[0].children![2].children = mobile
  return t
}

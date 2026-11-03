// 快照：应用前把整棵树每个节点的位置、标题、网址记下来，撤销和「从备份恢复」都按它对齐。
import type { BookmarkNode, BookmarksApi, Snapshot, SnapshotNode } from './types'

export const SNAPSHOT_FORMAT = 'bookmark-tidy-snapshot'

/** 除根 '0' 外的全部节点；index 按在父文件夹里的实际位置算 */
export function snapshotNodes(tree: BookmarkNode[]): SnapshotNode[] {
  const out: SnapshotNode[] = []
  const walk = (parent: BookmarkNode) => {
    for (const [index, node] of (parent.children ?? []).entries()) {
      const item: SnapshotNode = { id: node.id, parentId: parent.id, index, title: node.title }
      if (node.url !== undefined) item.url = node.url
      out.push(item)
      if (node.url === undefined) walk(node)
    }
  }
  for (const root of tree) walk(root)
  return out
}

export async function takeSnapshot(api: BookmarksApi, now: number = Date.now()): Promise<Snapshot> {
  return { id: `snap-${now}`, createdAt: now, nodes: snapshotNodes(await api.getTree()) }
}

/** 整棵树的指纹：只看 id、父、位置、标题、网址，不看时间字段。FNV-1a 64 位 */
export function treeFingerprint(tree: BookmarkNode[]): string {
  const lines = snapshotNodes(tree)
    .map((n) => `${n.id}|${n.parentId}|${n.index}|${n.title}|${n.url ?? ''}`)
    .sort()
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) h = ((h ^ BigInt(line.charCodeAt(i))) * prime) & mask
    h = ((h ^ 10n) * prime) & mask
  }
  return h.toString(16).padStart(16, '0')
}

export function serializeSnapshot(s: Snapshot): string {
  return JSON.stringify({ format: SNAPSHOT_FORMAT, version: 1, ...s }, null, 2)
}

/** 读备份文件。信任边界：结构不对就抛错，错误信息说清哪里不对 */
export function parseBackup(json: string): Snapshot {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    throw new Error('备份文件不是合法的 JSON')
  }
  if (!raw || typeof raw !== 'object') throw new Error('备份文件格式不对')
  const o = raw as Record<string, unknown>
  if (o.format !== undefined && o.format !== SNAPSHOT_FORMAT) throw new Error('这不是书签整理导出的备份文件')
  if (!Array.isArray(o.nodes) || !o.nodes.length) throw new Error('备份文件里没有书签数据（缺 nodes）')
  const seen = new Set<string>()
  const nodes: SnapshotNode[] = o.nodes.map((n: unknown, i: number) => {
    const x = (n || {}) as Record<string, unknown>
    if (typeof x.id !== 'string' || !x.id) throw new Error(`第 ${i + 1} 个节点缺 id`)
    if (typeof x.title !== 'string') throw new Error(`第 ${i + 1} 个节点（id ${x.id}）缺 title`)
    if (seen.has(x.id)) throw new Error(`节点 id ${x.id} 重复`)
    seen.add(x.id)
    if (x.parentId !== undefined && typeof x.parentId !== 'string') throw new Error(`节点 ${x.id} 的 parentId 不对`)
    if (x.index !== undefined && (!Number.isInteger(x.index) || (x.index as number) < 0)) throw new Error(`节点 ${x.id} 的 index 不对`)
    if (x.url !== undefined && typeof x.url !== 'string') throw new Error(`节点 ${x.id} 的 url 不对`)
    const node: SnapshotNode = { id: x.id, title: x.title }
    if (x.parentId !== undefined) node.parentId = x.parentId as string
    if (x.index !== undefined) node.index = x.index as number
    if (x.url !== undefined) node.url = x.url as string
    return node
  })
  for (const n of nodes) {
    if (n.parentId && n.parentId !== '0' && !seen.has(n.parentId)) throw new Error(`节点 ${n.id} 的父节点 ${n.parentId} 不在备份里`)
  }
  // 每个节点都要能从根接上：恢复时只从根往下走，父子成环的节点会被悄悄漏掉，宁可整份不认
  const kids = new Map<string, string[]>()
  for (const n of nodes) {
    const p = n.parentId ?? '0'
    kids.set(p, [...(kids.get(p) || []), n.id])
  }
  const reached = new Set<string>()
  const queue = ['0']
  while (queue.length) {
    for (const c of kids.get(queue.pop()!) || []) {
      if (reached.has(c)) continue
      reached.add(c)
      queue.push(c)
    }
  }
  const lost = nodes.length - reached.size
  if (lost) throw new Error(`备份文件里有 ${lost} 个节点接不到根上（父子关系成环）`)
  return { id: typeof o.id === 'string' ? o.id : `snap-import-${Date.now()}`, createdAt: typeof o.createdAt === 'number' ? o.createdAt : Date.now(), nodes }
}

// ---------------------------------------------------------------- 树的索引（apply / plan 共用）

export interface TreeIndex {
  nodes: Map<string, BookmarkNode>
  parent: Map<string, string>
}

export function indexTree(tree: BookmarkNode[]): TreeIndex {
  const nodes = new Map<string, BookmarkNode>()
  const parent = new Map<string, string>()
  const walk = (n: BookmarkNode) => {
    nodes.set(n.id, n)
    for (const c of n.children ?? []) {
      parent.set(c.id, n.id)
      walk(c)
    }
  }
  for (const root of tree) walk(root)
  return { nodes, parent }
}

/** 从 id 往上的祖先链（不含自己，含根） */
export function ancestorsOf(index: TreeIndex, id: string): string[] {
  const out: string[] = []
  let cur = index.parent.get(id)
  while (cur !== undefined) {
    out.push(cur)
    cur = index.parent.get(cur)
  }
  return out
}

/** 文件夹的整棵子树里有没有书签 */
export function hasBookmarks(node: BookmarkNode): boolean {
  return (node.children ?? []).some((c) => c.url !== undefined || hasBookmarks(c))
}

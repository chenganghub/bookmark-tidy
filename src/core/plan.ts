// 整理方案：把 AI 的目录和归类结果变成「每条书签去哪、标题改成什么」，以及预览里的编辑（全是纯函数，不碰书签）。
import { cleanTitle, normalizeUrl } from './rules'
import { treeFingerprint } from './snapshot'
import { descendantFolderIds, isUnderFolders } from './tree'
import type {
  BookmarkMeta,
  BookmarkNode,
  ClassifyOutput,
  FlatBookmark,
  FlatTree,
  PageInfo,
  Plan,
  PlanFolder,
  PlanItem,
  PlanItemReason,
  PlanOptions,
  TaxonomyNode
} from './types'

export const INBOX_NAME = '待整理'
export const CLEANUP_NAME = '待清理'
export const HOLDING_NAME = '整理前的空文件夹'
/** PlanItem.target 的两个特殊值 */
export const INBOX = 'inbox'
export const CLEANUP = 'cleanup'

export const LOW_CONFIDENCE = 0.6
export const LEAF_MIN = 3
export const LEAF_MAX = 40

const SPECIAL_NAMES = new Set([INBOX_NAME, CLEANUP_NAME, HOLDING_NAME])

/** 「其他书签」下这三个特殊文件夹（有的话） */
export function specialFolders(flat: FlatTree, otherRootId: string): { inbox?: string; cleanup?: string; holding?: string } {
  const find = (name: string) => flat.folders.find((f) => f.parentId === otherRootId && f.title === name)?.id
  return { inbox: find(INBOX_NAME), cleanup: find(CLEANUP_NAME), holding: find(HOLDING_NAME) }
}

/** 实际锁定的文件夹：设置里没选过时，按默认名字（受保护资料）认书签栏顶层文件夹 */
export function effectiveLockedIds(flat: FlatTree, s: { lockedFolderIds: string[]; defaultLockedNames: string[] }): string[] {
  if (s.lockedFolderIds.length) return s.lockedFolderIds
  const bar = flat.roots.filter((r) => r.rootType === 'bookmarks-bar').map((r) => r.id)
  return flat.folders.filter((f) => bar.includes(f.parentId) && s.defaultLockedNames.includes(f.title)).map((f) => f.id)
}

/** 参与整理的书签：书签栏和其他书签下；不含锁定的、「待清理」「整理前的空文件夹」里的；按选项不含书签栏上散放的 */
export function participants(flat: FlatTree, options: PlanOptions, barRootId: string, otherRootId: string): FlatBookmark[] {
  const locked = descendantFolderIds(flat, options.lockedFolderIds)
  const sp = specialFolders(flat, otherRootId)
  const parked = descendantFolderIds(flat, [sp.cleanup, sp.holding].filter((x): x is string => !!x))
  return flat.bookmarks.filter(
    (b) =>
      (b.rootId === barRootId || b.rootId === otherRootId) &&
      !isUnderFolders(b, locked) &&
      !isUnderFolders(b, parked) &&
      !(options.keepLooseBarItems && b.rootId === barRootId && b.depth === 1)
  )
}

const byNumericId = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true })

/** 重复的一组里留哪条：最近打开过的 → 最早加的 → id 最小的 */
function keeperOf(group: FlatBookmark[]): FlatBookmark {
  return [...group].sort((a, b) => b.dateLastUsed - a.dateLastUsed || a.dateAdded - b.dateAdded || byNumericId(a.id, b.id))[0]
}

function toFolders(taxonomy: TaxonomyNode[], emoji: boolean): PlanFolder[] {
  const node = (t: TaxonomyNode, key: string, children: PlanFolder[]): PlanFolder => {
    const f: PlanFolder = { key, name: t.name, desc: t.desc, children }
    if (emoji && t.emoji) f.emoji = t.emoji
    return f
  }
  return taxonomy.map((t) =>
    node(
      t,
      t.name,
      (t.children ?? []).map((c) => node(c, `${t.name}/${c.name}`, []))
    )
  )
}

const allKeys = (folders: PlanFolder[]): Set<string> => new Set(folders.flatMap((f) => [f.key, ...f.children.map((c) => c.key)]))

/** 规整：子目录不到 3 条上提到父目录；没有子目录的顶层不到 3 条进「待整理」 */
function normalize(folders: PlanFolder[], items: PlanItem[], issues: string[]): PlanFolder[] {
  const count = (key: string) => items.filter((i) => i.enabled && i.target === key).length
  const retarget = (from: string, to: string) => {
    for (const it of items) if (it.target === from) it.target = to
  }
  for (const top of folders) {
    top.children = top.children.filter((child) => {
      const n = count(child.key)
      if (n >= LEAF_MIN) return true
      retarget(child.key, top.key)
      if (n > 0) issues.push(`「${top.name}/${child.name}」只有 ${n} 条，并进了「${top.name}」`)
      return false
    })
  }
  return folders.filter((top) => {
    if (top.children.length) return true
    const n = count(top.key)
    if (n >= LEAF_MIN) return true
    retarget(top.key, INBOX)
    if (n > 0) issues.push(`「${top.name}」只有 ${n} 条，放进了「${INBOX_NAME}」`)
    return false
  })
}

export function buildPlan(input: {
  flat: FlatTree
  nodes: BookmarkNode[]
  taxonomy: TaxonomyNode[]
  classify: ClassifyOutput[]
  meta: Record<string, BookmarkMeta>
  pageInfos: Record<string, PageInfo>
  options: PlanOptions
  barRootId: string
  otherRootId: string
  now: number
}): { plan: Plan; issues: string[] } {
  const { flat, options, barRootId, otherRootId } = input
  const issues: string[] = []
  const scope = participants(flat, options, barRootId, otherRootId)
  let folders = toFolders(input.taxonomy, options.emoji)
  const keys = allKeys(folders)

  const dead = (b: FlatBookmark) => input.pageInfos[b.url]?.status === 'dead'
  const groups = new Map<string, FlatBookmark[]>()
  for (const b of scope) {
    if (dead(b)) continue
    const k = normalizeUrl(b.url)
    groups.set(k, [...(groups.get(k) || []), b])
  }
  const duplicateLosers = new Set<string>()
  for (const g of groups.values()) {
    if (g.length < 2) continue
    const keep = keeperOf(g)
    for (const b of g) if (b.id !== keep.id) duplicateLosers.add(b.id)
  }

  const cls = new Map(input.classify.map((c) => [c.id, c]))
  const items: PlanItem[] = scope.map((b) => {
    let target: string = INBOX
    let reason: PlanItemReason = 'ai-failed'
    let confidence = 0
    const c = cls.get(b.id)
    if (dead(b)) {
      target = CLEANUP
      reason = 'dead'
    } else if (duplicateLosers.has(b.id)) {
      target = CLEANUP
      reason = 'duplicate'
    } else if (c) {
      confidence = c.confidence
      if (!c.path || !keys.has(c.path)) reason = 'not-in-tree'
      else if (c.confidence < LOW_CONFIDENCE) reason = 'low-confidence'
      else {
        target = c.path
        reason = 'ai'
      }
    }
    const title = b.title.trim()
    const item: PlanItem = {
      bookmarkId: b.id,
      base: { parentId: b.parentId, title: b.title, url: b.url },
      target,
      confidence,
      reason,
      useRuleTitle: false,
      useAiTitle: false,
      enabled: true
    }
    const rule = cleanTitle(b.title)
    if (rule !== title) item.ruleTitle = rule
    const ai = input.meta[b.id]?.title?.trim()
    if (ai && ai !== title) item.aiTitle = ai
    // 把握不够进待整理：记下 AI 给的目录，应用后待处理里预选它
    if (reason === 'low-confidence' && c) item.guess = c.path
    item.useRuleTitle = options.ruleTitles && !!item.ruleTitle
    return item
  })

  folders = normalize(folders, items, issues)

  // 书签栏和其他书签下的旧顶层文件夹：应用后整棵子树空了就移进「整理前的空文件夹」
  const locked = descendantFolderIds(flat, options.lockedFolderIds)
  const oldFolderIds = flat.folders
    .filter((f) => (f.rootId === barRootId || f.rootId === otherRootId) && f.depth === 1 && !locked.has(f.id) && !(f.parentId === otherRootId && SPECIAL_NAMES.has(f.title)))
    .map((f) => f.id)

  const plan: Plan = {
    id: `plan-${input.now}`,
    createdAt: input.now,
    barRootId,
    otherRootId,
    options: structuredClone(options),
    folders,
    items,
    oldFolderIds,
    treeFingerprint: treeFingerprint(input.nodes)
  }
  return { plan, issues }
}

// ---------------------------------------------------------------- 检查和展示

/** 每个目标（目录 key / inbox / cleanup）分到的启用条目数 */
function targetCounts(plan: Plan): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of plan.items) if (it.enabled) out[it.target] = (out[it.target] || 0) + 1
  return out
}

export function validatePlan(plan: Plan): string[] {
  const issues: string[] = []
  const counts = targetCounts(plan)
  if (plan.folders.length > plan.options.maxTop) issues.push(`顶层目录 ${plan.folders.length} 个，超过上限 ${plan.options.maxTop}`)
  const dupNames = (list: PlanFolder[], where: string) => {
    const seen = new Set<string>()
    for (const f of list) {
      if (!f.name.trim()) issues.push(`${where}有目录没有名字`)
      else if (seen.has(f.name)) issues.push(`${where}有两个「${f.name}」`)
      seen.add(f.name)
    }
  }
  dupNames(plan.folders, '顶层')
  const leaf = (f: PlanFolder, path: string) => {
    const n = counts[f.key] || 0
    if (n < LEAF_MIN) issues.push(`「${path}」只有 ${n} 条`)
    if (n > LEAF_MAX) issues.push(`「${path}」有 ${n} 条，超过 ${LEAF_MAX} 条`)
  }
  for (const top of plan.folders) {
    dupNames(top.children, `「${top.name}」下`)
    if (!top.children.length) leaf(top, top.name)
    for (const c of top.children) {
      if (c.children.length) issues.push(`「${top.name}/${c.name}」超过两层`)
      leaf(c, `${top.name}/${c.name}`)
    }
  }
  const keys = allKeys(plan.folders)
  const orphans = plan.items.filter((i) => i.enabled && i.target !== INBOX && i.target !== CLEANUP && !keys.has(i.target)).length
  if (orphans) issues.push(`${orphans} 条的目标目录不存在`)
  return issues
}

export function folderDisplayName(f: PlanFolder, emoji: boolean): string {
  return emoji && f.emoji ? `${f.emoji} ${f.name}` : f.name
}

/** 应用后的标题：勾了 AI 标题用 AI 的；勾了规则清理用规则的；否则不变 */
export function finalTitle(item: PlanItem, currentTitle: string): string {
  if (item.useAiTitle && item.aiTitle) return item.aiTitle
  if (item.useRuleTitle && item.ruleTitle) return item.ruleTitle
  return currentTitle
}

/**
 * 应用时会复用的现有文件夹（方案目录键 → 文件夹 id）。和 applyPlan 里 ensure 同一规则：
 * 父目录下第一个同名、没锁定的文件夹；子目录只在复用的顶层下面找；「待整理」「待清理」在其他书签下找。
 */
export function reusedFolders(plan: Plan, flat: FlatTree): Record<string, string> {
  const locked = new Set(plan.options.lockedFolderIds)
  const find = (parentId: string, name: string) => flat.folders.find((f) => f.parentId === parentId && f.title === name && !locked.has(f.id))?.id
  const out: Record<string, string> = {}
  for (const top of plan.folders) {
    const topId = find(plan.barRootId, folderDisplayName(top, plan.options.emoji))
    if (!topId) continue
    out[top.key] = topId
    for (const c of top.children) {
      const id = find(topId, folderDisplayName(c, plan.options.emoji))
      if (id) out[c.key] = id
    }
  }
  const inbox = find(plan.otherRootId, INBOX_NAME)
  const cleanup = find(plan.otherRootId, CLEANUP_NAME)
  if (inbox) out[INBOX] = inbox
  if (cleanup) out[CLEANUP] = cleanup
  return out
}

/** 方案的数字。给了 reused（reusedFolders 的结果）时，「移动」不算已经在目标文件夹里的条目，和应用结果对得上 */
export function planStats(
  plan: Plan,
  reused: Record<string, string> = {}
): {
  total: number
  moving: number
  renaming: number
  inbox: number
  cleanup: number
  disabled: number
  perFolder: Record<string, number>
} {
  const enabled = plan.items.filter((i) => i.enabled)
  const perFolder = targetCounts(plan)
  return {
    total: plan.items.length,
    moving: enabled.filter((i) => reused[i.target] === undefined || reused[i.target] !== i.base.parentId).length,
    renaming: enabled.filter((i) => finalTitle(i, i.base.title) !== i.base.title).length,
    inbox: perFolder[INBOX] || 0,
    cleanup: perFolder[CLEANUP] || 0,
    disabled: plan.items.length - enabled.length,
    perFolder
  }
}

// ---------------------------------------------------------------- 预览编辑（纯函数：返回新方案，不改入参）

function locate(plan: Plan, key: string): { folder: PlanFolder; parent?: PlanFolder } | undefined {
  for (const top of plan.folders) {
    if (top.key === key) return { folder: top }
    const child = top.children.find((c) => c.key === key)
    if (child) return { folder: child, parent: top }
  }
  return undefined
}

function retarget(plan: Plan, from: string, to: string) {
  for (const it of plan.items) if (it.target === from) it.target = to
}

export function renameFolder(plan: Plan, key: string, name: string): Plan {
  const next = structuredClone(plan)
  const hit = locate(next, key)
  const n = name.trim()
  if (hit && n) hit.folder.name = n
  return next
}

/** from 的条目和子目录并进 into；into 是 from 的子目录时不做 */
export function mergeFolders(plan: Plan, fromKey: string, intoKey: string): Plan {
  const next = structuredClone(plan)
  const from = locate(next, fromKey)
  const into = locate(next, intoKey)
  if (!from || !into || fromKey === intoKey || into.parent?.key === fromKey) return next
  if (from.parent) {
    retarget(next, from.folder.key, into.folder.key)
    from.parent.children = from.parent.children.filter((c) => c.key !== fromKey)
    return next
  }
  for (const c of from.folder.children) {
    if (into.parent) {
      // 并进的是子目录：不能再往下挂，条目直接并进去
      retarget(next, c.key, into.folder.key)
      continue
    }
    const same = into.folder.children.find((x) => x.name === c.name)
    if (same) {
      retarget(next, c.key, same.key)
      continue
    }
    const keys = allKeys(next.folders)
    let key = `${into.folder.key}/${c.name}`
    for (let i = 2; keys.has(key); i++) key = `${into.folder.key}/${c.name}${i}`
    retarget(next, c.key, key)
    into.folder.children.push({ ...c, key })
  }
  retarget(next, from.folder.key, into.folder.key)
  next.folders = next.folders.filter((f) => f.key !== fromKey)
  return next
}

/** 删目录：它和子目录的条目回「待整理」 */
export function deleteFolder(plan: Plan, key: string): Plan {
  const next = structuredClone(plan)
  const hit = locate(next, key)
  if (!hit) return next
  const gone = new Set([hit.folder.key, ...hit.folder.children.map((c) => c.key)])
  for (const it of next.items) {
    if (gone.has(it.target)) {
      it.target = INBOX
      it.reason = 'manual'
    }
  }
  if (hit.parent) hit.parent.children = hit.parent.children.filter((c) => c.key !== key)
  else next.folders = next.folders.filter((f) => f.key !== key)
  return next
}

function editItem(plan: Plan, bookmarkId: string, edit: (it: PlanItem) => void): Plan {
  const next = structuredClone(plan)
  const it = next.items.find((i) => i.bookmarkId === bookmarkId)
  if (it) edit(it)
  return next
}

export function setItemTarget(plan: Plan, bookmarkId: string, target: string): Plan {
  return editItem(plan, bookmarkId, (it) => {
    it.target = target
    it.reason = 'manual'
  })
}

export function setItemEnabled(plan: Plan, bookmarkId: string, enabled: boolean): Plan {
  return editItem(plan, bookmarkId, (it) => {
    it.enabled = enabled
  })
}

export function setTitleChoice(plan: Plan, bookmarkId: string, choice: { useRuleTitle?: boolean; useAiTitle?: boolean }): Plan {
  return editItem(plan, bookmarkId, (it) => {
    if (choice.useRuleTitle !== undefined) it.useRuleTitle = choice.useRuleTitle && !!it.ruleTitle
    if (choice.useAiTitle !== undefined) it.useAiTitle = choice.useAiTitle && !!it.aiTitle
  })
}

// ---------------------------------------------------------------- 拆细太大的目录（第四段 AI 的结果落到方案上）

/** 超过 LEAF_MAX 条的末级目录：没有子目录的顶层，和所有子目录（「待整理」「待清理」不算） */
export function oversizedLeaves(plan: Plan): { key: string; path: string; bookmarkIds: string[] }[] {
  const counts = targetCounts(plan)
  const out: { key: string; path: string; bookmarkIds: string[] }[] = []
  for (const top of plan.folders) {
    const leaves = top.children.length ? top.children.map((c) => ({ f: c, path: `${top.name}/${c.name}` })) : [{ f: top, path: top.name }]
    for (const { f, path } of leaves) {
      if ((counts[f.key] || 0) <= LEAF_MAX) continue
      out.push({ key: f.key, path, bookmarkIds: plan.items.filter((i) => i.enabled && i.target === f.key).map((i) => i.bookmarkId) })
    }
  }
  return out
}

/** 拆的时候新目录不能用的名字：上一层的名字（会成同名嵌套）和兄弟目录的名字 */
export function splitTakenNames(plan: Plan, key: string): string[] {
  const hit = locate(plan, key)
  if (!hit) return []
  const top = hit.parent ?? hit.folder
  return [top.name, ...(hit.parent ? hit.parent.children.filter((c) => c.key !== key).map((c) => c.name) : [])]
}

/**
 * 把一个末级目录拆成几个更细的：
 * - 拆的是子目录：新目录替换它，排在它原来的位置（还是两层）；
 * - 拆的是没有子目录的顶层：新目录成为它的子目录。
 * 模型没分到的条目放在顶层；分完不到 3 条的新目录并回顶层；最后剩不到 2 个就不拆，原样返回。
 */
export function splitFolder(plan: Plan, key: string, parts: { name: string; desc: string; emoji?: string }[], assign: Record<string, string>): Plan {
  const next = structuredClone(plan)
  const hit = locate(next, key)
  if (!hit || hit.folder.children.length) return plan
  const top = hit.parent ?? hit.folder
  const taken = new Set(splitTakenNames(next, key))
  const keys = allKeys(next.folders)
  const made: PlanFolder[] = []
  for (const p of parts) {
    if (!p.name || taken.has(p.name) || made.some((m) => m.name === p.name)) continue
    // 新目录可以沿用被替换的那个子目录的 key（同名时）；别的撞了就加序号
    let k = `${top.key}/${p.name}`
    for (let i = 2; keys.has(k) && k !== key; i++) k = `${top.key}/${p.name}${i}`
    keys.add(k)
    const f: PlanFolder = { key: k, name: p.name, desc: p.desc, children: [] }
    if (next.options.emoji && p.emoji) f.emoji = p.emoji
    made.push(f)
  }
  const keyOf = new Map(made.map((m) => [m.name, m.key]))
  for (const it of next.items) if (it.target === key) it.target = keyOf.get(assign[it.bookmarkId]) ?? top.key
  const count = (k: string) => next.items.filter((i) => i.enabled && i.target === k).length
  const kept = made.filter((m) => {
    if (count(m.key) >= LEAF_MIN) return true
    for (const it of next.items) if (it.target === m.key) it.target = top.key
    return false
  })
  if (kept.length < 2) return plan
  if (hit.parent) hit.parent.children.splice(hit.parent.children.indexOf(hit.folder), 1, ...kept)
  else hit.folder.children = kept
  return next
}

export function setAllRuleTitles(plan: Plan, on: boolean): Plan {
  const next = structuredClone(plan)
  next.options.ruleTitles = on
  for (const it of next.items) if (it.ruleTitle) it.useRuleTitle = on
  return next
}

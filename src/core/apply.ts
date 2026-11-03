// 应用和撤销。原则：不删书签和旧文件夹（只移动）；先存快照再动手；每一步都记日志；
// 撤销按快照「对齐」，从完成、失败、中断任何状态都能撤，中断后重跑结果一样。
import { CLEANUP, CLEANUP_NAME, finalTitle, folderDisplayName, HOLDING_NAME, INBOX, INBOX_NAME } from './plan'
import { ancestorsOf, hasBookmarks, indexTree, takeSnapshot, type TreeIndex } from './snapshot'
import type { ApplyLog, ApplyReport, ApplyStore, BookmarkNode, BookmarksApi, Plan, PlanItem, Snapshot, SnapshotNode, UndoReport } from './types'

type SkipReason = ApplyReport['skipped'][number]['reason']

/** 日志 createdFolders 里特殊目录的键 */
const KEY_INBOX = '__inbox'
const KEY_CLEANUP = '__cleanup'
const KEY_HOLDING = '__holding'
const folderKeyOf = (target: string) => (target === INBOX ? KEY_INBOX : target === CLEANUP ? KEY_CLEANUP : target)

async function getNode(api: BookmarksApi, id: string): Promise<BookmarkNode | undefined> {
  try {
    return (await api.get(id))[0]
  } catch {
    return undefined
  }
}

/**
 * 一条还能不能按方案处理。「没变」= 还在、父文件夹、标题、网址都等于生成方案时，且不在锁定文件夹里。
 * 继续一次中断的应用时，已经移到目标目录、已经改成新标题的也算没变。
 */
function checkItem(index: TreeIndex, item: PlanItem, locked: Set<string>, done?: { targetId?: string; title: string }): SkipReason | undefined {
  const node = index.nodes.get(item.bookmarkId)
  if (!node) return 'missing'
  const parentId = index.parent.get(node.id)
  const atTarget = done?.targetId !== undefined && parentId === done.targetId
  if (parentId !== item.base.parentId && !atTarget) return 'moved'
  if (node.title !== item.base.title && node.title !== done?.title) return 'retitled'
  if (node.url !== item.base.url) return 'url-changed'
  if (ancestorsOf(index, node.id).some((id) => locked.has(id))) return 'locked'
  return undefined
}

export async function precheck(api: BookmarksApi, plan: Plan): Promise<{ items: PlanItem[]; skipped: ApplyReport['skipped'] }> {
  const index = indexTree(await api.getTree())
  const locked = new Set(plan.options.lockedFolderIds)
  const items: PlanItem[] = []
  const skipped: ApplyReport['skipped'] = []
  for (const it of plan.items) {
    if (!it.enabled) continue
    const reason = checkItem(index, it, locked)
    if (reason) skipped.push({ bookmarkId: it.bookmarkId, reason })
    else items.push(it)
  }
  return { items, skipped }
}

export async function applyPlan(
  api: BookmarksApi,
  plan: Plan,
  store: ApplyStore,
  opts: {
    onProgress?: (done: number, total: number) => void
    onSnapshot?: (snapshot: Snapshot) => void | Promise<void>
    resume?: ApplyLog
    now?: () => number
  } = {}
): Promise<ApplyLog> {
  const now = opts.now ?? Date.now
  const locked = new Set(plan.options.lockedFolderIds)
  const report: ApplyReport = { moved: 0, renamed: 0, createdFolders: 0, movedOldFolders: 0, skipped: [], mismatches: [] }
  let items: PlanItem[]
  let log: ApplyLog

  if (opts.resume) {
    log = structuredClone(opts.resume)
    log.status = 'running'
    log.done = 0
    delete log.error
    if (log.report) report.createdFolders = log.report.createdFolders
    const index = indexTree(await api.getTree())
    items = []
    for (const it of plan.items) {
      if (!it.enabled) continue
      const reason = checkItem(index, it, locked, { targetId: log.createdFolders[folderKeyOf(it.target)], title: finalTitle(it, it.base.title) })
      if (reason) report.skipped.push({ bookmarkId: it.bookmarkId, reason })
      else items.push(it)
    }
  } else {
    const pre = await precheck(api, plan)
    items = pre.items
    report.skipped.push(...pre.skipped)
    // 快照写完才动第一条书签
    const snapshot = await takeSnapshot(api, now())
    await store.saveSnapshot(snapshot)
    await opts.onSnapshot?.(snapshot)
    log = {
      applyId: `apply-${now()}`,
      planId: plan.id,
      snapshotId: snapshot.id,
      status: 'running',
      startedAt: now(),
      updatedAt: now(),
      total: 0,
      done: 0,
      createdFolders: {},
      undoIdMap: {}
    }
  }

  const save = async () => {
    log.updatedAt = now()
    log.report = report
    await store.saveLog(log)
  }
  const step = async () => {
    log.done++
    await save()
    opts.onProgress?.(log.done, log.total)
  }

  const needInbox = items.some((i) => i.target === INBOX)
  const needCleanup = items.some((i) => i.target === CLEANUP)
  const renames = items.filter((i) => finalTitle(i, i.base.title) !== i.base.title)
  const folderCount = plan.folders.reduce((s, f) => s + 1 + f.children.length, 0) + (needInbox ? 1 : 0) + (needCleanup ? 1 : 0)
  log.total = folderCount + items.length + renames.length + plan.oldFolderIds.length
  await save()

  /** 确保目录存在：先用日志里记的，再复用同名的（不碰锁定的），都没有才新建 */
  const ensure = async (key: string, name: string, parentId: string, index?: number): Promise<string> => {
    const mapped = log.createdFolders[key]
    const existing = mapped ? await getNode(api, mapped) : undefined
    if (existing) {
      if (existing.parentId !== parentId || (index !== undefined && existing.index !== index)) await api.move(existing.id, { parentId, index })
      return existing.id
    }
    const same = (await api.getChildren(parentId)).find((c) => c.url === undefined && c.title === name && !locked.has(c.id))
    if (same) {
      if (index !== undefined && same.index !== index) await api.move(same.id, { parentId, index })
      log.createdFolders[key] = same.id
      return same.id
    }
    const created = await api.create({ parentId, index, title: name })
    log.createdFolders[key] = created.id
    report.createdFolders++
    return created.id
  }

  try {
    // 1. 目录：顶层按方案顺序放在书签栏最前面；「待整理」「待清理」放在其他书签末尾
    const targetId: Record<string, string> = {}
    for (const [i, top] of plan.folders.entries()) {
      targetId[top.key] = await ensure(top.key, folderDisplayName(top, plan.options.emoji), plan.barRootId, i)
      await step()
      for (const [j, child] of top.children.entries()) {
        targetId[child.key] = await ensure(child.key, folderDisplayName(child, plan.options.emoji), targetId[top.key], j)
        await step()
      }
    }
    if (needInbox) {
      targetId[INBOX] = await ensure(KEY_INBOX, INBOX_NAME, plan.otherRootId)
      await step()
    }
    if (needCleanup) {
      targetId[CLEANUP] = await ensure(KEY_CLEANUP, CLEANUP_NAME, plan.otherRootId)
      await step()
    }

    // 2. 移动：每步前重读这一条，和基准不一致就跳过（预检之后又被改了）
    const placed: PlanItem[] = []
    for (const it of items) {
      const dest = targetId[it.target]
      const node = await getNode(api, it.bookmarkId)
      const title = finalTitle(it, it.base.title)
      const atTarget = node?.parentId === dest
      const unchanged = !!node && (node.parentId === it.base.parentId || atTarget) && (node.title === it.base.title || node.title === title) && node.url === it.base.url
      if (!dest || !unchanged) report.skipped.push({ bookmarkId: it.bookmarkId, reason: 'changed-during-apply' })
      else {
        if (!atTarget) {
          await api.move(it.bookmarkId, { parentId: dest })
          report.moved++
        }
        placed.push(it)
      }
      await step()
    }

    // 3. 改标题
    const placedIds = new Set(placed.map((i) => i.bookmarkId))
    for (const it of renames) {
      if (placedIds.has(it.bookmarkId)) {
        const title = finalTitle(it, it.base.title)
        const node = await getNode(api, it.bookmarkId)
        if (!node || node.url !== it.base.url || node.parentId !== targetId[it.target] || (node.title !== it.base.title && node.title !== title)) {
          report.skipped.push({ bookmarkId: it.bookmarkId, reason: 'changed-during-apply' })
          placedIds.delete(it.bookmarkId)
        } else if (node.title !== title) {
          await api.update(it.bookmarkId, { title })
          report.renamed++
        }
      }
      await step()
    }

    // 4. 旧顶层目录：此刻还在、还在根下、整棵子树没有书签的，整个移进「整理前的空文件夹」（不删，id 不变）
    const inUse = new Set(Object.values(log.createdFolders))
    const tree = indexTree(await api.getTree())
    for (const fid of plan.oldFolderIds) {
      const node = tree.nodes.get(fid)
      const parentId = tree.parent.get(fid)
      if (node && !inUse.has(fid) && (parentId === plan.barRootId || parentId === plan.otherRootId) && !hasBookmarks(node)) {
        const holding = await ensure(KEY_HOLDING, HOLDING_NAME, plan.otherRootId)
        inUse.add(holding)
        if (fid !== holding) {
          await api.move(fid, { parentId: holding })
          report.movedOldFolders++
        }
      }
      await step()
    }

    // 5. 读回整棵树逐条核对
    const after = indexTree(await api.getTree())
    for (const it of placed) {
      if (!placedIds.has(it.bookmarkId)) continue
      const expected = targetId[it.target]
      const actual = after.parent.get(it.bookmarkId)
      if (actual !== expected) report.mismatches.push({ bookmarkId: it.bookmarkId, expectedParentId: expected, actualParentId: actual })
    }
    log.status = 'done'
    await save()
  } catch (e) {
    log.status = 'failed'
    log.error = { step: log.done + 1, message: e instanceof Error ? e.message : String(e) }
    await save()
  }
  return log
}

export async function undoApply(
  api: BookmarksApi,
  log: ApplyLog,
  snapshot: Snapshot,
  store: ApplyStore,
  opts: {
    onProgress?: (done: number, total: number) => void
    now?: () => number
    /** 每重建一条（快照里有、现在没有的）就回调新 id；二期用它告诉自动整理别碰这条 */
    onRebuilt?: (newId: string) => void | Promise<void>
  } = {}
): Promise<ApplyLog> {
  const now = opts.now ?? Date.now
  const l = structuredClone(log)
  l.status = 'undoing'
  delete l.error
  l.updatedAt = now()
  await store.saveLog(l)
  try {
    const report = await alignToSnapshot(api, snapshot, {
      idMap: l.undoIdMap,
      onIdMapped: async (snapshotId, newId) => {
        l.undoIdMap[snapshotId] = newId
        l.updatedAt = now()
        await store.saveLog(l)
        await opts.onRebuilt?.(newId)
      },
      removableFolderIds: Object.values(l.createdFolders),
      onProgress: opts.onProgress
    })
    l.status = 'undone'
    l.undoReport = report
  } catch (e) {
    // 状态留在 undoing，界面提示「继续撤销」
    l.error = { step: 0, message: e instanceof Error ? e.message : String(e) }
  }
  l.updatedAt = now()
  await store.saveLog(l)
  return l
}

/**
 * 把书签树对齐到快照：快照文件夹从浅到深，每个文件夹按快照顺序把子节点放到位。
 * Chrome 同父移动时 index 大于旧位置会先减 1；按升序逐个放到位置 i 时旧位置一定 ≥ i，直接给 i 就对。
 * 快照里没有、却在快照文件夹里的节点（应用后新建的）会被挤到后面，保留并报告。
 */
export async function alignToSnapshot(
  api: BookmarksApi,
  snapshot: Snapshot,
  opts: {
    idMap?: Record<string, string>
    onIdMapped?: (snapshotId: string, newId: string) => void | Promise<void>
    removableFolderIds?: string[]
    onProgress?: (done: number, total: number) => void
  } = {}
): Promise<UndoReport> {
  const idMap = { ...(opts.idMap || {}) }
  const resolve = (sid: string) => idMap[sid] ?? sid
  const report: UndoReport = { restored: 0, rebuilt: [], keptExtras: [], keptFolders: [], removedFolders: 0 }
  const kids = new Map<string, SnapshotNode[]>()
  for (const n of snapshot.nodes) {
    const p = n.parentId ?? '0'
    kids.set(p, [...(kids.get(p) || []), n])
  }
  for (const list of kids.values()) list.sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
  const total = snapshot.nodes.length
  let done = 0
  const tick = () => opts.onProgress?.(++done, total)

  // 永久文件夹不能建也不能动：不在了就跳过它的整棵子树
  const queue: string[] = []
  for (const perm of kids.get('0') || []) {
    if (await getNode(api, perm.id)) queue.push(perm.id)
    tick()
  }
  const folders: string[] = [...queue]
  while (queue.length) {
    const fid = queue.shift()!
    const parentId = resolve(fid)
    for (const [i, c] of (kids.get(fid) || []).entries()) {
      const id = resolve(c.id)
      const node = await getNode(api, id)
      if (node?.unmodifiable) {
        tick()
        continue
      }
      if (!node) {
        const created = await api.create({ parentId, index: i, title: c.title, ...(c.url !== undefined ? { url: c.url } : {}) })
        idMap[c.id] = created.id
        await opts.onIdMapped?.(c.id, created.id)
        report.rebuilt.push({ snapshotId: c.id, newId: created.id, title: c.title })
      } else {
        let changed = false
        if (node.parentId !== parentId || node.index !== i) {
          await api.move(id, { parentId, index: i })
          changed = true
        }
        const changes: { title?: string; url?: string } = {}
        if (node.title !== c.title) changes.title = c.title
        if (c.url !== undefined && node.url !== c.url) changes.url = c.url
        if (changes.title !== undefined || changes.url !== undefined) {
          await api.update(id, changes)
          changed = true
        }
        if (changed) report.restored++
      }
      if (c.url === undefined) {
        queue.push(c.id)
        folders.push(c.id)
      }
      tick()
    }
  }

  // 方案新建的目录：现在空了就删（快照里有的绝不删）；不空就留着报告
  const snapIds = new Set(snapshot.nodes.map((n) => resolve(n.id)))
  let pending = (opts.removableFolderIds || []).filter((id) => !snapIds.has(id))
  for (let progress = true; progress; ) {
    progress = false
    for (const id of [...pending]) {
      if (!(await getNode(api, id))) {
        pending = pending.filter((x) => x !== id)
        continue
      }
      if ((await api.getChildren(id)).length === 0) {
        await api.remove(id)
        report.removedFolders++
        pending = pending.filter((x) => x !== id)
        progress = true
      }
    }
  }
  report.keptFolders = pending
  const kept = new Set(pending)
  // 应用后新建、留下来的：快照文件夹里的，和因为有新书签而保留的方案目录里的，都逐条列出
  for (const fid of [...folders.map(resolve), ...pending]) {
    for (const c of await api.getChildren(fid).catch(() => [] as BookmarkNode[])) {
      if (!snapIds.has(c.id) && !kept.has(c.id)) report.keptExtras.push(c.id)
    }
  }
  return report
}

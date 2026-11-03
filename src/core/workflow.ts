// 把各模块串成界面要的 Workflow。浏览器能力都能注入（测试全用假的）；不注入时才用 wxt/browser。
// wxt/browser 在 node 里也能 import（browser 是 undefined），所以只在用到默认依赖时才取它的属性。
import { browser } from 'wxt/browser'
import { addUsage, createChatJson, estimateCostUsd, testConnection } from './ai'
import { alignToSnapshot, applyPlan, undoApply } from './apply'
import { createFetchQueue, fetchPage, planFetch } from './fetcher'
import { buildPlan, effectiveLockedIds, oversizedLeaves, participants, splitFolder, splitTakenNames, validatePlan } from './plan'
import { leafPaths } from './prompts'
import { runClassify, runDescribe, runSplit, runTaxonomy } from './pipeline'
import { audit, cleanTitle } from './rules'
import { sanitizeText, sanitizeUrlForAi, truncate } from './sanitize'
import { parseBackup, serializeSnapshot } from './snapshot'
import { browserLocks, createMutationLock, type MutationLock } from './locks'
import { chromeKV, createStore } from './store'
import { descendantFolderIds, flattenTree, isUnderFolders, pickRoot } from './tree'
import type { BookmarkMeta, BookmarksApi, ChatJsonFn, FlatTree, KV, PlanOptions, RootInfo, Settings, TaxonomyNode, Workflow } from './types'

const SITE_ORIGINS = ['http://*/*', 'https://*/*']

export interface WorkflowDeps {
  bookmarks?: BookmarksApi
  kv?: KV
  fetchImpl?: typeof fetch
  now?: () => number
  permissions?: { contains(p: { origins: string[] }): Promise<boolean>; request(p: { origins: string[] }): Promise<boolean> }
  bookmarkEvents?: { subscribe(callback: () => void): () => void }
  /** 测试用：直接给聊天函数，不走 HTTP */
  chat?: ChatJsonFn
  /** 二期：改书签的锁（和后台的自动整理共用）；不给时浏览器里用 Web Locks */
  lock?: MutationLock
}

function browserBookmarkEvents(): { subscribe(callback: () => void): () => void } {
  return {
    subscribe(callback) {
      const b = browser.bookmarks
      const events = [b.onCreated, b.onRemoved, b.onChanged, b.onMoved, b.onChildrenReordered, b.onImportEnded]
      const handler = () => callback()
      for (const e of events) e.addListener(handler)
      return () => {
        for (const e of events) e.removeListener(handler)
      }
    }
  }
}

export function createWorkflow(deps: WorkflowDeps = {}): Workflow {
  const bookmarks = deps.bookmarks ?? (browser.bookmarks as unknown as BookmarksApi)
  const store = createStore(deps.kv ?? chromeKV(browser.storage.local as never))
  // fetch 要绑定在 globalThis 上调用，否则浏览器里会报 Illegal invocation
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const now = deps.now ?? Date.now
  const permissions = deps.permissions ?? (browser.permissions as unknown as NonNullable<WorkflowDeps['permissions']>)
  const events = deps.bookmarkEvents ?? browserBookmarkEvents()
  // 二期：应用、撤销、恢复和后台的自动整理用同一把锁，不会同时改书签（node 里没有 browser，只用进程内的锁）
  const lock =
    deps.lock ??
    createMutationLock({ locks: browserLocks(), session: browser?.storage?.session ? chromeKV(browser.storage.session as never) : undefined })

  let cachedSettings: Settings | undefined
  const settings = async () => (cachedSettings = await store.getSettings())
  const chatFor = (s: Settings): ChatJsonFn => deps.chat ?? createChatJson(s.ai, { fetchImpl })
  const requireKey = (s: Settings) => {
    if (!s.ai.apiKey && !deps.chat) throw new Error('还没填 API key，去设置里填')
  }

  const loadTree = async () => {
    const nodes = await bookmarks.getTree()
    return { nodes, flat: flattenTree(nodes) }
  }

  const roots = (flat: FlatTree): { bar: RootInfo; other: RootInfo } => {
    const bar = pickRoot(flat, 'bookmarks-bar')
    const other = pickRoot(flat, 'other')
    if (!bar || !other) throw new Error('找不到书签栏或其他书签')
    return { bar, other }
  }

  const lockedIds = effectiveLockedIds

  const emptyMeta = (): BookmarkMeta => ({ desc: '', title: '', tags: [], type: '其他', updatedAt: 0 })

  const workflow: Workflow = {
    loadTree,

    async audit() {
      const { flat } = await loadTree()
      return audit(flat, now())
    },

    onTreeChanged: (callback) => events.subscribe(callback),

    getSettings: settings,

    async saveSettings(patch) {
      cachedSettings = await store.saveSettings(patch)
      return cachedSettings
    },

    async ensureSitePermission() {
      if (await permissions.contains({ origins: SITE_ORIGINS })) return true
      return permissions.request({ origins: SITE_ORIGINS })
    },

    async testAi() {
      const s = await settings()
      if (!s.ai.apiKey && !deps.chat) return { ok: false, message: '还没填 API key' }
      return testConnection(chatFor(s))
    },

    getMeta: () => store.getMeta(),

    async saveManualMeta(bookmarkId, patch) {
      const cur = (await store.getMeta())[bookmarkId] ?? emptyMeta()
      await store.saveMeta({ [bookmarkId]: { ...cur, ...patch, manual: true, updatedAt: now() } })
    },

    getPageInfos: () => store.getPageInfos(),

    async planFetch() {
      const { flat } = await loadTree()
      const s = await settings()
      return planFetch(flat.bookmarks, {
        cache: await store.getPageInfos(),
        now: now(),
        lockedFolderIds: [...descendantFolderIds(flat, lockedIds(flat, s))],
        excludeFolderIds: [...descendantFolderIds(flat, s.excludeFolderIds)],
        excludeDomains: s.excludeDomains
      })
    },

    startFetch(plan, onProgress) {
      return createFetchQueue({
        items: plan.toFetch,
        fetchOne: (url) => fetchPage(url, { fetchImpl, now }),
        onResult: (info) => store.savePageInfo(info),
        onProgress
      })
    },

    async describe(onProgress, signal) {
      const s = await settings()
      requireKey(s)
      const { flat } = await loadTree()
      const { bar, other } = roots(flat)
      const locked = descendantFolderIds(flat, lockedIds(flat, s))
      const meta = await store.getMeta()
      const pages = await store.getPageInfos()
      const todo = flat.bookmarks.filter((b) => (b.rootId === bar.id || b.rootId === other.id) && !isUnderFolders(b, locked) && !meta[b.id])
      const inputs = todo.map((b) => ({
        id: b.id,
        title: sanitizeText(b.title),
        url: sanitizeUrlForAi(b.url),
        desc: truncate(sanitizeText(pages[b.url]?.description ?? ''), 200),
        path: sanitizeText(b.path.join('/'))
      }))
      const r = await runDescribe(inputs, chatFor(s), {
        onProgress,
        signal,
        onBatch: async (outs) => {
          // 跑的过程中用户可能手改了某条：手改的不覆盖
          const cur = await store.getMeta()
          const entries: Record<string, BookmarkMeta> = {}
          for (const o of outs) if (!cur[o.id]?.manual) entries[o.id] = { desc: o.desc, title: o.title, tags: o.tags, type: o.type, updatedAt: now() }
          await store.saveMeta(entries)
        }
      })
      return { usage: r.usage, failedIds: r.failedIds }
    },

    async buildPlan(options: PlanOptions, onProgress, signal) {
      const s = await settings()
      requireKey(s)
      const chat = chatFor(s)
      const { nodes, flat } = await loadTree()
      const { bar, other } = roots(flat)
      const meta = await store.getMeta()
      const pages = await store.getPageInfos()
      const scope = participants(flat, options, bar.id, other.id)
      if (!scope.length) throw new Error('没有要整理的书签')

      const lockedSet = new Set(options.lockedFolderIds)
      const topFolders = flat.folders.filter((f) => f.parentId === bar.id)
      const lockedNames = topFolders.filter((f) => lockedSet.has(f.id)).map((f) => f.title)
      const tax = await runTaxonomy(
        scope.map((b) => ({
          type: meta[b.id]?.type ?? '其他',
          tags: meta[b.id]?.tags ?? [],
          desc: sanitizeText(meta[b.id]?.desc || cleanTitle(b.title)),
          path: sanitizeText(b.path.join('/'))
        })),
        chat,
        {
          maxTop: options.maxTop,
          existingFolders: topFolders.filter((f) => !lockedSet.has(f.id)).map((f) => f.title),
          lockedFolders: lockedNames,
          emoji: options.emoji,
          onProgress,
          signal
        }
      )
      const paths = leafPaths(tax.folders)
      const descOf = (path: string): string => {
        const [top, child] = path.split('/')
        const t: TaxonomyNode | undefined = tax.folders.find((f) => f.name === top)
        return (child ? t?.children?.find((c) => c.name === child)?.desc : t?.desc) ?? ''
      }
      const clsInput = scope.map((b) => ({
        id: b.id,
        title: sanitizeText(meta[b.id]?.title || cleanTitle(b.title)),
        desc: sanitizeText(meta[b.id]?.desc ?? ''),
        tags: meta[b.id]?.tags ?? [],
        type: meta[b.id]?.type ?? ('其他' as const)
      }))
      const cls = await runClassify(clsInput, paths, chat, { onProgress, signal, descs: Object.fromEntries(paths.map((p) => [p, descOf(p)])) })
      const built = buildPlan({
        flat,
        nodes,
        taxonomy: tax.folders,
        classify: cls.results,
        meta,
        pageInfos: pages,
        options,
        barRootId: bar.id,
        otherRootId: other.id,
        now: now()
      })

      // 第四段：超过 40 条的末级目录再拆细。最多两轮；拆不开的留着，预览里会提示条数超了
      let plan = built.plan
      let usage = addUsage(tax.usage, cls.usage)
      const splitIssues: string[] = []
      const inputOf = new Map(clsInput.map((x) => [x.id, x]))
      for (let round = 0; round < 2 && !signal?.aborted; round++) {
        const big = oversizedLeaves(plan)
        if (!big.length) break
        let changed = false
        for (const [i, leaf] of big.entries()) {
          if (signal?.aborted) break
          onProgress({ stage: 'split', totalBatches: big.length, doneBatches: i, failedBatches: 0, usage })
          const items = leaf.bookmarkIds.map((id) => inputOf.get(id)).filter((x) => !!x)
          const r = await runSplit(leaf.path, items, chat, { taken: splitTakenNames(plan, leaf.key), lockedFolders: lockedNames, signal })
          usage = addUsage(usage, r.usage)
          splitIssues.push(...r.issues)
          const after = r.folders.length >= 2 ? splitFolder(plan, leaf.key, r.folders, r.assign) : plan
          if (after === plan) splitIssues.push(`「${leaf.path}」有 ${leaf.bookmarkIds.length} 条，没拆开`)
          else changed = true
          plan = after
        }
        if (signal?.aborted) break
        onProgress({ stage: 'split', totalBatches: big.length, doneBatches: big.length, failedBatches: 0, usage })
        if (!changed) break
      }

      await store.savePlan(plan)
      return { plan, usage, issues: [...tax.issues, ...built.issues, ...splitIssues, ...validatePlan(plan)] }
    },

    getPlan: () => store.getPlan(),
    savePlan: (plan) => store.savePlan(plan),

    apply: (plan, onProgress, onSnapshot) =>
      lock.run('apply', () => applyPlan(bookmarks, plan, store, { onProgress, onSnapshot: (snap) => onSnapshot?.(snap.id), now })),

    async continueApply(applyId, onProgress) {
      const log = await store.getLog(applyId)
      const plan = await store.getPlan()
      if (!log) throw new Error('找不到这次应用的记录')
      if (!plan || plan.id !== log.planId) throw new Error('找不到这次应用的方案')
      return lock.run('apply', () => applyPlan(bookmarks, plan, store, { resume: log, onProgress, now }))
    },

    async undo(applyId, onProgress) {
      const log = await store.getLog(applyId)
      if (!log) throw new Error('找不到这次应用的记录')
      const snapshot = await store.getSnapshot(log.snapshotId)
      if (!snapshot) throw new Error('这次应用的快照已经被清掉了，请用备份文件恢复')
      // 重建出来的书签每建一条就记进 autoOwn：后台的自动整理不碰它们
      return lock.run('undo', () => undoApply(bookmarks, log, snapshot, store, { onProgress, now, onRebuilt: (newId) => store.addOwn([newId]) }))
    },

    getLatestApply: () => store.getLatestLog(),

    async exportSnapshot(snapshotId) {
      const s = await store.getSnapshot(snapshotId)
      if (!s) throw new Error('找不到这份快照')
      return serializeSnapshot(s)
    },

    async restoreFromBackup(json, onProgress) {
      const snap = parseBackup(json)
      // 恢复的是最近一次应用前的快照时，那次新建的空目录一起清掉
      const latest = await store.getLatestLog()
      const removable = latest && latest.snapshotId === snap.id ? Object.values(latest.createdFolders) : []
      return lock.run('restore', () =>
        alignToSnapshot(bookmarks, snap, { onProgress, removableFolderIds: removable, onIdMapped: (_snapshotId, newId) => store.addOwn([newId]) })
      )
    },

    estimateCost: (usage) => estimateCostUsd(usage, cachedSettings?.ai.model ?? 'deepseek-flash', true)
  }

  void settings().catch(() => {})
  return workflow
}

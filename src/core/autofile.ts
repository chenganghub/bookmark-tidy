// 收藏即整理和一键整理的调度（二期）。浏览器能力全部注入（后台 background.ts 传真的，单测传假的）。
// 一条收藏：onCreated 时判断是不是「当场收藏」→ 进会话存储里的队列 → 8 秒后处理。
// 处理分两段：准备（读页面、抓公开正文、问 AI，都在锁外）和提交（拿锁，只读写书签）。
import { createChatJson } from './ai'
import {
  AUTO_DELAY_MS,
  BUTTON_DIRECT_MAX,
  candidateFolders,
  checkJob,
  decideMove,
  findDuplicate,
  isOrganized,
  MOVED_AGAIN_MS,
  sameUrl,
  unfiledBookmarks,
  WAIT_MAX_MS,
  type MoveDecision
} from './auto'
import { fetchPage, fetchPublicText, skipReasonOf } from './fetcher'
import type { MutationLock } from './locks'
import { effectiveLockedIds, INBOX_NAME, specialFolders } from './plan'
import { buildFileMessages, parseFile } from './prompts'
import { cleanTitle, hostOf, isHttp } from './rules'
import { sanitizeText, sanitizeUrlForAi, truncate } from './sanitize'
import { isPrivateUrl, matchesDomain, privateSites, textAllowed } from './sites'
import { createStore } from './store'
import { cutChars, isPublicExcerpt, rawExcerpt, TEXT_MAX } from './text'
import { descendantFolderIds, flattenTree, isUnderFolders, pickRoot } from './tree'
import { pendingCount } from './triage'
import type { ApplyStatus, AutoJob, AutoRecord, AutoStats, BookmarkMeta, BookmarkNode, BookmarksApi, ChatJsonFn, FileOutput, FlatTree, KV, Settings } from './types'

/** 注入页面的抽正文脚本返回的东西 */
export interface PageRead {
  url: string
  title: string
  description: string
  text: string
}

export interface AutoNotice {
  bookmarkId: string
  title: string
  message: string
  /** 以前收藏过时写旧位置 */
  context?: string
}

export interface BatchItem {
  bookmarkId: string
  title: string
  path: string
  /** 目标文件夹 id；进待整理时为 '' */
  folderId: string
  toInbox: boolean
  confidence: number
}

export interface BatchState {
  id: string
  phase: 'running' | 'preview' | 'done' | 'failed'
  total: number
  done: number
  startedAt: number
  /** 最近一次写进度的时间：「整理中」很久没更新 = 后台中途被停掉了 */
  updatedAt?: number
  /** preview 时：每条的去向，等用户勾选 */
  items?: BatchItem[]
  /** preview 时：AI 请求失败的条数和第一条原因，确认后并进结果 */
  aiFailed?: { count: number; error: string }
  /** failed、error：AI 请求失败的条数和第一条原因（有失败才有）；失败的下次还算进 N */
  result?: { filed: number; toInbox: number; skipped: number; failed?: number; error?: string }
  error?: string
}

export interface AutoStatus {
  organized: boolean
  /** 最近一次应用的状态（没应用过时没有）：弹窗按它写为什么不能整理 */
  applyStatus?: ApplyStatus
  autoFile: boolean
  hasPermission: boolean
  hasKey: boolean
  unfiled: number
  /** 待处理里要你拿主意的书签数（拿不准放哪 + 建议删除） */
  pending: number
  stats: AutoStats
  recent: (AutoRecord & { title: string })[]
  batch?: BatchState
  lastBatch?: string
  lastError?: { at: number; message: string }
}

export interface AutoFilerDeps {
  bookmarks: BookmarksApi
  /** chrome.storage.local */
  kv: KV
  /** chrome.storage.session */
  session: KV
  lock: MutationLock
  tabs: { query(q: Record<string, never>): Promise<{ id?: number; url?: string; pendingUrl?: string }[]> }
  /** 在标签页里注入抽正文脚本；拿不到返回 undefined */
  readPage?: (tabId: number) => Promise<PageRead | undefined>
  hasSitePermission: () => Promise<boolean>
  notify?: (n: AutoNotice) => void | Promise<void>
  /** 安排一次 processDue（后台用 setTimeout + alarms） */
  schedule?: (delayMs: number) => void
  fetchImpl?: typeof fetch
  /** 测试用：直接给聊天函数 */
  chat?: ChatJsonFn
  now?: () => number
  /** 测试用：心跳间隔（毫秒），默认 20 秒 */
  heartbeatMs?: number
}

/** 会话存储里的键。pending：预览里准备好的去向（后台空闲约 30 秒会被停掉，内存里的会丢） */
const Q = { queue: 'auto:queue', importing: 'auto:importing', batch: 'auto:batch', pending: 'auto:pending', lastError: 'auto:lastError' }
/** 这些操作拿着锁时收到的移动不算「你又挪走」：一期的应用、撤销、恢复，和管理页待处理、卡片上的移动（那里你挪的会记成你定过位置） */
const ONE_OFF_OPS = new Set(['apply', 'undo', 'restore', 'manual'])
/** 待确认的预览多久过期 */
const BATCH_TTL_MS = 30 * 60000
/** 「整理中」这么久没有进展，当作后台中途被停掉了（一条最长：抓网页 + 两次 30 秒的 AI 请求） */
const BATCH_STALE_MS = 2 * 60000
/** 最近一次应用是这两个状态 = 一期的应用或撤销正在跑（或做到一半停了）：收藏先排着 */
const BUSY_STATUSES = new Set<ApplyStatus>(['running', 'undoing'])
/** 排着等一期操作做完时，隔多久再看一次 */
const WAIT_STEP_MS = 3000
/** 一批在跑时多久写一次心跳（比「2 分钟没进展算停掉」短得多） */
const HEARTBEAT_MS = 20000

interface PendingItem {
  bookmarkId: string
  url: string
  parentId: string
  title: string
  prep: Prepared
  decision: MoveDecision
}

interface Prepared {
  suggestion?: FileOutput
  page?: PageRead
  isPrivate: boolean
  aiFailed?: string
}

export function createAutoFiler(deps: AutoFilerDeps) {
  const store = createStore(deps.kv)
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init))
  const chatFor = (s: Settings): ChatJsonFn => deps.chat ?? createChatJson(s.ai, { fetchImpl, timeoutMs: 30000, maxRetries: 1 })
  /** 自己刚做的移动：onMoved 收到时不当成用户挪的 */
  const expected = new Map<string, { parentId: string; until: number }>()
  /** 预览里准备好的去向（后台内存；会话存储的 auto:pending 里另存一份，后台被停掉重启后从那里拿） */
  const pendingPreview = new Map<string, PendingItem[]>()
  /** 正在跑的一键整理（同一个后台里连点只跑一批）、正在提交的预览 */
  let buttonRun: Promise<BatchState> | undefined
  const applying = new Set<string>()
  let importing = false
  let importBeganAt = 0
  let processing: Promise<void> | undefined
  // 队列的读改写串起来做：onCreated 和 processDue 同时改队列时不丢条目
  let queueChain: Promise<unknown> = Promise.resolve()
  const withQueue = <T>(fn: (queue: AutoJob[]) => Promise<{ next: AutoJob[]; result: T }>): Promise<T> => {
    const run = queueChain.then(async () => {
      const { next, result } = await fn(await readQueue())
      await deps.session.set({ [Q.queue]: next })
      return result
    })
    queueChain = run.catch(() => {})
    return run
  }

  const sget = async <T>(key: string): Promise<T | undefined> => (await deps.session.get(key))[key] as T | undefined
  const tree = async (): Promise<FlatTree> => flattenTree(await deps.bookmarks.getTree())
  const getNode = async (id: string): Promise<BookmarkNode | undefined> => {
    try {
      return (await deps.bookmarks.get(id))[0]
    } catch {
      return undefined
    }
  }
  const expectMove = (id: string, parentId: string) => expected.set(id, { parentId, until: now() + 10000 })
  const setError = (message: string) => deps.session.set({ [Q.lastError]: { at: now(), message } }).catch(() => {})

  async function readQueue(): Promise<AutoJob[]> {
    return (await sget<AutoJob[]>(Q.queue)) ?? []
  }

  /** 锁定、私有站点、候选目录：每次按当前的树重算 */
  function context(flat: FlatTree, s: Settings, plan?: Parameters<typeof candidateFolders>[3]) {
    const bar = pickRoot(flat, 'bookmarks-bar')
    const other = pickRoot(flat, 'other')
    const lockedIds = new Set(effectiveLockedIds(flat, s))
    const lockedAll = descendantFolderIds(flat, [...lockedIds])
    const lockedUrls = flat.bookmarks.filter((b) => isUnderFolders(b, lockedAll)).map((b) => b.url)
    const privList = privateSites(lockedUrls, s.privateDomains)
    const cands = bar ? candidateFolders(flat, bar.id, lockedIds, plan) : { paths: [], idOf: {}, descs: {} }
    return { bar, other, lockedIds, privList, cands }
  }

  // ---------------------------------------------------------------- 准备：读页面、正文片段、问 AI（不拿锁）

  async function prepare(input: { id: string; url: string; title: string; tabId?: number; useTab: boolean }, flat: FlatTree, s: Settings, readMeta: boolean): Promise<Prepared> {
    const plan = await store.getPlan()
    const { privList, cands } = context(flat, s, plan)
    const isPrivate = isPrivateUrl(input.url, privList)
    let page: PageRead | undefined
    if (!isPrivate && input.useTab && input.tabId !== undefined && deps.readPage) {
      page = await deps.readPage(input.tabId).catch(() => undefined)
      if (page && !sameUrl(page.url, input.url)) page = undefined
    }
    // 和一期抓取同样的跳过规则：像操作链接（退订、验证、退出登录…）、带凭证参数、带长随机串的，
    // 以及用户在体检页的抓取清单里按域名、按文件夹取消勾选的，都不去请求（不带 Cookie 的 GET 也可能触发退订之类的操作）
    const host = hostOf(input.url)
    const self = flat.bookmarks.find((x) => x.id === input.id)
    const inExcludedFolder = !!self && isUnderFolders(self, new Set(s.excludeFolderIds))
    const excluded = (!!host && matchesDomain(host, s.excludeDomains)) || inExcludedFolder
    const mayFetch = !isPrivate && !excluded && !skipReasonOf(input.url)
    // 简介只用不带 Cookie 抓到的（和一期一样）：标签页里读到的可能是登录后的版本，不发
    let desc = ''
    if (mayFetch) {
      const cached = readMeta ? (await store.getPageInfos())[input.url] : undefined
      const info = cached ?? (await fetchPage(input.url, { fetchImpl }).catch(() => undefined))
      desc = info?.description ?? ''
    }
    let excerpt: string | undefined
    if (mayFetch && page?.text && textAllowed(input.url, s.textDomains, privList)) {
      const raw = rawExcerpt(page.text)
      const pub = await fetchPublicText(input.url, { fetchImpl })
      if (pub.ok && isPublicExcerpt(raw, pub.text)) excerpt = sanitizeText(raw)
    }
    if (!cands.paths.length) return { page, isPrivate }
    const fileInput = {
      id: input.id,
      title: sanitizeText(cleanTitle(input.title)),
      url: isPrivate ? hostOf(input.url) : sanitizeUrlForAi(input.url),
      desc: isPrivate ? '' : truncate(sanitizeText(desc), 200),
      ...(excerpt ? { excerpt } : {})
    }
    try {
      const r = await chatFor(s)(buildFileMessages(fileInput, cands.paths, cands.descs))
      return { suggestion: parseFile(r.data, input.id, cands.paths), page, isPrivate }
    } catch (e) {
      return { page, isPrivate, aiFailed: e instanceof Error ? e.message : String(e) }
    }
  }

  // ---------------------------------------------------------------- 提交：在锁里只读写书签

  interface Committed {
    decision?: MoveDecision
    moved: boolean
    retitled: boolean
    desc: string
    duplicateOf?: string
  }

  /** 进待整理时要的那个目录：其他书签下的「待整理」，没有就建（一期就有的保留目录） */
  async function inboxId(flat: FlatTree): Promise<string | undefined> {
    const other = pickRoot(flat, 'other')
    if (!other) return undefined
    const found = specialFolders(flat, other.id).inbox
    if (found) return found
    return (await deps.bookmarks.create({ parentId: other.id, title: INBOX_NAME })).id
  }

  /**
   * 提交一条。job 里是准备时看到的父文件夹和标题：现在不一样了 = 用户动过，不移动、不改标题。
   * 一键整理传 forceDecision（预览里确认过的去向），目标目录已经不在了就不移动。
   */
  async function commitOne(
    job: Pick<AutoJob, 'bookmarkId' | 'url' | 'parentId' | 'title'>,
    prep: Prepared,
    s: Settings,
    opts: { source: 'save' | 'button'; batchId?: string; forceDecision?: MoveDecision }
  ): Promise<Committed | undefined> {
    const flat = await tree()
    const plan = await store.getPlan()
    const ctx = context(flat, s, plan)
    const records = await store.getRecords()
    // 一键整理是用户自己点的：可以重新处理之前进了待整理的、撤销或恢复重建出来的；
    // 撤销过、用户挪过的由 unfiledBookmarks 排除
    const button = opts.source === 'button'
    const own = button ? new Set<string>() : new Set(await store.getOwn())
    const check = checkJob({ ...job, index: 0, createdAt: 0, dueAt: 0 }, flat, { lockedIds: ctx.lockedIds, records: button ? {} : records, own })
    if (check.drop) return undefined
    // 你已经定过位置的（待处理里放好的、预览里没勾的……）：后台排着的、预览里准备好的旧去向都不再用
    if ((await store.getHandPlaced()).includes(job.bookmarkId)) return undefined
    const node = await getNode(job.bookmarkId)
    if (!node || node.parentId === undefined) return undefined
    const { userMoved, userRetitled } = check
    // 处理前你已经自己挪过：位置算你定的，以后也不再自动挪
    if (userMoved) await store.addHandPlaced([node.id])

    let decision: MoveDecision | undefined
    if (!userMoved && prep.suggestion) decision = opts.forceDecision ?? decideMove(prep.suggestion, s.autoThreshold, ctx.cands)
    if (decision?.kind === 'folder') {
      const folderId = decision.folderId
      if (!flat.folders.some((f) => f.id === folderId)) decision = undefined
    }
    let target = node.parentId
    if (decision?.kind === 'folder') target = decision.folderId
    if (decision?.kind === 'inbox') target = (await inboxId(flat)) ?? node.parentId
    const moved = target !== node.parentId
    if (moved) {
      expectMove(node.id, target)
      await deps.bookmarks.move(node.id, { parentId: target })
    }
    const clean = cleanTitle(node.title)
    const retitled = !userRetitled && s.ruleTitles && clean !== node.title
    if (retitled) await deps.bookmarks.update(node.id, { title: clean })

    const sug = prep.suggestion
    // 动了书签就马上记下来（撤销靠它），再写说明和正文：中途出错或后台被停掉，也不会「挪了却撤销不了」
    if (moved || retitled) {
      const rec: AutoRecord = {
        bookmarkId: node.id,
        at: now(),
        source: opts.source,
        ...(opts.batchId ? { batchId: opts.batchId } : {}),
        from: { parentId: node.parentId, index: node.index ?? 0, title: node.title },
        to: { parentId: target, title: retitled ? clean : node.title },
        path: decision?.path ?? '',
        confidence: sug?.confidence ?? 0,
        status: decision?.kind === 'inbox' ? 'inbox' : 'filed',
        // 进待整理时 AI 给的目录还在候选里：待处理里预选它
        ...(decision?.kind === 'inbox' && sug && ctx.cands.idOf[sug.path] ? { guessFolderId: ctx.cands.idOf[sug.path] } : {})
      }
      await store.saveRecord(rec, now())
      await store.bumpStats(decision?.kind === 'inbox' ? { toInbox: 1 } : decision?.kind === 'folder' ? { filed: 1 } : {})
    }
    if (sug) {
      const cur = (await store.getMeta())[node.id]
      if (!cur?.manual) await store.saveMeta({ [node.id]: { desc: sug.desc, title: sug.title, tags: sug.tags, type: sug.type, updatedAt: now() } })
    }
    if (prep.page?.text && !prep.isPrivate) await store.saveText(node.id, { url: job.url, text: cutChars(prep.page.text, TEXT_MAX), savedAt: now() })
    const dup = findDuplicate(flat, node.id, job.url)
    // 旧的那条直接放在根下时，写根文件夹的名字（书签栏、其他书签……）
    const dupWhere = dup ? dup.path.join('/') || (flat.roots.find((r) => r.id === dup.rootId)?.title ?? '') : undefined
    return { decision, moved, retitled, desc: sug?.desc ?? '', duplicateOf: dupWhere }
  }

  // ---------------------------------------------------------------- A：收藏即整理

  /**
   * 'ok' 照常处理；'off' 不处理（关了、没整理过、撤销了、失败了、没有网页权限）；
   * 'wait' 一期的应用或撤销正在跑：先排着，做完再看（应用完成就处理，撤销了就不处理）。
   */
  async function gate(): Promise<{ s: Settings; state: 'ok' | 'wait' | 'off' }> {
    const s = await store.getSettings()
    if (!s.autoFile) return { s, state: 'off' }
    const latest = await store.getLatestLog()
    const busy = !!latest && BUSY_STATUSES.has(latest.status)
    if (!busy && !isOrganized(latest)) return { s, state: 'off' }
    if (!(await deps.hasSitePermission())) return { s, state: 'off' }
    return { s, state: busy ? 'wait' : 'ok' }
  }

  /** 放回队列过一会儿再看；队列里已经有同一条或同一网页更新的收藏时不放回 */
  async function requeue(job: AutoJob): Promise<void> {
    await withQueue(async (queue) => ({
      next: queue.some((j) => j.bookmarkId === job.bookmarkId || sameUrl(j.url, job.url)) ? queue : [...queue, { ...job, dueAt: now() + WAIT_STEP_MS }],
      result: undefined
    }))
    deps.schedule?.(WAIT_STEP_MS + 200)
  }

  async function onCreated(id: string, node: BookmarkNode): Promise<boolean> {
    if (!node.url || !isHttp(node.url) || importing || node.parentId === undefined) return false
    const { s, state } = await gate()
    if (state === 'off') return false
    const flat = await tree()
    const b = flat.bookmarks.find((x) => x.id === id)
    if (!b) return false
    const check = checkJob({ bookmarkId: id, url: node.url, parentId: node.parentId, index: 0, title: node.title, createdAt: 0, dueAt: 0 }, flat, {
      lockedIds: context(flat, s).lockedIds,
      records: {},
      own: new Set(await store.getOwn())
    })
    if (check.drop) return false
    const tabs = await deps.tabs.query({}).catch(() => [])
    if (!tabs.some((t) => sameUrl(t.url || t.pendingUrl || '', node.url!))) return false
    const t = now()
    const job: AutoJob = { bookmarkId: id, url: node.url, parentId: node.parentId, index: node.index ?? 0, title: node.title, createdAt: t, dueAt: t + AUTO_DELAY_MS }
    // 同一网页在等待期里又收藏了一次：只留后一条
    await withQueue(async (queue) => ({ next: [...queue.filter((j) => !sameUrl(j.url, job.url)), job], result: undefined }))
    deps.schedule?.(AUTO_DELAY_MS + 500)
    return true
  }

  async function processJob(job: AutoJob): Promise<void> {
    const { s, state } = await gate()
    if (state === 'off') return
    if (state === 'wait') {
      // 一期的应用或撤销还没做完：放回队列；等太久（做到一半停了）就不等了
      if (now() - job.createdAt < WAIT_MAX_MS) await requeue(job)
      return
    }
    const flat = await tree()
    const check = checkJob(job, flat, { lockedIds: context(flat, s).lockedIds, records: await store.getRecords(), own: new Set(await store.getOwn()) })
    if (check.drop) return
    // 等待期里你在管理页放好了：不再抓网页、问 AI（提交时 commitOne 还会再查一次）
    if ((await store.getHandPlaced()).includes(job.bookmarkId)) return
    const tabs = await deps.tabs.query({}).catch(() => [])
    const tab = tabs.find((t) => sameUrl(t.url || '', job.url))
    const prep = await prepare({ id: job.bookmarkId, url: job.url, title: job.title, tabId: tab?.id, useTab: true }, flat, s, false)
    if (prep.aiFailed) await setError(prep.aiFailed)
    if (!prep.suggestion) {
      // AI 没给结果：不移动，留给一键整理；读到的正文照样存
      if (prep.page?.text && !prep.isPrivate) await store.saveText(job.bookmarkId, { url: job.url, text: cutChars(prep.page.text, TEXT_MAX), savedAt: now() })
      return
    }
    const done = await deps.lock.run('auto', () => commitOne(job, prep, s, { source: 'save' }))
    // 只在真的挪了位置时通知；用户自己挑了文件夹的、本来就在对的位置的不打扰
    if (!done?.moved || !done.decision || !s.autoNotify || !deps.notify) return
    await deps.notify({
      bookmarkId: job.bookmarkId,
      title: done.decision.kind === 'folder' ? `已放进「${done.decision.path}」` : `放进了「${INBOX_NAME}」`,
      message: done.desc || cleanTitle(job.title),
      ...(done.duplicateOf ? { context: `以前收藏过，在「${done.duplicateOf}」` } : {})
    })
  }

  /** 处理到期的；一次只跑一轮，同时来的调用等这一轮跑完 */
  async function processDue(): Promise<void> {
    if (processing) return processing
    processing = (async () => {
      try {
        for (;;) {
          const t = now()
          const { due, rest } = await withQueue(async (queue) => {
            const due = queue.filter((j) => j.dueAt <= t)
            const rest = queue.filter((j) => j.dueAt > t)
            return { next: rest, result: { due, rest } }
          })
          if (!due.length) {
            if (rest.length) deps.schedule?.(Math.max(500, Math.min(...rest.map((j) => j.dueAt)) - now() + 200))
            return
          }
          for (const job of due) {
            try {
              await processJob(job)
            } catch (e) {
              await setError(e instanceof Error ? e.message : String(e))
            }
          }
        }
      } finally {
        processing = undefined
      }
    })()
    return processing
  }

  async function onMoved(id: string, info: { parentId: string }): Promise<void> {
    const exp = expected.get(id)
    if (exp && exp.parentId === info.parentId && now() <= exp.until) {
      expected.delete(id)
      return
    }
    const op = await sget<{ op: string }>('bt:op')
    if (op && ONE_OFF_OPS.has(op.op)) return
    const rec = await store.getRecord(id)
    if (!rec || (rec.status !== 'filed' && rec.status !== 'inbox') || now() - rec.at > MOVED_AGAIN_MS || info.parentId === rec.to.parentId) return
    await store.saveRecord({ ...rec, status: 'moved-by-user' }, now())
    await store.bumpStats({ movedAgain: 1 })
  }

  async function onImportBegan(): Promise<void> {
    importing = true
    importBeganAt = now()
    await deps.session.set({ [Q.importing]: { since: importBeganAt } })
  }

  async function onImportEnded(): Promise<void> {
    importing = false
    const since = importBeganAt || (await sget<{ since: number }>(Q.importing))?.since || 0
    await withQueue(async (queue) => ({ next: queue.filter((j) => j.createdAt < since), result: undefined }))
    await deps.session.remove(Q.importing)
  }

  /** 撤销一条：还在自动放的位置才移回去；标题还是自动改的才改回去 */
  async function undoOne(rec: AutoRecord): Promise<boolean> {
    if (rec.status !== 'filed' && rec.status !== 'inbox') return false
    const node = await getNode(rec.bookmarkId)
    if (!node) return false
    let changed = false
    if (node.parentId === rec.to.parentId && rec.from.parentId !== rec.to.parentId && (await getNode(rec.from.parentId))) {
      const siblings = await deps.bookmarks.getChildren(rec.from.parentId)
      expectMove(node.id, rec.from.parentId)
      await deps.bookmarks.move(node.id, { parentId: rec.from.parentId, index: Math.min(rec.from.index, siblings.length) })
      changed = true
    }
    if (node.title === rec.to.title && rec.from.title !== rec.to.title) {
      await deps.bookmarks.update(node.id, { title: rec.from.title })
      changed = true
    }
    await store.saveRecord({ ...rec, status: 'undone' }, now())
    if (changed) await store.bumpStats({ undone: 1 })
    return changed
  }

  async function undo(bookmarkId: string): Promise<boolean> {
    return deps.lock.run('auto', async () => {
      const rec = await store.getRecord(bookmarkId)
      return rec ? undoOne(rec) : false
    })
  }

  // ---------------------------------------------------------------- B：一键整理

  async function unfiled(flat?: FlatTree): Promise<ReturnType<typeof unfiledBookmarks>> {
    const s = await store.getSettings()
    const latest = await store.getLatestLog()
    if (!isOrganized(latest)) return []
    const f = flat ?? (await tree())
    return unfiledBookmarks({
      flat: f,
      meta: await store.getMeta(),
      records: await store.getRecords(),
      lockedIds: new Set(effectiveLockedIds(f, s)),
      keepLooseBarItems: s.keepLooseBarItems,
      organizedAt: latest!.startedAt,
      own: new Set(await store.getOwn()),
      placed: new Set(await store.getHandPlaced())
    })
  }

  async function saveBatch(b: BatchState) {
    await deps.session.set({ [Q.batch]: { ...b, updatedAt: now() } })
  }

  /**
   * 正在跑的一批：每次改状态都写进会话存储，另外每 20 秒按最新状态再写一次（心跳）。
   * 等锁（一期的应用正在跑）、等 AI 时也不会被当成「后台停掉了」；后台真被停掉，心跳跟着停，2 分钟后能重新点。
   */
  function liveBatch(initial: BatchState) {
    let cur = initial
    // 写入排队，每次轮到时写当时最新的状态：心跳不会把旧状态盖在新状态上面
    let chain: Promise<unknown> = Promise.resolve()
    const write = () => {
      const run = chain.then(() => saveBatch(cur))
      chain = run.catch(() => {})
      return run
    }
    const timer = setInterval(() => void write().catch(() => {}), deps.heartbeatMs ?? HEARTBEAT_MS)
    return {
      get: () => cur,
      async set(next: BatchState): Promise<BatchState> {
        cur = next
        await write()
        return next
      },
      stop: () => clearInterval(timer)
    }
  }

  /** 逐条提交；某条出错（比如目标目录刚被删）只算跳过，不影响别的。每提交一条回调一次（写进度） */
  async function commitBatch(batchId: string, items: PendingItem[], s: Settings, onEach?: () => Promise<unknown>) {
    let filed = 0
    let toInbox = 0
    let skipped = 0
    // 一条要放的都没有（AI 都没给出能用的结果）：不占「最近一批」，上一批照样能「撤销这次」
    if (!items.length) return { filed, toInbox, skipped }
    // 先记下这是最近一批：后面哪一步出错，已经放好的也能「撤销这次」
    await store.setLastBatch(batchId)
    await deps.lock.run('button', async () => {
      for (const it of items) {
        let r: Committed | undefined
        try {
          r = await commitOne(it, it.prep, s, { source: 'button', batchId, forceDecision: it.decision })
        } catch {
          r = undefined
        }
        // 本来就在建议的目录里的也算放好了（不用动）；没有去向的（用户刚挪过、没了、进了锁定）才算跳过
        if (!r?.decision) skipped++
        else if (r.decision.kind === 'inbox') toInbox++
        else filed++
        await onEach?.().catch(() => {})
      }
    })
    await store.bumpStats({ buttonRuns: 1 }).catch(() => {})
    return { filed, toInbox, skipped }
  }

  /** 正在跑的一批（2 分钟没有进展的当作中途停掉了），或 30 分钟内还没确认的预览、刚做完的结果 */
  async function currentBatch(): Promise<BatchState | undefined> {
    const b = await sget<BatchState>(Q.batch)
    if (!b) return undefined
    const idle = now() - (b.updatedAt ?? b.startedAt)
    if (b.phase === 'running' ? idle > BATCH_STALE_MS : idle > BATCH_TTL_MS) return undefined
    return b
  }

  /** 点「整理」：≤ 10 条直接放，多了先给去向等确认。整个过程在后台跑，进度写进会话存储。连点两下只跑一批 */
  function runButton(): Promise<BatchState> {
    buttonRun ??= runButtonOnce().finally(() => (buttonRun = undefined))
    return buttonRun
  }

  async function runButtonOnce(): Promise<BatchState> {
    const cur = await currentBatch()
    if (cur?.phase === 'running') return cur
    const id = `batch-${now()}`
    const live = liveBatch({ id, phase: 'running', total: 0, done: 0, startedAt: now() })
    // 从第一步起任何一步出错都记成「失败」：弹窗里看得到原因，不会一直挂着「整理中」
    try {
      await live.set(live.get())
      const s = await store.getSettings()
      const flat = await tree()
      const list = await unfiled(flat)
      await live.set({ ...live.get(), total: list.length })
      const prepared: { bookmarkId: string; url: string; parentId: string; title: string; prep: Prepared }[] = []
      let next = 0
      const worker = async () => {
        while (next < list.length) {
          const b = list[next++]
          const prep = await prepare({ id: b.id, url: b.url, title: b.title, useTab: false }, flat, s, true)
          prepared.push({ bookmarkId: b.id, url: b.url, parentId: b.parentId, title: b.title, prep })
          await live.set({ ...live.get(), done: prepared.length })
        }
      }
      await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker))
      const ok = prepared.filter((p) => p.prep.suggestion)
      const failedItems = prepared.filter((p) => p.prep.aiFailed)
      const failMsg = failedItems[0]?.prep.aiFailed
      if (!ok.length && failMsg) throw new Error(failMsg)
      // AI 没成的：不写说明、不算定过位置，下次还在 N 里；条数和第一条原因写进结果
      const aiFailed = failMsg ? { count: failedItems.length, error: failMsg } : undefined
      const { cands } = context(flat, s, await store.getPlan())
      const decided = ok.map((p) => ({ ...p, decision: decideMove(p.prep.suggestion, s.autoThreshold, cands) }))
      if (decided.length <= BUTTON_DIRECT_MAX) {
        const result = await commitBatch(id, decided, s)
        const skipped = result.skipped + (list.length - decided.length - failedItems.length)
        return await live.set({ ...live.get(), phase: 'done', result: { ...result, skipped, ...failedPart(aiFailed) } })
      }
      pendingPreview.set(id, decided)
      await deps.session.set({ [Q.pending]: { batchId: id, items: decided } })
      return await live.set({
        ...live.get(),
        phase: 'preview',
        ...(aiFailed ? { aiFailed } : {}),
        items: decided.map((d) => ({
          bookmarkId: d.bookmarkId,
          title: d.title,
          path: d.decision.path,
          folderId: d.decision.kind === 'folder' ? d.decision.folderId : '',
          toInbox: d.decision.kind === 'inbox',
          confidence: d.prep.suggestion?.confidence ?? 0
        }))
      })
    } catch (e) {
      await dropPending(id).catch(() => {})
      const failed: BatchState = { ...live.get(), phase: 'failed', items: undefined, error: e instanceof Error ? e.message : String(e) }
      await live.set(failed).catch(() => {})
      return failed
    } finally {
      live.stop()
    }
  }

  /** 结果里的失败部分：有失败才带 */
  const failedPart = (f: BatchState['aiFailed']) => (f ? { failed: f.count, error: f.error } : {})

  /** 预览里没勾的：记进「你定过位置的」（之后不算进 N、自动整理不再挪）；AI 给的说明照样存（不覆盖手改的） */
  async function keepUnchosen(items: PendingItem[]): Promise<void> {
    if (!items.length) return
    await store.addHandPlaced(items.map((p) => p.bookmarkId))
    const cur = await store.getMeta()
    const entries: Record<string, BookmarkMeta> = {}
    for (const { bookmarkId, prep } of items) {
      const sug = prep.suggestion
      if (sug && !cur[bookmarkId]?.manual) entries[bookmarkId] = { desc: sug.desc, title: sug.title, tags: sug.tags, type: sug.type, updatedAt: now() }
    }
    await store.saveMeta(entries)
  }

  /** 预览里准备好的去向：先看内存；后台被停掉重启过，就从会话存储里拿 */
  async function pendingOf(batchId: string): Promise<PendingItem[] | undefined> {
    const mem = pendingPreview.get(batchId)
    if (mem) return mem
    const saved = await sget<{ batchId: string; items: PendingItem[] }>(Q.pending)
    return saved?.batchId === batchId ? saved.items : undefined
  }

  async function dropPending(batchId: string): Promise<void> {
    pendingPreview.delete(batchId)
    const saved = await sget<{ batchId: string }>(Q.pending)
    if (saved?.batchId === batchId) await deps.session.remove(Q.pending)
  }

  async function applyBatch(batchId: string, bookmarkIds: string[]): Promise<BatchState> {
    // 连点两下：同一批只提交一次
    if (applying.has(batchId)) return (await currentBatch()) ?? { id: batchId, phase: 'running', total: 0, done: 0, startedAt: now() }
    applying.add(batchId)
    let live: ReturnType<typeof liveBatch> | undefined
    try {
      const b = await currentBatch()
      if (b?.id === batchId && (b.phase === 'running' || b.phase === 'done')) return b
      const pending = await pendingOf(batchId)
      if (!b || b.id !== batchId || b.phase !== 'preview' || !pending) {
        const gone: BatchState = { id: batchId, phase: 'failed', total: 0, done: 0, startedAt: now(), error: '这批的去向已经过期，请重新点「整理」' }
        await saveBatch(gone)
        return gone
      }
      const s = await store.getSettings()
      const chosen = new Set(bookmarkIds)
      const items = pending.filter((p) => chosen.has(p.bookmarkId))
      // 先收起预览、显示「整理中」：弹窗里不再有「放好」「取消」可点；之后每放一条写一次进度
      const l = (live = liveBatch({ ...b, phase: 'running', items: undefined, total: items.length, done: 0 }))
      await l.set(l.get())
      // 没勾的 = 你定了这几条不动。在改书签的锁里写（等锁时上面的心跳一直在写）：和管理页待处理里的移动（也写「你定过位置的」）不会互相覆盖
      await deps.lock.run('button', () => keepUnchosen(pending.filter((p) => !chosen.has(p.bookmarkId))))
      let n = 0
      const result = await commitBatch(batchId, items, s, () => l.set({ ...l.get(), done: ++n }))
      // 清掉预览的去向只是收尾，失败了也不影响结果
      await dropPending(batchId).catch(() => {})
      const skipped = result.skipped + (pending.length - items.length)
      return await l.set({ ...b, phase: 'done', items: undefined, aiFailed: undefined, result: { ...result, skipped, ...failedPart(b.aiFailed) } })
    } catch (e) {
      // 存储写不进去之类：记成失败，弹窗里看得到原因，不会一直挂着「整理中」
      await dropPending(batchId).catch(() => {})
      // 保留这批的条数、进度和开始时间（和 runButtonOnce 的失败一样），只换阶段和原因
      const base: BatchState = live?.get() ?? { id: batchId, phase: 'running', total: 0, done: 0, startedAt: now() }
      const failed: BatchState = { ...base, phase: 'failed', items: undefined, error: e instanceof Error ? e.message : String(e) }
      await (live ? live.set(failed) : saveBatch(failed)).catch(() => {})
      return failed
    } finally {
      live?.stop()
      applying.delete(batchId)
    }
  }

  /** 预览里点「取消」：丢掉这批去向，什么都不动。在跑的、做完的、失败的不动；后台停掉后过期的能清掉 */
  async function cancelBatch(batchId: string): Promise<void> {
    if (applying.has(batchId)) return
    const live = await currentBatch()
    if (live?.id === batchId && live.phase !== 'preview') return
    await dropPending(batchId)
    const raw = await sget<BatchState>(Q.batch)
    if (raw?.id === batchId) await deps.session.remove(Q.batch)
  }

  async function undoBatch(batchId: string): Promise<number> {
    return deps.lock.run('button', async () => {
      let n = 0
      for (const rec of Object.values(await store.getRecords())) if (rec.batchId === batchId && (await undoOne(rec))) n++
      return n
    })
  }

  // ---------------------------------------------------------------- 状态、校准

  async function status(): Promise<AutoStatus> {
    const s = await store.getSettings()
    const flat = await tree()
    const records = Object.values(await store.getRecords()).sort((a, b) => b.at - a.at)
    const titleOf = new Map(flat.bookmarks.map((b) => [b.id, b.title]))
    const latest = await store.getLatestLog()
    return {
      organized: isOrganized(latest),
      ...(latest ? { applyStatus: latest.status } : {}),
      autoFile: s.autoFile,
      hasPermission: await deps.hasSitePermission(),
      hasKey: !!s.ai.apiKey || !!deps.chat,
      unfiled: (await unfiled(flat)).length,
      pending: pendingCount(flat),
      stats: await store.getStats(),
      recent: records
        .filter((r) => r.source === 'save' && titleOf.has(r.bookmarkId))
        .slice(0, 5)
        .map((r) => ({ ...r, title: titleOf.get(r.bookmarkId) ?? '' })),
      batch: await currentBatch(),
      lastBatch: await store.getLastBatch(),
      lastError: await sget<{ at: number; message: string }>(Q.lastError)
    }
  }

  /** 校准用：不动书签，只问 A 会把这条放到哪（不给当前文件夹、不读标签页、不带正文片段） */
  async function suggest(bookmarkId: string): Promise<{ path: string; confidence: number } | undefined> {
    const s = await store.getSettings()
    const flat = await tree()
    const b = flat.bookmarks.find((x) => x.id === bookmarkId)
    if (!b) return undefined
    const prep = await prepare({ id: b.id, url: b.url, title: b.title, useTab: false }, flat, s, true)
    return prep.suggestion ? { path: prep.suggestion.path, confidence: prep.suggestion.confidence } : undefined
  }

  async function init(): Promise<void> {
    const flag = await sget<{ since: number }>(Q.importing)
    if (flag) {
      importing = true
      importBeganAt = flag.since
    }
    if ((await readQueue()).length) deps.schedule?.(500)
  }

  return { onCreated, onMoved, onImportBegan, onImportEnded, processDue, undo, unfiled, runButton, applyBatch, cancelBatch, undoBatch, status, suggest, init }
}

export type AutoFiler = ReturnType<typeof createAutoFiler>

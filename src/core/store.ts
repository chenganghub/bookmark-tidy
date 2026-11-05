// 本地存储：全部放 chrome.storage.local。正文也存本地，manifest 申请 unlimitedStorage。
import { DEFAULT_PRIVATE_DOMAINS, DEFAULT_TEXT_DOMAINS } from './sites'
import type { ApplyLog, ApplyStore, AutoRecord, AutoStats, BookmarkMeta, KV, PageInfo, Plan, SavedText, Settings, Snapshot } from './types'

export const DEFAULT_SETTINGS: Settings = {
  ai: { baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-flash', disableThinking: true },
  maxTop: 8,
  emoji: false,
  ruleTitles: true,
  keepLooseBarItems: true,
  lockedFolderIds: [],
  defaultLockedNames: ['受保护资料'],
  excludeFolderIds: [],
  excludeDomains: [],
  theme: 'auto',
  view: 'cards',
  autoFile: true,
  autoNotify: true,
  // 默认把握阈值；可用 tools/e2e/calibrate.mjs 在书签副本上校准。
  // 设置只存改过的键，修改默认值对未覆盖此项的已安装实例也生效。
  autoThreshold: 0.5,
  textDomains: [...DEFAULT_TEXT_DOMAINS],
  privateDomains: [...DEFAULT_PRIVATE_DOMAINS],
  badge: true
}

/** 快照最多留几份：存新的时删最旧的 */
export const MAX_SNAPSHOTS = 5
/** 自动整理的记录：只留 30 天内、最多 500 条 */
export const RECORD_DAYS = 30
export const MAX_RECORDS = 500
/** 撤销、恢复重建出来的书签 id：先进先出最多留这么多 */
export const MAX_OWN = 2000
/** 你定过位置的书签 id（不算进角标、自动整理不再挪）：先进先出最多留这么多 */
export const MAX_HAND_PLACED = 2000
/** 正文最多存多少条 */
export const MAX_TEXTS = 1000

export const EMPTY_STATS: AutoStats = { filed: 0, toInbox: 0, undone: 0, movedAgain: 0, omnibox: 0, buttonRuns: 0 }

/** 计数的读改写按存储对象排队（后台里自动整理和地址栏各建了一个 store，共用同一个 kv） */
const statChains = new WeakMap<KV, Promise<unknown>>()
/** 「你定过位置的」的读改写也按存储对象排队：同一个页面里几处同时改时不丢（不同页面之间靠改书签的锁） */
const placedChains = new WeakMap<KV, Promise<unknown>>()

const K = {
  settings: 'settings',
  plan: 'plan',
  snapshotIds: 'snapshotIds',
  latestApply: 'apply:latest',
  page: (url: string) => `page:${url}`,
  meta: (id: string) => `meta:${id}`,
  snapshot: (id: string) => `snapshot:${id}`,
  apply: (id: string) => `apply:${id}`,
  // 二期
  record: (id: string) => `autorec:${id}`,
  text: (id: string) => `text:${id}`,
  stats: 'autoStats',
  own: 'autoOwn',
  lastBatch: 'autoLastBatch',
  // bookmark-ux
  handPlaced: 'handPlaced'
}

export interface Store extends ApplyStore {
  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  getPageInfos(): Promise<Record<string, PageInfo>>
  savePageInfo(info: PageInfo): Promise<void>
  getMeta(): Promise<Record<string, BookmarkMeta>>
  saveMeta(entries: Record<string, BookmarkMeta>): Promise<void>
  getPlan(): Promise<Plan | undefined>
  savePlan(plan: Plan): Promise<void>
  // ---- 二期：自动整理
  getRecords(): Promise<Record<string, AutoRecord>>
  getRecord(bookmarkId: string): Promise<AutoRecord | undefined>
  /** 存一条；顺带删掉 30 天前的、超过 500 条时最旧的 */
  saveRecord(rec: AutoRecord, now: number): Promise<void>
  getStats(): Promise<AutoStats>
  bumpStats(delta: Partial<AutoStats>): Promise<AutoStats>
  getOwn(): Promise<string[]>
  addOwn(ids: string[]): Promise<void>
  /** 你定过位置的：待处理的「放到」、卡片的「移动」、一键整理预览里没勾的、自动整理前你已经挪过的、一期方案里没勾的 */
  getHandPlaced(): Promise<string[]>
  addHandPlaced(ids: string[]): Promise<void>
  removeHandPlaced(ids: string[]): Promise<void>
  getLastBatch(): Promise<string | undefined>
  setLastBatch(batchId: string): Promise<void>
  saveText(bookmarkId: string, t: SavedText): Promise<void>
  getText(bookmarkId: string): Promise<SavedText | undefined>
  /** 删掉书签已不存在的正文；总数超过 MAX_TEXTS 时删最旧的 */
  pruneTexts(existingIds: Set<string>): Promise<number>
}

export function createStore(kv: KV): Store {
  const one = async <T>(key: string): Promise<T | undefined> => (await kv.get(key))[key] as T | undefined
  const byPrefix = async <T>(prefix: string): Promise<Record<string, T>> => {
    const out: Record<string, T> = {}
    for (const [k, v] of Object.entries(await kv.get(null))) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v as T
    return out
  }

  const getSettings = async (): Promise<Settings> => {
    const saved = (await one<Partial<Settings>>(K.settings)) || {}
    return { ...structuredClone(DEFAULT_SETTINGS), ...saved, ai: { ...DEFAULT_SETTINGS.ai, ...(saved.ai || {}) } }
  }
  const getLog = (id: string) => one<ApplyLog>(K.apply(id))
  const editPlaced = (ids: string[], edit: (cur: string[]) => string[]): Promise<void> => {
    if (!ids.length) return Promise.resolve()
    const run = (placedChains.get(kv) ?? Promise.resolve()).then(async () => {
      await kv.set({ [K.handPlaced]: edit((await one<string[]>(K.handPlaced)) || []) })
    })
    placedChains.set(kv, run.catch(() => {}))
    return run
  }

  return {
    getSettings,
    // 只存提交过的键（设置对话框提交的是它显示的那几项），别的每次读都取代码里的默认值：
    // autoThreshold 不在设置界面里，存整份的话用户一填 API key 就把当时的默认值定死了，以后按计数调阈值、改代码也不生效。
    async saveSettings(patch) {
      const saved = (await one<Partial<Settings>>(K.settings)) || {}
      const next: Partial<Settings> = { ...saved, ...patch, ...(saved.ai || patch.ai ? { ai: { ...saved.ai, ...patch.ai } as Settings['ai'] } : {}) }
      await kv.set({ [K.settings]: next })
      return getSettings()
    },
    getPageInfos: () => byPrefix<PageInfo>('page:'),
    async savePageInfo(info) {
      await kv.set({ [K.page(info.url)]: info })
    },
    getMeta: () => byPrefix<BookmarkMeta>('meta:'),
    async saveMeta(entries) {
      const items: Record<string, unknown> = {}
      for (const [id, m] of Object.entries(entries)) items[K.meta(id)] = m
      if (Object.keys(items).length) await kv.set(items)
    },
    getPlan: () => one<Plan>(K.plan),
    async savePlan(plan) {
      await kv.set({ [K.plan]: plan })
    },
    async saveSnapshot(s: Snapshot) {
      const ids = [...((await one<string[]>(K.snapshotIds)) || []).filter((x) => x !== s.id), s.id]
      const keep = ids.slice(-MAX_SNAPSHOTS)
      const drop = ids.slice(0, ids.length - keep.length)
      await kv.set({ [K.snapshot(s.id)]: s, [K.snapshotIds]: keep })
      if (drop.length) await kv.remove(drop.map(K.snapshot))
    },
    getSnapshot: (id) => one<Snapshot>(K.snapshot(id)),
    async saveLog(log) {
      await kv.set({ [K.apply(log.applyId)]: log, [K.latestApply]: log.applyId })
    },
    getLog,
    async getLatestLog() {
      const id = await one<string>(K.latestApply)
      return id ? getLog(id) : undefined
    },

    // ---- 二期
    getRecords: () => byPrefix<AutoRecord>('autorec:'),
    getRecord: (id) => one<AutoRecord>(K.record(id)),
    async saveRecord(rec, now) {
      await kv.set({ [K.record(rec.bookmarkId)]: rec })
      const all = Object.values(await byPrefix<AutoRecord>('autorec:')).sort((a, b) => b.at - a.at)
      const drop = all.filter((r, i) => i >= MAX_RECORDS || now - r.at > RECORD_DAYS * 86400000)
      if (drop.length) await kv.remove(drop.map((r) => K.record(r.bookmarkId)))
    },
    async getStats() {
      return { ...EMPTY_STATS, ...((await one<Partial<AutoStats>>(K.stats)) || {}) }
    },
    // 读改写串起来做：后台里自动放好、又挪走、地址栏几处同时加计数时不互相覆盖（同一个存储对象共用一条链）
    bumpStats(delta) {
      const run = (statChains.get(kv) ?? Promise.resolve()).then(async () => {
        const cur = { ...EMPTY_STATS, ...((await one<Partial<AutoStats>>(K.stats)) || {}) }
        for (const [k, v] of Object.entries(delta) as [keyof AutoStats, number][]) cur[k] += v
        await kv.set({ [K.stats]: cur })
        return cur
      })
      statChains.set(kv, run.catch(() => {}))
      return run
    },
    async getOwn() {
      return (await one<string[]>(K.own)) || []
    },
    async addOwn(ids) {
      if (!ids.length) return
      const cur = (await one<string[]>(K.own)) || []
      const next = [...cur.filter((x) => !ids.includes(x)), ...ids]
      await kv.set({ [K.own]: next.slice(-MAX_OWN) })
    },
    async getHandPlaced() {
      return (await one<string[]>(K.handPlaced)) || []
    },
    addHandPlaced(ids) {
      return editPlaced(ids, (cur) => [...cur.filter((x) => !ids.includes(x)), ...ids].slice(-MAX_HAND_PLACED))
    },
    removeHandPlaced(ids) {
      return editPlaced(ids, (cur) => cur.filter((x) => !ids.includes(x)))
    },
    getLastBatch: () => one<string>(K.lastBatch),
    async setLastBatch(batchId) {
      await kv.set({ [K.lastBatch]: batchId })
    },
    async saveText(id, t) {
      await kv.set({ [K.text(id)]: t })
    },
    getText: (id) => one<SavedText>(K.text(id)),
    async pruneTexts(existingIds) {
      const all = Object.entries(await byPrefix<SavedText>('text:')).sort((a, b) => b[1].savedAt - a[1].savedAt)
      const drop = all.filter(([id], i) => !existingIds.has(id) || i >= MAX_TEXTS).map(([id]) => K.text(id))
      if (drop.length) await kv.remove(drop)
      return drop.length
    }
  }
}

/** chrome.storage.local（或 browser.storage.local）包成 KV */
export function chromeKV(area: {
  get(keys?: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}): KV {
  return {
    get: (keys) => area.get(keys),
    set: (items) => area.set(items),
    remove: (keys) => area.remove(keys)
  }
}

/** 内存版 KV：测试和演示模式用。存取都深拷贝，和真实存储一样不共享对象 */
export function memoryKV(initial: Record<string, unknown> = {}): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>(Object.entries(structuredClone(initial)))
  return {
    data,
    async get(keys) {
      const list = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys]
      const out: Record<string, unknown> = {}
      for (const k of list) if (data.has(k)) out[k] = structuredClone(data.get(k))
      return out
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v))
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k)
    }
  }
}

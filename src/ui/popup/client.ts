// 弹窗和后台之间的接口。真实实现发消息给后台（耗时的整理在后台跑，弹窗随时可能被关掉）；
// 地址带 ?demo=1 时用假数据（界面验收用，不碰真实书签）。
import type { AutoStatus, BatchState } from '../../core/autofile'
import type { SearchEntry } from '../../core/search'

export interface PopupClient {
  status(): Promise<AutoStatus>
  run(): Promise<void>
  applyBatch(batchId: string, ids: string[]): Promise<void>
  cancelBatch(batchId: string): Promise<void>
  undo(bookmarkId: string): Promise<boolean>
  undoBatch(batchId: string): Promise<number>
  search(q: string): Promise<SearchEntry[]>
  /** 后台写了进度、记录、计数时回调 */
  onChange(cb: () => void): void
  open(url: string): void
  openManager(view?: 'organize' | 'settings' | 'triage', query?: string): void
  requestPermission(): Promise<boolean>
}

export const params = new URLSearchParams(location.search)
export const isDemo = params.has('demo')

export async function getClient(): Promise<PopupClient> {
  return isDemo ? demoClient(params.get('state') ?? 'idle') : realClient()
}

async function realClient(): Promise<PopupClient> {
  const { browser } = await import('wxt/browser')
  const { buildIndex, searchBookmarks } = await import('../../core/search')
  const { chromeKV, createStore } = await import('../../core/store')
  const { flattenTree } = await import('../../core/tree')
  const send = async <T>(type: string, payload: Record<string, unknown> = {}): Promise<T> => {
    const r = (await browser.runtime.sendMessage({ type, ...payload })) as { ok: boolean; value?: T; error?: string } | undefined
    if (!r?.ok) throw new Error(r?.error ?? '后台没有响应')
    return r.value as T
  }
  let index: SearchEntry[] | undefined
  const store = createStore(chromeKV(browser.storage.local as never))
  const close = () => window.close()
  return {
    status: () => send<AutoStatus>('auto:status'),
    run: () => send('auto:run'),
    applyBatch: (batchId, ids) => send('auto:apply-batch', { batchId, ids }),
    cancelBatch: (batchId) => send('auto:cancel-batch', { batchId }),
    undo: (bookmarkId) => send<boolean>('auto:undo', { bookmarkId }),
    undoBatch: (batchId) => send<number>('auto:undo-batch', { batchId }),
    async search(q) {
      index ??= buildIndex(flattenTree((await browser.bookmarks.getTree()) as never), await store.getMeta())
      return searchBookmarks(index, q, 8)
    },
    onChange(cb) {
      browser.storage.onChanged.addListener((changes, area) => {
        const keys = Object.keys(changes)
        if ((area === 'session' && keys.includes('auto:batch')) || (area === 'local' && keys.some((k) => k.startsWith('autorec:') || k === 'autoStats'))) cb()
      })
    },
    open(url) {
      void browser.tabs.create({ url }).then(close)
    },
    openManager(view, query) {
      const qs = new URLSearchParams()
      if (view === 'organize' || view === 'triage') qs.set('view', view)
      if (view === 'settings') qs.set('settings', '1')
      if (query) qs.set('q', query)
      const s = qs.toString()
      void browser.tabs.create({ url: browser.runtime.getURL(`/manager.html${s ? `?${s}` : ''}`) }).then(close)
    },
    requestPermission: () => browser.permissions.request({ origins: ['http://*/*', 'https://*/*'] })
  }
}

// ---------------------------------------------------------------- 演示

const D = Date.parse('2026-10-31T12:00:00+08:00')

function demoClient(stateName: string): PopupClient {
  const raw: { bookmarkId: string; title: string; path: string; at: number; status: AutoStatus['recent'][number]['status'] }[] = [
    { bookmarkId: 'r1', title: 'Vue3 响应式原理：ref 和 reactive 的区别', path: '前端框架/Vue 资源', at: D - 3600000, status: 'filed' },
    { bookmarkId: 'r2', title: 'Defuddle：把网页正文抽成 Markdown', path: '开发工具', at: D - 86400000, status: 'filed' },
    { bookmarkId: 'r3', title: '某个说不清是什么的页面', path: '待整理', at: D - 2 * 86400000, status: 'inbox' },
    { bookmarkId: 'r4', title: 'uniapp 权限检查与拉起系统授权', path: '小程序/uniapp', at: D - 3 * 86400000, status: 'undone' }
  ]
  const recent: AutoStatus['recent'] = raw.map((r) => ({ ...r, source: 'save' as const, confidence: 0.9, from: { parentId: '2', index: 0, title: r.title }, to: { parentId: 'x', title: r.title } }))
  const previewItems = Array.from({ length: 12 }, (_, i) => ({
    bookmarkId: `p${i}`,
    title: ['Pinia 状态管理入门', 'CSS Grid 布局完全指南', 'MCP 协议规范', 'Vite 配置项', '小程序分包加载', 'TypeScript 泛型实战'][i % 6] + (i >= 6 ? `（${i}）` : ''),
    path: i % 5 === 4 ? '待整理' : ['前端框架/Vue 资源', '前端基础/CSS 布局', 'AI/AI 编程', '开发工具', '小程序/小程序开发'][i % 5],
    folderId: i % 5 === 4 ? '' : `f${i % 5}`,
    toInbox: i % 5 === 4,
    confidence: i % 5 === 4 ? 0.4 : 0.9
  }))
  const batches: Record<string, BatchState> = {
    running: { id: 'b1', phase: 'running', total: 12, done: 5, startedAt: D },
    preview: { id: 'b1', phase: 'preview', total: 12, done: 12, startedAt: D, items: previewItems },
    result: { id: 'b1', phase: 'done', total: 9, done: 9, startedAt: D, result: { filed: 7, toInbox: 2, skipped: 0 } },
    partial: { id: 'b1', phase: 'done', total: 3, done: 3, startedAt: D, result: { filed: 2, toInbox: 0, skipped: 0, failed: 1, error: '接口拒绝访问（HTTP 401），检查 API key' } }
  }
  const batch: BatchState | undefined = batches[stateName]
  /** 每个状态还没放好的新收藏数 */
  const unfiled: Record<string, number> = { result: 0, empty: 0, partial: 1 }
  const status: AutoStatus = {
    organized: stateName !== 'gate',
    autoFile: true,
    hasPermission: true,
    hasKey: true,
    unfiled: unfiled[stateName] ?? 3,
    pending: stateName === 'empty' ? 0 : 4,
    stats: { filed: 12, toInbox: 3, undone: 1, movedAgain: 0, omnibox: 5, buttonRuns: 2 },
    recent: stateName === 'empty' ? [] : recent,
    batch,
    lastBatch: stateName === 'result' || stateName === 'partial' ? 'b1' : undefined
  }
  const entries: SearchEntry[] = recent.map((r, i) => ({
    id: r.bookmarkId,
    url: `https://example.com/${i}`,
    title: r.title,
    aiTitle: '',
    desc: ['讲 Proxy 和依赖收集，写组件时查', '抽网页正文的开源库，做剪藏时用', '', '做 App 权限提示时用'][i],
    tags: [],
    folder: r.path,
    dateAdded: r.at,
    dateLastUsed: 0
  }))
  return {
    status: async () => structuredClone(status),
    run: async () => {},
    applyBatch: async () => {},
    cancelBatch: async () => {},
    undo: async () => true,
    undoBatch: async () => 0,
    search: async (q) => {
      const { searchBookmarks } = await import('../../core/search')
      return searchBookmarks(entries, q, 8)
    },
    onChange: () => {},
    open: () => {},
    openManager: () => {},
    requestPermission: async () => true
  }
}

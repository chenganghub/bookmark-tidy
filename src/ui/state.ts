// 全局状态和派生数据。组件只读 state、调这里的函数；改书签都经过 Workflow。
import { computed, nextTick, reactive } from 'vue'
import { effectiveLockedIds, specialFolders } from '../core/plan'
import { pickRoot } from '../core/tree'
import type { ApplyLog, AuditIssues, AuditSummary, BookmarkMeta, FlatBookmark, FlatFolder, FlatTree, PageInfo, Settings, UndoReport, Workflow } from '../core/types'
import { applySkipText, errorText } from './format'
import { getWorkflow, params } from './useWorkflow'

export type View = 'browse' | 'audit' | 'organize'
export type Layout = 'cards' | 'list'
export type SortKey = 'added' | 'used' | 'title'
export type FilterKey = 'cold' | 'duplicate' | 'login' | 'dead' | 'inbox'
export type Badge = 'dead' | 'unreachable' | 'login' | 'duplicate' | 'cold' | 'recent'

export interface Notice {
  kind: 'applied' | 'undone' | 'restored' | 'error'
  text: string
  applyId?: string
  details?: string[]
}

export const state = reactive({
  ready: false,
  error: '',
  flat: null as FlatTree | null,
  summary: null as AuditSummary | null,
  issues: null as AuditIssues | null,
  meta: {} as Record<string, BookmarkMeta>,
  pages: {} as Record<string, PageInfo>,
  settings: null as Settings | null,
  latest: undefined as ApplyLog | undefined,
  view: 'browse' as View,
  layout: 'cards' as Layout,
  query: '',
  folderId: '',
  filters: [] as FilterKey[],
  sort: 'added' as SortKey,
  settingsOpen: false,
  editingId: '',
  notice: null as Notice | null,
  /** 应用 / 撤销进行中：书签事件很多，先不跟着刷新 */
  busy: false
})

let wf: Workflow | undefined

export function workflow(): Workflow {
  if (!wf) throw new Error('还没加载完')
  return wf
}

export function applyTheme(theme: string) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

export async function init() {
  try {
    wf = await getWorkflow()
    ;(window as unknown as { __bt: unknown }).__bt = { workflow: wf, state }
    const s = await wf.getSettings()
    state.layout = s.view
    applyTheme(params.get('theme') ?? s.theme)
    const v = params.get('view')
    if (v === 'audit' || v === 'organize') state.view = v
    // 地址栏「s 关键词」回车、弹窗里搜不到时带着搜索词打开管理页
    state.query = params.get('q') ?? ''
    await reload()
    let timer: number | undefined
    wf.onTreeChanged(() => {
      clearTimeout(timer)
      timer = window.setTimeout(() => {
        if (!state.busy) void reload()
      }, 300)
    })
  } catch (e) {
    state.error = errorText(e)
  } finally {
    state.ready = true
  }
  // 弹窗里「去设置」带 ?settings=1：设置对话框在 ready 之后才挂上，等它挂好再打开，不然它收不到这次变化
  if (params.has('settings') && !state.error) {
    await nextTick()
    state.settingsOpen = true
  }
}

export async function reload() {
  const w = workflow()
  const [{ flat }, a, meta, pages, settings, latest] = await Promise.all([w.loadTree(), w.audit(), w.getMeta(), w.getPageInfos(), w.getSettings(), w.getLatestApply()])
  state.flat = flat
  state.summary = a.summary
  state.issues = a.issues
  state.meta = meta
  state.pages = pages
  state.settings = settings
  state.latest = latest
  if (state.folderId && !flat.folders.some((f) => f.id === state.folderId)) state.folderId = ''
}

export async function saveSettings(patch: Partial<Settings>) {
  state.settings = await workflow().saveSettings(patch)
  if (patch.theme && !params.get('theme')) applyTheme(patch.theme)
}

export function toggleView(v: View) {
  state.view = state.view === v ? 'browse' : v
}

// ---------------------------------------------------------------- 派生数据

export const roots = computed(() => {
  const f = state.flat
  return { bar: f ? pickRoot(f, 'bookmarks-bar') : undefined, other: f ? pickRoot(f, 'other') : undefined }
})

export const lockedIds = computed(() => new Set(state.flat && state.settings ? effectiveLockedIds(state.flat, state.settings) : []))

const inboxId = computed(() => (state.flat && roots.value.other ? specialFolders(state.flat, roots.value.other.id).inbox : undefined))
const dupSet = computed(() => new Set((state.issues?.duplicateGroups ?? []).flatMap((g) => g.slice(1))))
const coldSet = computed(() => new Set(state.issues?.cold ?? []))
const DAY = 86400000

export function badgesOf(b: FlatBookmark): Badge[] {
  const out: Badge[] = []
  const st = state.pages[b.url]?.status
  if (st === 'dead') out.push('dead')
  else if (st === 'unreachable') out.push('unreachable')
  // 「被拦」（403 / 429）只说明抓不到，不知道要不要登录：不打徽标，体检的抓取结果里单独计数
  else if (st === 'login') out.push('login')
  if (dupSet.value.has(b.id)) out.push('duplicate')
  if (coldSet.value.has(b.id)) out.push('cold')
  else if (b.dateLastUsed && Date.now() - b.dateLastUsed < 30 * DAY) out.push('recent')
  return out
}

export const badgeText: Record<Badge, string> = { dead: '失效', unreachable: '连不上', login: '要登录', duplicate: '重复', cold: '冷门', recent: '近期打开' }
export const filterText: Record<FilterKey, string> = { cold: '冷门', duplicate: '重复', login: '要登录', dead: '失效', inbox: '待整理' }
export const FILTERS: FilterKey[] = ['cold', 'duplicate', 'login', 'dead', 'inbox']

function matches(b: FlatBookmark, f: FilterKey): boolean {
  const st = state.pages[b.url]?.status
  if (f === 'cold') return coldSet.value.has(b.id)
  if (f === 'duplicate') return dupSet.value.has(b.id)
  if (f === 'login') return st === 'login'
  if (f === 'dead') return st === 'dead' || st === 'unreachable'
  return !!inboxId.value && b.folderIds.includes(inboxId.value)
}

/** 当前左栏选中范围里的书签 */
const scoped = computed(() => {
  const f = state.flat
  if (!f) return []
  return state.folderId ? f.bookmarks.filter((b) => b.folderIds.includes(state.folderId)) : f.bookmarks
})

export const filterCounts = computed(() => {
  const out = {} as Record<FilterKey, number>
  for (const k of FILTERS) out[k] = scoped.value.filter((b) => matches(b, k)).length
  return out
})

const haystack = computed(() => {
  const m = new Map<string, string>()
  for (const b of state.flat?.bookmarks ?? []) {
    const meta = state.meta[b.id]
    m.set(b.id, [b.title, meta?.title, meta?.desc, meta?.tags.join(' '), b.url].join(' ').toLowerCase())
  }
  return m
})

export const visible = computed(() => {
  const t0 = performance.now()
  const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean)
  const list = scoped.value.filter((b) => state.filters.every((f) => matches(b, f)) && terms.every((t) => haystack.value.get(b.id)?.includes(t)))
  const by: Record<SortKey, (a: FlatBookmark, b: FlatBookmark) => number> = {
    added: (a, b) => b.dateAdded - a.dateAdded,
    used: (a, b) => b.dateLastUsed - a.dateLastUsed || b.dateAdded - a.dateAdded,
    title: (a, b) => a.title.localeCompare(b.title, 'zh-CN')
  }
  list.sort(by[state.sort])
  ;(window as unknown as { __btSearchMs: number }).__btSearchMs = performance.now() - t0
  return list
})

export interface SideFolder {
  folder: FlatFolder
  children: SideFolder[]
}

/** 左栏：书签栏和其他书签下的文件夹树 */
export const sideTree = computed(() => {
  const f = state.flat
  const groups: { title: string; items: SideFolder[] }[] = []
  if (!f) return groups
  const byParent = Map.groupBy(f.folders, (x) => x.parentId)
  const build = (parentId: string): SideFolder[] => (byParent.get(parentId) ?? []).map((folder) => ({ folder, children: build(folder.id) }))
  for (const r of [roots.value.bar, roots.value.other]) if (r) groups.push({ title: r.title, items: build(r.id) })
  // 没有文件夹的分组不显示空标题
  return groups.filter((g) => g.items.length)
})

export const folderTitle = computed(() => (state.folderId ? (state.flat?.folders.find((f) => f.id === state.folderId)?.title ?? '') : '全部'))

// ---------------------------------------------------------------- 结果条

const titleOf = (id: string) => state.flat?.bookmarks.find((b) => b.id === id)?.title || state.flat?.folders.find((f) => f.id === id)?.title || id

export function applyNotice(log: ApplyLog): Notice {
  const r = log.report
  if (log.status !== 'done' || !r) return { kind: 'error', text: `应用中断：${log.error?.message ?? '未知错误'}`, applyId: log.applyId }
  const parts = [`移动 ${r.moved}`, `改标题 ${r.renamed}`, `新目录 ${r.createdFolders}`]
  if (r.skipped.length) parts.push(`跳过 ${r.skipped.length}`)
  if (r.mismatches.length) parts.push(`未到位 ${r.mismatches.length}`)
  const details = [
    ...r.skipped.map((s) => `${titleOf(s.bookmarkId)} · ${applySkipText[s.reason]}`),
    ...r.mismatches.map((m) => `${titleOf(m.bookmarkId)} · 未到位`)
  ]
  return { kind: 'applied', text: parts.join(' · '), applyId: log.applyId, details }
}

export function undoNotice(log: ApplyLog): Notice {
  const r = log.undoReport
  if (log.status !== 'undone' || !r) return { kind: 'error', text: `撤销中断：${log.error?.message ?? '未知错误'}`, applyId: log.applyId }
  return restoreNotice(r, 'undone')
}

/** restored 数的是动过的节点（书签和文件夹都算），和书签条数对不上，不显示；只报重建和保留的，详情里列出名字 */
export function restoreNotice(r: UndoReport, kind: 'undone' | 'restored' = 'restored'): Notice {
  const kept = [...r.keptFolders, ...r.keptExtras]
  const parts = [kind === 'undone' ? '已撤销' : '已恢复']
  if (r.rebuilt.length) parts.push(`重建 ${r.rebuilt.length}`)
  if (kept.length) parts.push(`保留 ${kept.length}`)
  return { kind, text: parts.join(' · '), details: [...r.rebuilt.map((x) => `${x.title} · 重建`), ...kept.map((id) => `${titleOf(id)} · 保留`)] }
}

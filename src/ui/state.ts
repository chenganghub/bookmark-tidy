// 全局状态和派生数据。组件只读 state、调这里的函数；改书签都经过 Workflow。
import { computed, nextTick, reactive } from 'vue'
import { effectiveLockedIds, specialFolders } from '../core/plan'
import { pickRoot } from '../core/tree'
import { folderChoices } from '../core/triage'
import type { ApplyLog, AuditIssues, AuditSummary, BookmarkMeta, FlatBookmark, FlatFolder, FlatTree, ManualChange, MoveTarget, PageInfo, Settings, Triage, UndoReport, Workflow } from '../core/types'
import { applySkipText, downloadText, errorText, stampForFile } from './format'
import { getWorkflow, params } from './useWorkflow'

/** triage：待处理（拿不准放哪、建议删除、空文件夹，底下是原来的体检） */
export type View = 'browse' | 'triage' | 'organize'
export type Layout = 'cards' | 'list'
export type SortKey = 'added' | 'used' | 'title'
export type FilterKey = 'cold' | 'duplicate' | 'login' | 'dead' | 'inbox'
export type Badge = 'dead' | 'unreachable' | 'login' | 'duplicate' | 'cold' | 'recent'

export interface Notice {
  kind: 'applied' | 'undone' | 'restored' | 'error' | 'manual'
  text: string
  applyId?: string
  details?: string[]
  /** kind 是 manual：这次移动或删除，「撤销」用 */
  change?: ManualChange
}

/** 移动对话框：要移的书签；newFolder 打开时直接是「新建文件夹」 */
export interface Moving {
  ids: string[]
  newFolder: boolean
}

/** 「放到」下拉里「新建文件夹…」那一项的值（待处理的行和移动对话框共用） */
export const NEW_FOLDER = '__new'

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
  moving: null as Moving | null,
  triage: null as Triage | null,
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
    if (v === 'triage' || v === 'organize') state.view = v
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
  const [{ flat }, a, meta, pages, settings, latest, triage] = await Promise.all([w.loadTree(), w.audit(), w.getMeta(), w.getPageInfos(), w.getSettings(), w.getLatestApply(), w.triage()])
  state.flat = flat
  state.summary = a.summary
  state.issues = a.issues
  state.meta = meta
  state.pages = pages
  state.settings = settings
  state.latest = latest
  state.triage = triage
  if (state.folderId && !flat.folders.some((f) => f.id === state.folderId)) state.folderId = ''
}

export async function saveSettings(patch: Partial<Settings>) {
  state.settings = await workflow().saveSettings(patch)
  if (patch.theme && !params.get('theme')) applyTheme(patch.theme)
  // 改了锁定：待处理的清单（空文件夹、AI 猜的目录）要按新的锁定重算，免得删到、放进刚锁上的文件夹
  if (patch.lockedFolderIds) state.triage = await workflow().triage()
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

/** 「放到」的选项：书签栏下前两层、不含锁定的 */
export const choices = computed(() => (state.flat ? folderChoices(state.flat, lockedIds.value) : []))
/** 顶栏「待处理」后面的数：拿不准放哪 + 建议删除（空文件夹不算） */
export const pendingN = computed(() => (state.triage ? state.triage.unsure.length + state.triage.cleanup.length : 0))

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

// ---------------------------------------------------------------- 待处理和卡片上的移动、删除（bookmark-ux）

const withSkipped = (text: string, skipped: number) => (skipped ? `${text} · 跳过 ${skipped}` : text)

/** 一次手动操作：同一时刻只做一件（应用、撤销进行中也不做）；做完刷新，真的动了书签时结果条带「撤销」 */
async function manual(run: () => Promise<ManualChange>, text: (c: ManualChange) => string) {
  if (state.busy) return
  state.busy = true
  try {
    const change = await run()
    const changed = change.moved.length + change.removed.length > 0
    state.notice = { kind: 'manual', text: withSkipped(text(change), change.skipped), ...(changed ? { change } : {}) }
  } catch (e) {
    state.notice = { kind: 'error', text: errorText(e) }
  } finally {
    state.busy = false
    await reload()
  }
}

/** 已经在那个文件夹里的不动；一条都没动时不报「已放到」：书签已经不在了（记成跳过）写「没放成」，本来就在那里写「本来就在」 */
export const moveTo = (ids: string[], target: MoveTarget, label: string) =>
  manual(
    () => workflow().moveBookmarks(ids, target),
    (c) => (c.moved.length ? `已放到「${label}」` : c.skipped ? '没放成' : `本来就在「${label}」`)
  )

/** 删书签；backup 时先下载整棵树的备份（批量删用） */
export const removeMarks = (ids: string[], backup = false) =>
  manual(
    () => workflow().removeBookmarks(ids, backup ? (json) => downloadText(json, `书签备份-${stampForFile()}.json`) : undefined),
    (c) => `已删除 ${c.removed.length} 条`
  )

export const removeEmpty = (ids: string[]) => manual(() => workflow().removeFolders(ids), (c) => `已删除 ${c.removed.length} 个空文件夹`)

/** 结果条上的「撤销」；撤销到一半出错、有没恢复回来的，都留着这次的记录，再点一次从断点接着做 */
export async function revertManual() {
  const change = state.notice?.change
  if (!change || state.busy) return
  state.busy = true
  try {
    const r = await workflow().revertChange(change)
    // 有没恢复回来的（期间被别处改过、书签接口出错）：留着记录，按钮还在，能再试
    state.notice = r.skipped ? { kind: 'manual', text: `撤销了 ${r.restored} 项，${r.skipped} 项没恢复`, change } : { kind: 'manual', text: '已撤销' }
  } catch (e) {
    state.notice = { kind: 'manual', text: `撤销没做完：${errorText(e)}`, change }
  } finally {
    state.busy = false
    await reload()
  }
}

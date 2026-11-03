<script setup lang="ts">
import { computed, ref } from 'vue'
import { hostOf } from '../../core/rules'
import type { FetchPlan, FetchProgress, FetchRun, FetchStatus, SkipReason } from '../../core/types'
import { errorText, fetchStatusText, skipReasonText } from '../format'
import { lockedIds, reload, roots, saveSettings, state, workflow } from '../state'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'

interface Stat {
  key: string
  label: string
  value: number
  ids?: string[]
  kind?: 'bookmark' | 'folder'
}

const stats = computed<Stat[]>(() => {
  const s = state.summary
  const i = state.issues
  if (!s || !i) return []
  const bar = roots.value.bar
  const all: Stat[] = [
    { key: 'bookmarks', label: '书签', value: s.bookmarks },
    { key: 'folders', label: '文件夹', value: s.folders },
    { key: 'top', label: '书签栏顶层', value: bar ? bar.topFolders + bar.looseBookmarks : 0 },
    { key: 'dup', label: '重复', value: s.duplicates.normalized.extra, ids: i.duplicateGroups.flatMap((g) => g.slice(1)), kind: 'bookmark' },
    { key: 'empty', label: '空文件夹', value: i.emptyFolders.length, ids: i.emptyFolders, kind: 'folder' },
    { key: 'nested', label: '同名嵌套', value: i.nestedSameNameFolders.length, ids: i.nestedSameNameFolders, kind: 'folder' },
    { key: 'default', label: '默认名', value: i.defaultNameFolders.length, ids: i.defaultNameFolders, kind: 'folder' },
    { key: 'clean', label: '可清理标题', value: i.cleanable.length, ids: i.cleanable, kind: 'bookmark' },
    { key: 'long', label: '超长标题', value: i.longTitle.length, ids: i.longTitle, kind: 'bookmark' },
    { key: 'cold', label: '冷门', value: i.cold.length, ids: i.cold, kind: 'bookmark' },
    { key: 'nothttp', label: '非 http', value: i.notHttp.length, ids: i.notHttp, kind: 'bookmark' },
    { key: 'intranet', label: '内网', value: i.intranet.length, ids: i.intranet, kind: 'bookmark' }
  ]
  return all.filter((x) => !x.ids || x.value > 0) // 总数三张常驻，问题为 0 的不显示
})

const selected = ref('')
const selectedStat = computed(() => stats.value.find((s) => s.key === selected.value))
const rows = computed(() => {
  const st = selectedStat.value
  const f = state.flat
  if (!st?.ids || !f) return []
  if (st.kind === 'folder') {
    const byId = new Map(f.folders.map((x) => [x.id, x]))
    return st.ids.map((id) => byId.get(id)).filter((x) => !!x).map((x) => ({ id: x!.id, title: x!.title, sub: x!.path.slice(0, -1).join(' / ') }))
  }
  const byId = new Map(f.bookmarks.map((x) => [x.id, x]))
  return st.ids.map((id) => byId.get(id)).filter((x) => !!x).map((x) => ({ id: x!.id, title: x!.title || x!.url, sub: x!.path.join(' / ') }))
})

function pick(s: Stat) {
  if (!s.ids) return
  selected.value = selected.value === s.key ? '' : s.key
}

// ---------------------------------------------------------------- 抓取网页信息

const plan = ref<FetchPlan | null>(null)
const run = ref<FetchRun | null>(null)
const progress = ref<FetchProgress | null>(null)
const finished = ref(false)
const error = ref('')

const fetchedCount = computed(() => Object.keys(state.pages).length)
const skippedCount = computed(() => plan.value?.skipped.reduce((s, x) => s + x.bookmarkIds.length, 0) ?? 0)
const skipGroups = computed(() => {
  const m = new Map<SkipReason, number>()
  for (const s of plan.value?.skipped ?? []) m.set(s.reason, (m.get(s.reason) || 0) + s.bookmarkIds.length)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
})
/** 域名：要抓的前 16 个（勾着），加上已经排除的（不勾，能再勾回来） */
const domains = computed(() => {
  const m = new Map<string, number>()
  for (const t of plan.value?.toFetch ?? []) {
    const h = hostOf(t.url)
    if (h) m.set(h, (m.get(h) || 0) + 1)
  }
  const on = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([host, n]) => ({ host, n, excluded: false }))
  const off = (state.settings?.excludeDomains ?? []).map((host) => ({ host, n: 0, excluded: true }))
  return [...on, ...off]
})

/** 文件夹：书签栏和其他书签下的顶层文件夹（锁定的本来就不抓，不列），勾着的才抓 */
const folders = computed(() => {
  const f = state.flat
  const { bar, other } = roots.value
  if (!f || !plan.value) return []
  const excluded = new Set(state.settings?.excludeFolderIds ?? [])
  const fetching = new Set(plan.value.toFetch.flatMap((t) => t.bookmarkIds))
  return f.folders
    .filter((x) => (x.parentId === bar?.id || x.parentId === other?.id) && !lockedIds.value.has(x.id))
    .map((x) => ({ id: x.id, title: x.title, excluded: excluded.has(x.id), n: f.bookmarks.filter((b) => b.folderIds.includes(x.id) && fetching.has(b.id)).length }))
    .filter((x) => x.n > 0 || x.excluded)
})
const statusCounts = computed(() => {
  const m = new Map<FetchStatus, number>()
  for (const p of Object.values(state.pages)) m.set(p.status, (m.get(p.status) || 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
})

async function prepare() {
  error.value = ''
  try {
    // Chrome 要求在用户点击里申请权限：这是点击处理的第一件事
    if (!(await workflow().ensureSitePermission())) {
      error.value = '没有网址权限'
      return
    }
    finished.value = false
    plan.value = await workflow().planFetch()
  } catch (e) {
    error.value = errorText(e)
  }
}

/** 勾上 = 抓，取消 = 排除；改完重算清单 */
const toggled = (list: string[], id: string, include: boolean) => (include ? list.filter((x) => x !== id) : [...new Set([...list, id])])

async function toggleDomain(host: string, include: boolean) {
  await saveSettings({ excludeDomains: toggled(state.settings?.excludeDomains ?? [], host, include) })
  plan.value = await workflow().planFetch()
}

async function toggleFolder(id: string, include: boolean) {
  await saveSettings({ excludeFolderIds: toggled(state.settings?.excludeFolderIds ?? [], id, include) })
  plan.value = await workflow().planFetch()
}

async function start() {
  if (!plan.value) return
  const r = workflow().startFetch(plan.value, (p) => (progress.value = p))
  run.value = r
  progress.value = r.progress()
  await r.done
  run.value = null
  plan.value = null
  finished.value = true
  await reload()
}

const paused = computed(() => !!progress.value?.paused)
</script>

<template>
  <section>
    <div class="view-head">
      <h1 class="view-title">体检</h1>
    </div>
    <div class="stats">
      <button v-for="s in stats" :key="s.key" class="stat" type="button" :aria-pressed="selected === s.key" :disabled="!s.ids" @click="pick(s)">
        <span class="num">{{ s.value }}</span>
        <span class="label">{{ s.label }}</span>
      </button>
    </div>
    <template v-if="selectedStat">
      <div v-if="rows.length" class="list" style="margin-top: 16px">
        <div v-for="r in rows" :key="r.id" class="row-wrap">
          <div class="row">
            <span class="row-title">{{ r.title }}</span>
            <span class="row-desc">{{ r.sub }}</span>
          </div>
        </div>
      </div>
      <EmptyState v-else icon="check" text="没有" />
    </template>

    <h2 class="section-title">网页信息</h2>
    <div class="panel">
      <template v-if="run && progress">
        <div class="row-gap">
          <progress :max="progress.total || 1" :value="progress.done"></progress>
          <span class="secondary">{{ progress.done }} / {{ progress.total }} · 失败 {{ progress.failed }}</span>
          <button class="btn btn-small" type="button" @click="paused ? run.resume() : run.pause()">{{ paused ? '继续' : '暂停' }}</button>
          <button class="btn btn-small" type="button" @click="run.stop()">停止</button>
        </div>
      </template>
      <template v-else-if="plan">
        <div class="kv">
          <span>抓取 <b>{{ plan.toFetch.length }}</b></span>
          <span>跳过 <b>{{ skippedCount }}</b></span>
          <span>已有 <b>{{ plan.cached.length }}</b></span>
        </div>
        <details v-if="skipGroups.length" style="margin: 12px 0 0 -4px">
          <summary class="disclose"><Icon name="chevron" :size="14" />跳过</summary>
          <div class="kv" style="margin: 8px 0 0 4px">
            <span v-for="[reason, n] in skipGroups" :key="reason">{{ skipReasonText[reason] }} <b>{{ n }}</b></span>
          </div>
        </details>
        <details v-if="folders.length" style="margin: 4px 0 0 -4px">
          <summary class="disclose"><Icon name="chevron" :size="14" />文件夹</summary>
          <div class="row-gap" style="margin: 8px 0 0 4px">
            <label v-for="x in folders" :key="x.id" class="check">
              <input type="checkbox" :checked="!x.excluded" @change="toggleFolder(x.id, ($event.target as HTMLInputElement).checked)" />
              <span>{{ x.title }}</span>
              <span v-if="!x.excluded" class="secondary">{{ x.n }}</span>
            </label>
          </div>
        </details>
        <details v-if="domains.length" style="margin: 4px 0 0 -4px">
          <summary class="disclose"><Icon name="chevron" :size="14" />域名</summary>
          <div class="row-gap" style="margin: 8px 0 0 4px">
            <label v-for="d in domains" :key="d.host" class="check">
              <input type="checkbox" :checked="!d.excluded" @change="toggleDomain(d.host, ($event.target as HTMLInputElement).checked)" />
              <span>{{ d.host }}</span>
              <span v-if="!d.excluded" class="secondary">{{ d.n }}</span>
            </label>
          </div>
        </details>
        <div class="row-gap" style="margin-top: 16px">
          <button class="btn btn-primary" type="button" :disabled="!plan.toFetch.length" @click="start">开始</button>
          <button class="btn" type="button" @click="plan = null">取消</button>
        </div>
      </template>
      <template v-else>
        <div class="row-gap">
          <button class="btn" type="button" @click="prepare">抓取网页信息</button>
          <span v-if="fetchedCount" class="secondary">已有 {{ fetchedCount }}</span>
        </div>
        <div v-if="finished || statusCounts.length" class="kv" style="margin-top: 12px">
          <span v-for="[status, n] in statusCounts" :key="status">{{ fetchStatusText[status] }} <b>{{ n }}</b></span>
        </div>
      </template>
      <p v-if="error" class="secondary" style="margin-top: 12px">{{ error }}</p>
    </div>
  </section>
</template>

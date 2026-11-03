<script setup lang="ts">
// 工具栏弹窗：搜索框、「整理 N 条」、一键整理的进度 / 预览 / 结果、最近自动放的几条、本机计数。
// 规则同管理页（docs/设计规范.md）：一个主色、同一时刻一个主按钮、不放解释性文案。
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { AutoStatus } from '../../core/autofile'
import type { SearchEntry } from '../../core/search'
import Icon from '../components/Icon.vue'
import { faviconUrl, hostOf, initialOf } from '../format'
import { getClient, params, type PopupClient } from './client'

const client = ref<PopupClient>()
const status = ref<AutoStatus>()
const query = ref('')
const results = ref<SearchEntry[]>([])
const picked = ref(new Set<string>())
const busy = ref(false)
const error = ref('')
const input = ref<HTMLInputElement>()

const theme = params.get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme

async function refresh() {
  try {
    status.value = await client.value!.status()
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

// 一键整理时后台每条都写存储，攒 300 毫秒再刷新一次
let refreshTimer: number | undefined
const refreshSoon = () => {
  clearTimeout(refreshTimer)
  refreshTimer = window.setTimeout(() => void refresh(), 300)
}

// 搜索：只用最后一次输入的结果（慢的旧结果回来时不覆盖），并记下结果是哪个词的；
// 后台接口还没连上时先记着，连上再搜；搜索出错时显示原因，不当成「没有结果」
let searchSeq = 0
let resultsFor = ''
const searchError = ref('')
async function runSearch(q: string) {
  const seq = ++searchSeq
  if (!q.trim() || !client.value) {
    results.value = []
    resultsFor = q
    return
  }
  let r: SearchEntry[] = []
  let err = ''
  try {
    r = await client.value.search(q)
  } catch (e) {
    err = e instanceof Error ? e.message : String(e)
  }
  if (seq !== searchSeq) return
  results.value = r
  resultsFor = q
  searchError.value = err
}

onMounted(async () => {
  try {
    client.value = await getClient()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return
  }
  client.value.onChange(refreshSoon)
  if (query.value.trim()) void runSearch(query.value)
  await refresh()
  await nextTick()
  input.value?.focus()
})

watch(query, (q) => void runSearch(q))

const batch = computed(() => status.value?.batch)
const gate = computed(() => {
  const s = status.value
  if (!s) return undefined
  if (!s.organized) {
    // 最近一次应用不是「完成」：没应用过、撤销了、没做完（应用或撤销停在一半、失败了）分开写
    const text = !s.applyStatus ? '还没整理过' : s.applyStatus === 'undone' ? '整理已撤销' : '上次整理没做完'
    return { text, action: '去整理', go: () => client.value!.openManager('organize') }
  }
  if (!s.hasKey) return { text: '没填 API key', action: '去设置', go: () => client.value!.openManager('settings') }
  if (!s.hasPermission) return { text: '没有网页权限', action: '授权', go: grant }
  return undefined
})

// 预览出来时默认全选
watch(
  () => batch.value?.phase === 'preview' && batch.value.id,
  () => {
    if (batch.value?.phase === 'preview') picked.value = new Set(batch.value.items?.map((i) => i.bookmarkId))
  }
)

/** 做完返回 true；没做（正忙）或出错返回 false，错误写进 error */
async function act(fn: () => Promise<unknown>): Promise<boolean> {
  if (busy.value) return false
  busy.value = true
  try {
    await fn()
    await refresh()
    return true
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
    return false
  } finally {
    busy.value = false
  }
}

const run = () => act(() => client.value!.run())
// 点了「放好」「取消」的那一批：后台不等提交完就回话，在状态刷新成「整理中」之前不让再点；
// 消息没送到后台（出错）就恢复能点
const submitted = ref('')
async function apply() {
  const id = batch.value!.id
  submitted.value = id
  if (!(await act(() => client.value!.applyBatch(id, [...picked.value])))) submitted.value = ''
}
async function cancel() {
  const id = batch.value!.id
  submitted.value = id
  if (!(await act(() => client.value!.cancelBatch(id)))) submitted.value = ''
}
const undoBatch = () => act(() => client.value!.undoBatch(status.value!.lastBatch!))
const undo = (id: string) => act(() => client.value!.undo(id))
async function grant() {
  if (await client.value!.requestPermission()) await refresh()
}
function toggle(id: string, on: boolean) {
  const next = new Set(picked.value)
  if (on) next.add(id)
  else next.delete(id)
  picked.value = next
}
async function onEnter() {
  const q = query.value
  // 刚改了词、列表里还是上一个词的结果：先按现在的词搜完再打开，不打开旧结果
  if (resultsFor !== q) await runSearch(q)
  if (query.value !== q) return
  const first = results.value[0]
  if (first) client.value?.open(first.url)
  else if (q.trim()) client.value?.openManager(undefined, q.trim())
}

const resultLine = computed(() => {
  const r = batch.value?.result
  if (!r) return ''
  const parts = [`放好 ${r.filed}`]
  if (r.toInbox) parts.push(`待整理 ${r.toInbox}`)
  if (r.skipped) parts.push(`跳过 ${r.skipped}`)
  return parts.join(' · ')
})
const statusText: Record<string, string> = { undone: '已撤销', 'moved-by-user': '已挪走' }
</script>

<template>
  <div class="pop">
    <label class="search pop-search">
      <Icon name="search" :size="14" />
      <input ref="input" v-model="query" type="search" placeholder="搜索" aria-label="搜索书签" @keydown.enter="onEnter" />
    </label>

    <template v-if="query.trim()">
      <ul v-if="results.length" class="pop-list" aria-label="搜索结果">
        <li v-for="e in results" :key="e.id">
          <button class="pop-row" type="button" :title="e.url" @click="client!.open(e.url)">
            <img v-if="faviconUrl(e.url)" class="favicon" :src="faviconUrl(e.url)" alt="" />
            <span v-else class="favicon favicon-letter">{{ initialOf(e.title, e.url) }}</span>
            <span class="pop-text">
              <span class="pop-title">{{ e.aiTitle || e.title || hostOf(e.url) }}</span>
              <span class="pop-sub">{{ e.desc || e.folder || hostOf(e.url) }}</span>
            </span>
          </button>
        </li>
      </ul>
      <div v-else class="pop-empty secondary" :role="searchError ? 'alert' : undefined">{{ searchError || '没有结果' }}</div>
    </template>

    <template v-else-if="status">
      <section class="pop-main" aria-live="polite">
        <div v-if="gate" class="pop-gate">
          <span class="secondary">{{ gate.text }}</span>
          <button class="link" type="button" @click="gate.go()">{{ gate.action }}</button>
        </div>
        <div v-else-if="batch?.phase === 'running'" class="pop-progress">
          <progress :value="batch.done" :max="batch.total || 1"></progress>
          <span class="secondary small">{{ batch.done }} / {{ batch.total }}</span>
        </div>
        <template v-else-if="batch?.phase === 'preview'">
          <ul class="pop-list pop-preview" aria-label="去向">
            <li v-for="it in batch.items" :key="it.bookmarkId">
              <label class="pop-row pop-check">
                <input type="checkbox" :checked="picked.has(it.bookmarkId)" @change="toggle(it.bookmarkId, ($event.target as HTMLInputElement).checked)" />
                <span class="pop-text">
                  <span class="pop-title">{{ it.title }}</span>
                  <span class="pop-sub">{{ it.path }}</span>
                </span>
              </label>
            </li>
          </ul>
          <div class="pop-actions">
            <button class="btn" type="button" :disabled="busy || submitted === batch.id" @click="cancel">取消</button>
            <button class="btn btn-primary" type="button" :disabled="busy || !picked.size || submitted === batch.id" @click="apply">放好 {{ picked.size }} 条</button>
          </div>
        </template>
        <div v-else-if="batch?.phase === 'done' && status.lastBatch === batch.id" class="pop-gate">
          <span>{{ resultLine }}</span>
          <button class="link" type="button" :disabled="busy" @click="undoBatch">撤销这次</button>
        </div>
        <div v-else-if="batch?.phase === 'failed'" class="pop-gate">
          <span class="secondary">{{ batch.error }}</span>
        </div>
        <div v-if="!gate && batch?.phase !== 'running' && batch?.phase !== 'preview'" class="pop-run-row">
          <button v-if="status.unfiled" class="btn btn-primary pop-run" type="button" :disabled="busy" @click="run">整理 {{ status.unfiled }} 条</button>
          <button v-else class="btn pop-run" type="button" disabled>整理</button>
        </div>
        <p v-if="error" class="secondary small pop-error" role="alert">{{ error }}</p>
      </section>

      <section v-if="status.recent.length" class="pop-section" aria-labelledby="recent-title">
        <h2 id="recent-title" class="pop-head">最近收藏</h2>
        <ul class="pop-list">
          <li v-for="r in status.recent" :key="r.bookmarkId" class="pop-rec">
            <span class="pop-text">
              <span class="pop-title">{{ r.title }}</span>
              <span class="pop-sub">{{ r.path }}</span>
            </span>
            <button v-if="r.status === 'filed' || r.status === 'inbox'" class="link pop-undo" type="button" :disabled="busy" @click="undo(r.bookmarkId)">撤销</button>
            <span v-else class="secondary small">{{ statusText[r.status] }}</span>
          </li>
        </ul>
      </section>

      <footer class="pop-foot secondary small">
        <span>自动放 {{ status.stats.filed }} · 待整理 {{ status.stats.toInbox }} · 撤销 {{ status.stats.undone }} · 又挪走 {{ status.stats.movedAgain }} · 地址栏 {{ status.stats.omnibox }}</span>
        <button class="link small" type="button" @click="client!.openManager()">管理页</button>
      </footer>
    </template>
    <div v-else class="pop-empty">
      <span v-if="error" class="secondary small" role="alert">{{ error }}</span>
      <span v-else class="spinner" role="status" aria-label="加载中"></span>
    </div>
  </div>
</template>

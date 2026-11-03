<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { participants, planStats, reusedFolders } from '../../core/plan'
import type { AiUsage, Plan, PlanOptions, StageProgress } from '../../core/types'
import { downloadText, errorText, money, stampForFile } from '../format'
import { applyNotice, lockedIds, reload, roots, saveSettings, state, workflow } from '../state'
import { isDemo } from '../useWorkflow'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import PlanPreview from './PlanPreview.vue'

const s = computed(() => state.settings!)
const hasKey = computed(() => isDemo || !!s.value.ai.apiKey)
const topFolders = computed(() => (state.flat?.folders ?? []).filter((f) => f.parentId === roots.value.bar?.id))
const lockOpen = ref(false)
const lockedNames = computed(() => topFolders.value.filter((f) => lockedIds.value.has(f.id)).map((f) => f.title))

const options = computed<PlanOptions>(() => ({
  maxTop: s.value.maxTop,
  emoji: s.value.emoji,
  ruleTitles: s.value.ruleTitles,
  lockedFolderIds: [...lockedIds.value],
  keepLooseBarItems: s.value.keepLooseBarItems
}))

/** 参与整理、还没有说明的条数 */
const missing = computed(() => {
  const f = state.flat
  const { bar, other } = roots.value
  if (!f || !bar || !other) return 0
  return participants(f, options.value, bar.id, other.id).filter((b) => !state.meta[b.id]).length
})

const plan = ref<Plan>()
const progress = ref<StageProgress>()
const usage = ref<AiUsage>()
const running = ref<'' | 'describe' | 'plan' | 'apply'>('')
const applied = ref<[number, number]>([0, 0])
const error = ref('')
const confirm = ref<HTMLDialogElement>()
let ctrl: AbortController | undefined

/**
 * 存着的方案：已经应用完的不再显示（免得再点一次「应用」）；撤销以后又显示出来，可以改了再应用。
 * 上次应用或撤销没做完时不让应用新的，先在结果条上继续或撤销。
 */
async function loadPlan() {
  const p = await workflow().getPlan()
  const l = state.latest
  plan.value = p && !(l?.planId === p.id && l.status === 'done') ? p : undefined
}
const pendingApply = computed(() => ['running', 'failed', 'undoing'].includes(state.latest?.status ?? ''))

onMounted(async () => {
  // 第一次打开：按默认名字（受保护资料）预选的锁定文件夹存回设置
  if (!s.value.lockedFolderIds.length && lockedIds.value.size) await saveSettings({ lockedFolderIds: [...lockedIds.value] })
  await loadPlan()
})
watch(
  () => [state.latest?.applyId, state.latest?.status],
  () => {
    if (running.value !== 'apply') void loadPlan()
  }
)

function toggleLock(id: string, on: boolean) {
  const next = new Set(lockedIds.value)
  if (on) next.add(id)
  else next.delete(id)
  void saveSettings({ lockedFolderIds: [...next] })
}

async function describe() {
  error.value = ''
  running.value = 'describe'
  ctrl = new AbortController()
  try {
    const r = await workflow().describe((p) => (progress.value = p), ctrl.signal)
    usage.value = r.usage
    state.meta = await workflow().getMeta()
    if (r.failedIds.length) error.value = `${r.failedIds.length} 条没写成`
  } catch (e) {
    error.value = errorText(e)
  } finally {
    running.value = ''
  }
}

async function generate() {
  error.value = ''
  running.value = 'plan'
  ctrl = new AbortController()
  try {
    const r = await workflow().buildPlan(options.value, (p) => (progress.value = p), ctrl.signal)
    plan.value = r.plan
    usage.value = r.usage
  } catch (e) {
    error.value = errorText(e)
  } finally {
    running.value = ''
  }
}

function edit(next: Plan) {
  plan.value = next
  void workflow().savePlan(next)
}

async function apply() {
  confirm.value?.close()
  if (!plan.value || state.busy) return
  error.value = ''
  running.value = 'apply'
  state.busy = true
  // 上一次的结果条（比如「已撤销」）先收起来：应用中不该还挂着旧结果和它的按钮
  state.notice = null
  try {
    const log = await workflow().apply(
      plan.value,
      (d, t) => (applied.value = [d, t]),
      async (snapshotId) => downloadText(await workflow().exportSnapshot(snapshotId), `书签备份-${stampForFile()}.json`)
    )
    state.notice = applyNotice(log)
    if (log.status === 'done') plan.value = undefined
  } catch (e) {
    error.value = errorText(e)
  } finally {
    running.value = ''
    state.busy = false
    await reload()
  }
}

const stageText: Record<StageProgress['stage'], string> = { describe: '说明', taxonomy: '目录', classify: '归类', split: '拆分' }
const progressLine = computed(() => {
  const p = progress.value
  if (!p) return ''
  const parts = [`${stageText[p.stage]} ${p.doneBatches} / ${p.totalBatches}`]
  if (p.failedBatches) parts.push(`失败 ${p.failedBatches}`)
  parts.push(`token ${p.usage.promptTokens + p.usage.completionTokens}`)
  parts.push(money(workflow().estimateCost(p.usage)))
  return parts.join(' · ')
})
const usageLine = computed(() => (usage.value ? `token ${usage.value.promptTokens + usage.value.completionTokens} · ${money(workflow().estimateCost(usage.value))}` : ''))

/** 底部条的方案数字：为 0 的不显示；「移动」不算已经在目标文件夹里的，和应用结果对得上 */
const planLine = computed(() => {
  if (!plan.value || !state.flat) return ''
  const st = planStats(plan.value, reusedFolders(plan.value, state.flat))
  const parts: [string, number][] = [
    ['移动', st.moving],
    ['改标题', st.renaming],
    ['待整理', st.inbox],
    ['待清理', st.cleanup],
    ['不动', st.disabled]
  ]
  return parts
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ')
})
</script>

<template>
  <section>
    <div class="view-head">
      <h1 class="view-title">整理</h1>
    </div>

    <div class="panel">
      <div class="row-gap" style="gap: 16px">
        <label class="check">
          顶层上限
          <select :value="s.maxTop" @change="saveSettings({ maxTop: Number(($event.target as HTMLSelectElement).value) })">
            <option v-for="n in [4, 5, 6, 7, 8, 9, 10, 11, 12]" :key="n" :value="n">{{ n }}</option>
          </select>
        </label>
        <label class="check"><input type="checkbox" :checked="s.ruleTitles" @change="saveSettings({ ruleTitles: ($event.target as HTMLInputElement).checked })" />清理标题</label>
        <label class="check"><input type="checkbox" :checked="s.keepLooseBarItems" @change="saveSettings({ keepLooseBarItems: ($event.target as HTMLInputElement).checked })" />散放不动</label>
        <label class="check"><input type="checkbox" :checked="s.emoji" @change="saveSettings({ emoji: ($event.target as HTMLInputElement).checked })" />emoji</label>
        <!-- 锁定的文件夹直接写出名字；展开后在下一行勾选，这一行不跳 -->
        <button class="disclose" type="button" :aria-expanded="lockOpen" aria-controls="lock-list" @click="lockOpen = !lockOpen">
          <Icon name="chevron" :size="14" />
          <span>锁定</span>
          <span class="secondary">{{ lockedNames.length ? lockedNames.join('、') : '无' }}</span>
        </button>
      </div>
      <div v-if="lockOpen" id="lock-list" class="row-gap" style="gap: 8px 16px; margin-top: 12px">
        <label v-for="f in topFolders" :key="f.id" class="check">
          <input type="checkbox" :checked="lockedIds.has(f.id)" @change="toggleLock(f.id, ($event.target as HTMLInputElement).checked)" />{{ f.title }}
        </label>
      </div>
      <div class="row-gap" style="margin-top: 16px">
        <template v-if="hasKey">
          <button class="btn" type="button" :disabled="!!running || !missing" @click="describe">生成说明<span v-if="missing" class="secondary">&nbsp;{{ missing }}</span></button>
          <!-- 有方案以后，主按钮让给底部的「应用」 -->
          <button class="btn" :class="{ 'btn-primary': !plan }" type="button" :disabled="!!running" @click="generate">生成方案</button>
          <button v-if="running === 'describe' || running === 'plan'" class="link" type="button" @click="ctrl?.abort()">停止</button>
        </template>
        <button v-else class="btn btn-primary" type="button" @click="state.settingsOpen = true">设置 API key</button>
        <template v-if="(running === 'describe' || running === 'plan') && progress">
          <progress :max="progress.totalBatches || 1" :value="progress.doneBatches"></progress>
          <span class="secondary">{{ progressLine }}</span>
        </template>
        <span v-else-if="usageLine" class="secondary small">{{ usageLine }}</span>
      </div>
      <p v-if="error" class="secondary" style="margin-top: 12px">{{ error }}</p>
    </div>

    <template v-if="plan">
      <h2 class="section-title">方案</h2>
      <PlanPreview :plan="plan" @update="edit" />
      <div class="applybar">
        <span class="grow row-gap">
          <template v-if="running === 'apply'">
            <progress :max="applied[1] || 1" :value="applied[0]"></progress>
            <span>{{ applied[0] }} / {{ applied[1] }}</span>
          </template>
          <template v-else>{{ planLine }}</template>
        </span>
        <button class="btn btn-primary" type="button" :disabled="!!running || pendingApply" @click="confirm?.showModal()">应用</button>
      </div>
    </template>
    <EmptyState v-else-if="hasKey && !running" icon="bookmark" text="还没有方案" />

    <dialog ref="confirm" aria-labelledby="confirm-title">
      <h2 id="confirm-title">应用整理方案？</h2>
      <p class="secondary">会先下载备份，可撤销。</p>
      <div class="actions">
        <button class="btn" type="button" @click="confirm?.close()">取消</button>
        <!-- 默认按钮：回车应用，Esc 取消（会先下载备份，能撤销） -->
        <button class="btn btn-primary" type="button" autofocus @click="apply">应用</button>
      </div>
    </dialog>
  </section>
</template>

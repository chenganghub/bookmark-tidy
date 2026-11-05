<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { CLEANUP, CLEANUP_NAME, deleteFolder, finalTitle, folderDisplayName, INBOX, INBOX_NAME, mergeFolders, planStats, renameFolder, setItemEnabled, setItemTarget, setTitleChoice, validatePlan } from '../../core/plan'
import type { Plan, PlanFolder, PlanItem } from '../../core/types'
import { faviconUrl, initialOf, reasonText } from '../format'
import { roots, state } from '../state'
import Icon from './Icon.vue'

const props = defineProps<{ plan: Plan }>()
const emit = defineEmits<{ update: [plan: Plan] }>()

const stats = computed(() => planStats(props.plan))
const problems = computed(() => validatePlan(props.plan))
const byId = computed(() => new Map((state.flat?.bookmarks ?? []).map((b) => [b.id, b])))
const current = computed(() => (state.flat?.folders ?? []).filter((f) => f.parentId === roots.value.bar?.id))

const name = (f: PlanFolder) => folderDisplayName(f, props.plan.options.emoji)
const countOf = (f: PlanFolder) => (stats.value.perFolder[f.key] || 0) + f.children.reduce((s, c) => s + (stats.value.perFolder[c.key] || 0), 0)

/** 目标下拉和清单分组：方案目录 + 待整理 + 待清理 */
const targets = computed(() => [
  ...props.plan.folders.flatMap((t) => [{ key: t.key, label: name(t) }, ...t.children.map((c) => ({ key: c.key, label: `${name(t)} / ${name(c)}` }))]),
  { key: INBOX, label: INBOX_NAME },
  { key: CLEANUP, label: CLEANUP_NAME }
])
/** 待整理、待清理：要你拿主意的，清单里排最前、默认展开，「放到」一直显示 */
const isSpecial = (key: string) => key === INBOX || key === CLEANUP
const groups = computed(() =>
  [...targets.value.filter((t) => isSpecial(t.key)), ...targets.value.filter((t) => !isSpecial(t.key))]
    .map((t) => ({ ...t, items: props.plan.items.filter((i) => i.target === t.key) }))
    .filter((g) => g.items.length)
)

// 只渲染展开的分组，400 条也不卡；新方案默认展开待整理、待清理和第一个目录
const open = ref(new Set<string>())
watch(
  () => props.plan.id,
  () => {
    const first = groups.value.find((g) => !isSpecial(g.key))
    open.value = new Set([...groups.value.filter((g) => isSpecial(g.key)).map((g) => g.key), ...(first ? [first.key] : [])])
  },
  { immediate: true }
)
function onToggle(key: string, e: Event) {
  const next = new Set(open.value)
  if ((e.target as HTMLDetailsElement).open) next.add(key)
  else next.delete(key)
  open.value = next
}

const renaming = ref('')
const renameValue = ref('')
function startRename(f: PlanFolder) {
  renaming.value = f.key
  renameValue.value = f.name
}
function commitRename() {
  if (renaming.value && renameValue.value.trim()) emit('update', renameFolder(props.plan, renaming.value, renameValue.value))
  renaming.value = ''
}
function merge(from: string, e: Event) {
  const into = (e.target as HTMLSelectElement).value
  if (into) emit('update', mergeFolders(props.plan, from, into))
}
const mergeTargets = (f: PlanFolder) => targets.value.filter((t) => t.key !== f.key && t.key !== INBOX && t.key !== CLEANUP && !f.children.some((c) => c.key === t.key))

/** 锁定的文件夹原样留在书签栏上（排在方案目录后面），「整理后」里也列出来，免得以为它没了 */
const locked = computed(() => new Set(props.plan.options.lockedFolderIds))
const lockedTop = computed(() => current.value.filter((f) => locked.value.has(f.id)))

const urlOf = (it: PlanItem) => byId.value.get(it.bookmarkId)?.url ?? it.base.url
const checked = (e: Event) => (e.target as HTMLInputElement).checked
</script>

<template>
  <div>
    <p v-if="problems.length" class="small secondary" style="margin-bottom: 12px">{{ problems.join('；') }}</p>

    <div class="cols">
      <div class="panel">
        <h2 class="panel-title">现在</h2>
        <ul class="tree">
          <li v-for="f in current" :key="f.id">
            <Icon name="folder" />
            <span class="grow">{{ f.title }}</span>
            <span class="n"><Icon v-if="locked.has(f.id)" name="lock" :size="12" />{{ f.totalBookmarks }}</span>
          </li>
        </ul>
      </div>
      <div class="panel">
        <h2 class="panel-title">整理后</h2>
        <ul class="tree">
          <template v-for="top in plan.folders" :key="top.key">
            <li v-for="f in [top, ...top.children]" :key="f.key" :class="{ child: f !== top }">
              <Icon name="folder" />
              <input v-if="renaming === f.key" v-model="renameValue" type="text" class="grow" aria-label="目录名" @keydown.enter="commitRename" @keydown.esc="renaming = ''" @blur="commitRename" />
              <span v-else class="grow">{{ name(f) }}</span>
              <!-- 改名、合并、移除：悬停或键盘聚焦这一行时出现 -->
              <span class="ops">
                <button class="btn btn-icon btn-small" type="button" aria-label="改名" title="改名" @click="startRename(f)"><Icon name="pencil" :size="14" /></button>
                <select aria-label="合并到" title="合并到" :value="''" @change="merge(f.key, $event)">
                  <option value="">合并到</option>
                  <option v-for="t in mergeTargets(f)" :key="t.key" :value="t.key">{{ t.label }}</option>
                </select>
                <button class="btn btn-icon btn-small" type="button" aria-label="移除" title="移除" @click="emit('update', deleteFolder(plan, f.key))"><Icon name="minus" :size="14" /></button>
              </span>
              <span class="n">{{ f === top ? countOf(f) : stats.perFolder[f.key] || 0 }}</span>
            </li>
          </template>
          <li v-for="f in lockedTop" :key="f.id">
            <Icon name="folder" />
            <span class="grow">{{ f.title }}</span>
            <span class="n"><Icon name="lock" :size="12" />{{ f.totalBookmarks }}</span>
          </li>
        </ul>
      </div>
    </div>

    <details v-for="g in groups" :key="g.key" class="group" :open="open.has(g.key)" @toggle="onToggle(g.key, $event)">
      <summary>
        <Icon name="chevron" :size="14" />
        <span>{{ g.label }}</span>
        <span class="secondary" style="font-weight: 400">{{ g.items.length }}</span>
      </summary>
      <template v-if="open.has(g.key)">
        <div v-for="it in g.items" :key="it.bookmarkId" class="item" :class="{ off: !it.enabled }">
          <input type="checkbox" :checked="it.enabled" aria-label="整理这条" @change="emit('update', setItemEnabled(plan, it.bookmarkId, checked($event)))" />
          <img v-if="faviconUrl(urlOf(it))" class="favicon" :src="faviconUrl(urlOf(it))" alt="" loading="lazy" />
          <span v-else class="favicon favicon-letter">{{ initialOf(finalTitle(it, it.base.title), urlOf(it)) }}</span>
          <div class="titles">
            <div>{{ finalTitle(it, it.base.title) }}</div>
            <div v-if="finalTitle(it, it.base.title) !== it.base.title" class="old">{{ it.base.title }}</div>
          </div>
          <select class="move" :class="{ always: isSpecial(g.key) }" :value="it.target" aria-label="放到" title="放到" @change="emit('update', setItemTarget(plan, it.bookmarkId, ($event.target as HTMLSelectElement).value))">
            <option v-for="t in targets" :key="t.key" :value="t.key">{{ t.label }}</option>
          </select>
          <div class="row-gap">
            <span v-if="reasonText[it.reason]" class="badge">{{ reasonText[it.reason] }}</span>
            <label v-if="it.ruleTitle" class="check small secondary">
              <input type="checkbox" :checked="it.useRuleTitle" @change="emit('update', setTitleChoice(plan, it.bookmarkId, { useRuleTitle: checked($event) }))" />清理标题
            </label>
            <label v-if="it.aiTitle" class="check small secondary">
              <input type="checkbox" :checked="it.useAiTitle" @change="emit('update', setTitleChoice(plan, it.bookmarkId, { useAiTitle: checked($event) }))" />AI 标题
            </label>
          </div>
        </div>
      </template>
    </details>
  </div>
</template>

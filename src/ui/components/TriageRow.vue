<script setup lang="ts">
// 待处理里的一条书签：点标题打开网页；「放到」选了就移过去（AI 猜的预选，点「放进去」确认）；「删除」直接删，结果条能撤销
import { computed } from 'vue'
import { cleanTitle } from '../../core/rules'
import type { TriageEntry } from '../../core/types'
import { faviconUrl, hostOf, initialOf } from '../format'
import { choices, moveTo, removeMarks, state } from '../state'

const props = defineProps<{ entry: TriageEntry; sub: string }>()

const NEW = '__new'
const b = computed(() => props.entry.bookmark)
const title = computed(() => cleanTitle(b.value.title) || hostOf(b.value.url))
const icon = computed(() => faviconUrl(b.value.url))
const initial = computed(() => props.entry.guess?.id ?? '')

function pick(e: Event) {
  const el = e.target as HTMLSelectElement
  const v = el.value
  // 下拉先回到原来的样子：选「新建文件夹…」时对话框里再定；移走了这一行也就没了
  el.value = initial.value
  if (v === NEW) state.moving = { ids: [b.value.id], newFolder: true }
  else void moveTo([b.value.id], { folderId: v }, choices.value.find((c) => c.id === v)!.path)
}
</script>

<template>
  <li class="tri-row">
    <img v-if="icon" class="favicon" :src="icon" alt="" loading="lazy" />
    <span v-else class="favicon favicon-letter">{{ initialOf(title, b.url) }}</span>
    <a class="tri-text" :href="b.url" target="_blank" rel="noopener" :title="b.title">
      <span class="tri-name">{{ title }}</span>
      <span class="tri-sub">{{ sub }}</span>
    </a>
    <select class="tri-move" :value="initial" aria-label="放到" :disabled="state.busy" @change="pick">
      <option v-if="!entry.guess" value="" disabled>放到…</option>
      <option v-for="c in choices" :key="c.id" :value="c.id">{{ c.id === entry.guess?.id ? `${c.path}（AI 猜的）` : c.path }}</option>
      <option :value="NEW">新建文件夹…</option>
    </select>
    <button v-if="entry.guess" class="btn btn-small" type="button" :disabled="state.busy" @click="moveTo([b.id], { folderId: entry.guess.id }, entry.guess.path)">放进去</button>
    <button class="link tri-del" type="button" :disabled="state.busy" @click="removeMarks([b.id])">删除</button>
  </li>
</template>

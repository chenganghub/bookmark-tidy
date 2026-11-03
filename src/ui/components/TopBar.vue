<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { saveSettings, state, toggleView, type Layout } from '../state'
import Icon from './Icon.vue'

const input = ref<HTMLInputElement>()

// / 或 Ctrl+K 聚焦搜索；正在输入时 / 不抢
function onKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement | null
  const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable)
  if ((e.key === '/' && !typing) || (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) {
    e.preventDefault()
    input.value?.focus()
    input.value?.select()
  }
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))

function setLayout(l: Layout) {
  state.layout = l
  void saveSettings({ view: l })
}
</script>

<template>
  <header class="topbar">
    <span class="app-name">书签整理</span>
    <div class="search">
      <Icon name="search" :size="14" />
      <input
        ref="input"
        v-model="state.query"
        type="search"
        placeholder="搜索"
        aria-label="搜索"
        @input="state.view = 'browse'"
        @keydown.esc="state.query = ''"
      />
    </div>
    <div class="segmented" role="group" aria-label="显示方式">
      <button type="button" :aria-pressed="state.layout === 'cards'" @click="setLayout('cards')">卡片</button>
      <button type="button" :aria-pressed="state.layout === 'list'" @click="setLayout('list')">列表</button>
    </div>
    <button class="btn" type="button" :aria-pressed="state.view === 'audit'" @click="toggleView('audit')">体检</button>
    <button class="btn btn-primary" type="button" :aria-pressed="state.view === 'organize'" @click="toggleView('organize')">整理</button>
    <button class="btn btn-icon" type="button" aria-label="设置" @click="state.settingsOpen = true">
      <Icon name="gear" />
    </button>
  </header>
</template>

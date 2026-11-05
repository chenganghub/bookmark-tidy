<script setup lang="ts">
// 原来的体检：只用规则的统计和清单。现在放在「待处理」底部的「全部检查项」里；抓取网页信息挪到了整理页
import { computed, ref } from 'vue'
import { roots, state } from '../state'
import EmptyState from './EmptyState.vue'

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
</script>

<template>
  <div>
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
  </div>
</template>

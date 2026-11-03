<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { FILTERS, filterCounts, filterText, folderTitle, state, visible, type FilterKey } from '../state'
import BookmarkCard from './BookmarkCard.vue'
import BookmarkRow from './BookmarkRow.vue'
import EmptyState from './EmptyState.vue'

// 先渲染一页，滚到底再加，400 条也流畅
const PAGE = 120
const limit = ref(PAGE)
const shown = computed(() => visible.value.slice(0, limit.value))
watch(
  () => [state.query, state.folderId, state.filters.join(), state.sort, state.layout],
  () => (limit.value = PAGE)
)

const sentinel = ref<HTMLElement>()
let io: IntersectionObserver | undefined
onMounted(() => {
  io = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting) && limit.value < visible.value.length) limit.value += PAGE
    },
    { rootMargin: '600px' }
  )
  if (sentinel.value) io.observe(sentinel.value)
})
onBeforeUnmount(() => io?.disconnect())

// 数量为 0 的筛选不显示（选中的除外）
const chips = computed(() => FILTERS.filter((f) => filterCounts.value[f] > 0 || state.filters.includes(f)))

function toggle(f: FilterKey) {
  state.filters = state.filters.includes(f) ? state.filters.filter((x) => x !== f) : [...state.filters, f]
}
</script>

<template>
  <section>
    <div class="view-head">
      <h1 class="view-title">{{ folderTitle }}</h1>
      <span class="view-count">{{ visible.length }}</span>
      <div class="view-tools">
        <button v-for="f in chips" :key="f" class="chip" type="button" :aria-pressed="state.filters.includes(f)" @click="toggle(f)">
          {{ filterText[f] }}<span class="n">{{ filterCounts[f] }}</span>
        </button>
        <select v-model="state.sort" aria-label="排序">
          <option value="added">添加时间</option>
          <option value="used">最近打开</option>
          <option value="title">标题</option>
        </select>
      </div>
    </div>
    <EmptyState v-if="!visible.length" icon="search" :text="state.query || state.filters.length ? '没有结果' : '没有书签'" />
    <div v-else-if="state.layout === 'cards'" class="grid">
      <BookmarkCard v-for="b in shown" :key="b.id" :b="b" />
    </div>
    <div v-else class="list">
      <BookmarkRow v-for="b in shown" :key="b.id" :b="b" />
    </div>
    <div ref="sentinel" style="height: 1px"></div>
  </section>
</template>

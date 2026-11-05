<script setup lang="ts">
import { computed } from 'vue'
import { cleanTitle } from '../../core/rules'
import type { FlatBookmark } from '../../core/types'
import { faviconUrl, hostOf, initialOf, yearMonth } from '../format'
import { badgeText, badgesOf, state } from '../state'
import CardOps from './CardOps.vue'

const props = defineProps<{ b: FlatBookmark }>()

const meta = computed(() => state.meta[props.b.id])
// 显示规则清理后的标题，原标题在悬停提示里
const title = computed(() => cleanTitle(props.b.title) || hostOf(props.b.url))
const icon = computed(() => faviconUrl(props.b.url))
const badges = computed(() => badgesOf(props.b))
</script>

<template>
  <div class="card-wrap">
    <a class="card" :href="b.url" target="_blank" rel="noopener" :title="b.title">
      <div class="card-body">
        <div class="card-head">
          <img v-if="icon" class="favicon" :src="icon" alt="" loading="lazy" />
          <span v-else class="favicon favicon-letter">{{ initialOf(title, b.url) }}</span>
          <span class="card-title">{{ title }}</span>
        </div>
        <p v-if="meta?.desc" class="card-desc">{{ meta.desc }}</p>
      </div>
      <div class="card-foot">
        <span class="meta">{{ hostOf(b.url) }}<template v-if="b.dateAdded"> · {{ yearMonth(b.dateAdded) }}</template></span>
        <span v-for="x in badges" :key="x" class="badge">{{ badgeText[x] }}</span>
      </div>
    </a>
    <CardOps :id="b.id" />
  </div>
</template>

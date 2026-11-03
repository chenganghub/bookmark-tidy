<script setup lang="ts">
import { computed } from 'vue'
import { cleanTitle } from '../../core/rules'
import type { FlatBookmark } from '../../core/types'
import { faviconUrl, hostOf, initialOf, yearMonth } from '../format'
import { badgeText, badgesOf, state } from '../state'
import Icon from './Icon.vue'

const props = defineProps<{ b: FlatBookmark }>()

const meta = computed(() => state.meta[props.b.id])
const title = computed(() => cleanTitle(props.b.title) || hostOf(props.b.url))
const icon = computed(() => faviconUrl(props.b.url))
const badges = computed(() => badgesOf(props.b))
</script>

<template>
  <div class="row-wrap">
    <a class="row" :href="b.url" target="_blank" rel="noopener" :title="b.title">
      <img v-if="icon" class="favicon" :src="icon" alt="" loading="lazy" />
      <span v-else class="favicon favicon-letter">{{ initialOf(title, b.url) }}</span>
      <span class="row-title">{{ title }}</span>
      <span class="row-desc">{{ meta?.desc }}</span>
      <span v-for="x in badges" :key="x" class="badge">{{ badgeText[x] }}</span>
      <span class="row-meta">{{ hostOf(b.url) }}<template v-if="b.dateAdded"> · {{ yearMonth(b.dateAdded) }}</template></span>
    </a>
    <button class="btn btn-icon card-edit" type="button" aria-label="编辑" @click="state.editingId = b.id">
      <Icon name="pencil" :size="14" />
    </button>
  </div>
</template>

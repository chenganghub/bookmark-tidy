<script setup lang="ts">
import { computed } from 'vue'
import { lockedIds, state, type SideFolder } from '../state'
import Icon from './Icon.vue'

const props = defineProps<{ item: SideFolder; depth: number }>()

const contains = (item: SideFolder, id: string): boolean => item.children.some((c) => c.folder.id === id || contains(c, id))
// 选中它或它的子孙时才展开子文件夹，平时保持一层
const open = computed(() => state.folderId === props.item.folder.id || contains(props.item, state.folderId))

function select() {
  state.folderId = props.item.folder.id
  state.view = 'browse'
}
</script>

<template>
  <button
    class="side-row"
    type="button"
    :style="{ paddingLeft: `${10 + depth * 16}px` }"
    :aria-current="state.view === 'browse' && state.folderId === item.folder.id"
    @click="select"
  >
    <Icon name="folder" />
    <span class="name">{{ item.folder.title }}</span>
    <span class="n">
      <Icon v-if="lockedIds.has(item.folder.id)" name="lock" :size="12" />
      {{ item.folder.totalBookmarks }}
    </span>
  </button>
  <template v-if="open">
    <SideItem v-for="c in item.children" :key="c.folder.id" :item="c" :depth="depth + 1" />
  </template>
</template>

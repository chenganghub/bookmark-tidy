<script setup lang="ts">
import { sideTree, state } from '../state'
import Icon from './Icon.vue'
import SideItem from './SideItem.vue'

function selectAll() {
  state.folderId = ''
  state.view = 'browse'
}
</script>

<template>
  <nav class="sidebar" aria-label="文件夹">
    <!-- 体检、整理视图里左栏不显示选中：内容区不是这个文件夹 -->
    <button class="side-row" type="button" :aria-current="state.view === 'browse' && state.folderId === ''" @click="selectAll">
      <Icon name="tray" />
      <span class="name">全部</span>
      <span class="n">{{ state.summary?.bookmarks }}</span>
    </button>
    <template v-for="g in sideTree" :key="g.title">
      <div class="side-group">{{ g.title }}</div>
      <SideItem v-for="item in g.items" :key="item.folder.id" :item="item" :depth="0" />
    </template>
  </nav>
</template>

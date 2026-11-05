<script setup lang="ts">
// 卡片和列表行悬停（或键盘聚焦）时出现的三个按钮：移动、删除（结果条能撤销）、编辑说明（bookmark-ux M1）
import { removeMarks, state } from '../state'
import Icon from './Icon.vue'

defineProps<{ id: string }>()
</script>

<template>
  <div class="card-ops">
    <button class="btn btn-icon btn-small" type="button" aria-label="移动" title="移动" :disabled="state.busy" @click="state.moving = { ids: [id], newFolder: false }">
      <Icon name="move" :size="14" />
    </button>
    <button class="btn btn-icon btn-small" type="button" aria-label="删除" title="删除" :disabled="state.busy" @click="removeMarks([id])">
      <Icon name="trash" :size="14" />
    </button>
    <button class="btn btn-icon btn-small card-edit" type="button" aria-label="编辑" title="编辑" @click="state.editingId = id">
      <Icon name="pencil" :size="14" />
    </button>
  </div>
</template>

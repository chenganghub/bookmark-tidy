<script setup lang="ts">
import Icon, { type IconName } from './Icon.vue'

defineProps<{ icon: IconName; text: string }>()
</script>

<template>
  <div class="empty" role="status">
    <Icon :name="icon" :size="32" />
    <span>{{ text }}</span>
  </div>
</template>

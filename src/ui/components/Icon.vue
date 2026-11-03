<script setup lang="ts">
// 线条图标：24 网格、1.5 描边、圆角端点（接近 SF Symbols 的观感），颜色跟随文字
export type IconName =
  | 'search'
  | 'folder'
  | 'lock'
  | 'gear'
  | 'pencil'
  | 'tray'
  | 'bookmark'
  | 'check'
  | 'close'
  | 'alert'
  | 'trash'
  | 'chevron'
  | 'eye'
  | 'minus'

defineProps<{ name: IconName; size?: number }>()

const paths: Record<IconName, string[]> = {
  search: ['M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M20.5 20.5l-5-5'],
  folder: ['M3.5 7.5A1.5 1.5 0 0 1 5 6h4.2l2 2H19a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z'],
  lock: ['M8 11V8a4 4 0 0 1 8 0v3', 'M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'
  ],
  pencil: ['M15.5 4.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z'],
  tray: ['M3.5 13l2.5-7h12l2.5 7', 'M3.5 13v5a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-5h-5l-1.5 2h-4L9 13z'],
  bookmark: ['M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z'],
  check: ['M5 12.5l4.5 4.5L19 7'],
  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  alert: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7.5v5.5', 'M12 16.5v.5'],
  trash: ['M4.5 7h15', 'M9.5 7V4.5h5V7', 'M6.5 7l1 13h9l1-13'],
  chevron: ['M9.5 6l6 6-6 6'],
  eye: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  minus: ['M6 12h12']
}
</script>

<template>
  <svg
    class="icon"
    :width="size ?? 16"
    :height="size ?? 16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="d in paths[name]" :key="d" :d="d" />
  </svg>
</template>

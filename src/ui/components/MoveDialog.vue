<script setup lang="ts">
// 移动到：书签栏下前两层的文件夹，或新建一个。卡片上的「移动」和待处理里的「新建文件夹…」共用
import { computed, nextTick, ref, watch } from 'vue'
import { choices, lockedIds, moveTo, NEW_FOLDER as NEW, roots, state } from '../state'

const dlg = ref<HTMLDialogElement>()
const nameInput = ref<HTMLInputElement>()
const target = ref('')
const name = ref('')
const parent = ref('')

const books = computed(() => (state.flat?.bookmarks ?? []).filter((b) => state.moving?.ids.includes(b.id)))
/** 新文件夹放在哪：书签栏，或书签栏下的顶层文件夹（不含锁定的） */
const parents = computed(() => {
  const bar = roots.value.bar
  if (!bar) return []
  const tops = (state.flat?.folders ?? []).filter((f) => f.parentId === bar.id && !lockedIds.value.has(f.id) && !f.unmodifiable)
  return [{ id: bar.id, title: bar.title }, ...tops.map((f) => ({ id: f.id, title: f.title }))]
})
const ready = computed(() => (target.value === NEW ? !!name.value.trim() && !!parent.value : !!target.value))

watch(
  () => state.moving,
  async (m) => {
    if (!m) {
      if (dlg.value?.open) dlg.value.close()
      return
    }
    // 默认选它现在所在的文件夹（在选项里的话）；不在选项里就空着，你自己选（不替你选第一个）；新建时直接到名称
    const current = books.value[0]?.parentId
    target.value = m.newFolder ? NEW : choices.value.some((c) => c.id === current) ? current! : ''
    name.value = ''
    parent.value = roots.value.bar?.id ?? ''
    await nextTick()
    dlg.value?.showModal()
    if (target.value === NEW) nameInput.value?.focus()
  }
)

async function submit() {
  const m = state.moving
  if (!m || !ready.value) return
  state.moving = null
  const title = name.value.trim()
  if (target.value === NEW) await moveTo(m.ids, { newFolder: { parentId: parent.value, title } }, title)
  // 对话框开着时书签树可能刷新过：找不到选项就用 id（workflow 里会再查锁定、文件夹还在不在）
  else await moveTo(m.ids, { folderId: target.value }, choices.value.find((c) => c.id === target.value)?.path ?? target.value)
}

/** 输入法正在选字时按的回车不提交 */
function onEnter(e: KeyboardEvent) {
  if (!e.isComposing) void submit()
}
</script>

<template>
  <dialog ref="dlg" aria-labelledby="move-title" @close="state.moving = null">
    <h2 id="move-title">移动到</h2>
    <p v-if="books.length === 1" class="secondary small">{{ books[0].title }}</p>
    <label class="field">
      <span>放到</span>
      <select v-model="target">
        <option value="" disabled>放到…</option>
        <option v-for="c in choices" :key="c.id" :value="c.id">{{ c.path }}</option>
        <option :value="NEW">新建文件夹…</option>
      </select>
    </label>
    <template v-if="target === NEW">
      <label class="field">
        <span>名称</span>
        <input ref="nameInput" v-model="name" type="text" maxlength="40" @keydown.enter="onEnter" />
      </label>
      <label class="field">
        <span>放在</span>
        <select v-model="parent">
          <option v-for="p in parents" :key="p.id" :value="p.id">{{ p.title }}</option>
        </select>
      </label>
    </template>
    <div class="actions">
      <button class="btn" type="button" @click="state.moving = null">取消</button>
      <button class="btn btn-primary" type="button" :disabled="!ready" @click="submit">移动</button>
    </div>
  </dialog>
</template>

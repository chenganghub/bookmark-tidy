<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { errorText } from '../format'
import { state, workflow } from '../state'

const dlg = ref<HTMLDialogElement>()
const desc = ref('')
const tags = ref('')
const error = ref('')
const b = computed(() => state.flat?.bookmarks.find((x) => x.id === state.editingId))

watch(
  () => state.editingId,
  async (id) => {
    if (!id) {
      if (dlg.value?.open) dlg.value.close()
      return
    }
    const m = state.meta[id]
    desc.value = m?.desc ?? ''
    tags.value = (m?.tags ?? []).join(' ')
    error.value = ''
    await nextTick()
    dlg.value?.showModal()
  }
)

async function save() {
  try {
    await workflow().saveManualMeta(state.editingId, {
      desc: desc.value.trim(),
      tags: tags.value
        .split(/[\s,，、]+/)
        .filter(Boolean)
        .slice(0, 5)
    })
    state.meta = await workflow().getMeta()
    state.editingId = ''
  } catch (e) {
    error.value = errorText(e)
  }
}
</script>

<template>
  <dialog ref="dlg" aria-labelledby="edit-title" @close="state.editingId = ''">
    <h2 id="edit-title">编辑</h2>
    <p class="secondary small">{{ b?.title }}</p>
    <label class="field">
      <span>说明</span>
      <textarea v-model="desc" rows="3" maxlength="80"></textarea>
    </label>
    <label class="field">
      <span>标签</span>
      <input v-model="tags" type="text" />
    </label>
    <p v-if="error" class="small secondary" style="margin-top: 12px">{{ error }}</p>
    <div class="actions">
      <button class="btn" type="button" @click="state.editingId = ''">取消</button>
      <button class="btn btn-primary" type="button" @click="save">保存</button>
    </div>
  </dialog>
</template>

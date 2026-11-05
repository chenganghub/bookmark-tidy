<script setup lang="ts">
import { computed, ref } from 'vue'
import { errorText } from '../format'
import { applyNotice, reload, revertManual, state, undoNotice, workflow } from '../state'
import Icon from './Icon.vue'

const running = ref(false)
const step = ref<[number, number]>([0, 0])
const showDetails = ref(false)

// 上次没做完的应用 / 撤销：打开页面时提示
const pending = computed(() => {
  const l = state.latest
  if (state.notice || !l) return undefined
  if (l.status === 'running' || l.status === 'failed') return { log: l, text: `上次应用未完成 ${l.done} / ${l.total}`, undoing: false }
  if (l.status === 'undoing') return { log: l, text: '上次撤销未完成', undoing: true }
  return undefined
})

async function run(fn: () => Promise<void>) {
  // 别处（整理页的应用、设置里的恢复）正在改书签时不接着做
  if (state.busy) return
  running.value = true
  state.busy = true
  showDetails.value = false
  try {
    await fn()
  } catch (e) {
    state.notice = { kind: 'error', text: errorText(e) }
  } finally {
    running.value = false
    state.busy = false
    await reload()
  }
}

const progress = (d: number, t: number) => (step.value = [d, t])
const undo = (applyId: string) => run(async () => void (state.notice = undoNotice(await workflow().undo(applyId, progress))))
const resume = (applyId: string) => run(async () => void (state.notice = applyNotice(await workflow().continueApply(applyId, progress))))
</script>

<template>
  <div v-if="running" class="bar" role="status">
    <progress :max="step[1] || 1" :value="step[0]"></progress>
    <span class="secondary">{{ step[0] }} / {{ step[1] }}</span>
  </div>
  <div v-else-if="pending" class="bar" role="status">
    <span class="grow">{{ pending.text }}</span>
    <template v-if="pending.undoing">
      <button class="link" type="button" @click="undo(pending.log.applyId)">继续撤销</button>
    </template>
    <template v-else>
      <button class="link" type="button" @click="undo(pending.log.applyId)">撤销</button>
      <button class="link" type="button" @click="resume(pending.log.applyId)">继续</button>
    </template>
  </div>
  <template v-else-if="state.notice">
    <div class="bar" role="status">
      <span class="grow">{{ state.notice.text }}</span>
      <button v-if="state.notice.details?.length" class="link" type="button" @click="showDetails = !showDetails">{{ showDetails ? '收起' : '详情' }}</button>
      <button v-if="state.notice.kind === 'applied' && state.notice.applyId" class="link" type="button" @click="undo(state.notice.applyId)">撤销</button>
      <button v-if="state.notice.kind === 'error' && state.notice.applyId" class="link" type="button" @click="undo(state.notice.applyId)">撤销</button>
      <button v-if="state.notice.kind === 'manual' && state.notice.change" class="link" type="button" :disabled="state.busy" @click="revertManual">撤销</button>
      <button class="btn btn-icon btn-small" type="button" aria-label="关闭" @click="state.notice = null"><Icon name="close" :size="14" /></button>
    </div>
    <div v-if="showDetails && state.notice.details?.length" class="list" style="margin: -8px 0 16px">
      <div v-for="(d, i) in state.notice.details" :key="i" class="row-wrap">
        <div class="row"><span class="row-desc">{{ d }}</span></div>
      </div>
    </div>
  </template>
</template>

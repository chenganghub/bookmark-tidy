<script setup lang="ts">
// 待处理（bookmark-ux）：扩展挪进「待整理」「待清理」「整理前的空文件夹」的，在这里一条条有出路。
// 每一类一行说明（≤ 24 字）；处理完的从列表里消失，结果条能撤销；三类都空时写「都处理完了」。底下收着原来的体检。
import { computed, ref } from 'vue'
import { HOLDING_NAME } from '../../core/plan'
import { batchRemovable } from '../../core/triage'
import type { TriageEntry } from '../../core/types'
import { cleanupReasonText, hostOf } from '../format'
import { removeEmpty, removeMarks, state } from '../state'
import AuditView from './AuditView.vue'
import EmptyState from './EmptyState.vue'
import Icon from './Icon.vue'
import TriageRow from './TriageRow.vue'

const unsure = computed(() => state.triage?.unsure ?? [])
const cleanup = computed(() => state.triage?.cleanup ?? [])
const empty = computed(() => state.triage?.empty ?? [])
const done = computed(() => !unsure.value.length && !cleanup.value.length && !empty.value.length)

/** 第二行：拿不准的写说明，建议删除的写原因；整理前的空文件夹里剩的写它在哪个旧目录；最后是域名 */
function sub(e: TriageEntry): string {
  const b = e.bookmark
  const parts = [e.reason ? cleanupReasonText(e.reason) : (state.meta[b.id]?.desc ?? '')]
  if (!e.reason && b.path[0] === HOLDING_NAME) parts.push(`在「${b.path.join(' / ')}」里`)
  parts.push(hostOf(b.url))
  return parts.filter(Boolean).join(' · ')
}

// 建议删除：批量只删原因还成立的（失效、重复、连不上），先确认、下载备份
const removable = computed(() => batchRemovable(cleanup.value))
const confirm = ref<HTMLDialogElement>()
async function removeAll() {
  confirm.value?.close()
  await removeMarks(
    removable.value.map((e) => e.bookmark.id),
    true
  )
}

// 空文件夹：一组一行，默认都勾着；off 是取消勾选的组
const off = ref(new Set<string>())
const chosen = computed(() => empty.value.filter((g) => !off.value.has(g.folder.id)))
const chosenCount = computed(() => chosen.value.reduce((s, g) => s + g.ids.length, 0))
const emptyCount = computed(() => empty.value.reduce((s, g) => s + g.ids.length, 0))
function toggleGroup(id: string, on: boolean) {
  const next = new Set(off.value)
  if (on) next.delete(id)
  else next.add(id)
  off.value = next
}
const groupSub = (path: string[], n: number) => [path.slice(0, -1).join(' / '), n > 1 ? `含 ${n - 1} 个子文件夹` : ''].filter(Boolean).join(' · ')
</script>

<template>
  <section>
    <div class="view-head">
      <h1 class="view-title">待处理</h1>
    </div>

    <EmptyState v-if="done" icon="check" text="都处理完了" />

    <section v-if="unsure.length" class="tri" aria-labelledby="tri-unsure">
      <div class="tri-head">
        <h2 id="tri-unsure" class="tri-title">拿不准放哪</h2>
        <span class="tri-n">{{ unsure.length }}</span>
      </div>
      <p class="tri-desc">AI 没把握放哪的，选个文件夹放进去，或者删掉</p>
      <ul class="tri-list">
        <TriageRow v-for="e in unsure" :key="e.bookmark.id" :entry="e" :sub="sub(e)" />
      </ul>
    </section>

    <section v-if="cleanup.length" class="tri" aria-labelledby="tri-cleanup">
      <div class="tri-head">
        <h2 id="tri-cleanup" class="tri-title">建议删除</h2>
        <span class="tri-n">{{ cleanup.length }}</span>
        <button v-if="removable.length" class="link tri-all" type="button" :disabled="state.busy" @click="confirm?.showModal()">删除这 {{ removable.length }} 条</button>
      </div>
      <p class="tri-desc">打不开的和重复的，删了能撤销</p>
      <ul class="tri-list">
        <TriageRow v-for="e in cleanup" :key="e.bookmark.id" :entry="e" :sub="sub(e)" />
      </ul>
    </section>

    <section v-if="empty.length" class="tri" aria-labelledby="tri-empty">
      <div class="tri-head">
        <h2 id="tri-empty" class="tri-title">空文件夹</h2>
        <span class="tri-n">{{ emptyCount }}</span>
        <button v-if="chosenCount" class="link tri-all" type="button" :disabled="state.busy" @click="removeEmpty(chosen.flatMap((g) => g.ids))">删除 {{ chosenCount }} 个空文件夹</button>
      </div>
      <p class="tri-desc">里面没有书签，删掉不影响任何书签</p>
      <details class="tri-more">
        <summary class="disclose"><Icon name="chevron" :size="14" />查看这 {{ emptyCount }} 个</summary>
        <ul class="tri-list">
          <li v-for="g in empty" :key="g.folder.id" class="tri-row">
            <label class="tri-check">
              <input type="checkbox" :checked="!off.has(g.folder.id)" @change="toggleGroup(g.folder.id, ($event.target as HTMLInputElement).checked)" />
              <span class="tri-text">
                <span class="tri-name">{{ g.folder.title }}</span>
                <span class="tri-sub">{{ groupSub(g.folder.path, g.ids.length) }}</span>
              </span>
            </label>
          </li>
        </ul>
      </details>
    </section>

    <details class="tri-audit">
      <summary class="disclose"><Icon name="chevron" :size="14" />全部检查项</summary>
      <AuditView />
    </details>

    <dialog ref="confirm" aria-labelledby="tri-confirm-title">
      <h2 id="tri-confirm-title">删除这 {{ removable.length }} 条书签？</h2>
      <p class="secondary">会先下载备份，能撤销。</p>
      <div class="actions">
        <button class="btn" type="button" @click="confirm?.close()">取消</button>
        <!-- 默认按钮：回车删除，Esc 取消（先下载备份，能撤销） -->
        <button class="btn btn-primary" type="button" autofocus @click="removeAll">删除</button>
      </div>
    </dialog>
  </section>
</template>

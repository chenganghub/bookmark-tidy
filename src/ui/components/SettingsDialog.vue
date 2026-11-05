<script setup lang="ts">
import { nextTick, reactive, ref, watch } from 'vue'
import { normalizeDomain } from '../../core/sites'
import type { Settings } from '../../core/types'
import { errorText } from '../format'
import { reload, restoreNotice, saveSettings, state, workflow } from '../state'
import Icon from './Icon.vue'

const dlg = ref<HTMLDialogElement>()
const confirmDlg = ref<HTMLDialogElement>()
const fileInput = ref<HTMLInputElement>()
const form = reactive({
  baseUrl: '',
  model: '',
  apiKey: '',
  disableThinking: true,
  theme: 'auto' as Settings['theme'],
  view: 'cards' as Settings['view'],
  // 二期：收藏时自动整理
  autoFile: true,
  autoNotify: true,
  textDomains: '',
  privateDomains: '',
  // bookmark-ux：工具栏图标上的数字
  badge: true
})
const showKey = ref(false)
const test = ref('')
const testing = ref(false)
const backup = ref('')
const error = ref('')

/** 文本框里一行一个域名；逗号、分号、顿号分隔的也认，粘贴来的网址只留主机名，去重 */
const lines = (s: string) => [
  ...new Set(
    s
      .split(/[\n,，;；、\s]+/)
      .map(normalizeDomain)
      .filter(Boolean)
  )
]

watch(
  () => state.settingsOpen,
  async (open) => {
    if (!open) {
      if (dlg.value?.open) dlg.value.close()
      return
    }
    const s = state.settings!
    Object.assign(form, {
      ...s.ai,
      theme: s.theme,
      view: s.view,
      autoFile: s.autoFile,
      autoNotify: s.autoNotify,
      textDomains: s.textDomains.join('\n'),
      privateDomains: s.privateDomains.join('\n'),
      badge: s.badge
    })
    test.value = ''
    error.value = ''
    showKey.value = false
    await nextTick()
    if (!dlg.value?.open) dlg.value?.showModal()
  },
  // 对话框在页面加载完才挂上：加载期间就点了「设置」的，挂上时直接打开
  { immediate: true }
)

async function persist() {
  await saveSettings({
    ai: { baseUrl: form.baseUrl.trim(), model: form.model.trim(), apiKey: form.apiKey.trim(), disableThinking: form.disableThinking },
    theme: form.theme,
    view: form.view,
    autoFile: form.autoFile,
    autoNotify: form.autoNotify,
    textDomains: lines(form.textDomains),
    privateDomains: lines(form.privateDomains),
    badge: form.badge
  })
  state.layout = form.view
  // 换成别家的接口时，申请它的网址权限（DeepSeek 已在必需权限里）
  try {
    if (new URL(form.baseUrl).hostname !== 'api.deepseek.com') await workflow().ensureSitePermission()
  } catch {
    // 地址不合法时留给测试连接报错
  }
}

async function testNow() {
  testing.value = true
  test.value = ''
  try {
    await persist()
    test.value = (await workflow().testAi()).message
  } catch (e) {
    test.value = errorText(e)
  } finally {
    testing.value = false
  }
}

async function done() {
  await persist()
  state.settingsOpen = false
}

async function pickBackup(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  // 应用或撤销进行中不能同时恢复：两边都在改书签
  if (!file || state.busy) return
  backup.value = await file.text()
  confirmDlg.value?.showModal()
}

async function restore() {
  confirmDlg.value?.close()
  if (state.busy) return
  error.value = ''
  state.busy = true
  state.notice = null
  try {
    const r = await workflow().restoreFromBackup(backup.value, () => {})
    state.notice = restoreNotice(r)
    state.settingsOpen = false
  } catch (e) {
    error.value = errorText(e)
  } finally {
    state.busy = false
    backup.value = ''
    await reload()
  }
}
</script>

<template>
  <!-- 初始焦点：没填 key 时在 key 输入框，否则在「完成」上（回车即完成，Esc 取消） -->
  <dialog ref="dlg" aria-labelledby="settings-title" @close="state.settingsOpen = false">
    <h2 id="settings-title">设置</h2>
    <label class="field">
      <span>接口地址</span>
      <input v-model="form.baseUrl" type="url" spellcheck="false" />
    </label>
    <label class="field">
      <span>模型</span>
      <input v-model="form.model" type="text" spellcheck="false" />
    </label>
    <label class="check" style="margin-top: 10px">
      <input type="checkbox" :checked="!form.disableThinking" @change="form.disableThinking = !($event.target as HTMLInputElement).checked" />思考模式
    </label>
    <div class="field">
      <label for="api-key">API key</label>
      <div class="input-wrap">
        <input id="api-key" v-model="form.apiKey" :type="showKey ? 'text' : 'password'" :autofocus="!form.apiKey" autocomplete="off" spellcheck="false" />
        <button class="btn btn-icon btn-small" type="button" :aria-label="showKey ? '隐藏' : '显示'" :aria-pressed="showKey" @click="showKey = !showKey"><Icon name="eye" :size="14" /></button>
      </div>
    </div>
    <div class="row-gap" style="margin-top: 10px">
      <button class="btn btn-small" type="button" :disabled="testing || !form.apiKey.trim()" @click="testNow">测试连接</button>
      <span v-if="test" class="secondary small" role="status">{{ test }}</span>
    </div>
    <div class="row-gap" style="margin-top: 24px; gap: 16px">
      <label class="check"><input v-model="form.autoFile" type="checkbox" />收藏时自动整理</label>
      <label class="check"><input v-model="form.autoNotify" type="checkbox" :disabled="!form.autoFile" />通知</label>
      <label class="check"><input v-model="form.badge" type="checkbox" />工具栏角标</label>
    </div>
    <label class="field">
      <span>发正文的网站</span>
      <textarea v-model="form.textDomains" rows="3" spellcheck="false" :disabled="!form.autoFile"></textarea>
    </label>
    <label class="field">
      <span>不读正文的网站</span>
      <textarea v-model="form.privateDomains" rows="3" spellcheck="false"></textarea>
    </label>
    <div class="row-gap" style="margin-top: 24px; gap: 16px">
      <label class="check">
        主题
        <select v-model="form.theme">
          <option value="auto">跟随系统</option>
          <option value="light">浅色</option>
          <option value="dark">深色</option>
        </select>
      </label>
      <label class="check">
        默认视图
        <select v-model="form.view">
          <option value="cards">卡片</option>
          <option value="list">列表</option>
        </select>
      </label>
    </div>
    <p v-if="error" class="secondary small" style="margin-top: 12px">{{ error }}</p>
    <div class="actions">
      <button class="btn" type="button" style="margin-right: auto" :disabled="state.busy" @click="fileInput?.click()">从备份恢复</button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="pickBackup" />
      <button class="btn btn-primary" type="button" :autofocus="!!form.apiKey" @click="done">完成</button>
    </div>
  </dialog>

  <dialog ref="confirmDlg" aria-labelledby="restore-title">
    <h2 id="restore-title">从备份恢复？</h2>
    <p class="secondary">书签会回到备份时的样子。</p>
    <div class="actions">
      <button class="btn" type="button" @click="confirmDlg?.close()">取消</button>
      <button class="btn btn-primary" type="button" @click="restore">恢复</button>
    </div>
  </dialog>
</template>

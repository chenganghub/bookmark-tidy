<script setup lang="ts">
import { onMounted } from 'vue'
import AuditView from '../../src/ui/components/AuditView.vue'
import BrowseView from '../../src/ui/components/BrowseView.vue'
import EditDialog from '../../src/ui/components/EditDialog.vue'
import EmptyState from '../../src/ui/components/EmptyState.vue'
import OrganizeView from '../../src/ui/components/OrganizeView.vue'
import SettingsDialog from '../../src/ui/components/SettingsDialog.vue'
import Sidebar from '../../src/ui/components/Sidebar.vue'
import StatusBar from '../../src/ui/components/StatusBar.vue'
import TopBar from '../../src/ui/components/TopBar.vue'
import { init, state } from '../../src/ui/state'

onMounted(init)
</script>

<template>
  <TopBar />
  <Sidebar />
  <main class="content">
    <div v-if="!state.ready" class="center"><span class="spinner" role="status" aria-label="加载中"></span></div>
    <EmptyState v-else-if="state.error" icon="alert" :text="state.error" />
    <template v-else>
      <StatusBar />
      <BrowseView v-if="state.view === 'browse'" />
      <AuditView v-else-if="state.view === 'audit'" />
      <OrganizeView v-else />
    </template>
  </main>
  <template v-if="state.ready && !state.error">
    <SettingsDialog />
    <EditDialog />
  </template>
</template>

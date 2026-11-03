// 内存版 ApplyStore。存取都深拷贝，模拟 chrome.storage 的序列化：代码改了对象不存就不算数。
import type { ApplyLog, ApplyStore, Snapshot } from '../../src/core/types'

export function createMemoryStore(): ApplyStore & { saveLogCalls(): number; logs(): ApplyLog[] } {
  const snapshots = new Map<string, Snapshot>()
  const logs = new Map<string, ApplyLog>()
  let latest: string | undefined
  let saveLogCount = 0
  return {
    async saveSnapshot(s) {
      snapshots.set(s.id, structuredClone(s))
    },
    async getSnapshot(id) {
      const s = snapshots.get(id)
      return s && structuredClone(s)
    },
    async saveLog(log) {
      saveLogCount++
      logs.set(log.applyId, structuredClone(log))
      latest = log.applyId
    },
    async getLog(id) {
      const l = logs.get(id)
      return l && structuredClone(l)
    },
    async getLatestLog() {
      return latest ? structuredClone(logs.get(latest)) : undefined
    },
    saveLogCalls: () => saveLogCount,
    logs: () => [...logs.values()].map((l) => structuredClone(l))
  }
}

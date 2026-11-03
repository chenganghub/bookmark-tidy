// 改书签的锁（二期）：一期的应用、撤销、从备份恢复，和二期的自动整理、一键整理，同一时刻只有一个在改书签。
// 浏览器里用 Web Locks（navigator.locks）：同一扩展的页面和后台共用一把，持有的页面关掉或崩溃时自动释放。
// 没有 navigator.locks（node 单测）时退回进程内的互斥。
import type { KV } from './types'

export type MutationOp = 'apply' | 'undo' | 'restore' | 'auto' | 'button'

export const LOCK_NAME = 'bt-bookmarks'
/** 会话存储里记着当前持锁的操作（看板、弹窗显示用；真正的互斥靠锁本身） */
export const OP_KEY = 'bt:op'

/** navigator.locks 用到的子集 */
export interface LockManagerLike {
  request<T>(name: string, options: { mode: 'exclusive' }, callback: () => Promise<T>): Promise<T>
}

export interface MutationLock {
  run<T>(op: MutationOp, fn: () => Promise<T>): Promise<T>
}

export function createMutationLock(deps: { locks?: LockManagerLike; session?: KV; now?: () => number } = {}): MutationLock {
  const now = deps.now ?? Date.now
  let chain: Promise<unknown> = Promise.resolve()
  const local = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn)
    chain = next.catch(() => {})
    return next
  }
  return {
    run<T>(op: MutationOp, fn: () => Promise<T>) {
      const body = async () => {
        await deps.session?.set({ [OP_KEY]: { op, since: now() } }).catch(() => {})
        try {
          return await fn()
        } finally {
          await deps.session?.remove(OP_KEY).catch(() => {})
        }
      }
      return deps.locks ? deps.locks.request(LOCK_NAME, { mode: 'exclusive' }, body) : local(body)
    }
  }
}

/** 浏览器里的默认依赖：有 navigator.locks 就用 */
export function browserLocks(): LockManagerLike | undefined {
  const nav = (globalThis as { navigator?: { locks?: LockManagerLike } }).navigator
  return nav?.locks
}

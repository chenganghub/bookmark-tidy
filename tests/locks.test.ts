import { describe, expect, it } from 'vitest'
import { browserLocks, createMutationLock, OP_KEY } from '../src/core/locks'
import { memoryKV } from '../src/core/store'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('改书签的锁', () => {
  for (const [name, locks] of [
    ['进程内互斥', undefined],
    ['Web Locks', browserLocks()]
  ] as const) {
    it(`${name}：同一时刻只有一个在跑，按到达顺序；会话存储里记着当前操作，跑完清掉`, async () => {
      const session = memoryKV()
      const lock = createMutationLock({ locks, session, now: () => 5 })
      const log: string[] = []
      const job = (n: string, ms: number) =>
        lock.run(n === 'a' ? 'undo' : 'auto', async () => {
          log.push(`${n}+`)
          if (n === 'a') expect((await session.get(OP_KEY))[OP_KEY]).toEqual({ op: 'undo', since: 5 })
          await sleep(ms)
          log.push(`${n}-`)
          return n
        })
      const r = await Promise.all([job('a', 30), job('b', 1), job('c', 1)])
      expect(r).toEqual(['a', 'b', 'c'])
      expect(log).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-'])
      expect((await session.get(OP_KEY))[OP_KEY]).toBeUndefined()
    })

    it(`${name}：里面抛错也会放锁`, async () => {
      const lock = createMutationLock({ locks })
      await expect(lock.run('apply', async () => Promise.reject(new Error('坏了')))).rejects.toThrow('坏了')
      expect(await lock.run('auto', async () => 'ok')).toBe('ok')
    })
  }
})

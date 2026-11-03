import { describe, expect, it } from 'vitest'
import { EMPTY_USAGE } from '../src/core/ai'
import { runClassify, runDescribe, runSplit, runTaxonomy } from '../src/core/pipeline'
import type { ChatJsonFn, ChatMessage, DescribeInput, StageProgress } from '../src/core/types'

const usage = { requests: 1, promptTokens: 100, completionTokens: 20, cacheHitTokens: 0, cacheMissTokens: 0 }
const inputs = (n: number): DescribeInput[] => Array.from({ length: n }, (_, i) => ({ id: `b${i}`, title: `标题${i}`, url: 'example.com', desc: '', path: '' }))

/** 从 user 消息里取回这批的 id（每行第一个字段） */
const idsOf = (messages: ChatMessage[]) =>
  messages[1].content
    .split('\n')
    .slice(1)
    .map((line) => line.split(' | ')[0])

const describeReply = (ids: string[]) => ({ items: ids.map((id) => ({ id, desc: `说明${id}`, title: `t${id}`, tags: ['x'], type: '文章' })) })

describe('runDescribe', () => {
  it('421 条切成 11 批，并发不超过 2，每批成功就回调', async () => {
    let active = 0
    let peak = 0
    let calls = 0
    const chat: ChatJsonFn = async (messages) => {
      calls++
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 1))
      active--
      return { data: describeReply(idsOf(messages)), usage }
    }
    const batches: number[] = []
    const progress: StageProgress[] = []
    const r = await runDescribe(inputs(421), chat, { onBatch: (outs) => void batches.push(outs.length), onProgress: (p) => progress.push(p) })
    expect(calls).toBe(11)
    expect(peak).toBe(2)
    expect(batches.reduce((a, b) => a + b, 0)).toBe(421)
    expect(r.results).toHaveLength(421)
    expect(r.failedIds).toEqual([])
    expect(r.usage.requests).toBe(11)
    expect(progress.at(-1)).toMatchObject({ stage: 'describe', totalBatches: 11, doneBatches: 11, failedBatches: 0 })
  })

  it('一批先失败、重试成功', async () => {
    let n = 0
    const chat: ChatJsonFn = async (messages) => {
      if (n++ === 0) throw new Error('网络抖了一下')
      return { data: describeReply(idsOf(messages)), usage }
    }
    const r = await runDescribe(inputs(10), chat)
    expect(r.results).toHaveLength(10)
    expect(n).toBe(2)
  })

  it('缺得多就重试；少量缺的进 failedIds', async () => {
    let n = 0
    const chat: ChatJsonFn = async (messages) => {
      const ids = idsOf(messages)
      n++
      // 第一次只回一半（缺 50%），第二次只缺 1 条
      return { data: describeReply(n === 1 ? ids.slice(0, 5) : ids.slice(1)), usage }
    }
    const r = await runDescribe(inputs(10), chat)
    expect(n).toBe(2)
    expect(r.results).toHaveLength(9)
    expect(r.failedIds).toEqual(['b0'])
  })

  it('重试后还失败：整批进 failedIds，不影响其他批', async () => {
    const chat: ChatJsonFn = async (messages) => {
      const ids = idsOf(messages)
      if (ids.includes('b0')) throw new Error('这批总失败')
      return { data: describeReply(ids), usage }
    }
    const progress: StageProgress[] = []
    const r = await runDescribe(inputs(50), chat, { batchSize: 20, onProgress: (p) => progress.push(p) })
    expect(r.failedIds).toHaveLength(20)
    expect(r.results).toHaveLength(30)
    expect(progress.at(-1)).toMatchObject({ doneBatches: 3, failedBatches: 1 })
  })

  it('中止后不再发新批次', async () => {
    const ctrl = new AbortController()
    let calls = 0
    const chat: ChatJsonFn = async (messages) => {
      calls++
      if (calls === 1) ctrl.abort()
      return { data: describeReply(idsOf(messages)), usage }
    }
    await runDescribe(inputs(200), chat, { batchSize: 20, concurrency: 1, signal: ctrl.signal })
    expect(calls).toBe(1)
  })
})

describe('runTaxonomy', () => {
  const items = [{ type: '文章' as const, tags: ['Vue'], desc: '讲 Vue', path: 'vue' }]
  const opts = { maxTop: 8, existingFolders: [], lockedFolders: [], emoji: false }

  it('成功返回目录', async () => {
    const chat: ChatJsonFn = async () => ({ data: { folders: [{ name: 'Vue', desc: 'Vue 相关' }] }, usage })
    const r = await runTaxonomy(items, chat, opts)
    expect(r.folders).toEqual([{ name: 'Vue', desc: 'Vue 相关' }])
    expect(r.usage.requests).toBe(1)
  })

  it('第一次没给目录，第二次成功', async () => {
    let n = 0
    const chat: ChatJsonFn = async () => ({ data: n++ === 0 ? { folders: [] } : { folders: [{ name: 'A', desc: '' }] }, usage })
    expect((await runTaxonomy(items, chat, opts)).folders).toHaveLength(1)
  })

  it('两次都失败就抛错', async () => {
    const chat: ChatJsonFn = async () => {
      throw new Error('接口挂了')
    }
    await expect(runTaxonomy(items, chat, opts)).rejects.toThrow('接口挂了')
  })
})

describe('runClassify', () => {
  it('按 80 条一批，结果合并', async () => {
    const items = Array.from({ length: 170 }, (_, i) => ({ id: `b${i}`, title: 't', desc: 'd', tags: [], type: '文章' as const }))
    let calls = 0
    const chat: ChatJsonFn = async (messages) => {
      calls++
      return { data: { items: idsOf(messages).map((id) => ({ id, path: 'A', confidence: 0.9 })) }, usage: EMPTY_USAGE }
    }
    const r = await runClassify(items, ['A', 'B/b'], chat)
    expect(calls).toBe(3)
    expect(r.results).toHaveLength(170)
    expect(r.results.every((x) => x.path === 'A')).toBe(true)
  })
})

describe('runSplit', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, title: `标题${i}`, desc: '', tags: [] }))
  const opts = { taken: ['前端'], lockedFolders: ['受保护资料'] }
  const good = { folders: [{ name: 'A', desc: '' }, { name: 'B', desc: '' }], items: items.map((x, i) => ({ id: x.id, folder: i % 2 ? 'B' : 'A' })) }

  it('成功：目录和每条的归属', async () => {
    const chat: ChatJsonFn = async () => ({ data: good, usage })
    const r = await runSplit('前端/JS', items, chat, opts)
    expect(r.folders.map((f) => f.name)).toEqual(['A', 'B'])
    expect(r.assign).toEqual({ b0: 'A', b1: 'B', b2: 'A', b3: 'B', b4: 'A', b5: 'B' })
    expect(r.usage.requests).toBe(1)
  })

  it('第一次只给了一个目录（等于没拆），重试一次', async () => {
    let n = 0
    const chat: ChatJsonFn = async () => ({ data: n++ === 0 ? { folders: [{ name: 'A' }], items: [] } : good, usage })
    const r = await runSplit('前端/JS', items, chat, opts)
    expect(r.folders).toHaveLength(2)
    expect(r.usage.requests).toBe(2)
  })

  it('模型写了「父/子」或名字里带半角斜杠：都认得出', async () => {
    const data = {
      folders: [{ name: 'UI/UX', desc: '' }, { name: 'B', desc: '' }],
      items: items.map((x, i) => ({ id: x.id, folder: i % 2 ? '前端/B' : 'UI/UX' }))
    }
    const r = await runSplit('前端/JS', items, async () => ({ data, usage }), opts)
    expect(r.folders.map((f) => f.name)).toEqual(['UI／UX', 'B'])
    expect(Object.values(r.assign)).toEqual(['UI／UX', 'B', 'UI／UX', 'B', 'UI／UX', 'B'])
  })

  it('两次都不理想：取缺得少的那次', async () => {
    let n = 0
    const half = { ...good, items: good.items.slice(0, 3) } // 缺 3 条（50%）
    const chat: ChatJsonFn = async () => ({ data: n++ === 0 ? half : { folders: [{ name: 'A' }], items: [] }, usage })
    const r = await runSplit('前端/JS', items, chat, opts)
    expect(Object.keys(r.assign)).toEqual(['b0', 'b1', 'b2'])
    expect(r.usage.requests).toBe(2)
  })

  it('中止后不再重试', async () => {
    const ctrl = new AbortController()
    let calls = 0
    const chat: ChatJsonFn = async () => {
      calls++
      ctrl.abort()
      throw new Error('已取消')
    }
    expect(await runSplit('前端/JS', items, chat, { ...opts, signal: ctrl.signal })).toMatchObject({ folders: [] })
    expect(calls).toBe(1)
  })

  it('两次都不行：不抛错，返回空目录（调用方保留原目录）', async () => {
    const chat: ChatJsonFn = async () => {
      throw new Error('接口挂了')
    }
    expect(await runSplit('前端/JS', items, chat, opts)).toMatchObject({ folders: [], assign: {} })
  })
})

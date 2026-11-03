import { describe, expect, it } from 'vitest'
import { createStore, DEFAULT_SETTINGS, MAX_SNAPSHOTS, memoryKV } from '../src/core/store'
import type { ApplyLog } from '../src/core/types'

const log = (applyId: string, status: ApplyLog['status'] = 'running'): ApplyLog => ({
  applyId,
  planId: 'p',
  snapshotId: 's',
  status,
  startedAt: 0,
  updatedAt: 0,
  total: 1,
  done: 0,
  createdFolders: {},
  undoIdMap: {}
})

describe('store', () => {
  it('设置：没存过返回默认值；ai 深合并', async () => {
    const kv = memoryKV()
    const store = createStore(kv)
    expect(await store.getSettings()).toEqual(DEFAULT_SETTINGS)
    await store.saveSettings({ ai: { apiKey: 'k' } as never, maxTop: 6 })
    const s = await store.getSettings()
    expect(s.ai).toEqual({ ...DEFAULT_SETTINGS.ai, apiKey: 'k' })
    expect(s.maxTop).toBe(6)
    expect(s.defaultLockedNames).toEqual(['受保护资料'])
    expect(kv.data.has('settings')).toBe(true)
  })

  it('设置只存改过的键：没改过的（如不在界面里的 autoThreshold）每次读都取代码默认值', async () => {
    const kv = memoryKV()
    const store = createStore(kv)
    const back = await store.saveSettings({ ai: { apiKey: 'k' } as never, autoFile: false })
    expect(back.autoThreshold).toBe(DEFAULT_SETTINGS.autoThreshold)
    expect(kv.data.get('settings')).toEqual({ ai: { apiKey: 'k' }, autoFile: false })
    await store.saveSettings({ ai: { model: 'm' } as never })
    expect(kv.data.get('settings')).toEqual({ ai: { apiKey: 'k', model: 'm' }, autoFile: false })
    expect((await store.getSettings()).ai).toEqual({ ...DEFAULT_SETTINGS.ai, apiKey: 'k', model: 'm' })
    await store.saveSettings({ autoThreshold: 0.9 })
    expect((await store.getSettings()).autoThreshold).toBe(0.9)
  })

  it('计数同时加不丢（后台里两个 store 共用一个存储对象）', async () => {
    const kv = memoryKV()
    const a = createStore(kv)
    const b = createStore(kv)
    await Promise.all([a.bumpStats({ filed: 1 }), b.bumpStats({ movedAgain: 1 }), a.bumpStats({ filed: 1 }), b.bumpStats({ omnibox: 1 })])
    expect(await a.getStats()).toMatchObject({ filed: 2, movedAgain: 1, omnibox: 1 })
  })

  it('网页信息按网址、说明按书签 id 分键存', async () => {
    const kv = memoryKV()
    const store = createStore(kv)
    await store.savePageInfo({ url: 'https://a.com', status: 'ok', fetchedAt: 1 })
    await store.saveMeta({ '12': { desc: 'd', title: 't', tags: [], type: '文章', updatedAt: 1 } })
    expect([...kv.data.keys()].sort()).toEqual(['meta:12', 'page:https://a.com'])
    expect(Object.keys(await store.getPageInfos())).toEqual(['https://a.com'])
    expect((await store.getMeta())['12'].desc).toBe('d')
  })

  it(`快照最多留 ${MAX_SNAPSHOTS} 份，存新的删最旧的`, async () => {
    const kv = memoryKV()
    const store = createStore(kv)
    for (let i = 1; i <= MAX_SNAPSHOTS + 1; i++) await store.saveSnapshot({ id: `s${i}`, createdAt: i, nodes: [] })
    expect(await store.getSnapshot('s1')).toBeUndefined()
    expect((await store.getSnapshot(`s${MAX_SNAPSHOTS + 1}`))?.createdAt).toBe(MAX_SNAPSHOTS + 1)
    expect([...kv.data.keys()].filter((k) => k.startsWith('snapshot:'))).toHaveLength(MAX_SNAPSHOTS)
  })

  it('应用日志：按 id 取，latest 指向最近存的', async () => {
    const store = createStore(memoryKV())
    expect(await store.getLatestLog()).toBeUndefined()
    await store.saveLog(log('a1'))
    await store.saveLog(log('a2', 'done'))
    expect((await store.getLatestLog())?.applyId).toBe('a2')
    expect((await store.getLog('a1'))?.status).toBe('running')
  })

  it('取出来的是拷贝，改了不影响存储', async () => {
    const store = createStore(memoryKV())
    await store.saveLog(log('a1'))
    const l = (await store.getLog('a1'))!
    l.done = 99
    expect((await store.getLog('a1'))!.done).toBe(0)
  })
})

describe('store：二期的自动整理数据', () => {
  const DAY = 86400000
  const rec = (id: string, at: number) => ({
    bookmarkId: id,
    at,
    source: 'save' as const,
    from: { parentId: '2', index: 0, title: 't' },
    to: { parentId: 'F', title: 't' },
    path: 'p',
    confidence: 0.9,
    status: 'filed' as const
  })

  it('新设置有默认值', async () => {
    const s = await createStore(memoryKV({ settings: { maxTop: 6 } })).getSettings()
    expect(s.maxTop).toBe(6)
    expect(s.autoFile).toBe(true)
    expect(s.textDomains).toContain('blog.csdn.net')
    expect(s.privateDomains).toContain('feishu.cn')
  })

  it('记录：存的时候删掉 30 天前的', async () => {
    const store = createStore(memoryKV())
    const now = 100 * DAY
    await store.saveRecord(rec('old', now - 31 * DAY), now)
    await store.saveRecord(rec('new', now - DAY), now)
    expect(Object.keys(await store.getRecords())).toEqual(['new'])
    expect((await store.getRecord('new'))?.status).toBe('filed')
  })

  it('计数累加；重建 id 去重、先进先出', async () => {
    const store = createStore(memoryKV())
    await store.bumpStats({ filed: 1 })
    expect(await store.bumpStats({ filed: 2, undone: 1 })).toMatchObject({ filed: 3, undone: 1, omnibox: 0 })
    await store.addOwn(['1', '2'])
    await store.addOwn(['2', '3'])
    expect(await store.getOwn()).toEqual(['1', '2', '3'])
  })

  it('正文：删掉书签已不在的', async () => {
    const store = createStore(memoryKV())
    await store.saveText('a', { url: 'u', text: 't', savedAt: 1 })
    await store.saveText('b', { url: 'u', text: 't', savedAt: 2 })
    expect(await store.pruneTexts(new Set(['b']))).toBe(1)
    expect(await store.getText('a')).toBeUndefined()
    expect((await store.getText('b'))?.text).toBe('t')
  })
})

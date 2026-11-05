import { describe, expect, it } from 'vitest'
import { EMPTY_USAGE } from '../src/core/ai'
import { CLEANUP } from '../src/core/plan'
import { parseBackup, treeFingerprint } from '../src/core/snapshot'
import { memoryKV } from '../src/core/store'
import type { ChatJsonFn, ChatMessage, PlanOptions } from '../src/core/types'
import { createWorkflow } from '../src/core/workflow'
import { createFakeBookmarks, folder, link, treeOf } from '../src/core/memory-bookmarks'
import { createMutationLock, type MutationLock } from '../src/core/locks'
import { createStore } from '../src/core/store'

const sampleTree = () =>
  treeOf(
    [
      folder('vue 资料', [0, 1, 2, 3].map((i) => link(`Vue ${i} - 知乎`, `https://zhuanlan.zhihu.com/p/${i}?utm_source=x&token=SECRET`, {}, `v${i}`)), 'FV'),
      folder('受保护资料', [link('公司文档', 'https://x.feishu.cn/docx/1', {}, 'w1')], 'LOCK'),
      link('散放', 'https://loose.com', {}, 'loose')
    ],
    [link('其他', 'https://other.com', {}, 'o1'), link('其他 2', 'https://other.com/2', {}, 'o2'), link('其他 3', 'https://other.com/3', {}, 'o3')],
    [link('手机上的', 'https://m.com', {}, 'm1')]
  )

/** 按 system 提示词分辨是哪一段，回假结果，并把收到的 user 消息记下来 */
function fakeChat() {
  const seen: { stage: string; user: string }[] = []
  const chat: ChatJsonFn = async (messages: ChatMessage[]) => {
    const sys = messages[0].content
    const user = messages[1].content
    const ids = user
      .split('\n')
      .slice(1)
      .map((l) => l.split(' | ')[0])
    if (sys.includes('desc：一句话说明')) {
      seen.push({ stage: 'describe', user })
      return { data: { items: ids.map((id) => ({ id, desc: `说明${id}`, title: `标题${id}`, tags: ['t'], type: '文章' })) }, usage: { ...EMPTY_USAGE, requests: 1, promptTokens: 100 } }
    }
    if (sys.includes('重新设计')) {
      seen.push({ stage: 'taxonomy', user })
      return { data: { folders: [{ name: 'Vue', desc: 'vue' }, { name: '杂项', desc: '其他' }] }, usage: { ...EMPTY_USAGE, requests: 1 } }
    }
    if (sys.includes('更细的目录')) {
      seen.push({ stage: 'split', user })
      const folders = [{ name: 'Vue 基础', desc: '基础' }, { name: 'Vue 进阶', desc: '进阶' }]
      return { data: { folders, items: ids.map((id, i) => ({ id, folder: folders[i % 2].name })) }, usage: { ...EMPTY_USAGE, requests: 1 } }
    }
    seen.push({ stage: 'classify', user })
    return { data: { items: ids.map((id) => ({ id, path: id.startsWith('v') ? 'Vue' : '杂项', confidence: 0.9 })) }, usage: { ...EMPTY_USAGE, requests: 1 } }
  }
  return { chat, seen }
}

function setup(opts: { granted?: boolean; withKey?: boolean; tree?: ReturnType<typeof sampleTree>; lock?: MutationLock } = {}) {
  const api = createFakeBookmarks(opts.tree ?? sampleTree())
  const kv = memoryKV()
  const { chat, seen } = fakeChat()
  const requests: string[][] = []
  let granted = opts.granted ?? false
  const listeners = new Set<() => void>()
  const wf = createWorkflow({
    bookmarks: api,
    kv,
    lock: opts.lock,
    now: () => 1_800_000_000_000,
    chat: opts.withKey === false ? undefined : chat,
    fetchImpl: (async (url: string) => new Response(`<html><head><title>页面 ${url}</title><meta name="description" content="简介 ${'很长'.repeat(200)}"></head></html>`, { headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch,
    permissions: {
      contains: async () => granted,
      request: async (p) => {
        requests.push(p.origins)
        granted = true
        return true
      }
    },
    bookmarkEvents: {
      subscribe(cb) {
        listeners.add(cb)
        return () => listeners.delete(cb)
      }
    }
  })
  return { api, kv, wf, seen, requests, listeners }
}

const planOptions = (patch: Partial<PlanOptions> = {}): PlanOptions => ({ maxTop: 8, emoji: false, ruleTitles: true, lockedFolderIds: ['LOCK'], keepLooseBarItems: true, ...patch })

describe('workflow', () => {
  it('体检数得对', async () => {
    const { wf } = setup()
    const { summary } = await wf.audit()
    expect(summary.bookmarks).toBe(10)
    expect(summary.roots['bookmarks-bar']).toEqual({ bookmarks: 6, topFolders: 2, looseBookmarks: 1 })
  })

  it('网址权限：已有就不再申请', async () => {
    const a = setup({ granted: true })
    expect(await a.wf.ensureSitePermission()).toBe(true)
    expect(a.requests).toEqual([])
    const b = setup()
    expect(await b.wf.ensureSitePermission()).toBe(true)
    expect(b.requests).toEqual([['http://*/*', 'https://*/*']])
  })

  it('抓取计划：没设锁定时按默认名字锁「受保护资料」，排除域名生效', async () => {
    const { wf } = setup()
    await wf.saveSettings({ excludeDomains: ['other.com'] })
    const plan = await wf.planFetch()
    const reasons = Object.fromEntries(plan.skipped.map((s) => [s.bookmarkIds[0], s.reason]))
    expect(reasons.w1).toBe('locked')
    expect(reasons.o1).toBe('excluded-domain')
    expect(reasons.v0).toBe('credential-param') // 网址里带 token=
    expect(plan.toFetch.map((t) => t.bookmarkIds[0])).toContain('loose')
  })

  it('抓取：结果存进本地，7 天内不重抓', async () => {
    const { wf } = setup()
    const plan = await wf.planFetch()
    const run = wf.startFetch(plan, () => {})
    const final = await run.done
    expect(final.done).toBe(plan.toFetch.length)
    const pages = await wf.getPageInfos()
    expect(pages['https://loose.com']?.title).toBe('页面 https://loose.com')
    const again = await wf.planFetch()
    expect(again.toFetch).toEqual([])
    expect(again.cached.length).toBe(plan.toFetch.length)
  })

  it('说明：范围不含锁定和移动设备；输入已脱敏；跳过已有和手改的；每批存盘', async () => {
    const { wf, seen } = setup()
    await wf.startFetch(await wf.planFetch(), () => {}).done
    await wf.saveManualMeta('o1', { desc: '我自己写的' })
    const r = await wf.describe(() => {})
    expect(r.failedIds).toEqual([])
    const user = seen.find((s) => s.stage === 'describe')!.user
    expect(user).not.toContain('w1')
    expect(user).not.toContain('m1')
    expect(user).not.toContain('o1 |')
    expect(user).not.toContain('SECRET')
    expect(user).not.toContain('utm_source')
    expect(user).toContain('zhuanlan.zhihu.com/p/0')
    // 抓到的网页简介截到 200 字
    const line = user.split('\n').find((l) => l.startsWith('loose |'))!
    const desc = line.split(' | ')[3]
    expect(desc.startsWith('简介')).toBe(true)
    expect([...desc].length).toBe(200)
    const meta = await wf.getMeta()
    expect(meta.v0).toMatchObject({ desc: '说明v0', title: '标题v0', type: '文章' })
    expect(meta.o1).toMatchObject({ desc: '我自己写的', manual: true })
    expect(meta.w1).toBeUndefined()
    // 再跑一次：都有说明了，不再调用
    const before = seen.length
    await wf.describe(() => {})
    expect(seen.length).toBe(before)
  })

  it('归类后超过 40 条的目录自动拆细，应用后建成两层', async () => {
    const many = treeOf(
      [
        folder('vue 资料', Array.from({ length: 45 }, (_, i) => link(`Vue ${i}`, `https://vue.com/${i}`, {}, `v${i}`)), 'FV'),
        folder('受保护资料', [link('公司文档', 'https://x.feishu.cn/docx/1', {}, 'w1')], 'LOCK')
      ],
      [link('其他', 'https://other.com', {}, 'o1'), link('其他 2', 'https://other.com/2', {}, 'o2'), link('其他 3', 'https://other.com/3', {}, 'o3')],
      []
    )
    const { wf, api, seen } = setup({ tree: many })
    await wf.describe(() => {})
    const stages = new Set<string>()
    const { plan, issues, usage } = await wf.buildPlan(planOptions(), (p) => void stages.add(p.stage))
    expect([...stages]).toEqual(['taxonomy', 'classify', 'split'])
    const split = seen.filter((s) => s.stage === 'split')
    expect(split).toHaveLength(1)
    expect(split[0].user).toContain('书签共 45 条')
    expect(split[0].user).not.toContain('受保护资料')
    expect(plan.folders.find((f) => f.name === 'Vue')!.children.map((c) => c.name)).toEqual(['Vue 基础', 'Vue 进阶'])
    expect(issues).toEqual([])
    expect(usage.requests).toBe(3)
    expect((await wf.getPlan())?.folders).toEqual(plan.folders) // 存下来的是拆过的

    const log = await wf.apply(plan, () => {})
    expect(log.status).toBe('done')
    const vue = (await api.getChildren('1')).find((n) => n.title === 'Vue')!
    const subs = await api.getChildren(vue.id)
    const sizes = await Promise.all(subs.map(async (n) => [n.title, (await api.getChildren(n.id)).length]))
    expect(sizes).toEqual([
      ['Vue 基础', 23],
      ['Vue 进阶', 22]
    ])
  })

  it('写说明的过程中手改了某条：这批结果回来也不覆盖手改的', async () => {
    const api = createFakeBookmarks(sampleTree())
    let wfRef: ReturnType<typeof createWorkflow> | undefined
    const chat: ChatJsonFn = async (messages) => {
      const ids = messages[1].content
        .split('\n')
        .slice(1)
        .map((l) => l.split(' | ')[0])
      // 这一批还在等模型时，用户在编辑框里改了 v1
      await wfRef!.saveManualMeta('v1', { desc: '跑的时候我自己改的' })
      return { data: { items: ids.map((id) => ({ id, desc: `说明${id}`, title: `标题${id}`, tags: ['t'], type: '文章' })) }, usage: { ...EMPTY_USAGE, requests: 1 } }
    }
    wfRef = createWorkflow({ bookmarks: api, kv: memoryKV(), now: () => 1_800_000_000_000, chat, permissions: { contains: async () => true, request: async () => true }, bookmarkEvents: { subscribe: () => () => {} } })
    await wfRef.describe(() => {})
    const meta = await wfRef.getMeta()
    expect(meta.v1).toMatchObject({ desc: '跑的时候我自己改的', manual: true })
    expect(meta.v0).toMatchObject({ desc: '说明v0' })
  })

  it('没填 key 时说明和方案都报错', async () => {
    const { wf } = setup({ withKey: false })
    await expect(wf.describe(() => {})).rejects.toThrow('还没填 API key')
    await expect(wf.buildPlan(planOptions(), () => {})).rejects.toThrow('还没填 API key')
    expect((await wf.testAi()).ok).toBe(false)
  })

  it('方案 → 应用 → 撤销，一路走通；快照能导出、能从备份恢复', async () => {
    const { wf, api, seen } = setup()
    await wf.describe(() => {})
    const before = treeFingerprint(api.dump())
    const { plan, issues, usage } = await wf.buildPlan(planOptions(), () => {})
    expect(issues).toEqual([])
    expect(usage.requests).toBe(2)
    expect(seen.find((s) => s.stage === 'taxonomy')!.user).not.toContain('公司文档')
    expect(plan.items.map((i) => i.bookmarkId).sort()).toEqual(['o1', 'o2', 'o3', 'v0', 'v1', 'v2', 'v3'])
    expect(treeFingerprint(api.dump())).toBe(before) // 生成方案不碰书签
    expect((await wf.getPlan())?.id).toBe(plan.id)

    let snapId = ''
    const log = await wf.apply(plan, () => {}, (id) => void (snapId = id))
    expect(log.status).toBe('done')
    expect(snapId).toBe(log.snapshotId)
    expect((await api.getChildren('1')).map((n) => n.title)).toEqual(['Vue', '杂项', '受保护资料', '散放'])
    expect((await wf.getLatestApply())?.applyId).toBe(log.applyId)

    const backup = await wf.exportSnapshot(log.snapshotId)
    expect(JSON.parse(backup).format).toBe('bookmark-tidy-snapshot')

    const undone = await wf.undo(log.applyId, () => {})
    expect(undone.status).toBe('undone')
    expect(treeFingerprint(api.dump())).toBe(before)

    // 再应用一次，然后用备份文件恢复
    const second = await wf.apply((await wf.buildPlan(planOptions(), () => {})).plan, () => {})
    const json = await wf.exportSnapshot(second.snapshotId)
    const report = await wf.restoreFromBackup(json, () => {})
    expect(report.removedFolders).toBeGreaterThan(0)
    expect(treeFingerprint(api.dump())).toBe(before)
  })

  it('继续一次中断的应用', async () => {
    const { wf, api } = setup()
    const { plan } = await wf.buildPlan(planOptions(), () => {})
    api.failAfter(3)
    const failed = await wf.apply(plan, () => {})
    expect(failed.status).toBe('failed')
    api.failAfter(Infinity)
    const resumed = await wf.continueApply(failed.applyId, () => {})
    expect(resumed.status).toBe('done')
    expect((await api.getChildren('1')).map((n) => n.title)).toEqual(['Vue', '杂项', '受保护资料', '散放'])
  })

  it('改了方案（一条去待清理）照样应用', async () => {
    const { wf, api } = setup()
    const { plan } = await wf.buildPlan(planOptions(), () => {})
    const edited = { ...plan, items: plan.items.map((i) => (i.bookmarkId === 'o3' ? { ...i, target: CLEANUP } : i)) }
    await wf.savePlan(edited)
    await wf.apply(edited, () => {})
    expect((await api.getChildren('2')).map((n) => n.title)).toContain('待清理')
  })

  it('估算费用按模型算；书签变化的订阅能取消', async () => {
    const { wf, listeners } = setup()
    await wf.getSettings()
    expect(wf.estimateCost({ ...EMPTY_USAGE, promptTokens: 1_000_000 })).toBeCloseTo(0.3, 6)
    const off = wf.onTreeChanged(() => {})
    expect(listeners.size).toBe(1)
    off()
    expect(listeners.size).toBe(0)
  })
})

describe('二期：一期的操作和后台自动整理共用一把锁', () => {
  it('锁被自动整理占着时，应用等它放开才动书签', async () => {
    const lock = createMutationLock()
    const { wf } = setup({ granted: true, lock })
    await wf.describe(() => {})
    const { plan } = await wf.buildPlan(planOptions(), () => {})
    const order: string[] = []
    let release!: () => void
    const held = lock.run('auto', () => new Promise<void>((r) => (release = r)))
    let started = false
    const applying = wf.apply(plan, () => {
      if (!started) order.push('应用开始动书签')
      started = true
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual([])
    order.push('自动整理放锁')
    release()
    await held
    const log = await applying
    expect(log.status).toBe('done')
    expect(order).toEqual(['自动整理放锁', '应用开始动书签'])
  })

  it('撤销、从备份恢复重建出来的书签记进 autoOwn', async () => {
    const { wf, api, kv } = setup({ granted: true })
    await wf.describe(() => {})
    const log = await wf.apply((await wf.buildPlan(planOptions(), () => {})).plan, () => {})
    const backup = await wf.exportSnapshot(log.snapshotId)
    await api.external.remove('v0')
    const undone = await wf.undo(log.applyId, () => {})
    const rebuilt = undone.undoReport!.rebuilt.map((r) => r.newId)
    expect(rebuilt).toHaveLength(1)
    expect(await createStore(kv).getOwn()).toEqual(rebuilt)
    await api.external.remove(rebuilt[0])
    const report = await wf.restoreFromBackup(backup, () => {})
    expect(report.rebuilt).toHaveLength(1)
    expect(await createStore(kv).getOwn()).toEqual([...rebuilt, report.rebuilt[0].newId])
  })
})

describe('bookmark-ux：待处理和手动操作', () => {
  const T = 1_800_000_000_000

  it('T3、K3 放到：移进去、记成你定过位置；撤销后回原处、移出「你定过」，自动整理的记录写回去', async () => {
    const { wf, api, kv } = setup()
    const store = createStore(kv)
    const rec = { bookmarkId: 'o2', at: T - 1000, source: 'button' as const, from: { parentId: '2', index: 1, title: '其他 2' }, to: { parentId: '2', title: '其他 2' }, path: '待整理', confidence: 0.3, status: 'inbox' as const }
    await store.saveRecord(rec, T)
    await store.addHandPlaced(['o3'])
    const change = await wf.moveBookmarks(['o1', 'o2', 'o3'], { folderId: 'FV' })
    expect((await api.getChildren('FV')).map((c) => c.id).slice(-3)).toEqual(['o1', 'o2', 'o3'])
    // o3 以前就记过，这次不算新记的
    expect(change.placed).toEqual(['o1', 'o2'])
    expect(Object.keys(change.records)).toEqual(['o2'])
    expect((await store.getHandPlaced()).sort()).toEqual(['o1', 'o2', 'o3'])
    // 后台收到这次移动会把记录改成「用户挪走」；撤销后写回原来的
    await store.saveRecord({ ...rec, status: 'moved-by-user' }, T)
    expect(await wf.revertChange(change)).toEqual({ restored: 3, skipped: 0 })
    expect((await api.getChildren('2')).map((c) => c.id)).toEqual(['o1', 'o2', 'o3'])
    expect(await store.getHandPlaced()).toEqual(['o3'])
    expect((await store.getRecord('o2'))?.status).toBe('inbox')
  })

  it('T4 新建文件夹再放进去：同名的直接用；撤销「放到」不删新建的文件夹', async () => {
    const { wf, api } = setup()
    const first = await wf.moveBookmarks(['o1'], { newFolder: { parentId: '1', title: '杂项' } })
    const made = (await api.get('o1'))[0].parentId!
    expect((await api.get(made))[0].title).toBe('杂项')
    await wf.moveBookmarks(['o2'], { newFolder: { parentId: '1', title: '杂项' } })
    expect((await api.get('o2'))[0].parentId).toBe(made)
    await wf.revertChange(first)
    expect((await api.get('o1'))[0].parentId).toBe('2')
    expect((await api.get(made))[0].title).toBe('杂项')
  })

  it('T6、T7 删除：先交出整棵树的备份（parseBackup 读得了）再删；备份这一步出错就不删；撤销后重建在原位置、记进 autoOwn、说明跟着走', async () => {
    const { wf, api, kv } = setup()
    const store = createStore(kv)
    await wf.saveManualMeta('o2', { desc: '我写的说明' })
    await expect(
      wf.removeBookmarks(['o2'], () => {
        throw new Error('下载不了')
      })
    ).rejects.toThrow('下载不了')
    expect((await api.get('o2'))[0].title).toBe('其他 2')
    let json = ''
    const change = await wf.removeBookmarks(['o2', 'o3'], (j) => void (json = j))
    expect(parseBackup(json).nodes.some((n) => n.id === 'o2' && n.url === 'https://other.com/2')).toBe(true)
    expect((await api.getChildren('2')).map((c) => c.id)).toEqual(['o1'])
    expect(await wf.revertChange(change)).toEqual({ restored: 2, skipped: 0 })
    const kids = await api.getChildren('2')
    expect(kids.map((c) => c.title)).toEqual(['其他', '其他 2', '其他 3'])
    expect(kids[1].id).toBe(change.rebuilt.o2)
    expect(await store.getOwn()).toEqual(expect.arrayContaining([change.rebuilt.o2, change.rebuilt.o3]))
    expect((await wf.getMeta())[change.rebuilt.o2]).toMatchObject({ desc: '我写的说明', manual: true })
  })

  it('T8 删空文件夹：不管传进来的顺序，深的先删；有东西的跳过；撤销后回来', async () => {
    const tree = treeOf([folder('旧', [folder('甲', [folder('乙', [], 'Y')], 'X')], 'OLD'), folder('有东西', [link('留着', 'https://keep.com', {}, 'K')], 'KEEP')])
    const { wf, api } = setup({ tree })
    const change = await wf.removeFolders(['OLD', 'KEEP', 'X', 'Y'])
    expect(change.removed.map((r) => r.id)).toEqual(['Y', 'X', 'OLD'])
    expect(change.skipped).toBe(1)
    await wf.revertChange(change)
    const old = (await api.getChildren('1')).find((c) => c.title === '旧')!
    expect((await api.getChildren(old.id)).map((c) => c.title)).toEqual(['甲'])
  })

  it('T11 删除只在你点了以后发生：说明、方案、应用都不删；撤销、恢复只删这次应用新建、已经空了的目录', async () => {
    const { wf, api } = setup({ granted: true })
    const removed: string[] = []
    api.beforeWrite((op, id) => void (op === 'remove' && removed.push(id)))
    await wf.describe(() => {})
    const log = await wf.apply((await wf.buildPlan(planOptions(), () => {})).plan, () => {})
    expect(log.status).toBe('done')
    expect(removed).toEqual([])
    const json = await wf.exportSnapshot(log.snapshotId)
    const undone = await wf.undo(log.applyId, () => {})
    const created = new Set(Object.values(undone.createdFolders))
    expect(removed.every((id) => created.has(id))).toBe(true)
    const before = removed.length
    await wf.restoreFromBackup(json, () => {})
    expect(removed.slice(before).every((id) => created.has(id))).toBe(true)
  })

  it('T12 手动操作和一期的应用用同一把锁：应用没做完时，移动等着', async () => {
    const lock = createMutationLock()
    const { wf, api } = setup({ lock })
    let release!: () => void
    const held = lock.run('apply', () => new Promise<void>((r) => (release = r)))
    const moving = wf.moveBookmarks(['o1'], { folderId: 'FV' })
    await new Promise((r) => setTimeout(r, 20))
    expect((await api.get('o1'))[0].parentId).toBe('2')
    release()
    await held
    await moving
    expect((await api.get('o1'))[0].parentId).toBe('FV')
  })

  it('O1 生成方案前先给没有说明的写说明（进度从「说明」开始，用量算在一起）；都有了就不再写', async () => {
    const { wf, seen } = setup()
    const stages: string[] = []
    const { usage, describeFailed } = await wf.buildPlan(planOptions(), (p) => void (stages.at(-1) !== p.stage && stages.push(p.stage)))
    expect(stages[0]).toBe('describe')
    expect(seen[0].stage).toBe('describe')
    expect(usage.requests).toBe(seen.length)
    expect(describeFailed).toBe(0)
    const n = seen.length
    await wf.buildPlan(planOptions(), () => {})
    expect(seen.slice(n).map((s) => s.stage)).not.toContain('describe')
  })

  it('O1 生成方案写说明的范围和原来「生成说明」一样（散放的也写，锁定的不写）；没有要整理的就不花钱写', async () => {
    const { wf, seen } = setup()
    await wf.buildPlan(planOptions(), () => {})
    const user = seen.find((s) => s.stage === 'describe')!.user
    expect(user).toContain('loose |')
    expect(user).not.toContain('w1 |')
    const lonely = setup({ tree: treeOf([link('只有散放的', 'https://a.com', {}, 'a')]) })
    await expect(lonely.wf.buildPlan(planOptions(), () => {})).rejects.toThrow('没有要整理的书签')
    expect(lonely.seen).toEqual([])
  })

  it('不能往锁定的文件夹里放、不删锁定的空文件夹（界面上的清单可能是锁定之前算的）', async () => {
    const tree = treeOf([folder('受保护资料', [folder('空的', [], 'LE')], 'LOCK'), folder('空的不锁', [], 'FE')], [link('其他', 'https://other.com', {}, 'o1')])
    const { wf, api } = setup({ tree })
    await wf.saveSettings({ lockedFolderIds: ['LOCK'] })
    await expect(wf.moveBookmarks(['o1'], { folderId: 'LOCK' })).rejects.toThrow('锁定')
    await expect(wf.moveBookmarks(['o1'], { newFolder: { parentId: 'LOCK', title: '新' } })).rejects.toThrow('锁定')
    expect((await api.get('o1'))[0].parentId).toBe('2')
    // 先查锁定再动手：锁定的文件夹里没有多出新建的文件夹
    expect((await api.getChildren('LOCK')).map((c) => c.title)).toEqual(['空的'])
    const change = await wf.removeFolders(['LE', 'FE'])
    expect(change.removed.map((r) => r.id)).toEqual(['FE'])
    expect(change.skipped).toBe(1)
    expect((await api.get('LE'))[0].title).toBe('空的')
  })

  it('删了你定过位置的书签再撤销：重建出来的新 id 照样算你定过；删掉以后旧 id 不占名额', async () => {
    const { wf, kv } = setup()
    const store = createStore(kv)
    await store.addHandPlaced(['o2'])
    const change = await wf.removeBookmarks(['o2'])
    expect(await store.getHandPlaced()).toEqual([])
    await wf.revertChange(change)
    expect(await store.getHandPlaced()).toEqual([change.rebuilt.o2])
  })


  it('K3 应用完成后，方案里没勾的记成你定过位置；撤销这次应用后拿掉（以前就记过的留着）', async () => {
    const { wf, kv } = setup()
    const store = createStore(kv)
    await store.addHandPlaced(['o2'])
    const { plan } = await wf.buildPlan(planOptions(), () => {})
    const edited = { ...plan, items: plan.items.map((i) => (i.bookmarkId === 'o3' || i.bookmarkId === 'o2' ? { ...i, enabled: false } : i)) }
    await wf.savePlan(edited)
    const log = await wf.apply(edited, () => {})
    expect(log.status).toBe('done')
    expect((await store.getHandPlaced()).sort()).toEqual(['o2', 'o3'])
    expect(log.placedIds).toEqual(['o3'])
    expect((await wf.undo(log.applyId, () => {})).status).toBe('undone')
    expect(await store.getHandPlaced()).toEqual(['o2'])
  })

  it('T2、T5 待处理清单：应用后待整理、待清理里的都列出来', async () => {
    const { wf } = setup()
    const { plan } = await wf.buildPlan(planOptions(), () => {})
    const edited = { ...plan, items: plan.items.map((i) => (i.bookmarkId === 'o3' ? { ...i, target: CLEANUP } : i.bookmarkId === 'o2' ? { ...i, target: 'inbox' } : i)) }
    await wf.apply(edited, () => {})
    const t = await wf.triage()
    expect(t.unsure.map((e) => e.bookmark.id)).toEqual(['o2'])
    expect(t.cleanup.map((e) => [e.bookmark.id, e.reason?.kind])).toEqual([['o3', 'other']])
  })
})

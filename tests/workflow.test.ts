import { describe, expect, it } from 'vitest'
import { EMPTY_USAGE } from '../src/core/ai'
import { CLEANUP } from '../src/core/plan'
import { treeFingerprint } from '../src/core/snapshot'
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

import { describe, expect, it } from 'vitest'
import { alignToSnapshot, applyPlan, precheck, undoApply } from '../src/core/apply'
import { buildPlan, HOLDING_NAME, INBOX_NAME, setItemTarget, validatePlan, CLEANUP, CLEANUP_NAME } from '../src/core/plan'
import { takeSnapshot, treeFingerprint } from '../src/core/snapshot'
import { flattenTree } from '../src/core/tree'
import type { BookmarkNode, ClassifyOutput, Plan, TaxonomyNode } from '../src/core/types'
import { createFakeBookmarks, folder, link, treeOf, type FakeBookmarks } from '../src/core/memory-bookmarks'
import { createMemoryStore } from './helpers/memory-store'

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${i}`)

function sampleTree(): BookmarkNode[] {
  return treeOf(
    [
      folder('vue 资料', ids('v', 5).map((id, i) => link(`Vue 文章 ${i} - 知乎`, `https://zhuanlan.zhihu.com/p/${i}`, {}, id)), 'FV'),
      folder('css框架', [folder('css', ids('c', 4).map((id, i) => link(`CSS ${i}`, `https://css.com/${i}`, {}, id)), 'FCSS')], 'FC'),
      folder('工具', [...ids('t', 3).map((id, i) => link(`工具 ${i}`, `https://tool.com/${i}`, {}, id)), folder('新建文件夹', [], 'FN')], 'FT'),
      folder('受保护资料', [link('公司文档', 'https://x.feishu.cn/docx/1', {}, 'w1')], 'LOCK'),
      link('散放', 'https://loose.com', {}, 'loose')
    ],
    ids('o', 3).map((id, i) => link(`其他 ${i}`, `https://other.com/${i}`, {}, id))
  )
}

const taxonomy: TaxonomyNode[] = [
  { name: '前端', desc: '', children: [{ name: 'Vue', desc: '' }, { name: 'CSS', desc: '' }] },
  { name: '工具', desc: '' },
  { name: '杂项', desc: '' }
]
const classify: ClassifyOutput[] = [
  ...ids('v', 5).map((id) => ({ id, path: '前端/Vue', confidence: 0.9 })),
  ...ids('c', 4).map((id) => ({ id, path: '前端/CSS', confidence: 0.9 })),
  ...ids('t', 3).map((id) => ({ id, path: '工具', confidence: 0.9 })),
  ...ids('o', 3).map((id) => ({ id, path: '杂项', confidence: 0.9 }))
]

function planFor(nodes: BookmarkNode[], cls = classify, tax = taxonomy): Plan {
  const { plan } = buildPlan({
    flat: flattenTree(nodes),
    nodes,
    taxonomy: tax,
    classify: cls,
    meta: {},
    pageInfos: {},
    options: { maxTop: 8, emoji: false, ruleTitles: true, lockedFolderIds: ['LOCK'], keepLooseBarItems: true },
    barRootId: '1',
    otherRootId: '2',
    now: 1
  })
  return plan
}

function setup(tree = sampleTree()) {
  const api = createFakeBookmarks(tree)
  const store = createMemoryStore()
  const plan = planFor(api.dump())
  return { api, store, plan, before: treeFingerprint(api.dump()) }
}

/** 每个节点 → 「父文件夹名/…/自己的标题」，方便比结构 */
async function layout(api: FakeBookmarks): Promise<string[]> {
  const out: string[] = []
  const walk = (n: BookmarkNode, path: string) => {
    for (const c of n.children ?? []) {
      out.push(`${path}/${c.title}`)
      walk(c, `${path}/${c.title}`)
    }
  }
  walk((await api.getTree())[0], '')
  return out
}

const childTitles = async (api: FakeBookmarks, id: string) => (await api.getChildren(id)).map((n) => n.title)
const parentOf = async (api: FakeBookmarks, id: string) => (await api.get(id))[0].parentId

describe('applyPlan', () => {
  it('按方案落地：新目录在书签栏最前，同名复用，旧目录整个移走且 id 不变，锁定和散放不动', async () => {
    const { api, store, plan } = setup()
    expect(validatePlan(plan)).toEqual([])
    let writesAtSnapshot = -1
    const log = await applyPlan(api, plan, store, { onSnapshot: () => void (writesAtSnapshot = api.writes()), now: () => 100 })

    expect(log.status).toBe('done')
    expect(writesAtSnapshot).toBe(0)
    expect(log.report?.mismatches).toEqual([])
    expect(log.report?.skipped).toEqual([])
    expect(await childTitles(api, '1')).toEqual(['前端', '工具', '杂项', '受保护资料', '散放'])
    const frontend = (await api.getChildren('1'))[0]
    expect(await childTitles(api, frontend.id)).toEqual(['Vue', 'CSS'])
    expect(log.createdFolders['工具']).toBe('FT') // 复用了旧的「工具」
    // 本来就在「工具」里的不用移动，顺序不变
    expect(await childTitles(api, 'FT')).toEqual(['工具 0', '工具 1', '工具 2', '新建文件夹'])

    const vue = (await api.getChildren(frontend.id))[0]
    expect(await childTitles(api, vue.id)).toEqual(['Vue 文章 0', 'Vue 文章 1', 'Vue 文章 2', 'Vue 文章 3', 'Vue 文章 4'])
    expect(log.report).toMatchObject({ moved: 12, renamed: 5, movedOldFolders: 2 })

    // 旧目录在「其他书签/整理前的空文件夹」里，id 不变，子目录跟着走
    const holding = (await api.getChildren('2')).find((n) => n.title === HOLDING_NAME)!
    expect((await api.getChildren(holding.id)).map((n) => n.id)).toEqual(['FV', 'FC'])
    expect(await parentOf(api, 'FCSS')).toBe('FC')
    // 锁定的原样
    expect(await childTitles(api, 'LOCK')).toEqual(['公司文档'])
    // 没有条目就不建「待整理」「待清理」
    expect(await childTitles(api, '2')).toEqual([HOLDING_NAME])
  })

  it('每一步都写日志；进度到总数', async () => {
    const { api, store, plan } = setup()
    const progress: [number, number][] = []
    const log = await applyPlan(api, plan, store, { onProgress: (d, t) => progress.push([d, t]) })
    expect(progress.at(-1)).toEqual([log.total, log.total])
    expect(store.saveLogCalls()).toBeGreaterThanOrEqual(log.total)
    expect((await store.getLatestLog())?.status).toBe('done')
  })

  it('预检：被移动、改名、改网址、删掉、移进锁定目录的都不动（E8）', async () => {
    const { api, store, plan } = setup()
    await api.external.move('v0', { parentId: 'FC' })
    await api.external.update('v1', { title: '用户改的标题' })
    await api.external.update('v2', { url: 'https://changed.com' })
    await api.external.remove('v3')
    await api.external.move('c0', { parentId: 'LOCK' })
    const pre = await precheck(api, plan)
    expect(Object.fromEntries(pre.skipped.map((s) => [s.bookmarkId, s.reason]))).toEqual({ v0: 'moved', v1: 'retitled', v2: 'url-changed', v3: 'missing', c0: 'moved' })

    const log = await applyPlan(api, plan, store)
    expect(log.status).toBe('done')
    expect(await parentOf(api, 'v0')).toBe('FC')
    expect((await api.get('v1'))[0].title).toBe('用户改的标题')
    expect(await parentOf(api, 'c0')).toBe('LOCK')
    expect(log.report?.skipped).toHaveLength(5)
  })

  it('执行中被外部改了：这条跳过，记 changed-during-apply', async () => {
    const { api, store, plan } = setup()
    let done = false
    api.beforeWrite(async (op) => {
      if (op === 'move' && !done) {
        done = true
        await api.external.update('o2', { title: '刚被改' })
      }
    })
    const log = await applyPlan(api, plan, store)
    expect(log.status).toBe('done')
    expect(log.report?.skipped).toEqual([{ bookmarkId: 'o2', reason: 'changed-during-apply' }])
    expect(await parentOf(api, 'o2')).toBe('2')
  })

  it('中途失败：日志 failed 并记位置；从失败状态撤销，树和应用前完全一样（E5）', async () => {
    const { api, store, plan, before } = setup()
    api.failAfter(7)
    const log = await applyPlan(api, plan, store)
    expect(log.status).toBe('failed')
    expect(log.error?.step).toBeGreaterThan(0)
    expect(log.error?.message).toMatch(/写操作被设定为失败/)

    api.failAfter(Infinity)
    const snapshot = (await store.getSnapshot(log.snapshotId))!
    const undone = await undoApply(api, (await store.getLog(log.applyId))!, snapshot, store)
    expect(undone.status).toBe('undone')
    expect(treeFingerprint(api.dump())).toBe(before)
  })

  it('继续一次中断的应用：做完，不重复建目录，结果和一次做完一样', async () => {
    const oneShot = setup()
    await applyPlan(oneShot.api, oneShot.plan, oneShot.store)
    const expected = await layout(oneShot.api)

    const { api, store, plan } = setup()
    api.failAfter(9)
    const failed = await applyPlan(api, plan, store)
    expect(failed.status).toBe('failed')
    api.failAfter(Infinity)
    const resumed = await applyPlan(api, plan, store, { resume: (await store.getLog(failed.applyId))! })
    expect(resumed.status).toBe('done')
    expect(resumed.applyId).toBe(failed.applyId)
    expect(resumed.snapshotId).toBe(failed.snapshotId)
    expect(await layout(api)).toEqual(expected)
  })
})

describe('undoApply', () => {
  async function applied() {
    const s = setup()
    const log = await applyPlan(s.api, s.plan, s.store)
    const snapshot = (await s.store.getSnapshot(log.snapshotId))!
    return { ...s, log, snapshot }
  }

  it('没有外部改动：撤销后指纹和应用前完全一致', async () => {
    const { api, store, log, snapshot, before } = await applied()
    expect(treeFingerprint(api.dump())).not.toBe(before)
    const undone = await undoApply(api, log, snapshot, store)
    expect(undone.status).toBe('undone')
    expect(treeFingerprint(api.dump())).toBe(before)
    expect(undone.undoReport).toMatchObject({ rebuilt: [], keptExtras: [], keptFolders: [] })
    expect(undone.undoReport!.removedFolders).toBe(5) // 前端、Vue、CSS、杂项、整理前的空文件夹
  })

  it('应用后外部删了一条书签：按快照重建，其余 id 不变', async () => {
    const { api, store, log, snapshot } = await applied()
    await api.external.remove('v2')
    const undone = await undoApply(api, log, snapshot, store)
    expect(undone.undoReport!.rebuilt).toEqual([{ snapshotId: 'v2', newId: expect.any(String), title: 'Vue 文章 2 - 知乎' }])
    expect((await api.getChildren('FV')).map((n) => n.id)).toEqual(['v0', 'v1', undone.undoReport!.rebuilt[0].newId, 'v3', 'v4'])
    expect(await childTitles(api, '1')).toEqual(['vue 资料', 'css框架', '工具', '受保护资料', '散放'])
  })

  it('应用后外部删了「整理前的空文件夹」里的旧目录：重建并把书签放回去', async () => {
    const { api, store, log, snapshot } = await applied()
    await api.external.remove('FC') // 连同空的 css 子目录
    const undone = await undoApply(api, log, snapshot, store)
    const rebuilt = Object.fromEntries(undone.undoReport!.rebuilt.map((r) => [r.snapshotId, r.newId]))
    expect(Object.keys(rebuilt).sort()).toEqual(['FC', 'FCSS'])
    expect((await api.getChildren(rebuilt.FCSS)).map((n) => n.id)).toEqual(['c0', 'c1', 'c2', 'c3'])
    expect(await childTitles(api, '1')).toEqual(['vue 资料', 'css框架', '工具', '受保护资料', '散放'])
  })

  it('应用后在快照文件夹里新建的书签保留，排在后面；方案目录里有新书签就保留目录', async () => {
    const { api, store, log, snapshot } = await applied()
    const extra = await api.external.create({ parentId: 'LOCK', index: 0, title: '新加的', url: 'https://new.com' })
    const vueId = log.createdFolders['前端/Vue']
    const inPlanFolder = await api.external.create({ parentId: vueId, title: '放在新目录里', url: 'https://new2.com' })
    const undone = await undoApply(api, log, snapshot, store)
    expect(await childTitles(api, 'LOCK')).toEqual(['公司文档', '新加的'])
    // 两条新书签都逐条列出：快照文件夹里的，和留下来的方案目录里的
    expect(undone.undoReport!.keptExtras.sort()).toEqual([extra.id, inPlanFolder.id].sort())
    // Vue 里有新书签，它和它的父目录「前端」都留着
    expect(undone.undoReport!.keptFolders.sort()).toEqual([vueId, log.createdFolders['前端']].sort())
    expect(await parentOf(api, inPlanFolder.id)).toBe(vueId)
  })

  it('撤销中途断了再跑：结果和一次跑完一样，不重复重建', async () => {
    const { api, store, log, snapshot, before } = await applied()
    await api.external.remove('v2')
    // 第一次撤销：重建 v2 之后的下一个写操作就断
    let rebuilt = false
    api.beforeWrite((op) => {
      if (rebuilt) throw new Error('模拟中断')
      if (op === 'create') rebuilt = true
    })
    const first = await undoApply(api, log, snapshot, store)
    expect(first.status).toBe('undoing')
    expect(first.error?.message).toBe('模拟中断')
    expect(Object.keys(first.undoIdMap)).toEqual(['v2'])
    api.beforeWrite(undefined)
    const second = await undoApply(api, (await store.getLog(log.applyId))!, snapshot, store)
    expect(second.status).toBe('undone')
    expect((await api.getChildren('FV')).filter((n) => n.title === 'Vue 文章 2 - 知乎')).toHaveLength(1)
    // 除了重建的那条换了 id，整棵树和应用前一致
    const newId = second.undoIdMap.v2
    const normalized = JSON.stringify(api.dump()).replaceAll(`"${newId}"`, '"v2"')
    const fresh = createFakeBookmarks(JSON.parse(normalized))
    expect(treeFingerprint(fresh.dump())).toBe(before)
  })

  it('alignToSnapshot 从备份恢复：快照里有的目录绝不删', async () => {
    const api = createFakeBookmarks(sampleTree())
    const snapshot = await takeSnapshot(api)
    await api.external.move('v0', { parentId: '2' })
    const report = await alignToSnapshot(api, snapshot, { removableFolderIds: ['FV', 'FN'] })
    expect(report.removedFolders).toBe(0)
    expect(await parentOf(api, 'v0')).toBe('FV')
    expect(report.restored).toBe(1)
  })
})

describe('接近真实的一棵树：23 个顶层文件夹、约 400 条', () => {
  // 固定种子的伪随机，结果可复现
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
  }

  function realisticTree(): BookmarkNode[] {
    const rand = rng(42)
    let n = 0
    const bm = () => {
      n++
      return link(`文章 ${n}_某某的博客-CSDN博客`, `https://blog.csdn.net/u/article/details/${100000 + n}`, { dateAdded: 1_600_000_000_000 + n * 1000 }, `b${n}`)
    }
    const bar: BookmarkNode[] = []
    for (let f = 0; f < 23; f++) {
      if (f === 5) {
        bar.push(folder('受保护资料', [bm(), bm(), bm()], 'LOCK'))
        continue
      }
      const size = 5 + Math.floor(rand() * 25)
      const kids: BookmarkNode[] = Array.from({ length: size }, bm)
      if (f === 2) kids.push(folder('css', Array.from({ length: 12 }, bm), 'NEST1'))
      if (f === 7) kids.push(folder('js处理', Array.from({ length: 6 }, bm), 'NEST2'))
      if (f === 9) kids.push(folder('新建文件夹', [], 'EMPTY'))
      bar.push(folder(f === 2 ? 'css框架' : f === 7 ? 'js处理' : `文件夹${f}`, kids, `F${f}`))
    }
    bar.push(bm(), bm(), bm())
    return treeOf(bar, [bm(), bm()])
  }

  it('生成方案 → 校验无错 → 应用 → 每条到位 → 撤销 → 指纹一致', async () => {
    const api = createFakeBookmarks(realisticTree())
    const store = createMemoryStore()
    const nodes = api.dump()
    const flat = flattenTree(nodes)
    expect(flat.bookmarks.length).toBeGreaterThan(350)
    const tax: TaxonomyNode[] = [
      { name: '前端基础', desc: '', children: [{ name: 'JS', desc: '' }, { name: 'CSS', desc: '' }, { name: '浏览器', desc: '' }] },
      { name: 'Vue', desc: '', children: [{ name: '组件', desc: '' }, { name: '工程', desc: '' }] },
      { name: '小程序', desc: '' },
      { name: 'AI', desc: '', children: [{ name: '工具', desc: '' }, { name: '教程', desc: '' }] },
      { name: '工具', desc: '' },
      { name: '学习', desc: '', children: [{ name: '课程', desc: '' }, { name: '社区', desc: '' }] },
      { name: '文档', desc: '' }
    ]
    const leaves = ['前端基础/JS', '前端基础/CSS', '前端基础/浏览器', 'Vue/组件', 'Vue/工程', '小程序', 'AI/工具', 'AI/教程', '工具', '学习/课程', '学习/社区', '文档']
    const rand = rng(7)
    const cls = flat.bookmarks.map((b) => ({ id: b.id, path: leaves[Math.floor(rand() * leaves.length)], confidence: 0.6 + rand() * 0.4 }))
    const { plan } = buildPlan({
      flat,
      nodes,
      taxonomy: tax,
      classify: cls,
      meta: {},
      pageInfos: {},
      options: { maxTop: 8, emoji: false, ruleTitles: true, lockedFolderIds: ['LOCK'], keepLooseBarItems: true },
      barRootId: '1',
      otherRootId: '2',
      now: 1
    })
    expect(validatePlan(plan)).toEqual([])
    const before = treeFingerprint(api.dump())

    const log = await applyPlan(api, plan, store)
    expect(log.status).toBe('done')
    expect(log.report?.mismatches).toEqual([])
    for (const it of plan.items) {
      expect(await parentOf(api, it.bookmarkId)).toBe(log.createdFolders[it.target])
      expect((await api.get(it.bookmarkId))[0].title).toMatch(/^文章 \d+$/)
    }
    const bar = await childTitles(api, '1')
    expect(bar.slice(0, 7)).toEqual(['前端基础', 'Vue', '小程序', 'AI', '工具', '学习', '文档'])
    expect(bar.slice(7)).toEqual(['受保护资料', '文章 395_某某的博客-CSDN博客', '文章 396_某某的博客-CSDN博客', '文章 397_某某的博客-CSDN博客'].map((t, i) => (i === 0 ? t : bar[7 + i])))
    expect(await childTitles(api, 'LOCK')).toHaveLength(3)

    const undone = await undoApply(api, log, (await store.getSnapshot(log.snapshotId))!, store)
    expect(undone.status).toBe('undone')
    expect(treeFingerprint(api.dump())).toBe(before)
  })

  it('改了方案（一条改去待清理）也能往返', async () => {
    const api = createFakeBookmarks(sampleTree())
    const store = createMemoryStore()
    const plan = setItemTarget(planFor(api.dump()), 'o0', CLEANUP)
    const before = treeFingerprint(api.dump())
    const log = await applyPlan(api, plan, store)
    expect((await api.getChildren('2')).map((n) => n.title)).toEqual([CLEANUP_NAME, HOLDING_NAME])
    expect(INBOX_NAME).toBe('待整理')
    await undoApply(api, log, (await store.getSnapshot(log.snapshotId))!, store)
    expect(treeFingerprint(api.dump())).toBe(before)
  })
})

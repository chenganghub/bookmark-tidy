import { describe, expect, it } from 'vitest'
import { applyPlan } from '../src/core/apply'
import {
  buildPlan,
  CLEANUP,
  deleteFolder,
  finalTitle,
  folderDisplayName,
  INBOX,
  mergeFolders,
  oversizedLeaves,
  planStats,
  renameFolder,
  reusedFolders,
  splitFolder,
  splitTakenNames,
  setAllRuleTitles,
  setItemEnabled,
  setItemTarget,
  setTitleChoice,
  validatePlan
} from '../src/core/plan'
import { flattenTree } from '../src/core/tree'
import type { BookmarkNode, ClassifyOutput, PlanOptions, TaxonomyNode } from '../src/core/types'
import { createFakeBookmarks, folder, link, treeOf } from '../src/core/memory-bookmarks'
import { createMemoryStore } from './helpers/memory-store'

const options = (patch: Partial<PlanOptions> = {}): PlanOptions => ({ maxTop: 8, emoji: false, ruleTitles: true, lockedFolderIds: ['LOCK'], keepLooseBarItems: true, ...patch })

/** 书签栏：Vue（v1..v5）、CSS（c1..c4，含子文件夹）、锁定的「受保护资料」、散放一条；其他书签：待整理、待清理、整理前的空文件夹 */
function sampleTree(): BookmarkNode[] {
  const v = Array.from({ length: 5 }, (_, i) => link(`Vue 文章 ${i} - 知乎`, `https://zhuanlan.zhihu.com/p/${i}`, { dateAdded: 1000 + i }, `v${i}`))
  const c = Array.from({ length: 4 }, (_, i) => link(`CSS ${i}`, `https://css.com/${i}`, {}, `c${i}`))
  return treeOf(
    [
      folder('vue 资料', v, 'FV'),
      folder('css框架', [folder('css', c, 'FCSS')], 'FC'),
      folder('受保护资料', [link('公司文档', 'https://x.feishu.cn/docx/1', {}, 'w1')], 'LOCK'),
      link('散放', 'https://loose.com', {}, 'loose')
    ],
    [
      folder('待整理', [link('收件箱里的', 'https://inbox.com', {}, 'in1')], 'FIN'),
      folder('待清理', [link('已经在待清理', 'https://dead.com', {}, 'cl1')], 'FCL'),
      folder('整理前的空文件夹', [folder('旧', [], 'OLD')], 'FHOLD'),
      link('其他散放', 'https://other.com', {}, 'o1'),
      link('其他散放 2', 'https://other2.com', {}, 'o2')
    ],
    [link('手机上的', 'https://m.com', {}, 'm1')]
  )
}

const taxonomy: TaxonomyNode[] = [
  { name: '前端', desc: '前端', children: [{ name: 'Vue', desc: 'vue' }, { name: 'CSS', desc: 'css' }] },
  { name: '杂项', desc: '杂' }
]

function build(patch: { classify?: ClassifyOutput[]; options?: Partial<PlanOptions>; tree?: BookmarkNode[]; pageInfos?: Record<string, never>; meta?: Record<string, never> } = {}) {
  const nodes = patch.tree ?? sampleTree()
  const flat = flattenTree(nodes)
  const classify = patch.classify ?? [
    ...['v0', 'v1', 'v2', 'v3', 'v4'].map((id) => ({ id, path: '前端/Vue', confidence: 0.9 })),
    ...['c0', 'c1', 'c2', 'c3'].map((id) => ({ id, path: '前端/CSS', confidence: 0.9 })),
    { id: 'in1', path: '杂项', confidence: 0.9 },
    { id: 'o1', path: '杂项', confidence: 0.9 },
    { id: 'o2', path: '杂项', confidence: 0.9 }
  ]
  return buildPlan({ flat, nodes, taxonomy, classify, meta: patch.meta ?? {}, pageInfos: patch.pageInfos ?? {}, options: options(patch.options), barRootId: '1', otherRootId: '2', now: 7 })
}

describe('buildPlan', () => {
  it('参与范围：不含锁定、散放、待清理、整理前的空文件夹、移动设备；含待整理和其他书签散放', () => {
    const { plan } = build()
    expect(plan.items.map((i) => i.bookmarkId).sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'in1', 'o1', 'o2', 'v0', 'v1', 'v2', 'v3', 'v4'])
    const withLoose = build({ options: { keepLooseBarItems: false } }).plan
    expect(withLoose.items.map((i) => i.bookmarkId)).toContain('loose')
  })

  it('目标映射；低置信度、不在树上、没有结果进待整理并带原因', () => {
    const { plan } = build({
      classify: [
        { id: 'v0', path: '前端/Vue', confidence: 0.9 },
        { id: 'v1', path: '前端/Vue', confidence: 0.59 },
        { id: 'v2', path: '不存在', confidence: 0.9 },
        { id: 'v3', path: '', confidence: 0.9 }
      ],
      options: { lockedFolderIds: ['LOCK'] }
    })
    const by = Object.fromEntries(plan.items.map((i) => [i.bookmarkId, [i.target, i.reason]]))
    expect(by.v1).toEqual([INBOX, 'low-confidence'])
    expect(by.v2).toEqual([INBOX, 'not-in-tree'])
    expect(by.v3).toEqual([INBOX, 'not-in-tree'])
    expect(by.v4).toEqual([INBOX, 'ai-failed'])
  })

  it('失效进待清理；重复保留最近打开 → 最早添加 → id 最小的', () => {
    const tree = treeOf([
      folder(
        'F',
        [
          link('a', 'https://dup.com/x', { dateAdded: 5 }, 'd1'),
          link('b', 'http://www.dup.com/x/?utm_source=1', { dateAdded: 3 }, 'd2'),
          link('c', 'https://dup.com/x#top', { dateAdded: 9, dateLastUsed: 100 }, 'd3'),
          link('dead', 'https://gone.com', {}, 'g1'),
          link('e', 'https://same.com', { dateAdded: 1 }, '20'),
          link('f', 'https://same.com', { dateAdded: 1 }, '3')
        ],
        'F'
      )
    ])
    const { plan } = build({ tree, classify: [], pageInfos: { 'https://gone.com': { url: 'https://gone.com', status: 'dead', fetchedAt: 0 } } as never })
    const by = Object.fromEntries(plan.items.map((i) => [i.bookmarkId, [i.target, i.reason]]))
    expect(by.g1).toEqual([CLEANUP, 'dead'])
    expect(by.d3[0]).toBe(INBOX) // 最近打开过，保留
    expect(by.d1).toEqual([CLEANUP, 'duplicate'])
    expect(by.d2).toEqual([CLEANUP, 'duplicate'])
    expect(by['3'][0]).toBe(INBOX) // id 小的保留（按数字比）
    expect(by['20']).toEqual([CLEANUP, 'duplicate'])
  })

  it('ruleTitle 和 aiTitle 只在不同时有；默认用规则标题、不用 AI 标题', () => {
    const { plan } = build({ meta: { v0: { desc: 'd', title: 'Vue 文章 0', tags: [], type: '文章', updatedAt: 0 }, c0: { desc: 'd', title: 'CSS 0', tags: [], type: '文章', updatedAt: 0 } } as never })
    const v0 = plan.items.find((i) => i.bookmarkId === 'v0')!
    expect(v0.ruleTitle).toBe('Vue 文章 0')
    expect(v0.aiTitle).toBe('Vue 文章 0')
    expect(v0.useRuleTitle).toBe(true)
    expect(v0.useAiTitle).toBe(false)
    const c0 = plan.items.find((i) => i.bookmarkId === 'c0')!
    expect(c0.ruleTitle).toBeUndefined()
    expect(c0.aiTitle).toBeUndefined()
    expect(build({ options: { ruleTitles: false } }).plan.items.find((i) => i.bookmarkId === 'v0')!.useRuleTitle).toBe(false)
  })

  it('旧文件夹：书签栏和其他书签的顶层文件夹，不含锁定和三个特殊文件夹', () => {
    const { plan } = build()
    expect(plan.oldFolderIds.sort()).toEqual(['FC', 'FV'])
  })

  it('规整：子目录不到 3 条上提；没有子目录的顶层不到 3 条进待整理', () => {
    const { plan, issues } = build({
      classify: [
        ...['v0', 'v1', 'v2', 'v3', 'v4'].map((id) => ({ id, path: '前端/Vue', confidence: 0.9 })),
        { id: 'c0', path: '前端/CSS', confidence: 0.9 },
        { id: 'c1', path: '前端/CSS', confidence: 0.9 },
        { id: 'in1', path: '杂项', confidence: 0.9 }
      ]
    })
    expect(plan.folders.map((f) => f.name)).toEqual(['前端'])
    expect(plan.folders[0].children.map((c) => c.name)).toEqual(['Vue'])
    const by = Object.fromEntries(plan.items.map((i) => [i.bookmarkId, i.target]))
    expect(by.c0).toBe('前端')
    expect(by.in1).toBe(INBOX)
    expect(issues.join('\n')).toMatch(/前端\/CSS」只有 2 条/)
    expect(issues.join('\n')).toMatch(/杂项」只有 1 条/)
  })

  it('validatePlan：超过 40 条、顶层超数、目标不存在都报', () => {
    const many = Array.from({ length: 45 }, (_, i) => link(`l${i}`, `https://m.com/${i}`, {}, `m${i}`))
    const tree = treeOf([folder('多', many, 'FM')])
    const { plan } = build({ tree, classify: many.map((n) => ({ id: n.id, path: '杂项', confidence: 0.9 })) })
    expect(validatePlan(plan).join('\n')).toMatch(/「杂项」有 45 条，超过 40 条/)
    const over = { ...plan, options: { ...plan.options, maxTop: 0 } }
    expect(validatePlan(over).join('\n')).toMatch(/超过上限 0/)
    const orphan = setItemTarget(plan, 'm0', '没有这个目录')
    expect(validatePlan(orphan).join('\n')).toMatch(/1 条的目标目录不存在/)
  })

  it('正常方案没有问题；emoji 开关', () => {
    expect(validatePlan(build().plan)).toEqual([])
    const withEmoji = buildPlan({
      flat: flattenTree(sampleTree()),
      nodes: sampleTree(),
      taxonomy: [{ name: '杂项', desc: '', emoji: '📦' }],
      classify: ['v0', 'v1', 'v2'].map((id) => ({ id, path: '杂项', confidence: 1 })),
      meta: {},
      pageInfos: {},
      options: options({ emoji: true }),
      barRootId: '1',
      otherRootId: '2',
      now: 1
    }).plan
    expect(folderDisplayName(withEmoji.folders[0], true)).toBe('📦 杂项')
    expect(folderDisplayName(withEmoji.folders[0], false)).toBe('杂项')
    expect(build().plan.folders[0].emoji).toBeUndefined()
  })
})

describe('预览编辑', () => {
  it('都不改入参，也不碰书签', () => {
    const api = createFakeBookmarks(sampleTree())
    const { plan } = build()
    const before = structuredClone(plan)
    const edits = [
      renameFolder(plan, '前端', '前端开发'),
      mergeFolders(plan, '前端/CSS', '前端/Vue'),
      mergeFolders(plan, '杂项', '前端'),
      deleteFolder(plan, '前端'),
      setItemTarget(plan, 'v0', CLEANUP),
      setItemEnabled(plan, 'v0', false),
      setTitleChoice(plan, 'v0', { useAiTitle: true, useRuleTitle: false }),
      setAllRuleTitles(plan, false)
    ]
    expect(plan).toEqual(before)
    expect(edits.every((p) => p !== plan)).toBe(true)
    expect(api.writes()).toBe(0)
  })

  it('改名、合并子目录、合并顶层、删目录', () => {
    const { plan } = build()
    expect(renameFolder(plan, '前端/Vue', ' Vue 3 ').folders[0].children[0].name).toBe('Vue 3')
    expect(renameFolder(plan, '前端', '  ').folders[0].name).toBe('前端')

    const m1 = mergeFolders(plan, '前端/CSS', '前端/Vue')
    expect(m1.folders[0].children.map((c) => c.key)).toEqual(['前端/Vue'])
    expect(m1.items.filter((i) => i.target === '前端/Vue')).toHaveLength(9)

    const m2 = mergeFolders(plan, '前端', '杂项')
    expect(m2.folders.map((f) => f.key)).toEqual(['杂项'])
    expect(m2.folders[0].children.map((c) => c.key)).toEqual(['杂项/Vue', '杂项/CSS'])
    expect(m2.items.filter((i) => i.target === '杂项/Vue')).toHaveLength(5)

    expect(mergeFolders(plan, '前端', '前端/Vue')).toEqual(plan) // 并进自己的子目录不做

    const d = deleteFolder(plan, '前端')
    expect(d.folders.map((f) => f.key)).toEqual(['杂项'])
    expect(d.items.filter((i) => i.target === INBOX && i.reason === 'manual')).toHaveLength(9)
  })

  it('单条改目标、取消勾选、标题选择；统计和最终标题', () => {
    let p = build().plan
    p = setItemTarget(p, 'v0', CLEANUP)
    expect(p.items.find((i) => i.bookmarkId === 'v0')).toMatchObject({ target: CLEANUP, reason: 'manual' })
    p = setItemEnabled(p, 'v1', false)
    p = setTitleChoice(p, 'c0', { useAiTitle: true }) // 没有 AI 标题，开不了
    expect(p.items.find((i) => i.bookmarkId === 'c0')!.useAiTitle).toBe(false)
    const v2 = p.items.find((i) => i.bookmarkId === 'v2')!
    expect(finalTitle(v2, v2.base.title)).toBe('Vue 文章 2')
    expect(finalTitle({ ...v2, useRuleTitle: false }, v2.base.title)).toBe('Vue 文章 2 - 知乎')
    expect(finalTitle({ ...v2, aiTitle: 'AI 的', useAiTitle: true }, v2.base.title)).toBe('AI 的')
    const s = planStats(p)
    expect(s).toMatchObject({ total: 12, moving: 11, disabled: 1, cleanup: 1, inbox: 0 })
    expect(s.renaming).toBe(4) // v0 v2 v3 v4 的「 - 知乎」（v1 取消了）
    expect(s.perFolder['前端/Vue']).toBe(3)
    p = setAllRuleTitles(p, false)
    expect(planStats(p).renaming).toBe(0)
    expect(p.options.ruleTitles).toBe(false)
  })

  it('复用同名文件夹：已经在目标里的不算移动，和应用结果对得上', async () => {
    // 顶层「杂项」、子目录「前端/Vue」、「待整理」都已存在，各有 1 条已经在位
    const x = (n: number) => link(`v ${n}`, `https://v${n}.com`, {}, `x${n}`)
    const tree = treeOf(
      [
        folder('杂项', [link('已在杂项', 'https://a.com', {}, 'z1')], 'FZ'),
        folder('前端', [folder('Vue', [link('已在 Vue', 'https://vue.com', {}, 'q1')], 'FQ')], 'FF'),
        folder('vue 资料', [x(1), x(2), x(3), x(4)], 'FV')
      ],
      [folder('待整理', [link('收件箱', 'https://in.com', {}, 'in1')], 'FIN')],
      []
    )
    const flat = flattenTree(tree)
    const { plan } = build({
      tree,
      options: { lockedFolderIds: [] },
      classify: [
        { id: 'z1', path: '杂项', confidence: 0.9 },
        { id: 'x3', path: '杂项', confidence: 0.9 },
        { id: 'x4', path: '杂项', confidence: 0.9 },
        { id: 'q1', path: '前端/Vue', confidence: 0.9 },
        { id: 'x1', path: '前端/Vue', confidence: 0.9 },
        { id: 'x2', path: '前端/Vue', confidence: 0.9 },
        { id: 'in1', path: '', confidence: 0.9 }
      ]
    })
    const reused = reusedFolders(plan, flat)
    expect(reused).toEqual({ 杂项: 'FZ', 前端: 'FF', '前端/Vue': 'FQ', [INBOX]: 'FIN' })
    const s = planStats(plan, reused)
    expect(s.moving).toBe(4) // x1..x4；z1、q1、in1 已经在目标里
    expect(planStats(plan).moving).toBe(7) // 不给 reused 时按全部启用的条目算

    // 真跑一次应用：报告里的「移动」就是预估的数
    const api = createFakeBookmarks(tree)
    const log = await applyPlan(api, plan, createMemoryStore())
    expect(log.report!.moved).toBe(s.moving)

    // 锁定的同名文件夹不复用
    const locked = { ...plan, options: { ...plan.options, lockedFolderIds: ['FZ'] } }
    expect(reusedFolders(locked, flat)['杂项']).toBeUndefined()
  })
})

describe('拆细太大的目录', () => {
  /** 前端/Vue 45 条（超了）、前端/CSS 4 条、杂项 3 条 */
  function bigPlan() {
    const v = Array.from({ length: 45 }, (_, i) => link(`Vue ${i}`, `https://vue.com/${i}`, {}, `v${i}`))
    const c = Array.from({ length: 4 }, (_, i) => link(`CSS ${i}`, `https://css.com/${i}`, {}, `c${i}`))
    const z = Array.from({ length: 3 }, (_, i) => link(`杂 ${i}`, `https://z.com/${i}`, {}, `z${i}`))
    const tree = treeOf([folder('旧', [...v, ...c, ...z], 'OLD')], [], [])
    return build({
      tree,
      options: { lockedFolderIds: [] },
      classify: [...v.map((b) => ({ id: b.id!, path: '前端/Vue', confidence: 0.9 })), ...c.map((b) => ({ id: b.id!, path: '前端/CSS', confidence: 0.9 })), ...z.map((b) => ({ id: b.id!, path: '杂项', confidence: 0.9 }))]
    }).plan
  }
  const half = (n: number, a: string, b: string) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`v${i}`, i % 2 ? b : a]))

  it('找出超过 40 条的末级目录；不能用的名字是上一层和兄弟目录', () => {
    const plan = bigPlan()
    expect(oversizedLeaves(plan).map((x) => [x.key, x.path, x.bookmarkIds.length])).toEqual([['前端/Vue', '前端/Vue', 45]])
    expect(splitTakenNames(plan, '前端/Vue')).toEqual(['前端', 'CSS'])
    expect(splitTakenNames(plan, '杂项')).toEqual(['杂项'])
  })

  it('拆子目录：新目录替换它、排在原位置；没分到的放顶层', () => {
    const plan = bigPlan()
    const assign = half(44, 'Vue 基础', 'Vue 组件') // v44 没分到
    const next = splitFolder(plan, '前端/Vue', [{ name: 'Vue 基础', desc: 'a' }, { name: 'Vue 组件', desc: 'b' }], assign)
    expect(next.folders.find((f) => f.key === '前端')!.children.map((c) => [c.key, c.name])).toEqual([
      ['前端/Vue 基础', 'Vue 基础'],
      ['前端/Vue 组件', 'Vue 组件'],
      ['前端/CSS', 'CSS']
    ])
    expect(next.items.find((i) => i.bookmarkId === 'v0')!.target).toBe('前端/Vue 基础')
    expect(next.items.find((i) => i.bookmarkId === 'v1')!.target).toBe('前端/Vue 组件')
    expect(next.items.find((i) => i.bookmarkId === 'v44')!.target).toBe('前端')
    expect(oversizedLeaves(next)).toEqual([])
    expect(validatePlan(next)).toEqual([])
    expect(plan.folders.find((f) => f.key === '前端')!.children).toHaveLength(2) // 不改入参
  })

  it('拆没有子目录的顶层：新目录成为它的子目录', () => {
    const plan = bigPlan()
    // 把 Vue 的条目都改到「杂项」，杂项 48 条
    const moved = { ...plan, items: plan.items.map((i) => (i.target === '前端/Vue' ? { ...i, target: '杂项' } : i)) }
    const assign = { ...half(45, '常用', '收藏'), z0: '常用', z1: '收藏', z2: '常用' }
    const next = splitFolder(moved, '杂项', [{ name: '常用', desc: '' }, { name: '收藏', desc: '' }], assign)
    expect(next.folders.find((f) => f.key === '杂项')!.children.map((c) => c.key)).toEqual(['杂项/常用', '杂项/收藏'])
    expect(next.items.filter((i) => i.target === '杂项')).toEqual([])
  })

  it('分完不到 3 条的新目录并回顶层；剩不到 2 个就不拆；不能用的名字跳过', () => {
    const plan = bigPlan()
    const assign = { ...half(43, 'A', 'B'), v43: '小', v44: '小' }
    const next = splitFolder(plan, '前端/Vue', [{ name: 'A', desc: '' }, { name: 'B', desc: '' }, { name: '小', desc: '' }], assign)
    expect(next.folders.find((f) => f.key === '前端')!.children.map((c) => c.name)).toEqual(['A', 'B', 'CSS'])
    expect(next.items.filter((i) => i.bookmarkId === 'v43' || i.bookmarkId === 'v44').map((i) => i.target)).toEqual(['前端', '前端'])

    const one = Object.fromEntries(Array.from({ length: 45 }, (_, i) => [`v${i}`, 'A']))
    expect(splitFolder(plan, '前端/Vue', [{ name: 'A', desc: '' }, { name: 'B', desc: '' }], one)).toBe(plan)
    // 「CSS」是兄弟目录、「前端」是上一层：都不能用，剩一个就不拆
    expect(splitFolder(plan, '前端/Vue', [{ name: 'CSS', desc: '' }, { name: '前端', desc: '' }, { name: 'A', desc: '' }], half(45, 'A', 'CSS'))).toBe(plan)
    // 不是末级目录不拆
    expect(splitFolder(plan, '前端', [{ name: 'A', desc: '' }, { name: 'B', desc: '' }], {})).toBe(plan)
  })
})

import { describe, expect, it } from 'vitest'
import { candidateFolders, checkJob, decideMove, findDuplicate, isOrganized, sameUrl, unfiledBookmarks } from '../src/core/auto'
import { flattenTree } from '../src/core/tree'
import { folder, link, treeOf } from '../src/core/memory-bookmarks'
import type { AutoJob, AutoRecord, BookmarkMeta, Plan } from '../src/core/types'

const NOW = 2_000_000_000_000
const DAY = 86400000

/** 整理后的样子：书签栏 前端（Vue、CSS 两个子目录，前端自己也直接放着一条）、AI 工具、锁定的「受保护资料」、散放一条；其他书签：待整理、待清理、整理前的空文件夹、根下散放；手机上一条 */
function organizedTree() {
  return treeOf(
    [
      folder('前端', [
        folder('Vue', [link('Vue 文档', 'https://cn.vuejs.org/guide', { dateAdded: 1 }, 'v1')], 'FV'),
        folder('CSS', [link('CSS 技巧', 'https://css.com/1', { dateAdded: 1 }, 'c1')], 'FC'),
        link('前端周刊', 'https://weekly.com/', { dateAdded: 1 }, 'f1')
      ], 'FE'),
      folder('AI 工具', [link('ChatGPT', 'https://chatgpt.com/', { dateAdded: 1 }, 'a1')], 'FAI'),
      folder('UI/UX', [], 'FUI'),
      folder('受保护资料', [folder('文档', [link('公司文档', 'https://x.feishu.cn/docx/1', { dateAdded: 1 }, 'w1')], 'LSUB')], 'LOCK'),
      link('散放', 'https://loose.com', { dateAdded: NOW - DAY }, 'loose')
    ],
    [
      folder('待整理', [link('收件箱里的', 'https://inbox.com', { dateAdded: 1 }, 'in1')], 'FIN'),
      folder('待清理', [link('待清理的', 'https://dead.com', { dateAdded: NOW - DAY }, 'cl1')], 'FCL'),
      // 「整理前的空文件夹」里新加了一条（没有说明、整理后才加）：本来会算「新加的」，要被排除掉
      folder('整理前的空文件夹', [folder('旧', [link('旧目录里新加的', 'https://old.com', { dateAdded: NOW - DAY }, 'h1')], 'OLD')], 'FHOLD'),
      link('其他根下的', 'https://other.com', { dateAdded: 1 }, 'o1'),
      link('设置页', 'chrome://settings', { dateAdded: NOW - DAY }, 'o2')
    ],
    [link('手机上的', 'https://m.com', { dateAdded: 1 }, 'm1')]
  )
}

const meta = (): BookmarkMeta => ({ desc: 'd', title: '', tags: [], type: '文章', updatedAt: 1 })
const rec = (id: string, status: AutoRecord['status'], at = NOW - DAY): AutoRecord => ({
  bookmarkId: id,
  at,
  source: 'save',
  from: { parentId: '2', index: 0, title: 't' },
  to: { parentId: 'FIN', title: 't' },
  path: '待整理',
  confidence: 0.3,
  status
})

describe('候选目录', () => {
  it('书签栏下前两层、不含锁定；有子目录的顶层只有直接放着书签时才算；名字里的斜杠换成全角', () => {
    const flat = flattenTree(organizedTree())
    const plan = { folders: [{ key: '前端', name: '前端', desc: '前端开发', children: [{ key: '前端/Vue', name: 'Vue', desc: 'Vue 生态', children: [] }] }] } as unknown as Plan
    const c = candidateFolders(flat, '1', new Set(['LOCK']), plan)
    expect(c.paths).toEqual(['前端', '前端/Vue', '前端/CSS', 'AI 工具', 'UI／UX'])
    expect(c.idOf['前端/CSS']).toBe('FC')
    expect(c.descs).toEqual({ 前端: '前端开发', '前端/Vue': 'Vue 生态' })
    expect(c.paths.join()).not.toContain('受保护资料')
  })

  it('顶层有子目录、自己没有直接放书签时不算去处', () => {
    const flat = flattenTree(treeOf([folder('前端', [folder('Vue', [], 'FV')], 'FE')]))
    expect(candidateFolders(flat, '1', new Set()).paths).toEqual(['前端/Vue'])
  })
})

describe('还没放好的新收藏（角标、弹窗的 N，一键整理的范围）', () => {
  const base = (patch: Partial<Parameters<typeof unfiledBookmarks>[0]> = {}) =>
    unfiledBookmarks({
      flat: flattenTree(organizedTree()),
      meta: { v1: meta(), c1: meta(), f1: meta(), a1: meta(), in1: meta(), o1: meta(), m1: meta() },
      records: {},
      lockedIds: new Set(['LOCK']),
      keepLooseBarItems: true,
      organizedAt: NOW - 2 * DAY,
      placed: new Set(),
      ...patch
    }).map((b) => b.id)

  it('其他书签根下的、手机上的（有说明也算）；不含待整理（在待处理里）、锁定、待清理、整理前的空文件夹（里面新加的也不算）、散放、非 http', () => {
    expect(base()).toEqual(['o1', 'm1'])
  })

  it('K1 待整理里放着 6 条、别处没有要放的：N 是 0', () => {
    const flat = flattenTree(treeOf([folder('前端', [], 'FE')], [folder('待整理', [0, 1, 2, 3, 4, 5].map((i) => link(`拿不准 ${i}`, `https://in.com/${i}`, { dateAdded: NOW - 1000 }, `i${i}`)), 'FIN')]))
    expect(base({ flat, meta: {} })).toEqual([])
  })

  it('K3 你定过位置的不算：散放的、新加的都一样', () => {
    expect(base({ placed: new Set(['o1']) })).toEqual(['m1'])
    const flat = flattenTree(treeOf([folder('前端', [link('新收藏', 'https://new.com', { dateAdded: NOW - 1000 }, 'n1')], 'FE')]))
    expect(base({ flat, meta: {} })).toEqual(['n1'])
    expect(base({ flat, meta: {}, placed: new Set(['n1']) })).toEqual([])
  })

  it('整理之后新加、还没有说明的也算（锁定的除外）', () => {
    const flat = flattenTree(
      treeOf([folder('前端', [link('新收藏', 'https://new.com', { dateAdded: NOW - 1000 }, 'n1')], 'FE'), folder('受保护资料', [link('新公司文档', 'https://y.feishu.cn', { dateAdded: NOW - 1000 }, 'n2')], 'LOCK')])
    )
    expect(base({ flat, meta: {} })).toEqual(['n1'])
  })

  it('撤销过、用户挪过的不算；待整理里的过多久都不算（不再 7 天后重新算）', () => {
    expect(base({ records: { o1: rec('o1', 'undone'), m1: rec('m1', 'moved-by-user') } })).toEqual([])
    expect(base({ records: { in1: rec('in1', 'inbox', NOW - 30 * DAY) } })).toEqual(['o1', 'm1'])
  })

  it('散放的设置关掉后，书签栏上散放的、整理后新加的也算', () => {
    expect(base({ keepLooseBarItems: false, meta: {} })).toContain('loose')
  })

  it('手机上的只算根下直接放着的；撤销、恢复重建的（新 id、没有说明）不算「新加的」，放在根下的照样算', () => {
    const flat = flattenTree(
      treeOf(
        [folder('前端', [link('重建的', 'https://rebuilt.com', { dateAdded: NOW - 1000 }, 'r1'), link('新收藏', 'https://new.com', { dateAdded: NOW - 1000 }, 'n1')], 'FE')],
        [link('重建在根下的', 'https://r2.com', { dateAdded: NOW - 1000 }, 'r2')],
        [folder('手机上的文件夹', [link('手机子目录里的', 'https://m2.com', { dateAdded: 1 }, 'm2')], 'MF'), link('手机上的', 'https://m.com', { dateAdded: 1 }, 'm1')]
      )
    )
    expect(base({ flat, meta: { m1: meta(), m2: meta() }, own: new Set(['r1', 'r2']) }).sort()).toEqual(['m1', 'n1', 'r2'])
  })
})

describe('一条收藏还能不能动', () => {
  const job = (patch: Partial<AutoJob> = {}): AutoJob => ({ bookmarkId: 'n1', url: 'https://new.com', parentId: '2', index: 0, title: '新收藏', createdAt: NOW, dueAt: NOW + 8000, ...patch })
  const flatWith = (node: Parameters<typeof link>, where: 'other' | 'locked' | 'cleanup' = 'other') =>
    flattenTree(
      treeOf(
        [folder('受保护资料', where === 'locked' ? [link(...node)] : [], 'LOCK')],
        [folder('待清理', where === 'cleanup' ? [link(...node)] : [], 'FCL'), ...(where === 'other' ? [link(...node)] : [])]
      )
    )
  const ctx = (patch = {}) => ({ lockedIds: new Set(['LOCK']), records: {}, own: new Set<string>(), ...patch })

  it('没被动过', () => {
    expect(checkJob(job(), flatWith(['新收藏', 'https://new.com', {}, 'n1']), ctx())).toEqual({ userMoved: false, userRetitled: false })
  })

  it('用户挪过、改过标题', () => {
    expect(checkJob(job({ parentId: '1' }), flatWith(['改了的标题', 'https://new.com', {}, 'n1']), ctx())).toEqual({ userMoved: true, userRetitled: true })
  })

  it('丢弃：重建的、处理过的、没了、网址变了、进了锁定、进了待清理', () => {
    const flat = flatWith(['新收藏', 'https://new.com', {}, 'n1'])
    expect(checkJob(job(), flat, ctx({ own: new Set(['n1']) }))).toEqual({ drop: 'own' })
    expect(checkJob(job(), flat, ctx({ records: { n1: rec('n1', 'filed') } }))).toEqual({ drop: 'done-before' })
    expect(checkJob(job({ bookmarkId: 'zz' }), flat, ctx())).toEqual({ drop: 'missing' })
    expect(checkJob(job({ url: 'https://other.com' }), flat, ctx())).toEqual({ drop: 'url-changed' })
    expect(checkJob(job(), flatWith(['新收藏', 'https://new.com', {}, 'n1'], 'locked'), ctx())).toEqual({ drop: 'locked' })
    expect(checkJob(job(), flatWith(['新收藏', 'https://new.com', {}, 'n1'], 'cleanup'), ctx())).toEqual({ drop: 'parked' })
  })
})

describe('放到哪', () => {
  const c = { paths: ['前端/Vue'], idOf: { '前端/Vue': 'FV' }, descs: {} }
  it('把握够、目录在候选里 → 放进去；否则待整理', () => {
    expect(decideMove({ path: '前端/Vue', confidence: 0.85 }, 0.8, c)).toEqual({ kind: 'folder', folderId: 'FV', path: '前端/Vue' })
    expect(decideMove({ path: '前端/Vue', confidence: 0.7 }, 0.8, c)).toEqual({ kind: 'inbox', path: '待整理' })
    expect(decideMove({ path: '不存在', confidence: 0.99 }, 0.8, c)).toEqual({ kind: 'inbox', path: '待整理' })
    expect(decideMove(undefined, 0.8, c)).toEqual({ kind: 'inbox', path: '待整理' })
  })
})

describe('其他', () => {
  it('最近一次应用是完成才算整理过', () => {
    expect(isOrganized(undefined)).toBe(false)
    expect(isOrganized({ status: 'done' } as never)).toBe(true)
    expect(isOrganized({ status: 'undone' } as never)).toBe(false)
    expect(isOrganized({ status: 'running' } as never)).toBe(false)
  })

  it('同一网页：去 #、跟踪参数、www、尾斜杠', () => {
    expect(sameUrl('https://www.a.com/x/?utm_source=1#top', 'http://a.com/x')).toBe(true)
    expect(sameUrl('https://a.com/x?id=1', 'https://a.com/x?id=2')).toBe(false)
    const flat = flattenTree(organizedTree())
    expect(findDuplicate(flat, 'new', 'https://www.chatgpt.com/#a')?.id).toBe('a1')
    expect(findDuplicate(flat, 'a1', 'https://chatgpt.com/')).toBeUndefined()
  })
})

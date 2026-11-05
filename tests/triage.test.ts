import { describe, expect, it } from 'vitest'
import { folder, link, treeOf } from '../src/core/memory-bookmarks'
import { batchRemovable, buildTriage, folderChoices, pendingCount } from '../src/core/triage'
import { flattenTree } from '../src/core/tree'
import type { AutoRecord, PageInfo, Plan } from '../src/core/types'

/** 书签栏：前端（CSS、深/第三层）、AI 工具、锁定的「受保护资料」、空的「新建文件夹」；其他书签：待整理、整理前的空文件夹、待清理 */
const tree = () =>
  treeOf(
    [
      folder('前端', [folder('CSS', [link('CSS 技巧', 'https://css.com/1', {}, 'c1')], 'FC'), folder('深', [folder('第三层', [link('三层里的', 'https://deep.com', {}, 'd1')], 'F3')], 'FD'), link('MDN', 'https://developer.mozilla.org/', {}, 'mdn')], 'FE'),
      folder('AI 工具', [link('ChatGPT', 'https://chatgpt.com/', {}, 'a1')], 'FAI'),
      folder('受保护资料', [folder('空的锁定子目录', [], 'LSUB')], 'LOCK'),
      folder('新建文件夹', [], 'FNEW')
    ],
    [
      folder('待整理', [link('拿不准一', 'https://u1.com', {}, 'u1'), link('拿不准二', 'https://u2.com', {}, 'u2')], 'FIN'),
      folder('整理前的空文件夹', [folder('css框架', [folder('css', [], 'OLD2')], 'OLD1'), folder('js处理', [link('剩下的', 'https://left.com', {}, 'h1')], 'OLD3')], 'FHOLD'),
      folder(
        '待清理',
        [
          link('失效的', 'https://dead.com/a', {}, 'k1'),
          link('MDN 重复', 'https://developer.mozilla.org/?utm_source=x', {}, 'k2'),
          link('只在这里重复 A', 'https://twin.com/', {}, 'k3'),
          link('只在这里重复 B', 'https://www.twin.com', {}, 'k4'),
          link('连不上', 'https://gone.example/', {}, 'k5'),
          link('又能打开了', 'https://back.com/', {}, 'k6')
        ],
        'FCL'
      )
    ]
  )

const pages: Record<string, PageInfo> = {
  'https://dead.com/a': { url: 'https://dead.com/a', status: 'dead', httpStatus: 404, fetchedAt: 1 },
  'https://gone.example/': { url: 'https://gone.example/', status: 'unreachable', fetchedAt: 1 },
  'https://back.com/': { url: 'https://back.com/', status: 'ok', httpStatus: 200, fetchedAt: 1 }
}

const inboxRec = (id: string, guessFolderId?: string): AutoRecord => ({
  bookmarkId: id,
  at: 1,
  source: 'save',
  from: { parentId: '2', index: 0, title: id },
  to: { parentId: 'FIN', title: id },
  path: '待整理',
  confidence: 0.3,
  status: 'inbox',
  ...(guessFolderId ? { guessFolderId } : {})
})

const triage = (patch: Partial<Parameters<typeof buildTriage>[0]> = {}) => buildTriage({ flat: flattenTree(tree()), pages, lockedIds: new Set(['LOCK']), records: {}, ...patch })

describe('待处理', () => {
  it('「放到」的选项：书签栏下前两层，不含锁定的和第三层', () => {
    expect(folderChoices(flattenTree(tree()), new Set(['LOCK']))).toEqual([
      { id: 'FE', path: '前端' },
      { id: 'FC', path: '前端 / CSS' },
      { id: 'FD', path: '前端 / 深' },
      { id: 'FAI', path: 'AI 工具' },
      { id: 'FNEW', path: '新建文件夹' }
    ])
  })

  it('T2 拿不准放哪：待整理里的，加上整理前的空文件夹里还剩的', () => {
    expect(triage().unsure.map((e) => e.bookmark.id)).toEqual(['u1', 'u2', 'h1'])
  })

  it('O3 AI 猜的目录：自动整理的记录优先；目录不能放（锁定、不在了）就不预选；一期方案进待整理的换成应用后的文件夹', () => {
    const plan = {
      barRootId: '1',
      otherRootId: '2',
      options: { maxTop: 8, emoji: false, ruleTitles: true, lockedFolderIds: ['LOCK'], keepLooseBarItems: true },
      folders: [{ key: 'AI 工具', name: 'AI 工具', desc: '', children: [] }],
      items: [
        { bookmarkId: 'u1', target: 'inbox', guess: 'AI 工具' },
        { bookmarkId: 'u2', target: 'inbox', guess: 'AI 工具' },
        { bookmarkId: 'h1', target: 'inbox', guess: '已经没了' }
      ]
    } as unknown as Plan
    const records = { u1: inboxRec('u1', 'FC'), h1: inboxRec('h1', 'LSUB') }
    const got = Object.fromEntries(triage({ records, plan }).unsure.map((e) => [e.bookmark.id, e.guess]))
    expect(got).toEqual({ u1: { id: 'FC', path: '前端 / CSS' }, u2: { id: 'FAI', path: 'AI 工具' }, h1: undefined })
  })

  it('T5 建议删除的原因：失效带状态码；待清理以外还有一条才算重复（写它的路径）；只在待清理里互为重复的、链接又能打开的算「其他」', () => {
    const reasons = Object.fromEntries(triage().cleanup.map((e) => [e.bookmark.id, e.reason]))
    expect(reasons).toEqual({
      k1: { kind: 'dead', httpStatus: 404 },
      k2: { kind: 'duplicate', otherPath: '前端' },
      k3: { kind: 'other' },
      k4: { kind: 'other' },
      k5: { kind: 'unreachable' },
      k6: { kind: 'other' }
    })
  })

  it('T6 批量删只删原因还成立的', () => {
    expect(batchRemovable(triage().cleanup).map((e) => e.bookmark.id)).toEqual(['k1', 'k2', 'k5'])
  })

  it('T8 空文件夹：整棵子树没有书签的，按最上层分组、组里深的在前；不含锁定的和还有书签的', () => {
    expect(triage().empty.map((g) => [g.folder.id, g.ids])).toEqual([
      ['FNEW', ['FNEW']],
      ['OLD1', ['OLD2', 'OLD1']]
    ])
  })

  it('待处理 M：待整理、整理前的空文件夹、待清理里的书签数（空文件夹不算）', () => {
    expect(pendingCount(flattenTree(tree()))).toBe(9)
  })
})

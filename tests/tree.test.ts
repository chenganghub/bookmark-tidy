import { describe, expect, it } from 'vitest'
import { audit } from '../src/core/rules'
import { descendantFolderIds, flattenTree, isUnderFolders, pickRoot, rootTypeOf } from '../src/core/tree'
import type { BookmarkNode } from '../src/core/types'
import { folder, link, treeOf } from '../src/core/memory-bookmarks'

const sample = (): BookmarkNode[] => {
  const t = treeOf(
    [
      folder('css框架', [link('c1', 'https://c.com/1', { dateAdded: 10, dateLastUsed: 20 }, 'c1'), folder('css', [link('c2', 'https://c.com/2', {}, 'c2'), link('c3', 'https://c.com/3', {}, 'c3')], 'CSS')], 'FC'),
      folder('空的', [], 'EMPTY'),
      link('散放', 'https://loose.com', {}, 'L')
    ],
    [link('o1', 'https://o.com', {}, 'o1')],
    [link('m1', 'https://m.com', {}, 'm1')]
  )
  // 管理员配置的书签根
  t[0].children!.push({ id: '9', title: '管理的书签', folderType: 'managed', unmodifiable: 'managed', children: [folder('公司', [link('内网', 'https://intra.com', { unmodifiable: 'managed' }, 'i1')], 'MF')] })
  t[0].children![3].children![0].unmodifiable = 'managed'
  return t
}

describe('flattenTree', () => {
  it('根、书签、文件夹各就各位', () => {
    const flat = flattenTree(sample())
    expect(flat.roots.map((r) => [r.id, r.rootType, r.bookmarks, r.topFolders, r.looseBookmarks])).toEqual([
      ['1', 'bookmarks-bar', 4, 2, 1],
      ['2', 'other', 1, 0, 1],
      ['3', 'mobile', 1, 0, 1],
      ['9', 'managed', 1, 1, 0]
    ])
    const c2 = flat.bookmarks.find((b) => b.id === 'c2')!
    expect(c2).toMatchObject({ parentId: 'CSS', index: 0, path: ['css框架', 'css'], folderIds: ['FC', 'CSS'], rootId: '1', rootType: 'bookmarks-bar', depth: 3 })
    const c1 = flat.bookmarks.find((b) => b.id === 'c1')!
    expect(c1).toMatchObject({ depth: 2, dateAdded: 10, dateLastUsed: 20 })
    expect(flat.bookmarks.find((b) => b.id === 'L')).toMatchObject({ depth: 1, path: [], folderIds: [] })
    expect(flat.bookmarks.find((b) => b.id === 'c3')!.dateLastUsed).toBe(0)

    const fc = flat.folders.find((f) => f.id === 'FC')!
    expect(fc).toMatchObject({ depth: 1, parentTitle: '', path: ['css框架'], directBookmarks: 1, subFolders: 1, totalBookmarks: 3, unmodifiable: false })
    expect(flat.folders.find((f) => f.id === 'CSS')).toMatchObject({ depth: 2, parentTitle: 'css框架', path: ['css框架', 'css'], totalBookmarks: 2 })
    expect(flat.folders.find((f) => f.id === 'MF')!.unmodifiable).toBe(true)
    // 每条的 path 是独立拷贝
    c2.path.push('x')
    expect(flat.bookmarks.find((b) => b.id === 'c3')!.path).toEqual(['css框架', 'css'])
  })

  it('没有 folderType 的旧版树按固定 id 认根', () => {
    const t = sample()
    for (const r of t[0].children!) delete r.folderType
    expect(flattenTree(t).roots.map((r) => r.rootType)).toEqual(['bookmarks-bar', 'other', 'mobile', 'managed'])
    expect(rootTypeOf({ id: '42', title: '认不出' })).toBeUndefined()
  })

  it('结果直接喂给体检', () => {
    const { summary } = audit(flattenTree(sample()), Date.parse('2026-10-31'))
    expect(summary.bookmarks).toBe(7)
    expect(summary.folderIssues.empty).toBe(1)
    expect(summary.folderIssues.nestedSameName).toBe(1)
  })
})

describe('pickRoot', () => {
  it('同类多个根取书签多的；一样多取本机的', () => {
    const t = sample()
    t[0].children!.push({ id: '100', title: '书签栏', folderType: 'bookmarks-bar', syncing: true, children: [link('a', 'https://a', {}, 'acc1')] })
    expect(pickRoot(flattenTree(t), 'bookmarks-bar')?.id).toBe('1')
    t[0].children![0].children = [link('x', 'https://x', {}, 'x1')]
    t[0].children![0].syncing = false
    expect(pickRoot(flattenTree(t), 'bookmarks-bar')?.id).toBe('1') // 一样多（各 1 条），取 syncing false
    t[0].children![4].children!.push(link('b', 'https://b', {}, 'acc2'))
    expect(pickRoot(flattenTree(t), 'bookmarks-bar')?.id).toBe('100')
    expect(pickRoot(flattenTree(t), 'other')?.id).toBe('2')
  })
})

describe('descendantFolderIds / isUnderFolders', () => {
  it('含自己和所有子孙；书签按祖先链判断', () => {
    const flat = flattenTree(sample())
    expect([...descendantFolderIds(flat, ['FC'])].sort()).toEqual(['CSS', 'FC'])
    const set = descendantFolderIds(flat, ['FC'])
    expect(isUnderFolders(flat.bookmarks.find((b) => b.id === 'c2')!, set)).toBe(true)
    expect(isUnderFolders(flat.bookmarks.find((b) => b.id === 'L')!, set)).toBe(false)
    expect(isUnderFolders(flat.bookmarks.find((b) => b.id === 'c2')!, new Set(['FC']))).toBe(true)
  })
})

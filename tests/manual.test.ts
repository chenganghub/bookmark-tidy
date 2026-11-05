import { describe, expect, it } from 'vitest'
import { ensureFolder, moveBookmarks, removeBookmarks, removeFolders, revertChange } from '../src/core/manual'
import { createFakeBookmarks, folder, link, treeOf } from '../src/core/memory-bookmarks'
import type { BookmarksApi } from '../src/core/types'

const titles = async (api: BookmarksApi, id: string) => (await api.getChildren(id)).map((c) => c.title)
const noop = async () => {}
/** 书签栏：F 里 A、B、C、D，空的 G */
const tree = () =>
  treeOf([
    folder('F', [link('A', 'https://a.com', {}, 'A'), link('B', 'https://b.com', {}, 'B'), link('C', 'https://c.com', {}, 'C'), link('D', 'https://d.com', {}, 'D')], 'F'),
    folder('G', [], 'G')
  ])

describe('手动操作和撤销', () => {
  it('T3 同一个文件夹里移走几条，撤销后排回原来的顺序；已经在目标里的不动，不在了的记跳过', async () => {
    const api = createFakeBookmarks(tree())
    const change = await moveBookmarks(api, ['B', 'C', 'nope'], 'G', 1)
    expect(change.moved.map((m) => [m.id, m.from.index])).toEqual([
      ['B', 1],
      ['C', 1]
    ])
    expect(change.skipped).toBe(1)
    expect(await titles(api, 'G')).toEqual(['B', 'C'])
    expect((await moveBookmarks(api, ['B'], 'G', 2)).moved).toEqual([])
    expect(await revertChange(api, change, noop)).toMatchObject({ restored: 2, skipped: 0, movedBack: ['C', 'B'] })
    expect(await titles(api, 'F')).toEqual(['A', 'B', 'C', 'D'])
  })

  it('撤销移动：之后又被挪走的不动、记跳过', async () => {
    const api = createFakeBookmarks(tree())
    const change = await moveBookmarks(api, ['B'], 'G', 1)
    await api.move('B', { parentId: '2' })
    expect(await revertChange(api, change, noop)).toMatchObject({ restored: 0, skipped: 1, movedBack: [] })
    expect((await api.get('B'))[0].parentId).toBe('2')
  })

  it('T7 删同一个文件夹里的几条（两种顺序），撤销后回到原位置，标题、网址不变，id 是新的', async () => {
    for (const order of [
      ['B', 'C'],
      ['C', 'B']
    ]) {
      const api = createFakeBookmarks(tree())
      const change = await removeBookmarks(api, order, 1)
      expect(await titles(api, 'F')).toEqual(['A', 'D'])
      const rebuilt: string[] = []
      await revertChange(api, change, async (oldId, _newId, isBookmark) => void (isBookmark && rebuilt.push(oldId)))
      expect((await api.getChildren('F')).map((k) => [k.title, k.url])).toEqual([
        ['A', 'https://a.com'],
        ['B', 'https://b.com'],
        ['C', 'https://c.com'],
        ['D', 'https://d.com']
      ])
      expect(rebuilt.sort()).toEqual(['B', 'C'])
      expect(change.rebuilt.B).not.toBe('B')
    }
  })

  it('T7 删了书签，后来它所在的文件夹也没了：撤销时按祖先链先把文件夹重建出来', async () => {
    const api = createFakeBookmarks(treeOf([], [folder('待清理', [folder('子', [link('X', 'https://x.com', {}, 'X')], 'SUB')], 'FCL')]))
    const change = await removeBookmarks(api, ['X'], 1)
    await api.remove('SUB')
    await api.remove('FCL')
    await revertChange(api, change, noop)
    const cl = (await api.getChildren('2')).find((c) => c.title === '待清理')!
    const [sub] = await api.getChildren(cl.id)
    expect(sub.title).toBe('子')
    expect(await titles(api, sub.id)).toEqual(['X'])
  })

  it('T8 删空文件夹：按给的顺序（深的在前）删，里面有东西的跳过；撤销后整组按原来的层级和位置回来', async () => {
    const api = createFakeBookmarks(
      treeOf([folder('前', [], 'P0'), folder('旧', [folder('甲', [folder('乙', [], 'Y')], 'X'), folder('丙', [], 'Z')], 'OLD'), folder('后', [], 'P1'), folder('有东西', [link('留着', 'https://keep.com', {}, 'K')], 'KEEP')])
    )
    const change = await removeFolders(api, ['Y', 'X', 'Z', 'OLD', 'KEEP'], 1)
    expect(change.removed.map((r) => r.id)).toEqual(['Y', 'X', 'Z', 'OLD'])
    expect(change.skipped).toBe(1)
    expect(await titles(api, '1')).toEqual(['前', '后', '有东西'])
    await revertChange(api, change, noop)
    expect(await titles(api, '1')).toEqual(['前', '旧', '后', '有东西'])
    const old = (await api.getChildren('1'))[1]
    const kids = await api.getChildren(old.id)
    expect(kids.map((k) => k.title)).toEqual(['甲', '丙'])
    expect(await titles(api, kids[0].id)).toEqual(['乙'])
  })

  it('撤销到一半出错（存储写不进去）：再撤一次从断点接着做，不重复建', async () => {
    const api = createFakeBookmarks(tree())
    const change = await removeBookmarks(api, ['A', 'B', 'C'], 1)
    let calls = 0
    await expect(
      revertChange(api, change, async () => {
        if (++calls === 2) throw new Error('存储写不进去')
      })
    ).rejects.toThrow('存储写不进去')
    await revertChange(api, change, noop)
    expect(await titles(api, 'F')).toEqual(['A', 'B', 'C', 'D'])
  })

  it('T4 新建文件夹：同一个父文件夹下有同名的就用它，锁定的不算', async () => {
    const api = createFakeBookmarks(treeOf([folder('学习', [], 'S'), folder('锁定', [], 'L')]))
    expect(await ensureFolder(api, '1', '学习', new Set())).toBe('S')
    expect(await ensureFolder(api, '1', '锁定', new Set(['L']))).not.toBe('L')
    expect(await titles(api, '1')).toEqual(['学习', '锁定', '锁定'])
  })
})

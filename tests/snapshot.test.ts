import { describe, expect, it } from 'vitest'
import { parseBackup, serializeSnapshot, snapshotNodes, takeSnapshot, treeFingerprint } from '../src/core/snapshot'
import { createFakeBookmarks, folder, link, treeOf } from '../src/core/memory-bookmarks'

const sample = () =>
  treeOf([folder('A', [link('a1', 'https://a.com/1', {}, 'a1'), link('a2', 'https://a.com/2', {}, 'a2')], 'A'), link('loose', 'https://l.com', {}, 'L')], [link('o1', 'https://o.com', {}, 'O')])

describe('snapshot', () => {
  it('snapshotNodes 不含根，index 按实际位置', () => {
    const nodes = snapshotNodes(sample())
    expect(nodes.find((n) => n.id === '0')).toBeUndefined()
    expect(nodes.find((n) => n.id === '1')).toEqual({ id: '1', parentId: '0', index: 0, title: '书签栏' })
    expect(nodes.find((n) => n.id === 'a2')).toEqual({ id: 'a2', parentId: 'A', index: 1, title: 'a2', url: 'https://a.com/2' })
    expect(nodes.find((n) => n.id === 'L')).toMatchObject({ parentId: '1', index: 1 })
  })

  it('takeSnapshot 用接口读整棵树', async () => {
    const api = createFakeBookmarks(sample())
    const s = await takeSnapshot(api, 42)
    expect(s.id).toBe('snap-42')
    expect(s.nodes).toEqual(snapshotNodes(api.dump()))
    expect(api.writes()).toBe(0)
  })

  it('指纹对顺序、标题、网址敏感，对时间字段不敏感', async () => {
    const api = createFakeBookmarks(sample())
    const base = treeFingerprint(api.dump())
    expect(treeFingerprint(api.dump())).toBe(base)
    const withTimes = api.dump()
    withTimes[0].children![0].dateGroupModified = 123
    withTimes[0].children![0].children![0].dateLastUsed = 456
    expect(treeFingerprint(withTimes)).toBe(base)

    await api.move('a2', { parentId: 'A', index: 0 })
    expect(treeFingerprint(api.dump())).not.toBe(base)
    await api.move('a2', { parentId: 'A', index: 2 })
    expect(treeFingerprint(api.dump())).toBe(base)
    await api.update('a1', { title: '改了' })
    expect(treeFingerprint(api.dump())).not.toBe(base)
  })

  it('序列化和解析往返', () => {
    const s = { id: 'snap-1', createdAt: 1, nodes: snapshotNodes(sample()) }
    expect(parseBackup(serializeSnapshot(s))).toEqual(s)
  })

  it.each([
    ['不是 JSON', '{坏'],
    ['缺 nodes', JSON.stringify({ id: 'x' })],
    ['空 nodes', JSON.stringify({ nodes: [] })],
    ['节点缺 id', JSON.stringify({ nodes: [{ title: 't' }] })],
    ['节点缺 title', JSON.stringify({ nodes: [{ id: '1' }] })],
    ['重复 id', JSON.stringify({ nodes: [{ id: '1', title: 'a' }, { id: '1', title: 'b' }] })],
    ['父节点不在备份里', JSON.stringify({ nodes: [{ id: '5', parentId: '99', title: 'a' }] })],
    ['别的格式', JSON.stringify({ format: 'other', nodes: [{ id: '1', title: 'a' }] })],
    ['index 是负数', JSON.stringify({ nodes: [{ id: '1', parentId: '0', index: -1, title: 'a' }] })],
    [
      '父子成环，接不到根上',
      JSON.stringify({
        nodes: [
          { id: '1', parentId: '0', index: 0, title: '书签栏' },
          { id: 'a', parentId: 'b', index: 0, title: 'A' },
          { id: 'b', parentId: 'a', index: 0, title: 'B' }
        ]
      })
    ]
  ])('parseBackup 拒绝坏结构：%s', (_name, json) => {
    expect(() => parseBackup(json)).toThrow()
  })

  it('parseBackup：成环的报错说清有几个节点接不上', () => {
    const json = JSON.stringify({ nodes: [{ id: '1', parentId: '0', title: '书签栏' }, { id: 'a', parentId: 'b', title: 'A' }, { id: 'b', parentId: 'a', title: 'B' }] })
    expect(() => parseBackup(json)).toThrow('2 个节点接不到根上')
  })
})

describe('假书签接口和 Chrome 行为一致', () => {
  const api = () => createFakeBookmarks(treeOf([link('x0', 'https://x/0', {}, 'x0'), link('x1', 'https://x/1', {}, 'x1'), link('x2', 'https://x/2', {}, 'x2'), link('x3', 'https://x/3', {}, 'x3')]))
  const order = async (a: ReturnType<typeof api>) => (await a.getChildren('1')).map((n) => n.id)

  it('同父往后移：index 大于旧位置时实际位置减 1', async () => {
    const a = api()
    await a.move('x0', { parentId: '1', index: 2 })
    expect(await order(a)).toEqual(['x1', 'x0', 'x2', 'x3'])
  })

  it('同父往前移、移到末尾、越界追加', async () => {
    const a = api()
    await a.move('x3', { parentId: '1', index: 0 })
    expect(await order(a)).toEqual(['x3', 'x0', 'x1', 'x2'])
    await a.move('x3', { parentId: '1' })
    expect(await order(a)).toEqual(['x0', 'x1', 'x2', 'x3'])
    await a.move('x0', { parentId: '1', index: 99 })
    expect(await order(a)).toEqual(['x1', 'x2', 'x3', 'x0'])
  })

  it('跨父移动、永久文件夹不能动、非空文件夹不能删、取不到报错', async () => {
    const a = api()
    await a.move('x1', { parentId: '2', index: 0 })
    expect((await a.getChildren('2')).map((n) => n.id)).toEqual(['x1'])
    await expect(a.move('1', { parentId: '2' })).rejects.toThrow()
    await expect(a.update('2', { title: '改名' })).rejects.toThrow()
    await expect(a.remove('1')).rejects.toThrow()
    const f = await a.create({ parentId: '1', title: 'F' })
    await a.create({ parentId: f.id, title: 'in', url: 'https://in' })
    await expect(a.remove(f.id)).rejects.toThrow()
    await expect(a.get('nope')).rejects.toThrow("Can't find bookmark for id.")
    expect((await a.create({ title: '默认放其他书签', url: 'https://d' })).parentId).toBe('2')
  })

  it('failAfter 之后的写操作抛错', async () => {
    const a = api()
    a.failAfter(1)
    await a.move('x0', { parentId: '2' })
    await expect(a.move('x1', { parentId: '2' })).rejects.toThrow()
    expect(a.writes()).toBe(1)
  })
})

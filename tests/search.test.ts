import { describe, expect, it } from 'vitest'
import { buildIndex, searchBookmarks } from '../src/core/search'
import { flattenTree } from '../src/core/tree'
import { folder, link, treeOf } from '../src/core/memory-bookmarks'
import type { BookmarkMeta } from '../src/core/types'

const meta = (desc: string, tags: string[] = [], title = ''): BookmarkMeta => ({ desc, tags, title, type: '文章', updatedAt: 1 })

function index() {
  const flat = flattenTree(
    treeOf([
      folder('前端', [
        link('Vue 响应式原理', 'https://juejin.cn/post/1', { dateAdded: 1, dateLastUsed: 0 }, 'a'),
        link('随便一篇', 'https://blog.csdn.net/x/article/details/2', { dateAdded: 2 }, 'b'),
        link('uniapp 权限', 'https://ask.dcloud.net.cn/3', { dateAdded: 3, dateLastUsed: 50 }, 'c')
      ], 'F1'),
      folder('AI 工具', [link('ChatGPT', 'https://chatgpt.com/', { dateAdded: 4 }, 'd')], 'F2')
    ])
  )
  return buildIndex(flat, {
    a: meta('讲 Proxy 和依赖收集', ['Vue']),
    b: meta('响应式数据怎么调试', ['调试'], 'Vue 调试技巧'),
    c: meta('检查权限并跳到系统设置', ['uniapp', '权限']),
    d: meta('和 AI 对话', ['AI'])
  })
}

describe('搜索', () => {
  it('多个词都要命中；标题命中排前面', () => {
    const r = searchBookmarks(index(), '响应式')
    expect(r.map((x) => x.id)).toEqual(['a', 'b'])
    expect(searchBookmarks(index(), 'vue 调试').map((x) => x.id)).toEqual(['b'])
  })

  it('能搜说明、标签、网址、目录名；不分大小写', () => {
    expect(searchBookmarks(index(), '依赖收集').map((x) => x.id)).toEqual(['a'])
    expect(searchBookmarks(index(), 'UNIAPP').map((x) => x.id)).toEqual(['c'])
    expect(searchBookmarks(index(), 'chatgpt.com').map((x) => x.id)).toEqual(['d'])
    expect(searchBookmarks(index(), 'AI 工具').map((x) => x.id)).toEqual(['d'])
  })

  it('同分按最近打开、再按添加时间；最多 limit 条；空查询没有结果', () => {
    const r = searchBookmarks(index(), 'https', 2)
    expect(r).toHaveLength(2)
    expect(r[0].id).toBe('c')
    expect(searchBookmarks(index(), '   ')).toEqual([])
  })
})

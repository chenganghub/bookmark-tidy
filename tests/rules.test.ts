// 体检规则（从 tools/audit-bookmarks.test.mjs 迁过来，规则现在只在 src/core/rules.ts）
import { describe, expect, it } from 'vitest'
import { audit, cleanTitle, hasSiteSuffix, isCold, isNestedSameName, normalizeUrl } from '../src/core/rules'
import type { AuditInput } from '../src/core/types'

describe('标题清理：只去能确定的噪音', () => {
  it.each([
    // CSDN 旧格式「标题 - 博客名 - CSDN博客」
    ['Vue中axios踩坑之路-POST传参 - call_me_fly的博客 - CSDN博客', 'Vue中axios踩坑之路-POST传参'],
    ['微信小程序 分享功能 - 书写人生 - CSDN博客', '微信小程序 分享功能'],
    // CSDN 新格式「标题_某某的博客-CSDN博客_关键词」，作者名带下划线、带空格
    ['非常有趣的的免费API接口，基本上很全了。_MISTLETOE_WW的博客-CSDN博客', '非常有趣的的免费API接口，基本上很全了。'],
    ['(15条消息) js 数组遍历符合条件跳出循环体_JS数组那些特别好用的技巧_weixin_39954487的博客-CSDN博客', 'js 数组遍历符合条件跳出循环体_JS数组那些特别好用的技巧'],
    ['(1条消息) meta标签大全（荐）_White feathe 的博客-CSDN博客_meta大全', 'meta标签大全（荐）'],
    ['Vue3 composition API_tom的博客-CSDN博客', 'Vue3 composition API'],
    ['uniapp权限检查,拉起系统授权_uniapp打开系统设置权限_Jungle前端的博客-CSDN博客', 'uniapp权限检查,拉起系统授权_uniapp打开系统设置权限'],
    // 没有「的博客」标记：分不清博客名，只去「-CSDN博客_关键词」
    ['js二维数组转一维数组方法_一个人的价值取决于所在位置-CSDN博客_js二维数组转一维数组', 'js二维数组转一维数组方法_一个人的价值取决于所在位置'],
    // 知乎消息前缀、博客园和思否的作者段、B 站
    ['(17 封私信 / 20 条消息) 2万字Openclaw保姆教程 - 知乎', '2万字Openclaw保姆教程'],
    ['前端实现根据模版导出word【docxtemplater】 - ^Mao^ - 博客园', '前端实现根据模版导出word【docxtemplater】'],
    ['H5 notification浏览器桌面通知_OBKoro1分享 - SegmentFault 思否', 'H5 notification浏览器桌面通知'],
    ['【中字】xxx_哔哩哔哩_bilibili', '【中字】xxx'],
    // 不该动的
    ['Vue - 入门教程 - 知乎', 'Vue - 入门教程'],
    ['GitHub - vuejs/core: 🖖 Vue.js', 'GitHub - vuejs/core: 🖖 Vue.js'],
    ['知乎', '知乎']
  ])('%s', (input, want) => {
    expect(cleanTitle(input)).toBe(want)
  })

  it('hasSiteSuffix', () => {
    expect(hasSiteSuffix('标题 - 知乎')).toBe(true)
    expect(hasSiteSuffix('标题_某某的博客-CSDN博客')).toBe(true)
    expect(hasSiteSuffix('标题 - 作者 - 博客园')).toBe(true)
    expect(hasSiteSuffix('知乎上的好文章')).toBe(false)
  })
})

describe('网址规范化：只用于找重复', () => {
  it.each([
    ['https://www.Example.com/a/b/?utm_source=x&id=1#top', 'example.com/a/b?id=1'],
    ['http://example.com/a/b', 'example.com/a/b'],
    ['https://www.bilibili.com/video/BV1x?spm_id_from=333&vd_source=abc', 'bilibili.com/video/BV1x'],
    ['javascript:void(0)', 'javascript:void(0)'],
    ['http://localhost:8080/x/', 'localhost:8080/x']
  ])('%s → %s', (input, want) => {
    expect(normalizeUrl(input)).toBe(want)
  })
})

describe('isCold / isNestedSameName', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  const DAY = 86400000
  it('冷门 = 添加超过一年且没有打开记录', () => {
    expect(isCold({ dateAdded: now - 400 * DAY, dateLastUsed: 0 }, now)).toBe(true)
    expect(isCold({ dateAdded: now - 400 * DAY, dateLastUsed: now - DAY }, now)).toBe(false)
    expect(isCold({ dateAdded: now - 100 * DAY, dateLastUsed: 0 }, now)).toBe(false)
    expect(isCold({ dateAdded: 0, dateLastUsed: 0 }, now)).toBe(false)
  })
  it('同名嵌套 = 子名等于父名，或父名以子名开头', () => {
    expect(isNestedSameName({ title: 'css', parentTitle: 'css框架' })).toBe(true)
    expect(isNestedSameName({ title: 'js处理', parentTitle: 'js处理' })).toBe(true)
    expect(isNestedSameName({ title: 'CSS', parentTitle: 'css框架' })).toBe(true)
    expect(isNestedSameName({ title: '前端工具', parentTitle: '前端' })).toBe(false)
    expect(isNestedSameName({ title: 'css', parentTitle: '' })).toBe(false)
  })
})

describe('体检汇总', () => {
  const now = Date.parse('2026-10-31T00:00:00Z')
  const old = Date.parse('2020-01-01T00:00:00Z')
  const recent = Date.parse('2026-10-20T00:00:00Z')
  const bm = (id: string, title: string, url: string, depth: number, extra: Partial<AuditInput['bookmarks'][number]> = {}) => ({
    id,
    title,
    url,
    depth,
    rootType: 'bookmarks-bar',
    dateAdded: old,
    dateLastUsed: 0,
    ...extra
  })
  const input: AuditInput = {
    roots: [
      { rootType: 'bookmarks-bar', bookmarks: 4, topFolders: 2, looseBookmarks: 3 },
      { rootType: 'other', bookmarks: 0, topFolders: 0, looseBookmarks: 0 }
    ],
    bookmarks: [
      bm('b1', 'a - 知乎', 'https://zhuanlan.zhihu.com/p/1', 3),
      bm('b2', '重复一', 'https://www.example.com/x/?utm_source=a', 1),
      bm('b3', '重复二', 'http://example.com/x', 1, { dateLastUsed: recent }),
      bm('b4', '本机', 'http://localhost:3000/', 1)
    ],
    folders: [
      { id: 'f1', title: 'css框架', parentTitle: '', depth: 1, rootType: 'bookmarks-bar', directBookmarks: 0, subFolders: 1 },
      { id: 'f2', title: 'css', parentTitle: 'css框架', depth: 2, rootType: 'bookmarks-bar', directBookmarks: 1, subFolders: 0 },
      { id: 'f3', title: '工具', parentTitle: '', depth: 1, rootType: 'bookmarks-bar', directBookmarks: 0, subFolders: 1 },
      { id: 'f4', title: '新建文件夹', parentTitle: '工具', depth: 2, rootType: 'bookmarks-bar', directBookmarks: 0, subFolders: 0 }
    ]
  }

  it('数字', () => {
    const { summary: s } = audit(input, now)
    expect(s.bookmarks).toBe(4)
    expect(s.folders).toBe(4)
    expect(s.roots['bookmarks-bar']).toEqual({ bookmarks: 4, topFolders: 2, looseBookmarks: 3 })
    expect(s.maxFolderDepth).toBe(2)
    expect(s.folderIssues).toEqual({ empty: 1, singleBookmark: 1, bigFlat50: 0, nestedSameName: 1, defaultName: 1, duplicateNameGroups: 0 })
    expect(s.duplicates.exact.groups).toBe(0)
    expect(s.duplicates.normalized).toEqual({ groups: 1, extra: 1 })
    expect(s.urls.intranet).toBe(1)
    expect(s.urls.protocols).toEqual({ https: 2, http: 2 })
    expect(s.titles.siteSuffix).toBe(1)
    expect(s.titles.cleanable).toBe(1)
    expect(s.usage).toEqual({ hasLastUsed: 1, usedIn30d: 1, usedIn180d: 1, cold: 3 })
    expect(s.addedByYear).toEqual({ '2020': 4 })
  })

  it('每项对应的条目 id', () => {
    const { issues } = audit(input, now)
    expect(issues.emptyFolders).toEqual(['f4'])
    expect(issues.singleBookmarkFolders).toEqual(['f2'])
    expect(issues.nestedSameNameFolders).toEqual(['f2'])
    expect(issues.defaultNameFolders).toEqual(['f4'])
    expect(issues.duplicateGroups).toEqual([['b2', 'b3']])
    expect(issues.siteSuffix).toEqual(['b1'])
    expect(issues.intranet).toEqual(['b4'])
    expect(issues.cold).toEqual(['b1', 'b2', 'b4'])
  })
})

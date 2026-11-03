import { describe, expect, it } from 'vitest'
import {
  buildClassifyMessages,
  buildDescribeMessages,
  buildFileMessages,
  buildSplitMessages,
  buildTaxonomyMessages,
  folderName,
  leafPaths,
  parseClassify,
  parseDescribe,
  parseFile,
  parseSplit,
  parseTaxonomy
} from '../src/core/prompts'

describe('说明', () => {
  it('提示词：含 json 字样，每条一行，字段里的 | 和换行被替换', () => {
    const m = buildDescribeMessages([{ id: '7', title: 'A|B\nC', url: 'example.com/a', desc: '简介', path: 'css框架/css' }])
    expect(m[0].role).toBe('system')
    expect(m[0].content).toContain('json')
    expect(m[1].content).toContain('7 | A B C | example.com/a | 简介 | css框架/css')
  })

  it('解析：截断、标签取 3、类型兜底、丢未知和重复 id、列出缺的', () => {
    const raw = {
      items: [
        { id: '1', desc: '一'.repeat(50), title: '二'.repeat(40), tags: ['a', '', 'b', 'c', 'd'], type: '文章' },
        { id: '2', desc: '好', title: '', tags: 'x', type: '博客' },
        { id: '2', desc: '重复的', title: 't', tags: [], type: '文章' },
        { id: '9', desc: '不在输入里', title: 't', tags: [], type: '文章' },
        { id: 3, desc: '数字 id', title: 't', tags: [], type: '工具' },
        { id: '4', desc: '', title: '没有说明的不算', tags: [], type: '文章' }
      ]
    }
    const r = parseDescribe(raw, ['1', '2', '3', '4', '5'])
    expect(r.items.map((i) => i.id)).toEqual(['1', '2', '3'])
    expect([...r.items[0].desc].length).toBe(40)
    expect([...r.items[0].title].length).toBe(30)
    expect(r.items[0].tags).toEqual(['a', 'b', 'c'])
    expect(r.items[1]).toMatchObject({ desc: '好', type: '其他', tags: [] })
    expect(r.items[2].type).toBe('工具')
    expect(r.missing).toEqual(['4', '5'])
  })

  it('解析：根就是数组也认；不是对象返回全缺', () => {
    expect(parseDescribe([{ id: '1', desc: 'd', title: 't', tags: [], type: '文档' }], ['1']).items).toHaveLength(1)
    expect(parseDescribe('乱码', ['1'])).toEqual({ items: [], missing: ['1'] })
  })
})

describe('目录设计', () => {
  it('提示词带上限、现有目录；锁定目录的名字不发出去（解析时在本地去掉）；emoji 开关', () => {
    const items = [{ type: '文章' as const, tags: ['Vue'], desc: '讲 Vue', path: 'vue 工具' }]
    const m = buildTaxonomyMessages(items, { maxTop: 8, existingFolders: ['AI', '小程序'], lockedFolders: ['受保护资料'], emoji: false })
    expect(m[0].content).toContain('顶层最多 8 个')
    expect(m[0].content).toContain('AI、小程序')
    expect(m.map((x) => x.content).join('\n')).not.toContain('受保护资料')
    expect(m[0].content).not.toContain('emoji')
    expect(m[1].content).toContain('文章 | Vue | 讲 Vue | vue 工具')
    expect(buildTaxonomyMessages(items, { maxTop: 8, existingFolders: [], lockedFolders: [], emoji: true })[0].content).toContain('emoji')
  })

  it('解析：超数截断、第三层去掉、重名合并、保留名和锁定名去掉、清 emoji、名字截到 8 字', () => {
    const raw = {
      folders: [
        { name: '🤖 AI 工具', desc: 'AI 产品', emoji: '🤖' },
        { name: '前端基础', desc: '基础', children: [{ name: 'JS', desc: 'js', children: [{ name: '第三层' }] }, { name: 'CSS', desc: 'css' }] },
        { name: '前端基础', desc: '重名', children: [{ name: 'CSS', desc: '重复子目录' }, { name: '浏览器', desc: '原理' }] },
        { name: '待整理', desc: '不许建' },
        { name: '受保护资料', desc: '锁定的' },
        { name: '一二三四五六七八九十', desc: '太长' },
        { name: '', desc: '空名' },
        { name: 'D' },
        { name: 'E' },
        { name: 'F' },
        { name: 'G' },
        { name: 'H' }
      ]
    }
    const { folders, issues } = parseTaxonomy(raw, { maxTop: 6, emoji: false, lockedFolders: ['受保护资料'] })
    expect(folders.map((f) => f.name)).toEqual(['AI 工具', '前端基础', '一二三四五六七八', 'D', 'E', 'F'])
    expect(folders[0].emoji).toBeUndefined()
    expect(folders[1].children?.map((c) => c.name)).toEqual(['JS', 'CSS', '浏览器'])
    expect(folders[1].children?.[0].children).toBeUndefined()
    expect(issues.join('\n')).toMatch(/第三层/)
    expect(issues.join('\n')).toMatch(/重名/)
    expect(issues.join('\n')).toMatch(/待整理/)
    expect(issues.join('\n')).toMatch(/受保护资料/)
    expect(issues.join('\n')).toMatch(/超过上限 6/)
  })

  it('解析：emoji 开着时保留第一个 emoji', () => {
    const { folders } = parseTaxonomy({ folders: [{ name: 'AI', desc: 'x', emoji: '🤖✨' }, { name: '🎨 设计', desc: 'y' }] }, { maxTop: 8, emoji: true, lockedFolders: [] })
    expect(folders.map((f) => [f.name, f.emoji])).toEqual([
      ['AI', '🤖'],
      ['设计', '🎨']
    ])
  })

  it('目录名：英文按半个字算，不截在英文单词中间', () => {
    const issues: string[] = []
    expect(folderName('MCP 与 Skills', issues)).toBe('MCP 与 Skills') // 5.5 个字，不截
    expect(folderName('Vue UI 框架', issues)).toBe('Vue UI 框架')
    expect(issues).toEqual([])
    expect(folderName('前端工程化与 Webpack 配置', issues)).toBe('前端工程化与') // 截点在 Webpack 中间，退到单词前
    expect(folderName('Supercalifragilistic', issues)).toBe('Supercalifragili') // 整个是一个长单词：照字截（16 个半字）
    expect(issues).toHaveLength(2)
    // 半角斜杠是方案里「父/子」的分隔符，名字里的换成全角
    expect(folderName('UI/UX 设计', [])).toBe('UI／UX 设计')
  })

  it('解析目录：名字带斜杠的不会和「父/子」撞键', () => {
    const { folders } = parseTaxonomy({ folders: [{ name: 'UI/UX', desc: '' }, { name: 'UI', desc: '', children: [{ name: 'UX', desc: '' }] }] }, { maxTop: 8, emoji: false, lockedFolders: [] })
    expect(leafPaths(folders)).toEqual(['UI／UX', 'UI/UX'])
  })

  it('leafPaths', () => {
    expect(leafPaths([{ name: 'A', desc: '', children: [{ name: 'a1', desc: '' }, { name: 'a2', desc: '' }] }, { name: 'B', desc: '' }])).toEqual(['A/a1', 'A/a2', 'B'])
  })
})

describe('归类', () => {
  const paths = ['前端基础/JS 技巧', '前端基础/CSS', 'AI 工具', '小程序/组件', '跨端/组件']

  it('提示词列出全部路径和定义', () => {
    const m = buildClassifyMessages(paths, [{ id: '1', title: 't', desc: 'd', tags: ['x'], type: '文章' }], { 'AI 工具': '在用的 AI 产品' })
    for (const p of paths) expect(m[0].content).toContain(p)
    expect(m[0].content).toContain('AI 工具（在用的 AI 产品）')
    expect(m[1].content).toContain('1 | t | d | x | 文章')
  })

  it('解析：路径修正、末级名唯一匹配、歧义和未知给空、置信度夹紧', () => {
    const raw = {
      items: [
        { id: '1', path: '前端基础/JS 技巧', confidence: 0.9 },
        { id: '2', path: '前端基础/JS技巧（JS 写法）', confidence: 1.4 },
        { id: '3', path: 'CSS', confidence: -1 },
        { id: '4', path: '组件', confidence: 0.8 },
        { id: '5', path: '不存在', confidence: 0.8 },
        { id: '6', path: 'AI 工具' },
        { id: '7', path: '', confidence: 0.3 },
        { id: '99', path: 'AI 工具', confidence: 1 }
      ]
    }
    const r = parseClassify(raw, ['1', '2', '3', '4', '5', '6', '7', '8'], paths)
    expect(r.items).toEqual([
      { id: '1', path: '前端基础/JS 技巧', confidence: 0.9 },
      { id: '2', path: '前端基础/JS 技巧', confidence: 1 },
      { id: '3', path: '前端基础/CSS', confidence: 0 },
      { id: '4', path: '', confidence: 0.8 },
      { id: '5', path: '', confidence: 0.8 },
      { id: '6', path: 'AI 工具', confidence: 0.5 },
      { id: '7', path: '', confidence: 0.3 }
    ])
    expect(r.missing).toEqual(['8'])
  })
})

describe('拆细太大的目录', () => {
  const items = Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, title: `标题|${i}`, desc: `说明${i}`, tags: ['JS'] }))

  it('提示词带目录路径、条数、不能用的名字；锁定名不写进去', () => {
    const m = buildSplitMessages('前端基础/JS 学习', items, { maxParts: 4, taken: ['前端基础', 'CSS 布局'] })
    expect(m[0].content).toContain('「前端基础/JS 学习」里有 3 条')
    expect(m[0].content).toContain('2～4 个')
    expect(m[0].content).toContain('前端基础、CSS 布局')
    expect(m[1].content).toContain('b1 | 标题 1 | 说明1 | JS')
  })

  it('解析：去掉保留名、不能用的名字、锁定名和重名；归属认名字（忽略空格、大小写，取最后一段）', () => {
    const raw = {
      folders: [
        { name: 'JS 基础', desc: '语法' },
        { name: 'js基础', desc: '只差空格和大小写，算重名' },
        { name: '待整理', desc: '保留名' },
        { name: 'CSS 布局', desc: '兄弟目录的名字' },
        { name: '受保护资料', desc: '锁定名' },
        { name: 'JS 技巧', desc: '写法' }
      ],
      items: [
        { id: 'b0', folder: 'JS基础' },
        { id: 'b1', folder: '前端基础/JS 技巧' },
        { id: 'b2', folder: '不存在' },
        { id: 'x9', folder: 'JS 基础' }
      ]
    }
    const r = parseSplit(raw, ['b0', 'b1', 'b2'], { maxParts: 4, taken: ['CSS 布局'], lockedFolders: ['受保护资料'] })
    expect(r.folders.map((f) => f.name)).toEqual(['JS 基础', 'JS 技巧'])
    expect(r.items).toEqual([
      { id: 'b0', folder: 'JS 基础' },
      { id: 'b1', folder: 'JS 技巧' }
    ])
    expect(r.missing).toEqual(['b2'])
    expect(parseSplit({ folders: [1, 2, 3, 4, 5].map((n) => ({ name: `目录${n}` })) }, [], { maxParts: 3, taken: [], lockedFolders: [] }).folders).toHaveLength(3)
  })
})

describe('收藏即整理（说明 + 归类一次请求）', () => {
  const paths = ['前端/Vue', 'AI 工具']
  it('提示词里有候选目录和定义；没有当前文件夹；有正文片段时才写「正文开头」', () => {
    const m = buildFileMessages({ id: '9', title: 'A|B', url: 'juejin.cn/post/1', desc: '简介' }, paths, { 'AI 工具': '在用的 AI 产品' })
    expect(m[0].content).toContain('前端/Vue')
    expect(m[0].content).toContain('AI 工具（在用的 AI 产品）')
    expect(m[0].content).toContain('confidence')
    expect(m[0].content).not.toContain('正文开头')
    expect(m[1].content).toContain('9 | A B | juejin.cn/post/1 | 简介')
    expect(m[1].content).not.toContain('正文开头')
    const withText = buildFileMessages({ id: '9', title: 't', url: 'u', desc: '', excerpt: '第一行\n第二行' }, paths)
    expect(withText[0].content).toContain('正文开头')
    expect(withText[1].content).toContain('正文开头：\n第一行 第二行')
  })

  it('解析：说明字段照一期规则；目录不在候选里给空；没给把握算 0；没有说明返回 undefined', () => {
    const raw = { items: [{ id: '9', desc: '讲 Vue', title: '标题', tags: ['Vue'], type: '文章', path: '前端/Vue（Vue 生态）', confidence: 1.4 }] }
    expect(parseFile(raw, '9', paths)).toEqual({ id: '9', desc: '讲 Vue', title: '标题', tags: ['Vue'], type: '文章', path: '前端/Vue', confidence: 1 })
    expect(parseFile({ items: [{ id: '9', desc: 'd', path: '不存在', confidence: 0.9 }] }, '9', paths)?.path).toBe('')
    expect(parseFile({ items: [{ id: '9', desc: 'd', path: 'AI 工具' }] }, '9', paths)?.confidence).toBe(0)
    expect(parseFile({ items: [{ id: '9', desc: 'd', path: 'AI 工具', confidence: '高' }] }, '9', paths)?.confidence).toBe(0)
    expect(parseFile({ items: [{ id: '9', desc: 'd', path: 'AI 工具', confidence: '0.7' }] }, '9', paths)?.confidence).toBe(0.7)
    expect(parseFile({ items: [{ id: '9', desc: '', path: 'AI 工具' }] }, '9', paths)).toBeUndefined()
    expect(parseFile({ items: [{ id: '8', desc: 'd' }] }, '9', paths)).toBeUndefined()
  })
})

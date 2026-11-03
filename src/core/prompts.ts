// 三段提示词（说明、目录设计、归类）和对模型输出的校验。模型输出是信任边界：宽容地修，修不了的丢掉并记下。
import type { ChatMessage, ClassifyOutput, DescribeInput, DescribeOutput, FileInput, FileOutput, ItemType, TaxonomyNode } from './types'

export const ITEM_TYPES: ItemType[] = ['文章', '文档', '工具', '代码仓库', '视频', '课程', '社区', '后台', '其他']

/** 程序自己会建或保留的目录，模型不许建同名的 */
const RESERVED = ['待整理', '待清理', '其他', '未分类', '整理前的空文件夹']

const chars = (s: string) => [...s]
const cut = (s: string, max: number) => chars(s).slice(0, max).join('')
/** 一行一条的紧凑格式：字段里的 | 和换行会打乱格式，换掉 */
const field = (s: string) => s.replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const listOf = (raw: unknown, key: string): unknown[] => {
  if (Array.isArray(raw)) return raw
  const v = (raw as Record<string, unknown> | null)?.[key]
  return Array.isArray(v) ? v : []
}

// ---------------------------------------------------------------- 第一段：说明

const WHO = '你在帮用户整理浏览器书签。根据书签内容组织信息，不预设用户的职业或兴趣。'
// 说明的写法：一期的「说明」和二期的「收藏即整理」共用
const DESCRIBE_RULES = `- desc：一句话说明，不超过 40 个字。写清这页讲了什么或能做什么，以及什么时候用得上。不要以「这是」「本文」「该网站」开头。信息不够时按标题和网址合理推断，不编造具体细节。
- title：干净的标题，不超过 30 个字。去掉站名、作者名、消息数、多余的符号和关键词堆砌，保留关键信息。
- tags：1～3 个短标签（技术名或主题，如 Vue、CSS、小程序、AI 绘图、面试）。
- type：只能是 文章、文档、工具、代码仓库、视频、课程、社区、后台、其他 之一。`

const DESCRIBE_SYSTEM = `${WHO}
对每条书签，根据标题、网址（只有域名和路径）、网页简介和所在文件夹，写出：
${DESCRIBE_RULES}

只输出 json，格式如下：
{"items":[{"id":"123","desc":"讲 uniapp 怎么检查权限并跳到系统设置，做 App 权限提示时用","title":"uniapp 权限检查与拉起系统授权","tags":["uniapp","权限"],"type":"文章"}]}
每条输入都要有一条输出，id 原样返回。`

export function buildDescribeMessages(items: DescribeInput[]): ChatMessage[] {
  const lines = items.map((i) => [i.id, i.title, i.url, i.desc, i.path].map(field).join(' | '))
  return [
    { role: 'system', content: DESCRIBE_SYSTEM },
    { role: 'user', content: `书签共 ${items.length} 条，每行：id | 标题 | 网址 | 简介 | 文件夹\n${lines.join('\n')}` }
  ]
}

export function parseDescribe(raw: unknown, inputIds: string[]): { items: DescribeOutput[]; missing: string[] } {
  const want = new Set(inputIds)
  const seen = new Set<string>()
  const items: DescribeOutput[] = []
  for (const it of listOf(raw, 'items')) {
    const o = (it || {}) as Record<string, unknown>
    const id = str(o.id)
    const desc = cut(str(o.desc), 40)
    if (!want.has(id) || seen.has(id) || !desc) continue
    seen.add(id)
    const tags = (Array.isArray(o.tags) ? o.tags : [])
      .map(str)
      .filter(Boolean)
      .map((t) => cut(t, 12))
      .slice(0, 3)
    const type = ITEM_TYPES.includes(str(o.type) as ItemType) ? (str(o.type) as ItemType) : '其他'
    items.push({ id, desc, title: cut(str(o.title), 30), tags, type })
  }
  return { items, missing: inputIds.filter((id) => !seen.has(id)) }
}

// ---------------------------------------------------------------- 第二段：目录设计

/**
 * 锁定文件夹的名字（比如公司名）不写进提示词：数据最少原则。模型万一建了同名目录，parseTaxonomy 在本地去掉。
 * opts.lockedFolders 留在参数里，是为了让调用方和 parseTaxonomy 用同一份名单。
 */
export function buildTaxonomyMessages(
  items: { type: ItemType; tags: string[]; desc: string; path: string }[],
  opts: { maxTop: number; existingFolders: string[]; lockedFolders: string[]; emoji: boolean }
): ChatMessage[] {
  const system = `你在帮用户重新设计浏览器书签的目录。目标：以后想找某条书签时，一眼就知道去哪个目录。
规则：
- 按用途分，也就是「我什么时候会去找它」，不按网站分。
- 顶层最多 ${opts.maxTop} 个目录，最多两层。每个末级目录预计放 3～40 条：条目多的顶层目录再分子目录，条目少的不要分。
- 目录名用中文，2～6 个字（技术名可以用英文，如 Vue、CSS、AI）。同一层不重名。
- 合适的现有文件夹名可以沿用：${opts.existingFolders.join('、') || '无'}。
- 不要建这些目录（程序会自己处理）：${RESERVED.join('、')}。
- 每个目录给一句定义 desc（不超过 20 个字），写清放什么。${opts.emoji ? '\n- 每个目录给一个贴切的 emoji（字段 emoji）。' : ''}

只输出 json，格式如下：
{"folders":[{"name":"前端基础","desc":"JS、CSS、浏览器原理等基础知识"${opts.emoji ? ',"emoji":"📘"' : ''},"children":[{"name":"JS 技巧","desc":"JS 写法和常用技巧"${opts.emoji ? ',"emoji":"🧩"' : ''}}]},{"name":"AI 工具","desc":"在用或想试的 AI 产品"${opts.emoji ? ',"emoji":"🤖"' : ''}}]}`
  const lines = items.map((i) => [i.type, i.tags.join(','), i.desc, i.path].map(field).join(' | '))
  return [
    { role: 'system', content: system },
    { role: 'user', content: `全部书签的摘要共 ${items.length} 条，每行：类型 | 标签 | 说明 | 原文件夹\n${lines.join('\n')}` }
  ]
}

// emoji 和变体选择符、零宽连接符
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}\u{20E3}]/gu
const firstEmoji = (s: string): string | undefined => {
  const m = s.match(/\p{Extended_Pictographic}(?:\u{FE0F})?(?:\u{200D}\p{Extended_Pictographic}(?:\u{FE0F})?)*/u)
  return m?.[0]
}

/** 目录名最长 8 个字；英文字母、数字、空格按半个字算（「MCP 与 Skills」算 5.5 个字） */
export const FOLDER_NAME_MAX = 8
const isHalf = (c: string) => /[\x20-\x7e]/.test(c)
const nameWidth = (s: string) => chars(s).reduce((w, c) => w + (isHalf(c) ? 0.5 : 1), 0)

/**
 * 目录名：去 emoji、合并空白；半角斜杠换成全角（「UI/UX」→「UI／UX」），因为方案里用「父/子」当目录的键和路径；
 * 太长就截断，不截在英文单词中间（截了记一条提示）
 */
export function folderName(rawName: unknown, issues: string[]): string {
  const name = str(rawName).replace(EMOJI_RE, '').replace(/\//g, '／').replace(/\s+/g, ' ').trim()
  if (nameWidth(name) <= FOLDER_NAME_MAX) return name
  const cs = chars(name)
  let end = 0
  for (let w = 0; end < cs.length && w + (isHalf(cs[end]) ? 0.5 : 1) <= FOLDER_NAME_MAX; end++) w += isHalf(cs[end]) ? 0.5 : 1
  // 截点落在英文单词中间：退到这个单词前面（整个名字就是一个长单词时照字截）
  const word = /[A-Za-z0-9]/
  if (end < cs.length && word.test(cs[end]) && word.test(cs[end - 1])) {
    let back = end
    while (back > 0 && word.test(cs[back - 1])) back--
    if (back > 0) end = back
  }
  const out = cs.slice(0, end).join('').trim()
  issues.push(`目录名「${name}」太长，截成「${out}」`)
  return out
}

export function parseTaxonomy(raw: unknown, opts: { maxTop: number; emoji: boolean; lockedFolders: string[] }): { folders: TaxonomyNode[]; issues: string[] } {
  const issues: string[] = []
  const banned = new Set([...RESERVED, ...opts.lockedFolders])

  const normName = (rawName: unknown): string => folderName(rawName, issues)
  const normNode = (o: Record<string, unknown>, name: string): TaxonomyNode => {
    const node: TaxonomyNode = { name, desc: cut(str(o.desc), 30) }
    if (opts.emoji) {
      const e = firstEmoji(str(o.emoji)) ?? firstEmoji(str(o.name))
      if (e) node.emoji = e
    }
    return node
  }

  /** 同一层：去空名、去保留名、合并重名 */
  const level = (list: unknown[], depth: number): TaxonomyNode[] => {
    const out: TaxonomyNode[] = []
    for (const it of list) {
      const o = (it || {}) as Record<string, unknown>
      const name = normName(o.name)
      if (!name) continue
      if (banned.has(name)) {
        issues.push(`去掉了目录「${name}」（保留名或锁定的文件夹）`)
        continue
      }
      const kids = Array.isArray(o.children) ? o.children : []
      const existing = out.find((n) => n.name === name)
      if (depth === 1) {
        const node = existing ?? normNode(o, name)
        if (kids.length) node.children = [...(node.children || []), ...level(kids, 2)]
        if (existing) issues.push(`合并了重名目录「${name}」`)
        else out.push(node)
      } else {
        if (kids.length) issues.push(`「${name}」下的第三层目录去掉了`)
        if (existing) issues.push(`合并了重名目录「${name}」`)
        else out.push(normNode(o, name))
      }
    }
    return out
  }

  let folders = level(listOf(raw, 'folders'), 1)
  // 子目录合并后可能又重名
  for (const f of folders) {
    if (f.children) {
      const names = new Set<string>()
      f.children = f.children.filter((c) => (names.has(c.name) ? false : (names.add(c.name), true)))
      if (!f.children.length) delete f.children
    }
  }
  if (folders.length > opts.maxTop) {
    issues.push(`顶层目录 ${folders.length} 个，超过上限 ${opts.maxTop}，只保留前 ${opts.maxTop} 个`)
    folders = folders.slice(0, opts.maxTop)
  }
  return { folders, issues }
}

// ---------------------------------------------------------------- 第四段：拆细太大的目录

/** 归类后某个末级目录超过 40 条时，让模型把这些条目分成 2～maxParts 个更细的目录 */
export function buildSplitMessages(
  path: string,
  items: { id: string; title: string; desc: string; tags: string[] }[],
  opts: { maxParts: number; taken: string[] }
): ChatMessage[] {
  const system = `你在帮用户整理浏览器书签。目录「${path}」里有 ${items.length} 条书签，太多了，找起来费劲。
把这些书签分成 2～${opts.maxParts} 个更细的目录：
- 按用途分，也就是「我什么时候会去找它」。每个目录预计 3～40 条。
- 目录名用中文，2～6 个字（技术名可以用英文，如 Vue、CSS）。不要用这些名字：${[...RESERVED, ...opts.taken].join('、')}。
- 每个目录给一句定义 desc（不超过 20 个字），写清放什么。
- 每条书签放进其中一个目录（folder 填目录名），id 原样返回。

只输出 json，格式如下：
{"folders":[{"name":"JS 基础","desc":"语法、类型和作用域"},{"name":"JS 技巧","desc":"常用写法和工具函数"}],"items":[{"id":"123","folder":"JS 基础"}]}
每条输入都要有一条输出。`
  const lines = items.map((i) => [i.id, i.title, i.desc, i.tags.join(',')].map(field).join(' | '))
  return [
    { role: 'system', content: system },
    { role: 'user', content: `书签共 ${items.length} 条，每行：id | 标题 | 说明 | 标签\n${lines.join('\n')}` }
  ]
}

/** lockedFolders 只用来在本地去掉同名目录，不写进提示词（同 buildTaxonomyMessages） */
export function parseSplit(
  raw: unknown,
  inputIds: string[],
  opts: { maxParts: number; taken: string[]; lockedFolders: string[] }
): { folders: TaxonomyNode[]; items: { id: string; folder: string }[]; missing: string[]; issues: string[] } {
  const issues: string[] = []
  const banned = new Set([...RESERVED, ...opts.taken, ...opts.lockedFolders])
  // 名字比较忽略空格和大小写：「JS 基础」和「js基础」算同一个
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const folders: TaxonomyNode[] = []
  for (const it of listOf(raw, 'folders')) {
    const o = (it || {}) as Record<string, unknown>
    const name = folderName(o.name, issues)
    if (!name || banned.has(name) || folders.some((f) => squash(f.name) === squash(name))) continue
    folders.push({ name, desc: cut(str(o.desc), 30) })
  }
  if (folders.length > opts.maxParts) folders.length = opts.maxParts

  // 归属：认目录名（名字里的斜杠按 folderName 的规则换成全角再比）；模型写成「父/子」时取最后一段
  const byName = new Map(folders.map((f) => [squash(f.name), f.name]))
  const folderOf = (answer: string) => byName.get(squash(answer.replace(/\//g, '／'))) ?? byName.get(squash(answer.split('/').pop() || ''))
  const want = new Set(inputIds)
  const seen = new Set<string>()
  const items: { id: string; folder: string }[] = []
  for (const it of listOf(raw, 'items')) {
    const o = (it || {}) as Record<string, unknown>
    const id = str(o.id)
    const folder = folderOf(str(o.folder ?? o.path))
    if (!want.has(id) || seen.has(id) || !folder) continue
    seen.add(id)
    items.push({ id, folder })
  }
  return { folders, items, missing: inputIds.filter((id) => !seen.has(id)), issues }
}

/** 末级目录的路径：有子目录的写「父/子」，没有子目录的顶层写「父」 */
export function leafPaths(folders: TaxonomyNode[]): string[] {
  return folders.flatMap((f) => (f.children?.length ? f.children.map((c) => `${f.name}/${c.name}`) : [f.name]))
}

// ---------------------------------------------------------------- 第三段：归类

export function buildClassifyMessages(
  paths: string[],
  items: { id: string; title: string; desc: string; tags: string[]; type: ItemType }[],
  descs: Record<string, string> = {}
): ChatMessage[] {
  const pathLines = paths.map((p) => (descs[p] ? `${p}（${descs[p]}）` : p))
  const system = `把每条书签放进最合适的一个目录。只能从下面这些目录路径里选，原样返回完整路径（括号里是目录的定义，不要返回括号）：
${pathLines.join('\n')}

实在放不进任何目录时，path 填 ""。
confidence 是 0～1 之间的把握程度。

只输出 json，格式如下：
{"items":[{"id":"123","path":"${paths[0] ?? '前端基础/JS 技巧'}","confidence":0.9}]}
每条输入都要有一条输出，id 原样返回。`
  const lines = items.map((i) => [i.id, i.title, i.desc, i.tags.join(','), i.type].map(field).join(' | '))
  return [
    { role: 'system', content: system },
    { role: 'user', content: `书签共 ${items.length} 条，每行：id | 标题 | 说明 | 标签 | 类型\n${lines.join('\n')}` }
  ]
}

// ---------------------------------------------------------------- 二期：收藏即整理（一条书签一次请求：说明 + 归类）

/**
 * 不给当前文件夹：新收藏落在 Chrome「上次用过的文件夹」里，那个位置是噪音。
 * 候选目录只有书签栏下非锁定的目录，锁定文件夹的名字不会出现在这里。
 */
export function buildFileMessages(item: FileInput, paths: string[], descs: Record<string, string> = {}): ChatMessage[] {
  const pathLines = paths.map((p) => (descs[p] ? `${p}（${descs[p]}）` : p))
  const system = `${WHO}
用户刚收藏了一个网页。根据标题、网址（只有域名和路径）、网页简介${item.excerpt ? '和正文开头' : ''}，写出：
${DESCRIBE_RULES}
- path：把它放进最合适的一个目录。只能从下面这些目录路径里选，原样返回完整路径（括号里是目录的定义，不要返回括号）：
${pathLines.join('\n')}
  实在放不进任何目录时，path 填 ""。
- confidence：0～1 之间，放进这个目录的把握。

只输出 json，格式如下：
{"items":[{"id":"123","desc":"讲 uniapp 怎么检查权限并跳到系统设置，做 App 权限提示时用","title":"uniapp 权限检查与拉起系统授权","tags":["uniapp","权限"],"type":"文章","path":"${paths[0] ?? '前端基础/JS 技巧'}","confidence":0.9}]}
id 原样返回。`
  const line = [item.id, item.title, item.url, item.desc].map(field).join(' | ')
  const excerpt = item.excerpt ? `\n正文开头：\n${field(item.excerpt)}` : ''
  return [
    { role: 'system', content: system },
    { role: 'user', content: `书签 1 条：id | 标题 | 网址 | 简介\n${line}${excerpt}` }
  ]
}

/**
 * 说明部分不合格（没有 desc）返回 undefined；目录不在候选里时 path 为 ''（调用方放进「待整理」）。
 * AI 没给 confidence 时算 0：自动放不放看把握，不能用一期归类的缺省 0.5（正好等于校准出的阈值）。
 */
export function parseFile(raw: unknown, id: string, paths: string[]): FileOutput | undefined {
  const d = parseDescribe(raw, [id]).items[0]
  if (!d) return undefined
  const c = parseClassify(raw, [id], paths).items[0]
  const o = listOf(raw, 'items').find((it) => str(((it || {}) as Record<string, unknown>).id) === id) as Record<string, unknown> | undefined
  const given = typeof o?.confidence === 'number' ? o.confidence : Number(o?.confidence)
  return { ...d, path: c?.path ?? '', confidence: Number.isFinite(given) ? (c?.confidence ?? 0) : 0 }
}

export function parseClassify(raw: unknown, inputIds: string[], paths: string[]): { items: ClassifyOutput[]; missing: string[] } {
  const want = new Set(inputIds)
  const seen = new Set<string>()
  const pathSet = new Set(paths)
  const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
  const bySquash = new Map(paths.map((p) => [squash(p), p]))
  const leafName = (p: string) => p.split('/').pop() || ''
  const byLeaf = new Map<string, string[]>()
  for (const p of paths) byLeaf.set(squash(leafName(p)), [...(byLeaf.get(squash(leafName(p))) || []), p])

  const resolve = (p: string): string => {
    if (!p) return ''
    if (pathSet.has(p)) return p
    const cleaned = p.replace(/（[^）]*）|\([^)]*\)/g, '').trim()
    if (pathSet.has(cleaned)) return cleaned
    const sq = bySquash.get(squash(cleaned))
    if (sq) return sq
    const leaf = byLeaf.get(squash(leafName(cleaned)))
    return leaf && leaf.length === 1 ? leaf[0] : ''
  }

  const items: ClassifyOutput[] = []
  for (const it of listOf(raw, 'items')) {
    const o = (it || {}) as Record<string, unknown>
    const id = str(o.id)
    if (!want.has(id) || seen.has(id)) continue
    seen.add(id)
    const c = typeof o.confidence === 'number' ? o.confidence : Number(o.confidence)
    items.push({ id, path: resolve(str(o.path)), confidence: Number.isFinite(c) ? Math.min(1, Math.max(0, c)) : 0.5 })
  }
  return { items, missing: inputIds.filter((id) => !seen.has(id)) }
}

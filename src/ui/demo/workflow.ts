// 演示模式：真实的 workflow 逻辑跑在内存书签上（不碰真实书签），AI 和网页请求换成本地假的。
import { createFakeBookmarks } from '../../core/memory-bookmarks'
import { cleanTitle } from '../../core/rules'
import { memoryKV } from '../../core/store'
import type { ChatJsonFn, ItemType, Workflow } from '../../core/types'
import { createWorkflow } from '../../core/workflow'
import { demoPageOf, demoSeed } from './data'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

const TAXONOMY = {
  folders: [
    { name: 'AI 工具', desc: '在用和想试的 AI 产品', children: [{ name: '对话编程', desc: '对话、写代码' }, { name: 'Agent', desc: 'Agent、MCP、提示词' }] },
    { name: '前端基础', desc: 'CSS、JS 和浏览器', children: [{ name: 'CSS', desc: '样式和布局' }, { name: 'JS', desc: 'JS 写法和原理' }] },
    { name: 'Vue 生态', desc: 'Vue、构建和组件库' },
    { name: '小程序', desc: '小程序和 uni-app' },
    { name: '文档编辑', desc: '富文本、Word、在线文档' },
    { name: '学习资料', desc: '路线、教程、参考手册' }
  ]
}

// 按关键词归类：顺序有讲究（Element 样式先进 CSS，再轮到 Vue）
const RULES: [RegExp, string][] = [
  [/Agent|MCP|提示词|Prompt|OpenClaw/i, 'AI 工具/Agent'],
  [/ChatGPT|Claude|Cursor|DeepSeek|Hugging|模型|对话/i, 'AI 工具/对话编程'],
  [/CSS|样式|布局|定位|inline-block|animate/i, '前端基础/CSS'],
  [/JS|数组|对象|storage|缓存|HTTP|slice|reduce|通知/i, '前端基础/JS'],
  [/Vue|Vite|pnpm|Element|组件库/i, 'Vue 生态'],
  [/小程序|uni|GraceUI|DCloud|微信/i, '小程序'],
  [/Word|富文本|TinyMCE|Tiptap|文档生成|文档站|ONLYOFFICE|在线编辑/i, '文档编辑'],
  [/MDN|Can I use|兼容性|知识图谱|技术体系|工程化|学习路线/i, '学习资料']
]

const lines = (user: string) =>
  user
    .split('\n')
    .slice(1)
    .map((l) => l.split(' | '))

const demoChat: ChatJsonFn = async (messages) => {
  await sleep(600)
  const sys = messages[0].content
  const rows = lines(messages[1].content)
  const usage = { requests: 1, promptTokens: 300 + rows.length * 90, completionTokens: rows.length * 30, cacheHitTokens: 0, cacheMissTokens: 0 }
  if (sys.includes('desc：一句话说明')) {
    const items = rows.map(([id, title]) => ({ id, desc: `讲${cleanTitle(title).slice(0, 24)}`, title: cleanTitle(title).slice(0, 30), tags: [], type: '文章' as ItemType }))
    return { data: { items }, usage }
  }
  if (sys.includes('重新设计')) return { data: TAXONOMY, usage }
  const items = rows.map(([id, ...rest]) => {
    const text = rest.join(' ')
    const hit = RULES.find(([re]) => re.test(text))
    // 没命中的给一个把握很低的猜测：进待整理，待处理里能看到「AI 猜的」
    return { id, path: hit?.[1] ?? '学习资料', confidence: hit ? 0.92 : 0.3 }
  })
  return { data: { items }, usage }
}

const demoFetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  await sleep(60 + Math.random() * 160)
  const page = demoPageOf(url)
  if (!page) throw new TypeError('Failed to fetch')
  if (page.status === 'dead') return new Response('', { status: 404 })
  if (page.status === 'blocked') return new Response('', { status: 403 })
  const html = `<html><head><title>${esc(page.title)}</title><meta name="description" content="${esc(page.desc)}"></head><body></body></html>`
  return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })
}) as typeof fetch

export function createDemoWorkflow(): Workflow {
  const seed = demoSeed()
  const initial: Record<string, unknown> = {}
  for (const [id, m] of Object.entries(seed.meta)) initial[`meta:${id}`] = m
  for (const [url, p] of Object.entries(seed.pages)) initial[`page:${url}`] = p
  const listeners = new Set<() => void>()
  return createWorkflow({
    bookmarks: createFakeBookmarks(seed.tree),
    kv: memoryKV(initial),
    fetchImpl: demoFetch,
    chat: demoChat,
    permissions: { contains: async () => true, request: async () => true },
    bookmarkEvents: {
      subscribe(callback) {
        listeners.add(callback)
        return () => listeners.delete(callback)
      }
    }
  })
}

import { describe, expect, it } from 'vitest'
import { cutChars, decodeEntities, EXCERPT_MAX, htmlToText, isPublicExcerpt, rawExcerpt } from '../src/core/text'

describe('正文', () => {
  it('HTML 转纯文本：去脚本、样式、注释、head，块级标签换行，解实体', () => {
    const html = `<html><head><title>T</title><style>.a{}</style></head><body><!-- x --><script>var s='秘密'</script>
      <h1>标题&amp;副标题</h1><p>第一段<br>第二行</p><div>第三&nbsp;段 &#x4e2d;</div></body></html>`
    const t = htmlToText(html)
    expect(t).toBe('标题&副标题\n第一段\n第二行\n第三 段 中')
    expect(t).not.toContain('秘密')
    expect(t).not.toContain('T')
  })

  it('实体', () => {
    expect(decodeEntities('&lt;a&gt; &quot;x&quot; &#39;y&#39; &unknown;')).toBe('<a> "x" \'y\' &unknown;')
  })

  it('摘录：合并空白，按字符截到 1500', () => {
    expect(rawExcerpt('  a \n\n b\tc ')).toBe('a b c')
    const long = '字'.repeat(EXCERPT_MAX + 50)
    expect([...rawExcerpt(long)].length).toBe(EXCERPT_MAX)
    expect(cutChars('😀😀😀', 2)).toBe('😀😀')
  })

  it('公开版本核对：4 段至少 3 段在公开正文里', () => {
    const body = Array.from({ length: 40 }, (_, i) => `第${i}句讲的是响应式原理里的依赖收集和派发更新。`).join('')
    const excerpt = rawExcerpt(body)
    // 公开页面多了导航、换行和空格，一样算
    expect(isPublicExcerpt(excerpt, `首页 导航\n${body.replace(/。/g, '。\n ')}\n页脚`)).toBe(true)
    // 登录后才有的正文：公开页面只有一句提示
    expect(isPublicExcerpt(excerpt, '请登录后查看全文')).toBe(false)
    // 只有开头一段对得上（公开页只给了摘要）
    expect(isPublicExcerpt(excerpt, body.slice(0, 60))).toBe(false)
  })
  it('公开版本核对：摘录最后 30 字必须是公开的（登录墙截在摘录 80% 处，前 4 段都对得上也不算）', () => {
    const body = Array.from({ length: 80 }, (_, i) => `第${i}句讲的是响应式原理里的依赖收集和派发更新。`).join('')
    const excerpt = rawExcerpt(body)
    expect([...excerpt].length).toBe(EXCERPT_MAX)
    const cut = [...excerpt].slice(0, Math.floor([...excerpt].length * 0.8)).join('')
    expect(isPublicExcerpt(excerpt, `${cut}……登录后查看全文`)).toBe(false)
    // 公开页比摘录长（摘录只是前 1500 字）：照样算
    expect(isPublicExcerpt(excerpt, `${body}评论区`)).toBe(true)
  })

  it('短摘录要整段出现', () => {
    expect(isPublicExcerpt('短短一句', '这里有短短一句话')).toBe(true)
    expect(isPublicExcerpt('短短一句', '这里有短短的一句话')).toBe(false)
    expect(isPublicExcerpt('', '任何')).toBe(false)
  })
})

// 注入到标签页里抽正文（二期，收藏即整理用）：后台 scripting.executeScript({ files: ['/extract.js'] }) 调用，返回值就是结果。
// 在页面的副本上跑 Defuddle，不改动用户正在看的页面；不让它去第三方接口取内容（useAsync: false）。
import Defuddle from 'defuddle'
import { htmlToText, TEXT_MAX } from '../src/core/text'

export default defineUnlistedScript(() => {
  const meta = (name: string) => document.querySelector<HTMLMetaElement>(`meta[name="${name}"], meta[property="${name}"]`)?.content?.trim() ?? ''
  const base = { url: location.href, title: document.title, description: meta('description') || meta('og:description') }
  try {
    const r = new Defuddle(document.cloneNode(true) as Document, { url: location.href, removeImages: true, useAsync: false }).parse()
    return { ...base, description: base.description || r.description || '', text: htmlToText(r.content || '').slice(0, TEXT_MAX) }
  } catch {
    return { ...base, text: (document.body?.innerText ?? '').slice(0, TEXT_MAX) }
  }
})

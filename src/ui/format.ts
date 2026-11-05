// 界面用的小工具：格式化、文案映射。文案短，2～6 个字。
import { browser } from 'wxt/browser'
import type { ApplyReport, CleanupReason, FetchStatus, PlanItemReason, SkipReason } from '../core/types'
import { isDemo } from './useWorkflow'

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url.split(':')[0] || ''
  }
}

export function yearMonth(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

/** 扩展里用 Chrome 的 _favicon 接口；演示模式（普通网页）没有扩展环境，返回空串用首字母块 */
export function faviconUrl(url: string): string {
  if (isDemo) return ''
  // WXT 的类型只认打包进扩展的文件，_favicon 是 Chrome 提供的虚拟路径
  const getURL = browser.runtime.getURL as (path: string) => string
  return `${getURL('/_favicon/')}?pageUrl=${encodeURIComponent(url)}&size=32`
}

/** 首字母块：取标题里第一个字母、数字或汉字（跳过 emoji、括号、标点），没有就取域名的 */
export function initialOf(title: string, url: string): string {
  const pick = (s: string) => s.match(/[\p{L}\p{N}]/u)?.[0]
  return (pick(title) || pick(hostOf(url)) || '·').toUpperCase()
}

export function stampForFile(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

export const money = (usd: number) => `$${usd.toFixed(3)}`

export function downloadText(text: string, filename: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

export const reasonText: Record<PlanItemReason, string> = {
  ai: '',
  'low-confidence': '低置信度',
  'not-in-tree': '不在目录',
  'ai-failed': 'AI 失败',
  dead: '失效',
  duplicate: '重复',
  manual: '手改'
}

export const skipReasonText: Record<SkipReason, string> = {
  'not-http': '非 http',
  intranet: '内网',
  'action-word': '操作链接',
  'credential-param': '凭证参数',
  'random-token': '随机串',
  locked: '锁定',
  'excluded-folder': '排除文件夹',
  'excluded-domain': '排除域名'
}

export const fetchStatusText: Record<FetchStatus, string> = {
  ok: '正常',
  redirect: '跳转',
  login: '要登录',
  blocked: '被拦',
  dead: '失效',
  'server-error': '出错',
  unreachable: '连不上',
  timeout: '超时'
}

export const applySkipText: Record<ApplyReport['skipped'][number]['reason'], string> = {
  missing: '已删除',
  moved: '已移动',
  retitled: '已改名',
  'url-changed': '网址变了',
  locked: '在锁定目录',
  'changed-during-apply': '应用时被改'
}

/** 待处理「建议删除」每条的原因 */
export function cleanupReasonText(r: CleanupReason): string {
  if (r.kind === 'dead') return r.httpStatus ? `失效 · 打开是 ${r.httpStatus}` : '失效'
  if (r.kind === 'duplicate') return `重复 · 另一条在「${r.otherPath}」`
  if (r.kind === 'unreachable') return '连不上'
  return '原因已经不在了'
}

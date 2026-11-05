// 站点判断（二期）：哪些网站不读正文（私有），哪些可以把正文片段发给 AI（公开技术站点白名单）。
// 只用可擦除的 TS 语法，Node 24 能直接导入（tools/ 用得到）。
import { hostOf, isHttp, isIntranet } from './rules'

/** 默认白名单：允许发送公开正文片段的技术站点，可在设置中调整 */
export const DEFAULT_TEXT_DOMAINS = ['blog.csdn.net', 'cnblogs.com', 'juejin.cn', 'zhuanlan.zhihu.com', 'segmentfault.com', 'jianshu.com', 'github.com', 'developer.mozilla.org']

/** 默认私有站点：公司协作平台。内网、本机、锁定文件夹里出现过的站点另外算 */
export const DEFAULT_PRIVATE_DOMAINS = ['feishu.cn', 'feishu.net', 'larksuite.com', 'larkoffice.com', 'dingtalk.com']

/** 主机名像内网、本机的后缀（*.localhost 指本机，home.arpa 是家庭网络的保留域名） */
const INTERNAL_SUFFIX = /\.(local|lan|internal|intranet|corp|home|localhost|home\.arpa)$/i

/**
 * 一期 `isIntranet`（rules.ts）没管的内网、本机 IPv4：0.0.0.0、链路本地 169.254/16、
 * 组网常用的 100.64/10（Tailscale 之类）。127、10、192.168、172.16～31 由 `isIntranet` 判；
 * IPv6 字面量（[::1] 之类）没有点，由下面「没有点」那条判成私有。
 */
const MORE_LOCAL_IPV4 = /^(0\.0\.0\.0|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/

/** 常见的二级公共后缀：取主域名时要多带一段 */
const SECOND_LEVEL = new Set(['com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn', 'com.hk', 'com.tw', 'co.uk', 'co.jp', 'com.au', 'co.kr'])

/**
 * 设置里填的域名规整成主机名：去协议（含 `//` 开头的）、路径、端口、www，转小写；
 * 通配写法 `*.feishu.cn`、`.feishu.cn` 当成 `feishu.cn`（本来就含子域名），不然永远匹配不上，等于没填。
 */
export function normalizeDomain(raw: string): string {
  const s = raw.trim().toLowerCase()
  if (!s) return ''
  const noScheme = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\/\//, '')
  const host = noScheme.split(/[/?#]/)[0].replace(/:\d+$/, '')
  return host.replace(/^(\*\.|\.)+/, '').replace(/^www\./, '').replace(/\.$/, '')
}

/** 主域名（粗略）：a.b.example.com → example.com；x.example.com.cn → example.com.cn；IP 原样返回 */
export function siteOf(host: string): string {
  const h = normalizeDomain(host)
  if (!h || /^\d+(\.\d+){3}$/.test(h) || h.includes(':')) return h
  const parts = h.split('.')
  if (parts.length <= 2) return h
  const last2 = parts.slice(-2).join('.')
  return SECOND_LEVEL.has(last2) ? parts.slice(-3).join('.') : last2
}

/** host 等于名单里的某个域名，或是它的子域名 */
export function matchesDomain(host: string, domains: string[]): boolean {
  const h = normalizeDomain(host)
  if (!h) return false
  return domains.some((d) => {
    const x = normalizeDomain(d)
    return !!x && (h === x || h.endsWith(`.${x}`))
  })
}

/** 私有站点名单：设置里的，加上锁定文件夹里出现过的站点（按主域名）。内网地址另由 isPrivateUrl 判断 */
export function privateSites(lockedUrls: string[], configured: string[]): string[] {
  const out = new Set(configured.map(normalizeDomain).filter(Boolean))
  for (const u of lockedUrls) {
    if (!isHttp(u) || isIntranet(u)) continue
    const site = siteOf(hostOf(u))
    if (site) out.add(site)
  }
  return [...out]
}

/** 不读正文、请求里只给标题和域名：非 http(s)、内网和本机、像内网的主机名、私有站点 */
export function isPrivateUrl(url: string, privateList: string[]): boolean {
  if (!isHttp(url) || isIntranet(url)) return true
  // 主机名末尾的点（nas.local.）和不带点的是同一个地址，先去掉再比
  const host = hostOf(url).replace(/\.+$/, '')
  if (!host || INTERNAL_SUFFIX.test(host) || MORE_LOCAL_IPV4.test(host) || !host.includes('.')) return true
  return matchesDomain(host, privateList)
}

/** 能不能把正文片段发给 AI：白名单站点，并且不是私有的（是否公开版本另由 isPublicExcerpt 核对） */
export function textAllowed(url: string, textDomains: string[], privateList: string[]): boolean {
  return !isPrivateUrl(url, privateList) && matchesDomain(hostOf(url), textDomains)
}

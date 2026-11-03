import { describe, expect, it } from 'vitest'
import { DEFAULT_PRIVATE_DOMAINS, DEFAULT_TEXT_DOMAINS, isPrivateUrl, matchesDomain, normalizeDomain, privateSites, siteOf, textAllowed } from '../src/core/sites'

describe('站点', () => {
  it('规整设置里填的域名', () => {
    expect(normalizeDomain(' https://www.Example.com/a?b ')).toBe('example.com')
    expect(normalizeDomain('blog.csdn.net:8080')).toBe('blog.csdn.net')
    expect(normalizeDomain('')).toBe('')
    // 通配和 // 开头的写法：规整成主域名，子域名照样匹配得上
    expect(normalizeDomain('*.feishu.cn')).toBe('feishu.cn')
    expect(normalizeDomain('.feishu.cn')).toBe('feishu.cn')
    expect(normalizeDomain('//abc.feishu.cn/docx/1')).toBe('abc.feishu.cn')
    expect(matchesDomain('abc.feishu.cn', ['*.feishu.cn'])).toBe(true)
  })

  it('主域名', () => {
    expect(siteOf('a.b.example.com')).toBe('example.com')
    expect(siteOf('x.example.com.cn')).toBe('example.com.cn')
    expect(siteOf('abc.feishu.cn')).toBe('feishu.cn')
    expect(siteOf('10.0.0.1')).toBe('10.0.0.1')
    expect(siteOf('example.com')).toBe('example.com')
  })

  it('子域名也算命中，别的域名不算', () => {
    expect(matchesDomain('abc.feishu.cn', ['feishu.cn'])).toBe(true)
    expect(matchesDomain('feishu.cn', ['feishu.cn'])).toBe(true)
    expect(matchesDomain('notfeishu.cn', ['feishu.cn'])).toBe(false)
    expect(matchesDomain('www.cnblogs.com', ['cnblogs.com'])).toBe(true)
  })

  it('私有：默认名单、内网、本机、像内网的主机名、锁定文件夹里出现过的站点', () => {
    const list = privateSites(['https://oa.company.example/a', 'https://abc.feishu.cn/docx/1', 'http://192.168.1.2/x', 'chrome://settings'], DEFAULT_PRIVATE_DOMAINS)
    expect(list).toContain('company.example')
    expect(list).not.toContain('192.168.1.2')
    expect(isPrivateUrl('https://wiki.company.example/page', list)).toBe(true)
    expect(isPrivateUrl('https://x.feishu.cn/docx/2', list)).toBe(true)
    expect(isPrivateUrl('http://localhost:3000/', list)).toBe(true)
    expect(isPrivateUrl('http://nas.local/', list)).toBe(true)
    expect(isPrivateUrl('http://intranet/', list)).toBe(true)
    expect(isPrivateUrl('file:///C:/a.html', list)).toBe(true)
    expect(isPrivateUrl('https://juejin.cn/post/1', list)).toBe(false)
    // 默认名单里的 Lark、钉钉；内网和本机的 IP
    expect(DEFAULT_PRIVATE_DOMAINS).toEqual(['feishu.cn', 'feishu.net', 'larksuite.com', 'larkoffice.com', 'dingtalk.com'])
    expect(isPrivateUrl('https://abc.larksuite.com/docx/1', list)).toBe(true)
    expect(isPrivateUrl('https://abc.larkoffice.com/wiki/1', list)).toBe(true)
    expect(isPrivateUrl('https://alidocs.dingtalk.com/i/1', list)).toBe(true)
    expect(isPrivateUrl('http://192.168.1.2/x', list)).toBe(true)
    expect(isPrivateUrl('http://10.0.0.5/', list)).toBe(true)
    expect(isPrivateUrl('http://127.0.0.1:8080/', list)).toBe(true)
  })

  it('正文片段只给白名单里、并且不私有的', () => {
    expect(textAllowed('https://blog.csdn.net/u/article/details/1', DEFAULT_TEXT_DOMAINS, [])).toBe(true)
    expect(textAllowed('https://www.cnblogs.com/u/p/1.html', DEFAULT_TEXT_DOMAINS, [])).toBe(true)
    expect(textAllowed('https://example.com/a', DEFAULT_TEXT_DOMAINS, [])).toBe(false)
    // 白名单站点进了私有名单（比如锁定文件夹里有它）：私有优先
    expect(textAllowed('https://github.com/org/repo', DEFAULT_TEXT_DOMAINS, ['github.com'])).toBe(false)
  })
})

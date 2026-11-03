import { describe, expect, it } from 'vitest'
import { findRandomTokens, sanitizeText, sanitizeUrlForAi, truncate } from '../src/core/sanitize'

describe('sanitize', () => {
  it('邮箱和手机号换成占位符', () => {
    expect(sanitizeText('联系 chen.gang+test@example.com 或 13812345678')).toBe('联系 {邮箱} 或 {手机号}')
  })

  it('手机号前后有数字时不替换（订单号、时间戳）', () => {
    expect(sanitizeText('订单 213812345678')).toBe('订单 213812345678')
    expect(sanitizeText('138123456789')).toBe('138123456789')
    expect(sanitizeText('12345678901')).toBe('12345678901')
  })

  it('随机串：≥24 位且同时含字母和数字', () => {
    expect(findRandomTokens('a1b2c3d4e5f6a7b8c9d0e1f2')).toEqual(['a1b2c3d4e5f6a7b8c9d0e1f2'])
    expect(findRandomTokens('a1b2c3d4e5f6a7b8c9d0e1f')).toEqual([]) // 23 位
    expect(findRandomTokens('abcdefghijklmnopqrstuvwxyz')).toEqual([]) // 只有字母
    expect(findRandomTokens('123456789012345678901234567')).toEqual([]) // 只有数字
    expect(findRandomTokens('how-to-use-vue3-composition-api-in-2024')).toEqual([]) // 连字符分开的单词
    expect(sanitizeText('x 5f4dcc3b5aa765d61d8327deb882cf99 y')).toBe('x {随机串} y')
  })

  it('网址只留域名和路径，去掉参数和 #，路径也脱敏', () => {
    expect(sanitizeUrlForAi('https://www.Example.com/a/b/?token=abc#top')).toBe('example.com/a/b')
    expect(sanitizeUrlForAi('http://blog.csdn.net/qq_41234567/article/details/123456789')).toBe('blog.csdn.net/qq_41234567/article/details/123456789')
    expect(sanitizeUrlForAi('https://xx.feishu.cn/docx/AbCd1234EfGh5678IjKl9012MnOp')).toBe('xx.feishu.cn/docx/{随机串}')
    expect(sanitizeUrlForAi('https://example.com/%E6%96%87%E6%A1%A3/')).toBe('example.com/文档')
    expect(sanitizeUrlForAi('https://example.com/')).toBe('example.com')
  })

  it('非 http(s) 只返回协议', () => {
    expect(sanitizeUrlForAi('file:///C:/a.html')).toBe('file:')
    expect(sanitizeUrlForAi('javascript:void(0)')).toBe('javascript:')
    expect(sanitizeUrlForAi('不是网址')).toBe('')
  })

  it('truncate 按码点截，emoji 不被截半', () => {
    expect(truncate('一二三四五', 5)).toBe('一二三四五')
    expect(truncate('一二三四五六', 5)).toBe('一二三四…')
    expect(truncate('😀😀😀😀😀😀', 4)).toBe('😀😀😀…')
    expect([...truncate('😀😀😀😀😀😀', 4)].length).toBe(4)
  })
})

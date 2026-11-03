#!/usr/bin/env node
// 界面验收：在临时 Chrome 里打开演示模式（?demo=1，内存书签），按 docs/设计规范.md 逐项量计算样式和几何位置，
// 走一遍浏览、对话框、体检、抓取、整理、应用、撤销，每个状态截一张图给人工看。
// 用法：node tools/e2e/ui-check.mjs [--ext .output/chrome-mv3] [--out <截图目录>]
// 退出码：0 全部符合；1 有不符合的项。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { launch } from './browser.mjs'

const { values } = parseArgs({ options: { ext: { type: 'string', default: '.output/chrome-mv3' }, out: { type: 'string', default: path.join(os.tmpdir(), 'bt-shots') } } })

const LIGHT = {
  accent: 'rgb(0, 122, 255)',
  accentFill: 'rgba(0, 122, 255, 0.12)',
  bg: 'rgb(245, 245, 247)',
  surface: 'rgb(255, 255, 255)',
  glass: 'rgba(246, 246, 248, 0.78)',
  label: 'rgba(0, 0, 0, 0.85)',
  secondary: 'rgba(60, 60, 67, 0.6)',
  fill: 'rgba(120, 120, 128, 0.12)'
}
const DARK = { accent: 'rgb(10, 132, 255)', bg: 'rgb(0, 0, 0)', surface: 'rgb(28, 28, 30)', label: 'rgba(255, 255, 255, 0.85)', secondary: 'rgba(235, 235, 245, 0.6)' }
const EASE = 'cubic-bezier(0.25, 0.1, 0.25, 1)'
const GLASS = 'saturate(1.8) blur(20px)'

// [选择器, 属性, 期望值, 说明]；期望值是函数时自定义判断
const SPEC = [
  ['body', 'font-family', (v) => v.startsWith('-apple-system'), '系统字体栈'],
  ['body', 'font-size', '13px', '正文字号'],
  ['body', 'line-height', '18px', '正文行高'],
  ['body', 'color', LIGHT.label, '正文颜色'],
  ['body', 'background-color', LIGHT.bg, '页面底色'],
  ['.topbar', 'height', '52px', '顶栏高'],
  ['.topbar', 'padding-left', '16px', '顶栏左右内边距'],
  ['.topbar', 'column-gap', '8px', '顶栏控件间距'],
  ['.topbar', 'background-color', LIGHT.glass, '顶栏玻璃底色'],
  ['.topbar', 'backdrop-filter', GLASS, '顶栏毛玻璃'],
  ['.app-name', 'font-size', '15px', '应用名字号'],
  ['.app-name', 'font-weight', '600', '应用名字重'],
  ['.search input', 'height', '32px', '搜索框高'],
  ['.search', 'width', '320px', '搜索框宽'],
  ['.search input', 'border-top-left-radius', '999px', '搜索框胶囊'],
  ['.search input', 'padding-left', '32px', '搜索框左内边距'],
  ['.search input', 'background-color', LIGHT.fill, '搜索框底色'],
  ['.segmented', 'height', '32px', '分段控件高'],
  ['.segmented', 'border-top-left-radius', '999px', '分段控件胶囊'],
  ['.segmented button[aria-pressed="true"]', 'background-color', LIGHT.surface, '分段选中块'],
  ['.topbar .btn:not(.btn-icon)', 'height', '32px', '顶栏按钮高'],
  ['.topbar .btn:not(.btn-icon)', 'border-top-left-radius', '999px', '按钮胶囊'],
  ['.topbar .btn-primary', 'background-color', LIGHT.accent, '主按钮蓝底'],
  ['.topbar .btn-primary', 'color', 'rgb(255, 255, 255)', '主按钮白字'],
  ['.btn', 'transition-duration', (v) => v.split(',').every((x) => x.trim() === '0.15s'), '过渡 150ms'],
  ['.btn', 'transition-timing-function', (v) => v.split('),').every((x) => x.includes('0.25, 0.1, 0.25, 1')), `缓动 ${EASE}`],
  ['.sidebar', 'width', '240px', '左栏宽'],
  ['.sidebar', 'padding-top', '12px', '左栏上内边距'],
  ['.sidebar', 'padding-left', '8px', '左栏左右内边距'],
  ['.sidebar', 'backdrop-filter', GLASS, '左栏毛玻璃'],
  ['.side-row', 'height', '28px', '左栏行高'],
  ['.side-row', 'padding-left', '10px', '左栏行内边距'],
  ['.side-row', 'margin-bottom', '2px', '左栏行间距'],
  ['.side-row', 'border-top-left-radius', '8px', '左栏选中行圆角'],
  ['.side-row', 'column-gap', '8px', '图标和文字间距'],
  ['.side-row .icon', 'width', '16px', '左栏图标'],
  ['.side-row[aria-current="true"]', 'background-color', LIGHT.accentFill, '左栏选中底色'],
  ['.side-row[aria-current="true"]', 'color', LIGHT.accent, '左栏选中文字'],
  ['.side-group', 'font-size', '12px', '分组标题字号'],
  ['.side-group', 'font-weight', '600', '分组标题字重'],
  ['.side-group', 'margin-top', '16px', '分组标题上边距'],
  ['.side-group', 'margin-bottom', '4px', '分组标题下边距'],
  ['.side-group', 'padding-left', '10px', '分组标题左内边距'],
  ['.content', 'padding-top', '76px', '内容区上边距（顶栏 52 + 24）'],
  ['.content', 'padding-left', '32px', '内容区左右边距'],
  ['.content', 'padding-bottom', '32px', '内容区下边距'],
  ['.view-title', 'font-size', '22px', '视图标题字号'],
  ['.view-title', 'font-weight', '600', '视图标题字重'],
  ['.view-title', 'line-height', '28px', '视图标题行高'],
  ['.view-head', 'margin-bottom', '16px', '标题到内容'],
  ['.view-count', 'font-size', '13px', '标题数量字号'],
  ['.view-count', 'color', LIGHT.secondary, '标题数量颜色'],
  ['.grid', 'column-gap', '16px', '卡片间距'],
  ['.grid', 'grid-template-columns', (v) => v.split(' ').length === 3, '1440×900 下 3 列'],
  ['.card', 'padding-top', '16px', '卡片内边距'],
  ['.card', 'border-top-left-radius', '12px', '卡片圆角'],
  ['.card', 'background-color', LIGHT.surface, '卡片白底'],
  ['.card', 'box-shadow', 'none', '卡片无投影'],
  ['.card', 'border-top-width', '0px', '卡片无边框'],
  ['.card .favicon', 'width', '20px', '卡片图标'],
  ['.card .favicon', 'border-top-left-radius', '4px', '图标圆角'],
  ['.card-head', 'column-gap', '10px', '图标和标题间距'],
  ['.card-title', 'font-size', '14px', '卡片标题字号'],
  ['.card-title', 'font-weight', '600', '卡片标题字重'],
  ['.card-title', 'line-height', '20px', '卡片标题行高'],
  ['.card-desc', 'font-size', '13px', '卡片说明字号'],
  ['.card-desc', 'line-height', '18px', '卡片说明行高'],
  ['.card-desc', 'color', LIGHT.secondary, '卡片说明颜色'],
  ['.card-desc', 'margin-top', '6px', '标题到说明'],
  ['.card-foot', 'margin-top', '12px', '说明到底栏'],
  ['.card-foot', 'height', '20px', '底栏高 20（有没有徽标都一样）'],
  ['.card-foot', 'font-size', '12px', '底栏字号'],
  ['.card-foot', 'color', LIGHT.secondary, '底栏颜色'],
  ['.badge', 'font-size', '12px', '徽标字号'],
  ['.badge', 'border-top-left-radius', '999px', '徽标胶囊'],
  ['.badge', 'background-color', LIGHT.fill, '徽标灰底'],
  ['.badge', 'color', LIGHT.secondary, '徽标灰字'],
  ['.chip', 'border-top-left-radius', '999px', '筛选胶囊'],
  ['.chip', 'background-color', LIGHT.fill, '筛选灰底']
]

/** 在页面里取计算样式，返回 { [选择器]: { 属性: 值 } } */
const collect = (spec) => `(() => {
  const out = {}
  for (const [sel, prop] of ${JSON.stringify(spec.map(([s, p]) => [s, p]))}) {
    const el = document.querySelector(sel)
    out[sel] = out[sel] || {}
    out[sel][prop] = el ? getComputedStyle(el).getPropertyValue(prop).trim() : '（找不到元素）'
  }
  return out
})()`

/** 页面上所有元素用到的有色颜色（不是灰阶的），检查「一个主色」 */
const COLORS = `(() => {
  const seen = {}
  const parse = (c) => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const [r, g, b, a = '1'] = m[1].split(',').map((x) => x.trim()); return { r: +r, g: +g, b: +b, a: +a } }
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg') && el.tagName !== 'svg') continue
    if (el.matches('img')) continue
    const s = getComputedStyle(el)
    for (const p of ['color', 'background-color', 'border-top-color']) {
      const c = parse(s.getPropertyValue(p))
      if (!c || c.a === 0) continue
      const spread = Math.max(c.r, c.g, c.b) - Math.min(c.r, c.g, c.b)
      if (spread <= 12) continue
      if (p === 'border-top-color' && parseFloat(s.borderTopWidth) === 0) continue
      const key = c.r + ',' + c.g + ',' + c.b
      seen[key] = (seen[key] || 0) + 1
    }
  }
  return seen
})()`

/** 不在书签内容里、超过 8 个字的可见文字：给人工检查有没有解释性文案 */
const TEXTS = `(() => {
  const out = new Set()
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.textContent.trim()
    const el = n.parentElement
    if (!t || !el || el.closest('.card, .row, .item, .tree, option, select, script, style')) continue
    if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue
    if ([...t].length > 8) out.add(t)
  }
  return [...out]
})()`

/** 看得见的主按钮的文字：关着的 dialog 里的不算，显示成选中样式的顶栏「整理」不算 */
const primaries = (scope = 'body') =>
  `[...document.querySelectorAll(${JSON.stringify(`${scope} .btn-primary`)})].filter((b) => b.checkVisibility() && b.getAttribute('aria-pressed') !== 'true').map((b) => b.textContent.trim())`
const VISIBLE_PRIMARY_TEXTS = primaries()
const button = (text) => `[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)} && b.checkVisibility())`

let bad = 0
function check(spec, actual) {
  for (const [sel, prop, want, label] of spec) {
    const got = actual[sel]?.[prop]
    const ok = typeof want === 'function' ? !!got && got !== '（找不到元素）' && want(got) : got === want
    if (!ok) bad++
    console.log(`${ok ? '✓' : '✗'} ${label}：${sel} ${prop} = ${got}${ok ? '' : `（期望 ${typeof want === 'function' ? '满足规则' : want}）`}`)
  }
}
function expect(ok, label, detail = '') {
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? `：${detail}` : ''}`)
}
const same = (xs) => xs.length > 0 && xs.every((x) => Math.abs(x - xs[0]) < 0.5)
/** 关页面前检查页面里有没有没接住的异常和 console.error */
async function closePage(page) {
  expect(!page.errors.length, '页面没有报错', page.errors.slice(0, 3).join(' | '))
  await page.close()
}

fs.mkdirSync(values.out, { recursive: true })
const browser = await launch({ extPath: values.ext })
try {
  const shot = (name) => path.join(values.out, `${name}.png`)
  const ready = 'document.querySelector(".content .grid, .content .list, .content .stats, .content .panel")'

  // ---------------------------------------------------------------- 浅色 · 浏览
  let page = await browser.open('manager.html?demo=1&theme=light')
  await page.waitFor(ready)
  await sleep(300)
  console.log('— 浅色 · 浏览 —')
  check(SPEC, await page.evaluate(collect(SPEC)))
  await page.screenshot(shot('browse-light'))

  const colors = await page.evaluate(COLORS)
  const others = Object.entries(colors).filter(([k]) => k !== '0,122,255')
  expect(!others.length, '一个主色', `有色颜色 ${JSON.stringify(colors)}`)
  const browsePrimaries = await page.evaluate(VISIBLE_PRIMARY_TEXTS)
  expect(browsePrimaries.join() === '整理', '浏览视图只有顶栏「整理」一个主按钮', JSON.stringify(browsePrimaries))

  // 同一行卡片的底栏对齐、高度一样
  const rowsAligned = await page.evaluate(`(() => {
    const rows = new Map()
    for (const c of document.querySelectorAll('.grid .card')) {
      const r = c.getBoundingClientRect(), f = c.querySelector('.card-foot').getBoundingClientRect()
      const k = Math.round(r.top)
      if (!rows.has(k)) rows.set(k, [])
      rows.get(k).push({ bottom: Math.round(f.bottom), height: Math.round(r.height) })
    }
    return [...rows.values()].every((xs) => xs.every((x) => x.bottom === xs[0].bottom && x.height === xs[0].height))
  })()`)
  expect(rowsAligned, '同一行卡片等高、底栏对齐')
  const initials = await page.evaluate(`[...document.querySelectorAll('.favicon-letter')].map((x) => x.textContent.trim()).filter((t) => !/^[\\p{L}\\p{N}]$/u.test(t))`)
  expect(!initials.length, '首字母块都是字母、数字或汉字', JSON.stringify(initials))
  console.log(`  人工检查（超过 8 字的界面文字）：${JSON.stringify(await page.evaluate(TEXTS))}`)

  // 焦点环：文字输入框聚焦时一定显示（:focus-visible），量它的样式
  const ring = await page.evaluate(`(() => { const el = document.querySelector('.search input'); el.focus(); const s = getComputedStyle(el); const v = s.outlineStyle + ' ' + s.outlineWidth + ' ' + s.outlineColor + ' ' + s.outlineOffset; el.blur(); return v })()`)
  expect(ring === 'solid 3px rgba(0, 122, 255, 0.5) 0px', '焦点环 3px 半透明主色、贴着控件', ring)

  // 编辑对话框：悬停卡片出现铅笔，点开
  await page.hover('document.querySelector(".grid .card-wrap")')
  await sleep(250)
  const editOpacity = await page.evaluate(`getComputedStyle(document.querySelector('.grid .card-wrap .card-edit')).opacity`)
  expect(editOpacity === '1', '悬停卡片时出现编辑按钮', `opacity ${editOpacity}`)
  await page.screenshot(shot('browse-hover'))
  await page.evaluate(`document.querySelector('.grid .card-wrap .card-edit').click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  await sleep(250)
  await page.screenshot(shot('edit-light'))
  await page.evaluate(`document.querySelector('dialog[open]').close()`)

  // 列表
  await page.evaluate(`${button('列表')}.click()`)
  await page.waitFor('document.querySelector(".content .list")')
  const ROW = [
    ['.row', 'height', '44px', '列表行高'],
    ['.row', 'padding-left', '16px', '列表行内边距'],
    ['.list', 'border-top-left-radius', '12px', '列表容器圆角'],
    ['.list', 'background-color', LIGHT.surface, '列表容器白底']
  ]
  console.log('— 浅色 · 列表 —')
  check(ROW, await page.evaluate(collect(ROW)))
  const inset = await page.evaluate(`getComputedStyle(document.querySelector('.row-wrap .row'), '::after').left`)
  expect(inset === '46px', '分隔线缩进到文字起点', `${inset}（期望 46px）`)
  await page.screenshot(shot('list-light'))
  await page.evaluate(`${button('卡片')}.click()`)

  // 设置对话框
  await page.evaluate(`document.querySelector('[aria-label="设置"]').click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  await sleep(250)
  const DLG = [
    ['dialog[open]', 'width', '440px', '对话框宽'],
    ['dialog[open]', 'padding-top', '24px', '对话框内边距'],
    ['dialog[open]', 'border-top-left-radius', '14px', '对话框圆角'],
    ['dialog[open]', 'box-shadow', (v) => v.includes('40px'), '对话框阴影'],
    ['dialog[open]', 'animation-duration', '0.2s', '对话框淡入 200ms']
  ]
  console.log('— 设置对话框 —')
  check(DLG, await page.evaluate(collect(DLG)))
  const rights = await page.evaluate(`[...document.querySelectorAll('dialog[open] input[type=url], dialog[open] input[type=text], dialog[open] input[type=password]')].map((x) => x.getBoundingClientRect().right)`)
  expect(rights.length === 3 && same(rights), '三个输入框右边对齐', JSON.stringify(rights.map(Math.round)))
  const focused = await page.evaluate('document.activeElement?.id')
  expect(focused === 'api-key', '没填 key 时焦点在 key 输入框', String(focused))
  // 二期加的设置项：两个勾选框、两个文本框；对话框里还是只有一个主按钮、一个主色
  const autoItems = await page.evaluate(`(() => {
    const d = document.querySelector('dialog[open]')
    return {
      checks: [...d.querySelectorAll('label.check')].map((l) => l.textContent.trim()),
      areas: [...d.querySelectorAll('label.field')].filter((l) => l.querySelector('textarea')).map((l) => l.querySelector('span')?.textContent.trim())
    }
  })()`)
  expect(autoItems.checks.includes('收藏时自动整理') && autoItems.checks.includes('通知') && autoItems.areas.join() === '发正文的网站,不读正文的网站', '设置里有二期的四项（自动整理、通知、发正文的网站、不读正文的网站）', JSON.stringify(autoItems))
  const dlgPrimary = await page.evaluate(primaries('dialog[open]'))
  expect(dlgPrimary.join() === '完成', '设置对话框只有「完成」一个主按钮', JSON.stringify(dlgPrimary))
  const dlgColors = Object.entries(await page.evaluate(COLORS)).filter(([k]) => k !== '0,122,255')
  expect(!dlgColors.length, '设置对话框只有一个主色', JSON.stringify(dlgColors))
  console.log(`  人工检查（设置对话框超过 8 字的界面文字）：${JSON.stringify(await page.evaluate(TEXTS))}`)
  await page.screenshot(shot('settings-light'))
  await page.evaluate(`(document.querySelector('dialog[open] textarea')?.scrollIntoView({ block: 'center' }), true)`)
  await sleep(200)
  await page.screenshot(shot('settings-auto-light'))
  await closePage(page)

  // 弹窗里「没填 API key · 去设置」打开的是 manager.html?settings=1：一打开就弹出设置
  page = await browser.open('manager.html?demo=1&theme=light&settings=1')
  const viaQuery = await page.waitFor('document.querySelector("dialog[open] #api-key")', 8000).then(() => true, () => false)
  expect(viaQuery, '带 ?settings=1 打开管理页时直接弹出设置')
  await closePage(page)

  // ---------------------------------------------------------------- 深色
  page = await browser.open('manager.html?demo=1&theme=dark')
  await page.waitFor(ready)
  await sleep(300)
  const DARK_SPEC = [
    ['body', 'background-color', DARK.bg, '深色页面底'],
    ['body', 'color', DARK.label, '深色正文'],
    ['.card', 'background-color', DARK.surface, '深色卡片'],
    ['.topbar .btn-primary', 'background-color', DARK.accent, '深色主色'],
    ['.card-desc', 'color', DARK.secondary, '深色说明']
  ]
  console.log('— 深色 —')
  check(DARK_SPEC, await page.evaluate(collect(DARK_SPEC)))
  await page.screenshot(shot('browse-dark'), { dark: true })
  // 深色的设置对话框（含二期加的文本框）
  await page.evaluate(`document.querySelector('[aria-label="设置"]').click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  await sleep(250)
  const DARK_DLG = [
    ['dialog[open]', 'background-color', DARK.surface, '深色对话框底'],
    ['dialog[open]', 'color', DARK.label, '深色对话框文字'],
    ['dialog[open] textarea', 'background-color', DARK.surface, '深色文本框底'],
    ['dialog[open] textarea', 'color', DARK.label, '深色文本框文字'],
    ['dialog[open] .btn-primary', 'background-color', DARK.accent, '深色对话框主按钮']
  ]
  console.log('— 深色 · 设置对话框 —')
  check(DARK_DLG, await page.evaluate(collect(DARK_DLG)))
  await page.evaluate(`(document.querySelector('dialog[open] textarea')?.scrollIntoView({ block: 'center' }), true)`)
  await sleep(200)
  await page.screenshot(shot('settings-auto-dark'), { dark: true })
  await closePage(page)

  // ---------------------------------------------------------------- 体检、抓取
  page = await browser.open('manager.html?demo=1&theme=light&view=audit')
  await page.waitFor('document.querySelector(".stats .stat")')
  await sleep(300) // 等顶栏按钮的 150ms 过渡走完
  const STAT = [
    ['.stat', 'border-top-left-radius', '12px', '体检卡片圆角'],
    ['.stat', 'padding-top', '16px', '体检卡片内边距'],
    ['.stat .num', 'font-size', '28px', '体检数字字号'],
    ['.stat .num', 'font-weight', '600', '体检数字字重'],
    ['.stat .num', 'line-height', '34px', '体检数字行高'],
    ['.stat .label', 'font-size', '12px', '体检标签字号'],
    ['.topbar .btn[aria-pressed="true"]', 'background-color', LIGHT.accentFill, '「体检」显示选中']
  ]
  console.log('— 体检 —')
  check(STAT, await page.evaluate(collect(STAT)))
  const zeros = await page.evaluate(`[...document.querySelectorAll('.stat:not(:disabled)')].filter((s) => s.querySelector('.num').textContent.trim() === '0').length`)
  expect(zeros === 0, '问题数为 0 的卡片不显示', `${zeros} 张`)
  expect(!(await page.evaluate('document.querySelector(".side-row[aria-current=true]")')), '体检视图里左栏不显示选中')
  const auditPrimaries = await page.evaluate(primaries('.content'))
  expect(auditPrimaries.length === 0, '体检视图的内容区没有主按钮', JSON.stringify(auditPrimaries))
  await page.screenshot(shot('audit-light'))

  await page.evaluate(`[...document.querySelectorAll('.stat')].find((s) => s.textContent.includes('可清理标题')).click()`)
  await page.waitFor('document.querySelector(".content .list .row")')
  await page.screenshot(shot('audit-selected'))
  await page.evaluate(`[...document.querySelectorAll('.stat')].find((s) => s.textContent.includes('可清理标题')).click()`)

  await page.evaluate(`${button('抓取网页信息')}.click()`)
  await page.waitFor(button('开始'))
  await sleep(200)
  await page.screenshot(shot('audit-fetchplan'))

  // 开抓前能按文件夹排除：取消勾选第一个文件夹，要抓的条数变少；再勾回来恢复
  const fetchCount = `Number([...document.querySelectorAll('.panel .kv span')].find((s) => s.textContent.trim().startsWith('抓取'))?.querySelector('b')?.textContent)`
  const firstFolderBox = `(() => { const d = [...document.querySelectorAll('.panel details')].find((x) => x.querySelector('summary').textContent.includes('文件夹')); d.open = true; return d.querySelector('input[type=checkbox]') })()`
  const n0 = await page.evaluate(fetchCount)
  await page.evaluate(`${firstFolderBox}.click()`)
  await page.waitFor(`${fetchCount} < ${n0}`)
  const n1 = await page.evaluate(fetchCount)
  await page.screenshot(shot('audit-fetchplan-excluded'))
  await page.evaluate(`${firstFolderBox}.click()`)
  await page.waitFor(`${fetchCount} === ${n0}`)
  expect(n1 < n0, '开抓前能按文件夹排除，再勾回来恢复', `抓取 ${n0} → ${n1} → ${n0}`)

  // 按域名排除也一样：取消勾选第一个域名，要抓的变少；它留在列表里（不勾），再勾回来恢复
  const firstDomainBox = `(() => { const d = [...document.querySelectorAll('.panel details')].find((x) => x.querySelector('summary').textContent.includes('域名')); d.open = true; return d.querySelector('input[type=checkbox]') })()`
  const host = await page.evaluate(`${firstDomainBox}.closest('label').querySelector('span').textContent.trim()`)
  await page.evaluate(`${firstDomainBox}.click()`)
  await page.waitFor(`${fetchCount} < ${n0}`)
  const d1 = await page.evaluate(fetchCount)
  const listed = await page.evaluate(`[...[...document.querySelectorAll('.panel details')].find((x) => x.querySelector('summary').textContent.includes('域名')).querySelectorAll('label')].some((l) => l.textContent.includes(${JSON.stringify(host)}) && !l.querySelector('input').checked)`)
  await page.evaluate(`[...[...document.querySelectorAll('.panel details')].find((x) => x.querySelector('summary').textContent.includes('域名')).querySelectorAll('label')].find((l) => l.textContent.includes(${JSON.stringify(host)})).querySelector('input').click()`)
  await page.waitFor(`${fetchCount} === ${n0}`)
  expect(d1 < n0 && listed, '开抓前能按域名排除，排除的留在列表里能勾回来', `抓取 ${n0} → ${d1} → ${n0}`)

  await page.evaluate(`${button('开始')}.click()`)
  // 演示数据抓得快，进度可能一闪而过：看到就截，没看到不算错
  if (await page.waitFor('document.querySelector(".content progress")', 3000).catch(() => false)) await page.screenshot(shot('audit-fetching'))
  await page.waitFor(button('抓取网页信息'), 60000)
  await sleep(200)
  await page.screenshot(shot('audit-fetched'))
  await closePage(page)

  // ---------------------------------------------------------------- 整理：生成方案、预览、应用、撤销
  page = await browser.open('manager.html?demo=1&theme=light&view=organize')
  await page.waitFor(button('生成方案'))
  await sleep(300)
  const sideBefore = await page.evaluate(`[...document.querySelectorAll('.sidebar .side-row .name')].map((x) => x.textContent.trim())`)
  const before = await page.evaluate(VISIBLE_PRIMARY_TEXTS)
  expect(before.join() === '生成方案', '没有方案时主按钮是「生成方案」（顶栏「整理」显示选中）', JSON.stringify(before))
  await page.screenshot(shot('organize-empty'))
  await page.evaluate(`${button('生成方案')}.click()`)
  await page.waitFor('document.querySelector(".applybar")', 30000)
  await sleep(300)
  const ORG = [
    ['.applybar', 'position', 'sticky', '应用条吸底'],
    ['.applybar', 'bottom', '0px', '应用条贴底边'],
    ['.applybar', 'height', '52px', '应用条高 52'],
    ['.applybar', 'backdrop-filter', GLASS, '应用条玻璃'],
    ['.applybar', 'border-top-width', '1px', '应用条上分隔线'],
    ['.tree .ops', 'opacity', '0', '行内操作平时隐藏'],
    ['.item .move', 'opacity', '0', '换目录下拉平时隐藏'],
    ['.topbar .btn-primary', 'background-color', LIGHT.accentFill, '「整理」显示选中']
  ]
  console.log('— 整理 —')
  check(ORG, await page.evaluate(collect(ORG)))
  const after = await page.evaluate(VISIBLE_PRIMARY_TEXTS)
  expect(after.join() === '应用', '有方案后只有「应用」是主按钮', JSON.stringify(after))
  const tops = await page.evaluate(`[...document.querySelectorAll('.cols > .panel')].map((p) => p.getBoundingClientRect().top)`)
  expect(tops.length === 2 && same(tops), '「现在」「整理后」顶边对齐', JSON.stringify(tops.map(Math.round)))
  const countRights = await page.evaluate(`[...document.querySelectorAll('.cols > .panel')].map((p) => [...p.querySelectorAll('.tree .n')].map((n) => n.getBoundingClientRect().right))`)
  expect(
    countRights.length === 2 && countRights.every((xs) => same(xs)),
    '两栏的数量都右对齐',
    JSON.stringify(countRights.map((xs) => [...new Set(xs.map(Math.round))]))
  )
  const barBox = await page.evaluate(`(() => { const r = document.querySelector('.applybar').getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom } })()`)
  expect(Math.round(barBox.left) === 240 && Math.round(barBox.right) === 1440 && Math.round(barBox.bottom) === 900, '应用条占满内容区宽度、贴窗口底边', JSON.stringify(barBox))
  expect(!(await page.evaluate('document.querySelector(".side-row[aria-current=true]")')), '整理视图里左栏不显示选中')
  await page.screenshot(shot('organize-light'))
  await page.screenshot(shot('organize-full'), { fullPage: true })
  console.log(`  人工检查（整理页超过 8 字的界面文字）：${JSON.stringify(await page.evaluate(TEXTS))}`)

  // 悬停「整理后」的一行：操作淡入，子目录的操作和顶层对齐
  await page.hover('document.querySelectorAll(".cols > .panel")[1].querySelector(".tree li.child")')
  await sleep(250)
  const opsOpacity = await page.evaluate(`getComputedStyle(document.querySelectorAll(".cols > .panel")[1].querySelector(".tree li.child .ops")).opacity`)
  expect(opsOpacity === '1', '悬停时行内操作出现', `opacity ${opsOpacity}`)
  const opsLefts = await page.evaluate(`[...document.querySelectorAll('.cols .tree .ops')].map((o) => o.getBoundingClientRect().left)`)
  expect(same(opsLefts), '各行的行内操作左边对齐（子目录也一样）', JSON.stringify([...new Set(opsLefts.map(Math.round))]))
  await page.screenshot(shot('organize-hover'))

  // 应用：确认框（默认按钮是「应用」）→ 备份下载到临时目录 → 结果条带「撤销」，移动数和应用前底部条上的一样
  const planMoved = await page.evaluate(`document.querySelector('.applybar .grow').textContent.match(/移动 (\\d+)/)?.[1]`)
  await page.evaluate(`document.querySelector('.applybar .btn-primary').click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  await sleep(250)
  const confirmFocus = await page.evaluate(`document.activeElement?.textContent.trim()`)
  expect(confirmFocus === '应用', '确认框的默认按钮是「应用」', String(confirmFocus))
  await page.screenshot(shot('organize-confirm'))
  await page.evaluate(`document.querySelector('dialog[open] .btn-primary').click()`)
  await page.waitFor(`document.querySelector('.bar')?.textContent.includes('撤销')`, 30000)
  await sleep(300)
  await page.screenshot(shot('organize-applied'))
  const appliedMoved = await page.evaluate(`document.querySelector('.bar .grow').textContent.match(/移动 (\\d+)/)?.[1]`)
  expect(!!planMoved && planMoved === appliedMoved, '应用前后的「移动」数一样', `方案 ${planMoved}，结果 ${appliedMoved}`)
  const backup = (f) => /^书签备份-\d{8}-\d{4}\.json$/.test(f)
  for (let i = 0; i < 50 && !fs.readdirSync(browser.downloadsDir).some(backup); i++) await sleep(100)
  const files = fs.readdirSync(browser.downloadsDir)
  expect(files.some(backup), '应用前下载了备份（临时目录里）', JSON.stringify(files))
  const barSpec = [
    ['.bar', 'background-color', LIGHT.surface, '结果条白底'],
    ['.bar .link', 'color', LIGHT.accent, '「撤销」是主色链接']
  ]
  check(barSpec, await page.evaluate(collect(barSpec)))

  // 应用后：浏览页「待整理」的筛选数 = 文件夹里的条数（F3）；回到整理页，已经应用的方案不再显示
  const applied = await page.evaluate(`(async () => {
    const st = window.__bt.state
    const { flat } = await window.__bt.workflow.loadTree()
    const other = flat.roots.find((r) => r.rootType === 'other')
    const f = flat.folders.find((x) => x.parentId === other.id && x.title === '待整理')
    const want = f ? flat.bookmarks.filter((b) => b.folderIds.includes(f.id)).length : 0
    st.view = 'browse'
    await new Promise((r) => setTimeout(r, 300))
    const chip = [...document.querySelectorAll('.view-tools .chip')].find((c) => c.childNodes[0].textContent.trim() === '待整理')
    const got = chip ? Number(chip.querySelector('.n').textContent) : 0
    st.view = 'organize'
    await new Promise((r) => setTimeout(r, 500))
    return { want, got, planShown: !!document.querySelector('.applybar') }
  })()`)
  expect(applied.want > 0 && applied.got === applied.want, '应用后「待整理」筛选数和文件夹里的条数一样', `${applied.got} / ${applied.want}`)
  expect(!applied.planShown, '回到整理页不再显示已经应用的方案')

  await page.evaluate(`[...document.querySelectorAll('.bar .link')].find((b) => b.textContent.trim() === '撤销').click()`)
  await page.waitFor(`document.querySelector('.bar')?.textContent.includes('已撤销')`, 30000)
  await sleep(300)
  await page.screenshot(shot('organize-undone'))
  const replan = await page.waitFor('document.querySelector(".applybar")', 5000).catch(() => false)
  expect(!!replan, '撤销后方案又显示出来，可以改了再应用')

  // 再应用一次：一点「应用」，上一次的结果条（「已撤销」）马上收起，应用中不挂旧结果和它的按钮
  await page.evaluate(`document.querySelector('.applybar .btn-primary').click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  const staleNotice = await page.evaluate(`(() => { document.querySelector('dialog[open] .btn-primary').click(); return window.__bt.state.notice })()`)
  expect(staleNotice === null, '开始应用时收起上一次的结果条', JSON.stringify(staleNotice))
  await page.waitFor(`window.__bt.state.notice?.kind === 'applied' && !window.__bt.state.busy`, 30000)
  const restoreDisabledWhileBusy = await page.evaluate(`(async () => {
    // 应用进行中，设置里的「从备份恢复」不可用
    window.__bt.state.busy = true
    window.__bt.state.settingsOpen = true
    await new Promise((r) => setTimeout(r, 300))
    const b = [...document.querySelectorAll('dialog[open] button')].find((x) => x.textContent.trim() === '从备份恢复')
    const disabled = !!b && b.disabled
    window.__bt.state.settingsOpen = false
    window.__bt.state.busy = false
    await new Promise((r) => setTimeout(r, 300))
    return disabled
  })()`)
  expect(restoreDisabledWhileBusy, '应用或撤销进行中，「从备份恢复」不可用')
  await page.evaluate(`[...document.querySelectorAll('.bar .link')].find((b) => b.textContent.trim() === '撤销').click()`)
  await page.waitFor(`window.__bt.state.notice?.kind === 'undone' && !window.__bt.state.busy`, 30000)
  const sideAfterUndo = await page.evaluate(`[...document.querySelectorAll('.sidebar .side-row .name')].map((x) => x.textContent.trim())`)
  expect(sideAfterUndo.join() === sideBefore.join(), '撤销后左栏的文件夹和整理前一样', JSON.stringify(sideAfterUndo))
  await closePage(page)

  // ---------------------------------------------------------------- 二期：工具栏弹窗（演示数据）
  const POPUP_SPEC = [
    ['body', 'width', '360px', '弹窗宽'],
    ['body', 'font-size', '13px', '弹窗正文字号'],
    ['body', 'background-color', LIGHT.surface, '弹窗白底'],
    ['.pop', 'padding-top', '12px', '弹窗内边距'],
    ['.pop-search input', 'height', '32px', '弹窗搜索框高'],
    ['.pop-search input', 'border-top-left-radius', '999px', '弹窗搜索框胶囊'],
    ['.pop-search input', 'background-color', LIGHT.fill, '弹窗搜索框底色'],
    ['.pop-run', 'height', '32px', '整理按钮高'],
    ['.pop-run', 'border-top-left-radius', '999px', '整理按钮胶囊'],
    ['.pop-run.btn-primary', 'background-color', LIGHT.accent, '整理按钮蓝底'],
    ['.pop-head', 'font-size', '12px', '分组标题字号'],
    ['.pop-head', 'font-weight', '600', '分组标题字重'],
    ['.pop-head', 'color', LIGHT.secondary, '分组标题颜色'],
    ['.pop-rec', 'border-top-left-radius', '8px', '行圆角'],
    ['.pop-rec', 'min-height', '40px', '行高'],
    ['.pop-sub', 'font-size', '12px', '行副标题字号'],
    ['.pop-sub', 'color', LIGHT.secondary, '行副标题颜色'],
    ['.pop-undo', 'opacity', '0', '行内「撤销」平时隐藏'],
    ['.pop-foot', 'font-size', '12px', '底部计数字号']
  ]
  const popReady = `!!document.querySelector('.pop-main, .pop-empty')`
  page = await browser.open('popup.html?demo=1&theme=light&state=idle')
  await page.waitFor(popReady)
  await sleep(300)
  console.log('— 弹窗 · 浅色 —')
  check(POPUP_SPEC, await page.evaluate(collect(POPUP_SPEC)))
  const popColors = Object.entries(await page.evaluate(COLORS)).filter(([k]) => k !== '0,122,255')
  expect(!popColors.length, '弹窗只有一个主色', JSON.stringify(popColors))
  expect((await page.evaluate(VISIBLE_PRIMARY_TEXTS)).join() === '整理 3 条', '弹窗只有「整理 N 条」一个主按钮')
  await page.hover(`document.querySelector('.pop-rec')`)
  await sleep(250)
  expect((await page.evaluate(`getComputedStyle(document.querySelector('.pop-rec .pop-undo')).opacity`)) === '1', '悬停这一行时「撤销」出现')
  console.log(`  人工检查（超过 8 字的界面文字）：${JSON.stringify(await page.evaluate(TEXTS))}`)
  await page.screenshot(shot('popup-idle-light'), { width: 360, height: 480 })
  await page.evaluate(`(() => { const i = document.querySelector('.pop-search input'); i.value = '响应式'; i.dispatchEvent(new Event('input')); return true })()`)
  await page.waitFor(`document.querySelectorAll('.pop-row').length > 0`)
  expect((await page.evaluate(`document.querySelectorAll('.pop-row').length`)) === 1, '弹窗搜索边输边出结果')
  await page.screenshot(shot('popup-search-light'), { width: 360, height: 240 })
  await closePage(page)

  for (const [state, wantPrimary] of [
    ['preview', '放好 12 条'],
    ['result', ''],
    ['gate', ''],
    ['running', '']
  ]) {
    page = await browser.open(`popup.html?demo=1&theme=light&state=${state}`)
    await page.waitFor(popReady)
    await sleep(300)
    const prim = (await page.evaluate(VISIBLE_PRIMARY_TEXTS)).join()
    expect(prim === wantPrimary, `弹窗「${state}」状态的主按钮`, JSON.stringify(prim))
    await page.screenshot(shot(`popup-${state}-light`), { width: 360, height: 520 })
    await closePage(page)
  }

  page = await browser.open('popup.html?demo=1&theme=dark&state=idle')
  await page.waitFor(popReady)
  await sleep(300)
  console.log('— 弹窗 · 深色 —')
  const POPUP_DARK = [
    ['body', 'background-color', DARK.surface, '深色弹窗底'],
    ['body', 'color', DARK.label, '深色正文'],
    ['.pop-run.btn-primary', 'background-color', DARK.accent, '深色主按钮'],
    ['.pop-sub', 'color', DARK.secondary, '深色副标题']
  ]
  check(POPUP_DARK, await page.evaluate(collect(POPUP_DARK)))
  await page.screenshot(shot('popup-idle-dark'), { width: 360, height: 480, dark: true })
  await closePage(page)
} finally {
  await browser.close()
}
console.log(bad ? `\n不符合 ${bad} 项` : '\n全部符合')
console.log(`截图在：${values.out}`)
process.exitCode = bad ? 1 : 0

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
import { parseBackup } from '../../src/core/snapshot.ts'
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

  // 卡片上的操作（bookmark-ux M1）：平时隐藏，悬停出现移动、删除、编辑三个按钮
  const opsBefore = await page.evaluate(`getComputedStyle(document.querySelector('.grid .card-wrap .card-ops')).opacity`)
  await page.hover('document.querySelector(".grid .card-wrap")')
  await sleep(250)
  const ops = await page.evaluate(`(() => { const o = document.querySelector('.grid .card-wrap .card-ops'); return { opacity: getComputedStyle(o).opacity, labels: [...o.querySelectorAll('button')].map((b) => b.getAttribute('aria-label')) } })()`)
  expect(opsBefore === '0' && ops.opacity === '1' && ops.labels.join() === '移动,删除,编辑', 'M1 悬停卡片时出现移动、删除、编辑', `平时 ${opsBefore} → 悬停 ${ops.opacity}，${ops.labels.join('、')}`)
  await page.screenshot(shot('browse-hover'))
  await page.evaluate(`document.querySelector('.grid .card-wrap .card-edit').click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  await sleep(250)
  await page.screenshot(shot('edit-light'))
  await page.evaluate(`document.querySelector('dialog[open]').close()`)

  // M1 卡片上「移动」：对话框选一个文件夹 → 结果条「已放到」带撤销 → 撤销回原处；「删除」→「已删除 1 条」→ 撤销回来
  const firstId = await page.evaluate(`(() => { const t = document.querySelector('.grid .card-wrap .card').getAttribute('title'); return window.__bt.state.flat.bookmarks.find((b) => b.title === t).id })()`)
  const parentOfCard = (id) => page.evaluate(`(async () => (await window.__bt.workflow.loadTree()).flat.bookmarks.find((b) => b.id === ${JSON.stringify(id)})?.parentId ?? null)()`)
  const from = await parentOfCard(firstId)
  await page.evaluate(`document.querySelector('.grid .card-wrap .card-ops [aria-label="移动"]').click()`)
  await page.waitFor('document.querySelector("dialog[open] select")')
  await sleep(250)
  await page.screenshot(shot('move-dialog'))
  // 打开时预选它现在所在的文件夹（在前两层里的话）；「放到…」占位（值为空、不能选）和「新建文件夹…」不算
  const moveDefault = await page.evaluate(`document.querySelector('dialog[open] select').value`)
  const moveTo = await page.evaluate(`(() => { const s = document.querySelector('dialog[open] select'); const o = [...s.options].find((x) => x.value && x.value !== s.value && x.value !== '__new'); s.value = o.value; s.dispatchEvent(new Event('change')); return { id: o.value, path: o.textContent.trim() } })()`)
  expect(moveDefault === from, 'M1 移动对话框预选它现在所在的文件夹', `${moveDefault} / ${from}`)
  await page.evaluate(`document.querySelector('dialog[open] .btn-primary').click()`)
  await page.waitFor(`window.__bt.state.notice?.kind === 'manual' && !window.__bt.state.busy`)
  const movedNotice = await page.evaluate(`document.querySelector('.bar .grow').textContent.trim()`)
  const movedParent = await parentOfCard(firstId)
  await page.evaluate(`[...document.querySelectorAll('.bar .link')].find((b) => b.textContent.trim() === '撤销').click()`)
  await page.waitFor(`window.__bt.state.notice?.text === '已撤销' && !window.__bt.state.busy`)
  expect(movedNotice === `已放到「${moveTo.path}」` && movedParent === moveTo.id && (await parentOfCard(firstId)) === from, 'M1 卡片「移动」：放进选的文件夹，结果条能撤销回原处', `${movedNotice}；撤销后回到原文件夹 ${(await parentOfCard(firstId)) === from}`)
  const total0 = await page.evaluate(`window.__bt.state.flat.bookmarks.length`)
  await page.hover('document.querySelector(".grid .card-wrap")')
  await page.evaluate(`document.querySelector('.grid .card-wrap .card-ops [aria-label="删除"]').click()`)
  await page.waitFor(`window.__bt.state.notice?.kind === 'manual' && !window.__bt.state.busy`)
  const delNotice = await page.evaluate(`document.querySelector('.bar .grow').textContent.trim()`)
  const total1 = await page.evaluate(`window.__bt.state.flat.bookmarks.length`)
  await page.evaluate(`[...document.querySelectorAll('.bar .link')].find((b) => b.textContent.trim() === '撤销').click()`)
  await page.waitFor(`window.__bt.state.notice?.text === '已撤销' && !window.__bt.state.busy`)
  const total2 = await page.evaluate(`window.__bt.state.flat.bookmarks.length`)
  expect(delNotice === '已删除 1 条' && total1 === total0 - 1 && total2 === total0, 'M1 卡片「删除」：结果条「已删除 1 条」，撤销后回来', `${delNotice}；${total0} → ${total1} → ${total2}`)
  await page.evaluate(`window.__bt.state.notice = null`)

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
  expect(autoItems.checks.includes('工具栏角标'), 'K4 设置里有「工具栏角标」开关', JSON.stringify(autoItems.checks))
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

  // ---------------------------------------------------------------- 待处理（一开始什么都没有）、全部检查项（原来的体检）
  page = await browser.open('manager.html?demo=1&theme=light&view=triage')
  await page.waitFor('document.querySelector(".content .empty")')
  await sleep(300) // 等顶栏按钮的 150ms 过渡走完
  console.log('— 待处理 · 都处理完了 —')
  const doneText = await page.evaluate(`document.querySelector('.content .empty').textContent.trim()`)
  const topIdle = await page.evaluate(`[...document.querySelectorAll('.topbar .btn')].find((b) => b.textContent.startsWith('待处理')).textContent.trim()`)
  expect(doneText === '都处理完了' && !(await page.evaluate('document.querySelector(".tri")')), 'T9 三类都没有时显示「都处理完了」', doneText)
  expect(topIdle === '待处理', 'T1 没有要拿主意的时，顶栏「待处理」后面不带数字', topIdle)
  expect(await page.evaluate(`!document.querySelector('details.tri-audit').open`), 'T13 全部检查项默认收起')
  await page.screenshot(shot('triage-done-light'))
  await page.evaluate(`(document.querySelector('details.tri-audit').open = true, true)`)
  await page.waitFor('document.querySelector(".stats .stat")')
  await sleep(200)
  const STAT = [
    ['.stat', 'border-top-left-radius', '12px', '体检卡片圆角'],
    ['.stat', 'padding-top', '16px', '体检卡片内边距'],
    ['.stat .num', 'font-size', '28px', '体检数字字号'],
    ['.stat .num', 'font-weight', '600', '体检数字字重'],
    ['.stat .num', 'line-height', '34px', '体检数字行高'],
    ['.stat .label', 'font-size', '12px', '体检标签字号'],
    ['.topbar .btn[aria-pressed="true"]', 'background-color', LIGHT.accentFill, '「待处理」显示选中']
  ]
  console.log('— 全部检查项 —')
  check(STAT, await page.evaluate(collect(STAT)))
  const zeros = await page.evaluate(`[...document.querySelectorAll('.stat:not(:disabled)')].filter((s) => s.querySelector('.num').textContent.trim() === '0').length`)
  expect(zeros === 0, '问题数为 0 的卡片不显示', `${zeros} 张`)
  expect(!(await page.evaluate('document.querySelector(".side-row[aria-current=true]")')), '待处理视图里左栏不显示选中')
  const auditPrimaries = await page.evaluate(primaries('.content'))
  expect(auditPrimaries.length === 0, '待处理视图的内容区没有主按钮', JSON.stringify(auditPrimaries))
  await page.screenshot(shot('audit-light'))
  // T13 原体检页的统计卡片一张不少：按 state 里同一份体检结果算出该有的卡（书签、文件夹、书签栏顶层三张常驻，问题数不为 0 的才有），
  // 和页面上逐张对上标签和数字；每张问题卡片点开，下面的清单条数等于卡片上的数
  const audit = await page.evaluate(`(async () => {
    const { summary: s, issues: i, flat } = window.__bt.state
    const bar = flat.roots.find((r) => r.rootType === 'bookmarks-bar')
    const want = [
      ['书签', s.bookmarks], ['文件夹', s.folders], ['书签栏顶层', bar ? bar.topFolders + bar.looseBookmarks : 0],
      ['重复', s.duplicates.normalized.extra], ['空文件夹', i.emptyFolders.length], ['同名嵌套', i.nestedSameNameFolders.length],
      ['默认名', i.defaultNameFolders.length], ['可清理标题', i.cleanable.length], ['超长标题', i.longTitle.length],
      ['冷门', i.cold.length], ['非 http', i.notHttp.length], ['内网', i.intranet.length]
    ].filter(([, n], k) => k < 3 || n > 0)
    const cards = [...document.querySelectorAll('details.tri-audit .stat')]
    const got = cards.map((c) => [c.querySelector('.label').textContent.trim(), Number(c.querySelector('.num').textContent)])
    const lists = []
    for (const c of cards.filter((c) => !c.disabled)) {
      c.click()
      await new Promise((r) => setTimeout(r, 80))
      lists.push([c.querySelector('.label').textContent.trim(), Number(c.querySelector('.num').textContent), document.querySelectorAll('details.tri-audit .list .row').length])
      c.click()
      await new Promise((r) => setTimeout(r, 80))
    }
    return { want, got, lists }
  })()`)
  expect(JSON.stringify(audit.got) === JSON.stringify(audit.want), 'T13 全部检查项里统计卡片一张不少（标签、数字和体检结果逐张对上）', audit.got.map(([l, n]) => `${l} ${n}`).join('、'))
  expect(audit.lists.length === audit.got.length - 3 && audit.lists.every(([, n, rows]) => rows === n), 'T13 每张问题卡片点开都有清单，条数等于卡片上的数', audit.lists.map(([l, n, rows]) => `${l} ${n}→${rows} 行`).join('、'))
  // O1「抓取网页信息」从体检移走了：待处理（含展开的全部检查项）里没有抓取的按钮、也没有原来「网页信息」那一节
  const fetchLeft = await page.evaluate(`[...document.querySelectorAll('.content button, .content h2')].map((x) => x.textContent.trim()).filter((t) => t.includes('抓取') || t.includes('网页信息'))`)
  expect(fetchLeft.length === 0, 'O1、T13 待处理里（含全部检查项）没有「抓取网页信息」和「网页信息」一节，抓取在整理页第 ① 步', JSON.stringify(fetchLeft))

  await page.evaluate(`[...document.querySelectorAll('.stat')].find((s) => s.textContent.includes('可清理标题')).click()`)
  await page.waitFor('document.querySelector(".content .list .row")')
  await page.screenshot(shot('audit-selected'))
  await page.evaluate(`[...document.querySelectorAll('.stat')].find((s) => s.textContent.includes('可清理标题')).click()`)
  await closePage(page)

  // ---------------------------------------------------------------- 抓取网页信息（整理页第 ① 步）
  page = await browser.open('manager.html?demo=1&theme=light&view=organize')
  await page.waitFor(button('抓取网页信息'))
  await sleep(300)
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
  const steps = await page.evaluate(`[...document.querySelectorAll('.steps .step')].map((s) => s.querySelector('.step-n').textContent.trim() + s.querySelector('.step-title').textContent.trim())`)
  const stepButtons = await page.evaluate(`[...document.querySelectorAll('.steps button')].filter((b) => b.checkVisibility()).map((b) => b.textContent.trim())`)
  expect(steps.join() === '1抓取网页信息,2生成方案,3检查方案,4应用' && stepButtons.includes('抓取网页信息') && !stepButtons.includes('生成说明'), 'O1 整理页四步：抓取在第 ① 步，没有「生成说明」按钮', `${steps.join(' ')}；按钮 ${stepButtons.join('、')}`)
  // U1 整理页每一步最多一行说明，不超过 24 字
  const stepDescs = await page.evaluate(`[...document.querySelectorAll('.steps .step-head')].map((h) => [...h.querySelectorAll('.secondary')].map((x) => x.textContent.trim()))`)
  expect(stepDescs.length === 4 && stepDescs.every((d) => d.length <= 1 && d.every((t) => [...t].length <= 24)), 'U1 整理页每一步最多一行说明，不超过 24 字', JSON.stringify(stepDescs.map((d) => d.map((t) => `${t}（${[...t].length}）`))))
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
    ['.item .move:not(.always)', 'opacity', '0', '换目录下拉平时隐藏（待整理、待清理两组除外）'],
    ['.item .move.always', 'opacity', '1', 'O2 待整理、待清理两组的「放到」一直显示'],
    ['.topbar .btn-primary', 'background-color', LIGHT.accentFill, '「整理」显示选中']
  ]
  console.log('— 整理 —')
  check(ORG, await page.evaluate(collect(ORG)))
  const after = await page.evaluate(VISIBLE_PRIMARY_TEXTS)
  expect(after.join() === '应用', '有方案后只有「应用」是主按钮', JSON.stringify(after))
  const groupHeads = await page.evaluate(`[...document.querySelectorAll('details.group')].map((d) => [d.querySelector('summary span').textContent.trim(), d.open])`)
  expect(groupHeads[0]?.join() === '待整理,true' && groupHeads[1]?.join() === '待清理,true', 'O2 方案清单里待整理、待清理排最前、默认展开', JSON.stringify(groupHeads.slice(0, 3)))
  const described = await page.evaluate(`window.__bt.state.flat.bookmarks.filter((b) => !window.__bt.state.meta[b.id] && b.path[0] !== '受保护资料').length`)
  expect(described === 0, 'O1 生成方案时先给没有说明的写了说明', `还没有说明的 ${described} 条（锁定的除外）`)
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

  // ---------------------------------------------------------------- bookmark-ux：应用后的待处理
  page = await browser.open('manager.html?demo=1&theme=light&view=organize')
  await page.waitFor(button('生成方案'))
  await page.evaluate(`${button('生成方案')}.click()`)
  await page.waitFor('document.querySelector(".applybar")', 30000)
  await page.evaluate(`document.querySelector('.applybar .btn-primary').click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  await page.evaluate(`document.querySelector('dialog[open] .btn-primary').click()`)
  await page.waitFor(`window.__bt.state.notice?.kind === 'applied' && !window.__bt.state.busy`, 30000)
  await page.evaluate(`(window.__bt.state.view = 'triage', window.__bt.state.notice = null)`)
  await page.waitFor('document.querySelector(".tri")')
  await sleep(300)
  console.log('— 待处理 · 应用后 —')
  const TRI = [
    ['.tri', 'border-top-left-radius', '12px', '待处理分区圆角'],
    ['.tri', 'background-color', LIGHT.surface, '待处理分区白底'],
    ['.tri-title', 'font-size', '15px', '分区标题字号'],
    ['.tri-title', 'font-weight', '600', '分区标题字重'],
    ['.tri-desc', 'font-size', '12px', '分区说明字号'],
    ['.tri-desc', 'color', LIGHT.secondary, '分区说明颜色'],
    ['.tri-row', 'min-height', '48px', '行高'],
    ['.tri-all', 'color', LIGHT.accent, '批量删除是主色链接']
  ]
  check(TRI, await page.evaluate(collect(TRI)))
  const triColors = Object.entries(await page.evaluate(COLORS)).filter(([k]) => k !== '0,122,255')
  expect(!triColors.length, '待处理只有一个主色', JSON.stringify(triColors))
  const sections = `[...document.querySelectorAll('.tri')].map((s) => ({ title: s.querySelector('.tri-title').textContent.trim(), n: Number(s.querySelector('.tri-n').textContent), desc: s.querySelector('.tri-desc').textContent.trim(), all: s.querySelector('.tri-all')?.textContent.trim() ?? '' }))`
  const tri = await page.evaluate(sections)
  expect(tri.map((x) => x.title).join() === '拿不准放哪,建议删除,空文件夹', 'T2、T5、T8 待处理分三类', JSON.stringify(tri.map((x) => `${x.title} ${x.n}`)))
  expect(tri.every((x) => x.desc && [...x.desc].length <= 24), 'T10 每类一行说明，不超过 24 字', JSON.stringify(tri.map((x) => `${x.desc}（${[...x.desc].length}）`)))
  const topBusy = await page.evaluate(`[...document.querySelectorAll('.topbar .btn')].find((b) => b.textContent.startsWith('待处理')).textContent.trim()`)
  expect(topBusy === `待处理${tri[0].n + tri[1].n}`, 'T1 顶栏「待处理」后面是拿不准 + 建议删除的条数', topBusy)
  expect(/^删除这 \d+ 条$/.test(tri[1].all) && /^删除 \d+ 个空文件夹$/.test(tri[2].all), 'U2 按钮写动作和数量', JSON.stringify([tri[1].all, tri[2].all]))
  const triPrimaries = await page.evaluate(primaries('.content'))
  expect(triPrimaries.length === 0, '待处理内容区没有主按钮（删除不用蓝色主按钮）', JSON.stringify(triPrimaries))
  const reasons = await page.evaluate(`[...document.querySelectorAll('.tri')[1].querySelectorAll('.tri-sub')].map((s) => s.textContent.trim())`)
  expect(reasons.length === tri[1].n && reasons.every((r) => /^(失效|重复 · 另一条在「|连不上|原因已经不在了)/.test(r)), 'T5 建议删除每条写原因', JSON.stringify(reasons))
  // T2 拿不准放哪的每一行：标题、说明（有的话）、域名
  const unsureRow = await page.evaluate(`(() => {
    const e = window.__bt.state.triage.unsure[0]
    const row = document.querySelector('.tri .tri-row')
    return { name: row.querySelector('.tri-name').textContent.trim(), sub: row.querySelector('.tri-sub').textContent.trim(), desc: window.__bt.state.meta[e.bookmark.id]?.desc ?? '', host: new URL(e.bookmark.url).hostname.replace(/^www\\./, '') }
  })()`)
  expect(!!unsureRow.name && unsureRow.sub.includes(unsureRow.host) && (!unsureRow.desc || unsureRow.sub.startsWith(unsureRow.desc)), 'T2 拿不准的每行有标题、说明（有的话）、域名', `「${unsureRow.name}」/「${unsureRow.sub}」`)
  const guessOpt = await page.evaluate(`(() => { const s = document.querySelector('.tri .tri-row select'); return s.options[s.selectedIndex].textContent.trim() })()`)
  const lastOpt = await page.evaluate(`[...document.querySelector('.tri .tri-row select').options].at(-1).textContent.trim()`)
  expect(guessOpt.endsWith('（AI 猜的）') && lastOpt === '新建文件夹…', 'O3、T3 拿不准的预选 AI 猜的目录，最后一项「新建文件夹…」', `${guessOpt}；最后一项 ${lastOpt}`)
  await page.screenshot(shot('triage-light'), { fullPage: true })
  console.log(`  人工检查（待处理超过 8 字的界面文字）：${JSON.stringify(await page.evaluate(TEXTS))}`)

  const unsureN = `window.__bt.state.triage.unsure.length`
  const cleanupN = `window.__bt.state.triage.cleanup.length`
  const clickUndo = `[...document.querySelectorAll('.bar .link')].find((b) => b.textContent.trim() === '撤销').click()`
  const noticeText = `document.querySelector('.bar .grow').textContent.trim()`
  const settled = (cond) => page.waitFor(`(${cond}) && !window.__bt.state.busy`, 10000)

  // T3 「放进去」：这一条从列表里消失，结果条写放到哪，撤销后回来
  const u0 = await page.evaluate(unsureN)
  await page.evaluate(`[...document.querySelector('.tri .tri-row').querySelectorAll('button')].find((b) => b.textContent.trim() === '放进去').click()`)
  await settled(`window.__bt.state.notice?.kind === 'manual'`)
  const putText = await page.evaluate(noticeText)
  const u1 = await page.evaluate(unsureN)
  await page.screenshot(shot('triage-moved'))
  await page.evaluate(clickUndo)
  await settled(`window.__bt.state.notice?.text === '已撤销'`)
  expect(putText === `已放到「${guessOpt.replace('（AI 猜的）', '')}」` && u1 === u0 - 1 && (await page.evaluate(unsureN)) === u0, 'T3 放进去后从列表里消失、结果条写放到哪，撤销后回到待整理', `${putText}；${u0} → ${u1} → ${await page.evaluate(unsureN)}`)

  // T4 「新建文件夹…」：填名称、选放在哪，建好后放进去；撤销「放到」不删新建的文件夹，它出现在「空文件夹」里
  await page.evaluate(`(() => { const s = document.querySelector('.tri .tri-row select'); s.value = '__new'; s.dispatchEvent(new Event('change')); return true })()`)
  await page.waitFor('document.querySelector("dialog[open] input[type=text]")')
  await sleep(250)
  const parentChoices = await page.evaluate(`[...document.querySelectorAll('dialog[open] select')].at(-1).options.length`)
  await page.screenshot(shot('triage-newfolder'))
  await page.evaluate(`(() => { const i = document.querySelector('dialog[open] input[type=text]'); i.value = '临时收着'; i.dispatchEvent(new Event('input')); return true })()`)
  await page.evaluate(`document.querySelector('dialog[open] .btn-primary').click()`)
  await settled(`window.__bt.state.notice?.text === '已放到「临时收着」'`)
  const made = await page.evaluate(`(() => { const f = window.__bt.state.flat.folders.find((x) => x.title === '临时收着'); return f ? { top: f.depth === 1 && f.rootType === 'bookmarks-bar', n: f.totalBookmarks } : null })()`)
  await page.evaluate(clickUndo)
  await settled(`window.__bt.state.notice?.text === '已撤销'`)
  const keptEmpty = await page.evaluate(`window.__bt.state.triage.empty.some((g) => g.folder.title === '临时收着')`)
  expect(parentChoices > 1 && !!made && made.top && made.n === 1 && keptEmpty && (await page.evaluate(unsureN)) === u0, 'T4 新建文件夹（能选放在书签栏还是顶层文件夹下）放进去；撤销后文件夹留着、出现在空文件夹里', JSON.stringify({ parentChoices, made, keptEmpty }))

  // T6 「删除这 N 条」：确认框（默认按钮是「删除」）→ 下载整棵树的备份（parseBackup 读得了）→「已删除 N 条」→ 撤销回来
  // 应用前的备份可能在同一分钟、同一个文件名（下载会覆盖）：按修改时间找删除时下载的那份
  const backupsSince = (t) =>
    fs
      .readdirSync(browser.downloadsDir)
      .filter((f) => /^书签备份-\d{8}-\d{4}.*\.json$/.test(f))
      .map((f) => ({ f, t: fs.statSync(path.join(browser.downloadsDir, f)).mtimeMs }))
      .filter((x) => x.t >= t)
      .sort((a, b) => b.t - a.t)
  const nRemovable = Number(tri[1].all.match(/\d+/)[0])
  const c0 = await page.evaluate(cleanupN)
  const toDelete = await page.evaluate(`window.__bt.state.triage.cleanup.filter((e) => e.reason.kind !== 'other').map((e) => ({ id: e.bookmark.id, parentId: e.bookmark.parentId }))`)
  const delStart = Date.now() - 1000
  await page.evaluate(`[...document.querySelectorAll('.tri .tri-all')].find((b) => b.textContent.includes('条')).click()`)
  await page.waitFor('document.querySelector("dialog[open]")')
  await sleep(250)
  const delFocus = await page.evaluate(`document.activeElement?.textContent.trim()`)
  const delTitle = await page.evaluate(`document.querySelector('dialog[open] h2').textContent.trim()`)
  await page.screenshot(shot('triage-confirm'))
  await page.evaluate(`document.querySelector('dialog[open] .btn-primary').click()`)
  await settled(`window.__bt.state.notice?.text.startsWith('已删除')`)
  for (let i = 0; i < 50 && !backupsSince(delStart).length; i++) await sleep(100)
  const newest = backupsSince(delStart)[0]?.f
  let backupOk = false
  try {
    // 删除前那一刻的整棵树：要删的几条还在、就在待清理里（应用前的那份备份里它们不在待清理）
    const snap = parseBackup(fs.readFileSync(path.join(browser.downloadsDir, newest), 'utf8'))
    backupOk = toDelete.every((d) => snap.nodes.some((n) => n.id === d.id && n.parentId === d.parentId))
  } catch {
    backupOk = false
  }
  const delText = await page.evaluate(noticeText)
  const c1 = await page.evaluate(cleanupN)
  await page.screenshot(shot('triage-deleted'))
  await page.evaluate(clickUndo)
  await settled(`window.__bt.state.notice?.text === '已撤销'`)
  const c2 = await page.evaluate(cleanupN)
  expect(delTitle === `删除这 ${nRemovable} 条书签？` && delFocus === '删除', 'T6 批量删先确认，默认按钮是「删除」', `${delTitle}；焦点在 ${delFocus}`)
  expect(!!newest && backupOk, 'T6 删之前下载了整棵树的备份（parseBackup 读得了，「从备份恢复」认得），里面有要删的这几条、位置是删之前的', `${newest}；${backupOk}`)
  expect(delText === `已删除 ${nRemovable} 条` && c1 === c0 - nRemovable && c2 === c0, 'T6 结果条「已删除 N 条」带「撤销」，撤销后回来', `${delText}；${c0} → ${c1} → ${c2}`)

  // T8 「删除 N 个空文件夹」：只删勾着的；撤销后回来
  const emptyIds = `window.__bt.state.triage.empty.flatMap((g) => g.ids).length`
  await page.evaluate(`(document.querySelector('details.tri-more').open = true, true)`)
  await sleep(200)
  const boxes = await page.evaluate(`[...document.querySelectorAll('details.tri-more input[type=checkbox]')].map((b) => b.checked)`)
  await page.evaluate(`document.querySelector('details.tri-more input[type=checkbox]').click()`)
  await sleep(150)
  const btnText = await page.evaluate(`[...document.querySelectorAll('.tri .tri-all')].find((b) => b.textContent.includes('空文件夹'))?.textContent.trim() ?? ''`)
  const firstGroupSize = await page.evaluate(`window.__bt.state.triage.empty[0].ids.length`)
  const e0 = await page.evaluate(emptyIds)
  await page.screenshot(shot('triage-empty'))
  await page.evaluate(`[...document.querySelectorAll('.tri .tri-all')].find((b) => b.textContent.includes('空文件夹')).click()`)
  await settled(`window.__bt.state.notice?.text.includes('空文件夹')`)
  const emptyText = await page.evaluate(noticeText)
  const e1 = await page.evaluate(emptyIds)
  await page.evaluate(clickUndo)
  await settled(`window.__bt.state.notice?.text === '已撤销'`)
  expect(boxes.length > 0 && boxes.every(Boolean), 'T8 空文件夹默认全选', JSON.stringify(boxes))
  expect(btnText === `删除 ${e0 - firstGroupSize} 个空文件夹` && emptyText === `已删除 ${e0 - firstGroupSize} 个空文件夹` && e1 === firstGroupSize && (await page.evaluate(emptyIds)) === e0, 'T8 只删勾着的，撤销后回来', `${btnText}；${emptyText}；${e0} → ${e1} → ${await page.evaluate(emptyIds)}`)

  // T8 删的时候再查一次：清单列出来以后，勾着的一组最上层的文件夹里有了书签（比如在 Chrome 书签管理器里挪进去），
  // 删的时候跳过它，结果条写「· 跳过 1」。直接调 workflow 挪：演示数据的书签接口不发变化事件，清单不刷新，和看着旧清单点下去一样
  const skipRun = await page.evaluate(`(async () => {
    const bt = window.__bt
    const boxes = [...document.querySelectorAll('details.tri-more input[type=checkbox]')]
    const g = bt.state.triage.empty[boxes.findLastIndex((b) => b.checked)]
    const btn = [...document.querySelectorAll('.tri .tri-all')].find((b) => b.textContent.includes('空文件夹'))
    const k = Number(btn.textContent.match(/\\d+/)[0])
    const mark = bt.state.triage.unsure[0].bookmark
    window.__skipMove = await bt.workflow.moveBookmarks([mark.id], { folderId: g.folder.id })
    const stale = bt.state.triage.empty.some((x) => x.folder.id === g.folder.id)
    btn.click()
    return { k, target: g.folder.title, size: g.ids.length, stale, mark: mark.id, from: mark.parentId }
  })()`)
  await settled(`window.__bt.state.notice?.text.includes('空文件夹')`)
  const skipText = await page.evaluate(noticeText)
  await page.screenshot(shot('triage-empty-skipped'))
  await page.evaluate(clickUndo)
  await settled(`window.__bt.state.notice?.text === '已撤销'`)
  // 挪进去的那条也挪回原处：走结果条上的「撤销」（撤销完界面会刷新），等它回去了再往下
  await page.evaluate(`(window.__bt.state.notice = { kind: 'manual', text: '挪进空文件夹的那条', change: window.__skipMove }, true)`)
  await sleep(150)
  await page.evaluate(clickUndo)
  await settled(`window.__bt.state.flat.bookmarks.find((b) => b.id === ${JSON.stringify(skipRun.mark)})?.parentId === ${JSON.stringify(skipRun.from)} && window.__bt.state.triage.unsure.length === ${u0}`)
  expect(skipRun.stale && skipText === `已删除 ${skipRun.k - 1} 个空文件夹 · 跳过 1`, 'T8 删的时候再查一次：里面有了书签的跳过，结果条写「· 跳过 N」', `往「${skipRun.target}」（这组 ${skipRun.size} 个）里放了一条再点「删除 ${skipRun.k} 个空文件夹」：${skipText}`)

  // T9 全部处理完：拿不准的放进去、建议删除的删掉（「其他」的逐条删）、空文件夹删掉 →「都处理完了」，顶栏不带数字
  // 建议删除的每一行也有「放到」和「删除」
  const cleanupOps = await page.evaluate(`[...[...document.querySelectorAll('.tri')].find((s) => s.querySelector('.tri-title').textContent === '建议删除').querySelectorAll('.tri-row')].map((r) => !!r.querySelector('select') && r.querySelector('.tri-del')?.textContent.trim() === '删除')`)
  expect(cleanupOps.length === (await page.evaluate(cleanupN)) && cleanupOps.every(Boolean), 'T6 建议删除每条都有「放到」和「删除」', JSON.stringify(cleanupOps))
  const moveTexts = []
  for (let i = 0; i < 20 && (await page.evaluate(unsureN)); i++) {
    // 下拉里直接选一个文件夹（不是 AI 猜的那个「放进去」）
    const picked = await page.evaluate(`(() => { const s = document.querySelector('.tri .tri-row select'); const o = s.options[s.options.length - 2]; s.value = o.value; s.dispatchEvent(new Event('change')); return o.textContent.replace('（AI 猜的）', '').trim() })()`)
    await settled(`window.__bt.state.notice?.kind === 'manual'`)
    moveTexts.push([picked, await page.evaluate(noticeText)])
    await page.evaluate(`window.__bt.state.notice = null`)
  }
  expect(moveTexts.length > 0 && moveTexts.every(([p, t]) => t === `已放到「${p}」`) && (await page.evaluate(unsureN)) === 0, 'T3 「放到」下拉里选了就移过去、从列表里消失，结果条写「已放到「目录」」', JSON.stringify(moveTexts))
  const delTexts = []
  for (let i = 0; i < 20 && (await page.evaluate(cleanupN)); i++) {
    await page.evaluate(`[...document.querySelectorAll('.tri')].find((s) => s.querySelector('.tri-title').textContent === '建议删除').querySelector('.tri-del').click()`)
    await settled(`window.__bt.state.notice?.kind === 'manual'`)
    delTexts.push(await page.evaluate(noticeText))
    await page.evaluate(`window.__bt.state.notice = null`)
  }
  expect(delTexts.length > 0 && delTexts.every((t) => t === '已删除 1 条') && (await page.evaluate(cleanupN)) === 0, 'T6 建议删除逐条「删除」（包括原因已经不在了的）', JSON.stringify(delTexts))
  // T8 这时「待整理」「待清理」都空了：它们本身不进空文件夹清单
  const parkedListed = await page.evaluate(`(() => {
    const { flat, triage } = window.__bt.state
    return flat.folders.filter((f) => f.depth === 1 && f.rootType === 'other' && ['待整理', '待清理'].includes(f.title)).map((f) => [f.title, f.totalBookmarks, triage.empty.some((g) => g.ids.includes(f.id))])
  })()`)
  expect(parkedListed.length === 2 && parkedListed.every(([, n, listed]) => n === 0 && !listed), 'T8 「待整理」「待清理」空了本身不列进空文件夹', JSON.stringify(parkedListed))
  if (await page.evaluate(emptyIds)) {
    // T8 里取消勾选的那组勾回来
    await page.evaluate(`([...document.querySelectorAll('details.tri-more input[type=checkbox]')].filter((b) => !b.checked).forEach((b) => b.click()), true)`)
    await sleep(150)
    await page.evaluate(`[...document.querySelectorAll('.tri .tri-all')].find((b) => b.textContent.includes('空文件夹')).click()`)
    await settled(`window.__bt.state.notice?.text.includes('空文件夹')`)
  }
  await page.waitFor('document.querySelector(".content .empty")')
  const allDone = await page.evaluate(`document.querySelector('.content .empty').textContent.trim()`)
  const topDone = await page.evaluate(`[...document.querySelectorAll('.topbar .btn')].find((b) => b.textContent.startsWith('待处理')).textContent.trim()`)
  expect(allDone === '都处理完了' && topDone === '待处理', 'T9 处理完以后显示「都处理完了」，顶栏不带数字', `${allDone}；${topDone}`)
  await page.screenshot(shot('triage-cleared'))
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
  expect((await page.evaluate(VISIBLE_PRIMARY_TEXTS)).join() === '放好 3 条', 'K9 弹窗只有「放好 N 条」一个主按钮')
  const popIdle = await page.evaluate(`({ note: document.querySelector('.pop-note')?.textContent.trim(), pending: document.querySelector('.pop-pending')?.textContent.replace(/\\s+/g, ''), foot: document.querySelector('.pop-foot').textContent.trim() })`)
  expect(popIdle.note === '3 条新收藏还没放好', 'K9 主按钮上面写「N 条新收藏还没放好」', String(popIdle.note))
  expect(popIdle.pending === '待处理4', 'K6 有待处理时显示「待处理 M」', String(popIdle.pending))
  expect(popIdle.foot === '管理页', 'K8 底部不再显示自动放、待整理、撤销、又挪走、地址栏这行计数', popIdle.foot)
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

  const popText = `document.querySelector('.pop').innerText.replace(/\\s+/g, ' ')`
  for (const [state, wantPrimary] of [
    ['preview', '放好 12 条'],
    ['result', ''],
    ['partial', '放好 1 条'],
    ['empty', ''],
    ['gate', ''],
    ['running', '']
  ]) {
    page = await browser.open(`popup.html?demo=1&theme=light&state=${state}`)
    await page.waitFor(popReady)
    await sleep(300)
    const prim = (await page.evaluate(VISIBLE_PRIMARY_TEXTS)).join()
    expect(prim === wantPrimary, `弹窗「${state}」状态的主按钮`, JSON.stringify(prim))
    const text = await page.evaluate(popText)
    if (state === 'result') {
      const links = await page.evaluate(`[...document.querySelectorAll('.pop-result .link')].map((b) => b.textContent.trim())`)
      expect(text.includes('放好 7 条 · 2 条拿不准，在待整理里') && links.join() === '去处理,撤销这次', 'K7 结果写「N 条拿不准，在待整理里」，旁边「去处理」', `${text.slice(0, 60)}；${links.join('、')}`)
      expect(text.includes('新收藏都放好了'), 'K5 放好以后写「新收藏都放好了」')
    }
    if (state === 'partial') expect(text.includes('1 条没放成：接口拒绝访问（HTTP 401），检查 API key') && text.includes('1 条新收藏还没放好'), 'K2 AI 失败的写「N 条没放成」和原因，还算在 N 里', text.slice(0, 80))
    if (state === 'empty') {
      const disabled = await page.evaluate(`[...document.querySelectorAll('.pop button')].filter((b) => b.disabled && b.checkVisibility()).length`)
      expect(text.includes('新收藏都放好了') && disabled === 0 && !(await page.evaluate(`document.querySelector('.pop-pending')`)), 'K5、K6 N 为 0 写「新收藏都放好了」，没有点不了的按钮；M 为 0 不显示待处理', `${text}；禁用按钮 ${disabled}`)
    }
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

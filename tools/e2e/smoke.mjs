#!/usr/bin/env node
// 冒烟测试：临时 Chrome 配置里装扩展、打开 manager.html、数书签、可选截图。不依赖页面上的具体元素。
//
// 用法：node tools/e2e/smoke.mjs --ext .output/chrome-mv3 [--bookmarks <Bookmarks 文件>] [--shot <png>] [--keep]

import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { launch, redact } from './browser.mjs'

const COUNT = 'new Promise(r => chrome.bookmarks.getTree(t => { let n = 0; const w = x => { if (x.url) n++; (x.children || []).forEach(w) }; t.forEach(w); r(n) }))'

/** 书签文件里的网址条数（只数，不输出内容） */
function countInFile(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  let n = 0
  const walk = (x) => {
    if (x.type === 'url') n++
    for (const c of x.children || []) walk(c)
  }
  for (const root of Object.values(data.roots || {})) if (root && typeof root === 'object') walk(root)
  return n
}

async function main() {
  const { values } = parseArgs({
    options: {
      ext: { type: 'string' },
      bookmarks: { type: 'string' },
      shot: { type: 'string' },
      keep: { type: 'boolean', default: false }
    }
  })
  if (!values.ext) {
    console.error('用法：node tools/e2e/smoke.mjs --ext .output/chrome-mv3 [--bookmarks <文件>] [--shot <png>] [--keep]')
    process.exitCode = 2
    return
  }
  const expected = values.bookmarks ? countInFile(values.bookmarks) : null
  const browser = await launch({ extPath: values.ext, bookmarksFile: values.bookmarks, keep: values.keep })
  try {
    console.log(`${browser.version}，扩展 ID：${browser.extId}`)
    const page = await browser.open('manager.html')
    const total = await page.evaluate(COUNT)
    console.log(`书签总数：${total}`)
    if (expected !== null && total !== expected) {
      console.error(`和书签文件对不上：文件里有 ${expected} 条`)
      process.exitCode = 1
    }
    await sleep(2000)
    if (values.shot) console.log(`截图：${await page.screenshot(values.shot)}`)
    if (page.errors.length) console.log(`页面报错 ${page.errors.length} 条，第一条：${redact(page.errors[0]).split('\n')[0]}`)
  } catch (e) {
    console.error(redact(e.stack || e.message))
    const logs = browser.logs(10)
    if (logs.length) console.error(['Chrome 输出的最后几行：', ...logs.map((l) => `  ${l}`)].join('\n'))
    process.exitCode = 1
  } finally {
    await browser.close()
    const gone = !fs.existsSync(browser.userDataDir)
    console.log(values.keep ? `临时配置保留在：${browser.userDataDir}` : `临时配置${gone ? '已删除' : '没删掉'}：${browser.userDataDir}`)
  }
}

main().catch((e) => {
  console.error(redact(e.message))
  process.exitCode = 1
})

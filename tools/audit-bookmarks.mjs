#!/usr/bin/env node
// 只读统计 Chrome 书签文件，给需求分析和扩展「体检」对账用（accept B1）。
// 只输出汇总数字和域名计数，不输出完整网址列表；不改任何文件。
//
// 用法：
//   node tools/audit-bookmarks.mjs                 读默认配置（Default）
//   node tools/audit-bookmarks.mjs "Profile 1"     读指定配置目录
//   node tools/audit-bookmarks.mjs <Bookmarks 文件路径>
//   加 --json 输出机器可读的汇总（扩展体检做完后用它对账）
//   加 --samples 20 抽样打印标题清理前后对照（只在本机终端看，含书签标题）
//
// 规则只在 src/core/rules.ts 一处（Node 24 能直接 import 只含类型标注的 .ts）。
// 这里只管读书签文件、转成和扩展一样的结构；对账查的是「扩展用 API 读树」和「这里读文件」两条路径一致。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { audit, cleanTitle } from '../src/core/rules.ts'

// Chrome 文件里的时间：1601-01-01 起的微秒字符串
const toMs = (v) => (v && v !== '0' ? Number(BigInt(v) / 1000n) - 11644473600000 : 0)

const ROOT_TYPES = { bookmark_bar: 'bookmarks-bar', other: 'other', synced: 'mobile' }

/** 书签文件 → AuditInput（深度约定和 src/core/tree.ts 一样：直接在根下 = 1） */
export function toAuditInput(data) {
  const input = { roots: [], bookmarks: [], folders: [] }
  const walk = (node, depth, rootType, parentTitle) => {
    for (const child of node.children || []) {
      if (child.type === 'url') {
        input.bookmarks.push({
          id: String(child.id),
          title: child.name || '',
          url: child.url || '',
          depth: depth + 1,
          rootType,
          dateAdded: toMs(child.date_added),
          dateLastUsed: toMs(child.date_last_used)
        })
        continue
      }
      const kids = child.children || []
      const direct = kids.filter((c) => c.type === 'url').length
      input.folders.push({
        id: String(child.id),
        title: child.name || '',
        parentTitle,
        depth: depth + 1,
        rootType,
        directBookmarks: direct,
        subFolders: kids.length - direct
      })
      walk(child, depth + 1, rootType, child.name || '')
    }
  }
  for (const [key, root] of Object.entries(data.roots || {})) {
    const rootType = ROOT_TYPES[key]
    if (!rootType || !root || !Array.isArray(root.children)) continue
    const before = input.bookmarks.length
    walk(root, 0, rootType, '')
    const loose = root.children.filter((c) => c.type === 'url').length
    input.roots.push({ rootType, bookmarks: input.bookmarks.length - before, topFolders: root.children.length - loose, looseBookmarks: loose })
  }
  return input
}

function renderText(file, s) {
  const out = []
  out.push(`书签文件：${file}`)
  out.push(`书签 ${s.bookmarks} 条，文件夹 ${s.folders} 个，最深 ${s.maxFolderDepth} 层`)
  for (const [key, r] of Object.entries(s.roots)) out.push(`  ${key}：书签 ${r.bookmarks}，顶层文件夹 ${r.topFolders}，直接散放 ${r.looseBookmarks}`)
  const fi = s.folderIssues
  out.push(`文件夹：空 ${fi.empty}，只有 1 条 ${fi.singleBookmark}，直接放 ≥50 条 ${fi.bigFlat50}，同名嵌套 ${fi.nestedSameName}，默认名 ${fi.defaultName}，重名 ${fi.duplicateNameGroups} 组`)
  out.push(`重复：完全相同 ${s.duplicates.exact.groups} 组（多 ${s.duplicates.exact.extra} 条）；规范化后 ${s.duplicates.normalized.groups} 组（多 ${s.duplicates.normalized.extra} 条）`)
  out.push(`网址：协议 ${JSON.stringify(s.urls.protocols)}，内网/本机 ${s.urls.intranet}，域名 ${s.urls.domains} 个（只出现一次 ${s.urls.singleUseDomains}）`)
  out.push(`  域名前 20：${s.urls.topDomains.map((d) => `${d.domain} ${d.count}`).join('，')}`)
  const t = s.titles
  out.push(`标题：空 ${t.empty}，就是网址 ${t.isUrl}，消息数前缀 ${t.messagePrefix}，未读数前缀 ${t.countPrefix}，站名后缀 ${t.siteSuffix}，规则可清理 ${t.cleanable}，超过 50 字 ${t.long}，说明不了内容 ${t.vague}`)
  const u = s.usage
  out.push(`打开：有记录 ${u.hasLastUsed}，30 天内 ${u.usedIn30d}，180 天内 ${u.usedIn180d}；冷门（添加超过一年且没有打开记录）${u.cold}`)
  out.push(`按添加年份：${Object.entries(s.addedByYear).map(([y, n]) => `${y} ${n}`).join('，')}`)
  return out
}

function resolveFile(input) {
  if (fs.existsSync(input) && fs.statSync(input).isFile()) return input
  const base = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data')
  return path.join(base, input, 'Bookmarks')
}

function main() {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  const samplesAt = args.indexOf('--samples')
  const samples = samplesAt >= 0 ? Number(args[samplesAt + 1]) || 20 : 0
  const target = args.find((a, i) => !a.startsWith('--') && !(samplesAt >= 0 && i === samplesAt + 1)) || 'Default'

  const file = resolveFile(target)
  if (!fs.existsSync(file)) {
    console.error(`找不到书签文件：${file}`)
    process.exit(1)
  }
  const input = toAuditInput(JSON.parse(fs.readFileSync(file, 'utf8')))
  const { summary } = audit(input)

  if (asJson) {
    console.log(JSON.stringify({ file, ...summary }, null, 2))
    return
  }
  const out = renderText(file, summary)
  if (samples > 0) {
    const changed = input.bookmarks.map((b) => [b.title.trim(), cleanTitle(b.title)]).filter(([before, after]) => before !== after)
    const step = Math.max(1, Math.floor(changed.length / samples))
    out.push('', `标题清理抽样（共 ${changed.length} 条会变，每 ${step} 条取一条）：`)
    for (let i = 0; i < changed.length && out.length < 200; i += step) out.push(`- ${changed[i][0]}`, `  → ${changed[i][1]}`)
  }
  console.log(out.join('\n'))
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main()

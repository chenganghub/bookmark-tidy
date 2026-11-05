// 后台（service worker）。一期没有后台逻辑；二期在这里接：收藏即整理、一键整理的消息、通知按钮、地址栏搜索、工具栏角标。
// 判断和调度都在 src/core/autofile.ts（单测覆盖），这里只把浏览器事件和 API 接上去。
import { browser } from 'wxt/browser'
import { createAutoFiler, type PageRead } from '../src/core/autofile'
import { browserLocks, createMutationLock } from '../src/core/locks'
import { isHttp } from '../src/core/rules'
import { truncate } from '../src/core/sanitize'
import { buildIndex, searchBookmarks, type SearchEntry } from '../src/core/search'
import { chromeKV, createStore } from '../src/core/store'
import { flattenTree } from '../src/core/tree'
import type { BookmarkNode, BookmarksApi } from '../src/core/types'

const SITE_ORIGINS = ['http://*/*', 'https://*/*']
const ALARM = 'bt-auto'
const NOTICE_PREFIX = 'bt:'
/** 「撤销没成」这类说明用的通知：前缀和 NOTICE_PREFIX 不同，点它不会当成「撤销」「改位置」 */
const ERROR_PREFIX = 'bt-err:'

const escapeXml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

export default defineBackground(() => {
  const kv = chromeKV(browser.storage.local as never)
  const session = chromeKV(browser.storage.session as never)
  const store = createStore(kv)
  const lock = createMutationLock({ locks: browserLocks(), session })
  const bookmarks = browser.bookmarks as unknown as BookmarksApi
  let timer: ReturnType<typeof setTimeout> | undefined
  /** 只在 e2e 构建里记：发过的通知（端到端测试核对标题、正文、按钮） */
  const noticeLog: { id: string; title: string; message: string; context: string; buttons: string[] }[] = []

  const filer = createAutoFiler({
    bookmarks,
    kv,
    session,
    lock,
    tabs: { query: (q) => browser.tabs.query(q) },
    async readPage(tabId) {
      const run = browser.scripting.executeScript({ target: { tabId }, files: ['/extract.js'] })
      const r = await Promise.race([run.catch(() => undefined), new Promise<undefined>((res) => setTimeout(() => res(undefined), 5000))])
      const v = r?.[0]?.result as Partial<PageRead> | undefined
      // 脚本被页面挡住、没返回东西时退回抓取；字段不对的不用
      if (!v || typeof v.url !== 'string' || typeof v.text !== 'string') return undefined
      return { url: v.url, title: typeof v.title === 'string' ? v.title : '', description: typeof v.description === 'string' ? v.description : '', text: v.text }
    },
    hasSitePermission: () => browser.permissions.contains({ origins: SITE_ORIGINS }),
    async notify(n) {
      const id = `${NOTICE_PREFIX}${n.bookmarkId}`
      const options = {
        type: 'basic' as const,
        iconUrl: browser.runtime.getURL('/icon/128.png'),
        title: n.title,
        message: n.message,
        ...(n.context ? { contextMessage: n.context } : {}),
        buttons: [{ title: '撤销' }, { title: '改位置' }],
        priority: 0
      }
      await browser.notifications.create(id, options)
      // e2e 构建：记下发过的通知（chrome.notifications.getAll 只给 id，看不到标题和正文）
      if (import.meta.env.MODE === 'e2e') noticeLog.push({ id, title: options.title, message: options.message, context: n.context ?? '', buttons: options.buttons.map((b) => b.title) })
    },
    schedule(ms) {
      clearTimeout(timer)
      timer = setTimeout(() => void filer.processDue(), ms)
      // 后台在等待期里被浏览器停掉时，闹钟把它叫醒（最短 30 秒）
      void browser.alarms.create(ALARM, { delayInMinutes: 0.5 })
    }
  })

  // ---------------------------------------------------------------- 角标：没放好的条数

  let badgeTimer: ReturnType<typeof setTimeout> | undefined
  const badgeSoon = () => {
    clearTimeout(badgeTimer)
    badgeTimer = setTimeout(() => void updateBadge(), 2000)
  }
  async function updateBadge() {
    // 设置里关掉「工具栏角标」时不显示（弹窗里的 N 照常）
    const n = (await store.getSettings()).badge ? (await filer.unfiled().catch(() => [])).length : 0
    await browser.action.setBadgeBackgroundColor({ color: '#8E8E93' })
    await browser.action.setBadgeText({ text: n ? (n > 99 ? '99+' : String(n)) : '' })
  }

  // ---------------------------------------------------------------- 搜索索引（地址栏用）

  let index: SearchEntry[] | undefined
  const invalidate = () => (index = undefined)
  async function getIndex(): Promise<SearchEntry[]> {
    index ??= buildIndex(flattenTree((await browser.bookmarks.getTree()) as BookmarkNode[]), await store.getMeta())
    return index
  }
  const changed = () => {
    invalidate()
    badgeSoon()
  }

  // ---------------------------------------------------------------- 书签事件

  browser.bookmarks.onCreated.addListener((id, node) => {
    void filer.onCreated(id, node as BookmarkNode).catch(() => {})
    changed()
  })
  browser.bookmarks.onMoved.addListener((id, info) => {
    void filer.onMoved(id, info).catch(() => {})
    changed()
  })
  browser.bookmarks.onChanged.addListener(changed)
  browser.bookmarks.onRemoved.addListener(changed)
  browser.bookmarks.onImportBegan.addListener(() => void filer.onImportBegan())
  browser.bookmarks.onImportEnded.addListener(() => {
    void filer.onImportEnded()
    changed()
  })
  browser.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM) void filer.processDue()
  })
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (Object.keys(changes).some((k) => k.startsWith('meta:') || k.startsWith('autorec:') || k === 'apply:latest' || k === 'settings')) changed()
  })

  // ---------------------------------------------------------------- 通知按钮

  async function openFolderOf(bookmarkId: string) {
    const node = (await browser.bookmarks.get(bookmarkId).catch(() => []))[0]
    await browser.tabs.create({ url: `chrome://bookmarks/?id=${node?.parentId ?? ''}` })
  }
  async function onNoticeButton(nid: string, button: number) {
    if (!nid.startsWith(NOTICE_PREFIX)) return
    const id = nid.slice(NOTICE_PREFIX.length)
    try {
      if (button === 0) await filer.undo(id)
      else await openFolderOf(id)
    } catch (e) {
      // 撤销没成（锁拿不到、书签刚被删之类）：另弹一条写原因，弹窗「最近收藏」里还能再点「撤销」。
      // 这条用另一个前缀，点它不会再走到这里
      if (button === 0) {
        await browser.notifications
          .create(`${ERROR_PREFIX}${id}`, { type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title: '撤销没成', message: e instanceof Error ? e.message : String(e), priority: 0 })
          .catch(() => '')
      }
      throw e
    } finally {
      // 撤销或打开失败（书签刚被删之类）也把通知收掉，不留一个点了没反应的通知
      await browser.notifications.clear(nid).catch(() => false)
      badgeSoon()
    }
  }
  // 撤销没成（书签刚被删、锁拿不到）时通知已经收掉；错误不再往外冒
  browser.notifications.onButtonClicked.addListener((nid, button) => void onNoticeButton(nid, button).catch(() => {}))
  browser.notifications.onClicked.addListener((nid) => void onNoticeButton(nid, 1).catch(() => {}))

  // ---------------------------------------------------------------- 地址栏：关键字 s

  const omniboxLine = (e: SearchEntry) => `${escapeXml(e.aiTitle || e.title || e.url)} <dim>${escapeXml(truncate(e.desc || e.folder, 60))}</dim>`
  async function omniboxEnter(text: string, disposition: string) {
    const url = isHttp(text) ? text : browser.runtime.getURL(`/manager.html?q=${encodeURIComponent(text.trim())}`)
    if (disposition === 'currentTab') await browser.tabs.update({ url })
    else await browser.tabs.create({ url, active: disposition !== 'newBackgroundTab' })
    await store.bumpStats({ omnibox: 1 })
  }
  browser.omnibox.setDefaultSuggestion({ description: '在书签里搜：%s' })
  browser.omnibox.onInputChanged.addListener((text, suggest) => {
    void getIndex().then((all) => suggest(searchBookmarks(all, text, 6).map((e) => ({ content: e.url, description: omniboxLine(e) }))))
  })
  browser.omnibox.onInputEntered.addListener((text, disposition) => void omniboxEnter(text, disposition))

  // ---------------------------------------------------------------- 弹窗发来的消息（只认自己扩展的页面）

  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (sender.id !== browser.runtime.id || !sender.url?.startsWith(browser.runtime.getURL('/'))) return
    const m = msg as { type?: string; batchId?: string; ids?: string[]; bookmarkId?: string; q?: string; nid?: string; button?: number; text?: string; disposition?: string }
    const reply = (p: Promise<unknown>) => {
      p.then(
        (value) => sendResponse({ ok: true, value }),
        (e) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) })
      )
      return true
    }
    // 耗时的整理不等它做完就回话：弹窗随时可能被关掉，进度看会话存储
    const background = (p: Promise<unknown>) => {
      void p.catch(() => {}).finally(badgeSoon)
      return reply(Promise.resolve(true))
    }
    switch (m.type) {
      case 'auto:status':
        return reply(filer.status())
      case 'auto:run':
        return background(filer.runButton())
      case 'auto:apply-batch':
        return background(filer.applyBatch(m.batchId ?? '', m.ids ?? []))
      case 'auto:cancel-batch':
        return reply(filer.cancelBatch(m.batchId ?? ''))
      case 'auto:undo': {
        // 在弹窗「最近收藏」里撤销成功：这条的通知和之前的「撤销没成」都收掉，不留过时的
        const id = m.bookmarkId ?? ''
        return reply(
          filer
            .undo(id)
            .then(async (ok) => {
              if (ok) await Promise.all([browser.notifications.clear(`${NOTICE_PREFIX}${id}`), browser.notifications.clear(`${ERROR_PREFIX}${id}`)]).catch(() => [])
              return ok
            })
            .finally(badgeSoon)
        )
      }
      case 'auto:undo-batch':
        return reply(filer.undoBatch(m.batchId ?? '').finally(badgeSoon))
    }
    // 端到端测试和离线校准用的入口，只在 e2e 构建里有
    if (import.meta.env.MODE === 'e2e') {
      switch (m.type) {
        case 'e2e:suggest':
          return reply(filer.suggest(m.bookmarkId ?? ''))
        case 'e2e:search':
          return reply(getIndex().then((all) => searchBookmarks(all, m.q ?? '', 6).map((e) => ({ content: e.url, description: omniboxLine(e) }))))
        case 'e2e:omnibox-enter':
          return reply(omniboxEnter(m.text ?? '', m.disposition ?? 'newForegroundTab'))
        case 'e2e:notice-button':
          return reply(onNoticeButton(m.nid ?? '', m.button ?? 0))
        case 'e2e:notices':
          return reply(browser.notifications.getAll())
        case 'e2e:notice-log':
          return reply(Promise.resolve(noticeLog))
        case 'e2e:badge':
          return reply(updateBadge().then(() => browser.action.getBadgeText({})))
      }
    }
  })

  // ---------------------------------------------------------------- 启动

  void filer.init()
  badgeSoon()
  void browser.bookmarks
    .getTree()
    .then((t) => store.pruneTexts(new Set(flattenTree(t as BookmarkNode[]).bookmarks.map((b) => b.id))))
    .catch(() => {})
})

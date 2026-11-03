// 在临时 Chrome 配置里装扩展、开页面、执行脚本、截图（e2e 用，零依赖）。
// Chrome 正式版 137 起去掉了 --load-extension，这里用官方办法：管道 CDP + Extensions.loadUnpacked。
//
// 用法：
//   import { launch } from './browser.mjs'
//   const browser = await launch({ extPath: '.output/chrome-mv3', bookmarksFile: 'tmp/Bookmarks' })
//   const page = await browser.open('manager.html')
//   await page.waitFor('document.querySelector("main")')
//   console.log(await page.evaluate('document.title'))
//   await page.screenshot('tmp/manager-dark.png', { dark: true })
//   await browser.close()

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createCdp } from './cdp.mjs'

const DEFAULT_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']
// 等两帧（后台页不出帧时最多等 300ms），让新尺寸、新配色画出来
const SETTLE = 'new Promise(r => { const t = setTimeout(r, 300); requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(t); r() })) })'

/** 打印前把网址换成占位，避免书签网址进终端 */
export const redact = (text) => String(text).replace(/\b(?:https?|ftp|file|wss?):\/\/[^\s'"<>()]+/gi, '<网址>')

// ---- 进程退出、出异常、Ctrl+C 时也关掉 Chrome、删临时目录 ----

const live = new Set() // 还开着的浏览器：{ child, userDataDir, keep }
const onExit = () => {
  for (const b of live) {
    try {
      b.child.kill()
    } catch {}
    if (!b.keep) removeDirSync(b.userDataDir)
  }
}
const onSignal = () => process.exit(130)

function track(b) {
  if (live.size === 0) {
    process.on('exit', onExit)
    for (const s of SIGNALS) process.on(s, onSignal)
  }
  live.add(b)
}

function untrack(b) {
  live.delete(b)
  if (live.size > 0) return
  process.off('exit', onExit)
  for (const s of SIGNALS) process.off(s, onSignal)
}

// ---- 临时目录 ----

function makeTempDir() {
  const base = path.join(os.tmpdir(), `bookmark-tidy-e2e-${Date.now()}`)
  for (let i = 1; ; i++) {
    const dir = i === 1 ? base : `${base}-${i}`
    try {
      fs.mkdirSync(dir)
      return dir
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
    }
  }
}

// Windows 上 Chrome 退出后文件可能还被子进程占着：每 500ms 重试，最多 10 次
async function removeDir(dir) {
  for (let i = 0; i < 10; i++) {
    if (i > 0) await sleep(500)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    if (!fs.existsSync(dir)) return true
  }
  return false
}

function removeDirSync(dir) {
  const pause = new Int32Array(new SharedArrayBuffer(4))
  for (let i = 0; i < 10; i++) {
    if (i > 0) Atomics.wait(pause, 0, 0, 500)
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {}
    if (!fs.existsSync(dir)) return true
  }
  return false
}

// ---- 页面 ----

function describeError(d) {
  if (!d) return '未知错误'
  const ex = d.exception
  if (ex?.description) return ex.description
  if (ex && 'value' in ex) return String(ex.value)
  return d.text || '未知错误'
}

const argText = (a) => (a.value === undefined ? a.description || a.type : typeof a.value === 'string' ? a.value : JSON.stringify(a.value))

async function createPage(cdp, targetId, sessionId, onClose) {
  const send = (method, params = {}, timeoutMs) => cdp.send(method, params, sessionId, timeoutMs)
  const lifecycle = [] // 本次导航收到的 Page.lifecycleEvent
  const errors = [] // 页面里没接住的异常和 console.error，测试可以断言它为空
  const offs = [
    cdp.on('Page.lifecycleEvent', (p, sid) => {
      if (sid === sessionId) lifecycle.push(p)
    }),
    cdp.on('Runtime.exceptionThrown', (p, sid) => {
      if (sid === sessionId) errors.push(describeError(p.exceptionDetails))
    }),
    cdp.on('Runtime.consoleAPICalled', (p, sid) => {
      if (sid === sessionId && (p.type === 'error' || p.type === 'assert')) errors.push(p.args.map(argText).join(' '))
    })
  ]
  let closed = false
  const dispose = () => {
    if (closed) return
    closed = true
    for (const off of offs) off()
    onClose()
  }

  const page = {
    targetId,
    sessionId,
    errors,
    /** 发给这个页面的 CDP 命令 */
    send,
    /** 只收这个页面的事件：handler(params) */
    on: (event, handler) => cdp.on(event, (p, sid) => sid === sessionId && handler(p)),

    /** 导航并等 load 事件（按 loaderId 对上这次导航，不会被上一页的事件骗到） */
    async goto(url, timeoutMs = 30000) {
      lifecycle.length = 0
      const nav = await send('Page.navigate', { url }, timeoutMs)
      if (nav.errorText) throw new Error(`打开页面失败：${nav.errorText}（${url}）`)
      if (!nav.loaderId) return // 同一文档内跳转，没有新的 load
      const deadline = Date.now() + timeoutMs
      while (!lifecycle.some((e) => e.name === 'load' && e.loaderId === nav.loaderId)) {
        if (Date.now() > deadline) throw new Error(`等页面 load 超时（${timeoutMs}ms）：${url}`)
        await sleep(50)
      }
    },

    /** 在页面里执行表达式（也可以传无参函数），等 Promise，按值返回；页面里抛错就抛出带页面错误信息的 Error */
    async evaluate(expression, timeoutMs = 60000) {
      const code = typeof expression === 'function' ? `(${expression})()` : String(expression)
      const r = await send('Runtime.evaluate', { expression: code, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs)
      if (r.exceptionDetails) throw new Error(`页面脚本出错：${describeError(r.exceptionDetails)}`)
      return r.result.value
    },

    /** 每 100ms 执行一次，直到结果为真值，返回这个值 */
    async waitFor(expression, timeoutMs = 10000) {
      const deadline = Date.now() + timeoutMs
      let lastError
      for (;;) {
        try {
          const value = await page.evaluate(expression, Math.max(1000, deadline - Date.now()))
          if (value) return value
          lastError = undefined
        } catch (e) {
          lastError = e
        }
        if (Date.now() >= deadline) {
          const what = String(expression).slice(0, 200)
          throw new Error(`waitFor 超时（${timeoutMs}ms）：${what}${lastError ? `\n最后一次出错：${lastError.message}` : ''}`)
        }
        await sleep(100)
      }
    },

    /**
     * 像用户一样用鼠标点元素中心（真的按下、松开）。页面里会把它当成用户手势，
     * 所以 chrome.permissions.request 这类必须由用户点击触发的接口也能用。expression 返回一个元素
     */
    async click(expression) {
      const rect = await page.evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
      if (!rect) throw new Error(`click 找不到元素：${String(expression).slice(0, 120)}`)
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        await send('Input.dispatchMouseEvent', { type, x: rect.x, y: rect.y, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 })
      }
      return rect
    },

    /** 鼠标移到元素中心（触发 :hover）。expression 返回一个元素，比如 'document.querySelector(".card")' */
    async hover(expression) {
      const rect = await page.evaluate(`(() => { const el = ${expression}; if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
      if (!rect) throw new Error(`hover 找不到元素：${String(expression).slice(0, 120)}`)
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y })
      return rect
    },

    /** 截图写成 PNG，返回绝对路径。视口尺寸和配色会留在页面上 */
    async screenshot(file, { width = 1440, height = 900, dark = false, fullPage = false } = {}) {
      const metrics = (h) => send('Emulation.setDeviceMetricsOverride', { width, height: h, deviceScaleFactor: 1, mobile: false })
      await send('Page.bringToFront')
      await metrics(height)
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
      await page.evaluate(SETTLE)
      let shotHeight = height
      if (fullPage) {
        const m = await send('Page.getLayoutMetrics')
        shotHeight = Math.max(height, Math.ceil((m.cssContentSize || m.contentSize).height))
        if (shotHeight !== height) {
          await metrics(shotHeight)
          await page.evaluate(SETTLE)
        }
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      if (shotHeight !== height) await metrics(height)
      const out = path.resolve(file)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, Buffer.from(data, 'base64'))
      return out
    },

    async close() {
      if (closed) return
      dispose()
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {})
    },
    dispose
  }

  await send('Page.enable')
  await send('Page.setLifecycleEventsEnabled', { enabled: true })
  await send('Runtime.enable')
  return page
}

// ---- 浏览器 ----

/**
 * 启动临时配置的 Chrome，装上扩展。
 * @param {object} o
 * @param {string} [o.extPath] 解压的扩展目录（含 manifest.json），比如 .output/chrome-mv3
 * @param {string} [o.bookmarksFile] 启动前复制成 <临时目录>/Default/Bookmarks
 * @param {string} [o.hostRules] --host-resolver-rules 的值，比如 'MAP *.test 127.0.0.1'
 * @param {boolean} [o.keep] 关闭后保留临时目录
 * @param {boolean} [o.headless]
 * @param {string[]} [o.args] 额外的 Chrome 启动参数
 */
export async function launch({ extPath, bookmarksFile, hostRules, keep = false, headless = true, args = [] } = {}) {
  const chrome = process.env.CHROME_PATH || DEFAULT_CHROME
  if (!fs.existsSync(chrome)) throw new Error(`找不到 Chrome：${chrome}（可用环境变量 CHROME_PATH 指定）`)
  const ext = extPath ? path.resolve(extPath) : ''
  if (ext && !fs.existsSync(path.join(ext, 'manifest.json'))) throw new Error(`扩展目录里没有 manifest.json：${ext}`)
  if (bookmarksFile && !fs.statSync(bookmarksFile, { throwIfNoEntry: false })?.isFile()) throw new Error(`找不到书签文件：${bookmarksFile}`)

  const userDataDir = makeTempDir()
  if (bookmarksFile) {
    fs.mkdirSync(path.join(userDataDir, 'Default'))
    fs.copyFileSync(bookmarksFile, path.join(userDataDir, 'Default', 'Bookmarks'))
  }

  const flags = [
    ...(headless ? ['--headless=new'] : []),
    '--remote-debugging-pipe',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,900',
    ...(hostRules ? [`--host-resolver-rules=${hostRules}`] : []),
    ...args,
    'about:blank'
  ]
  // fd 3：Chrome 读命令；fd 4：Chrome 写结果
  const child = spawn(chrome, flags, { stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'] })
  const record = { child, userDataDir, keep }
  track(record)

  const tail = [] // stdout / stderr 最后 50 行，出错时打印
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8')
    stream.on('data', (text) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) tail.push(line)
      if (tail.length > 50) tail.splice(0, tail.length - 50)
    })
  }
  let exitInfo = null
  const exited = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve((exitInfo = { code, signal })))
    child.once('error', (error) => resolve((exitInfo = { code: null, signal: null, error })))
  })

  const cdp = createCdp(child.stdio[3], child.stdio[4])
  const pages = new Set()
  let closing = null

  const browser = {
    extId: '',
    version: '',
    /** Chrome 主进程的 pid（有界面时用它找窗口） */
    pid: child.pid,
    userDataDir,
    /** 下载存放目录（launch 里设好） */
    downloadsDir: '',
    cdp,
    /** Chrome 输出的最后几行（网址已打码） */
    logs: (n = 10) => tail.slice(-n).map(redact),

    /** 开新标签页打开任意网址（不给网址就停在 about:blank） */
    async newPage(url) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      const page = await createPage(cdp, targetId, sessionId, () => pages.delete(page))
      pages.add(page)
      if (url) await page.goto(url)
      return page
    },

    /** 接管一个已经开着的标签页（比如点工具栏图标打开的），返回和 newPage 一样的页面对象 */
    async attach(targetId) {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      const page = await createPage(cdp, targetId, sessionId, () => pages.delete(page))
      pages.add(page)
      return page
    },

    /** 打开扩展里的页面，比如 open('manager.html') */
    open(pagePath) {
      if (!browser.extId) return Promise.reject(new Error('没有装扩展：launch 时要给 extPath'))
      return browser.newPage(`chrome-extension://${browser.extId}/${String(pagePath).replace(/^\/+/, '')}`)
    },

    /** 关 Chrome、删临时目录（keep 时保留）；可重复调用 */
    close() {
      closing ||= (async () => {
        for (const page of [...pages]) page.dispose()
        if (!exitInfo) {
          await cdp.send('Browser.close', {}, undefined, 5000).catch(() => {})
          if (!(await Promise.race([exited, sleep(5000)]))) {
            child.kill()
            await Promise.race([exited, sleep(3000)])
          }
        }
        cdp.close()
        child.stdout.destroy()
        child.stderr.destroy()
        untrack(record)
        if (!keep && !(await removeDir(userDataDir))) console.warn(`临时目录没删掉（文件可能还被占用）：${userDataDir}`)
      })()
      return closing
    }
  }

  const explain = (e) => {
    const lines = [e.message]
    if (exitInfo) lines.push(`Chrome 已退出：${exitInfo.error ? exitInfo.error.message : `退出码 ${exitInfo.code}`}`)
    const logs = browser.logs(10)
    if (logs.length) lines.push('Chrome 输出的最后几行：', ...logs.map((l) => `  ${l}`))
    return new Error(lines.join('\n'))
  }

  try {
    browser.version = (await cdp.send('Browser.getVersion')).product
    if (ext) browser.extId = (await cdp.send('Extensions.loadUnpacked', { path: ext })).id
    // 下载（比如应用前的备份）存进临时目录，不进真实的「下载」文件夹；测试可以检查这里的文件
    browser.downloadsDir = path.join(userDataDir, 'Downloads')
    fs.mkdirSync(browser.downloadsDir, { recursive: true })
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: browser.downloadsDir })
  } catch (e) {
    await Promise.race([exited, sleep(500)]) // Chrome 崩了的话，等它的退出码
    const err = explain(e)
    await browser.close()
    throw err
  }
  return browser
}

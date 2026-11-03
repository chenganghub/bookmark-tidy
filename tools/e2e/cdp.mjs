// 管道 CDP 客户端。Chrome 以 --remote-debugging-pipe 启动后从 fd 3 读命令、往 fd 4 写结果，
// 每条消息是 UTF-8 JSON 加 '\0' 结尾。按字节拼缓冲、按 \0 切开后再解码，多字节字符不会被切断。

const DEFAULT_TIMEOUT = 30000

/**
 * @param {import('node:stream').Writable} input  Chrome 读命令的管道（子进程 fd 3）
 * @param {import('node:stream').Readable} output Chrome 写结果的管道（子进程 fd 4）
 */
export function createCdp(input, output, { timeoutMs = DEFAULT_TIMEOUT } = {}) {
  let nextId = 1
  let closedReason = ''
  const pending = new Map() // id → { method, resolve, fail, timer }
  const listeners = new Map() // 事件名 → Set<handler>
  const waiters = new Set() // waitForEvent 的失败回调，管道关了要通知
  let parts = [] // 还没等到 \0 的字节片段

  output.on('data', (chunk) => {
    let start = 0
    let end
    while ((end = chunk.indexOf(0, start)) !== -1) {
      parts.push(chunk.subarray(start, end))
      const text = Buffer.concat(parts).toString('utf8')
      parts = []
      start = end + 1
      dispatch(text)
    }
    if (start < chunk.length) parts.push(chunk.subarray(start))
  })
  output.on('close', () => shutdown('CDP 管道已关闭（Chrome 可能已退出）'))
  output.on('error', (e) => shutdown(`CDP 管道出错：${e.message}`))
  input.on('error', (e) => shutdown(`CDP 管道出错：${e.message}`))

  function dispatch(text) {
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      return
    }
    if (msg.id !== undefined) {
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      clearTimeout(p.timer)
      if (msg.error) p.fail(`${p.method}：${msg.error.message}${msg.error.data ? `（${msg.error.data}）` : ''}`, msg.error.code)
      else p.resolve(msg.result || {})
      return
    }
    for (const handler of [...(listeners.get(msg.method) || [])]) {
      try {
        handler(msg.params || {}, msg.sessionId)
      } catch (e) {
        console.error(`CDP 事件 ${msg.method} 的处理函数出错：`, e)
      }
    }
  }

  function shutdown(reason) {
    if (closedReason) return
    closedReason = reason
    for (const p of pending.values()) {
      clearTimeout(p.timer)
      p.fail(`${p.method}：${reason}`)
    }
    pending.clear()
    for (const fail of [...waiters]) fail(reason)
  }

  /** 发命令；sessionId 为空时发给浏览器本身。按 id 对应回应，超时报错带方法名 */
  function send(method, params = {}, sessionId, timeout = timeoutMs) {
    const origin = new Error() // 留住调用处的栈，报错时好找
    return new Promise((resolve, reject) => {
      const fail = (message, code) => {
        const err = new Error(message)
        err.stack = `Error: ${message}\n${origin.stack.split('\n').slice(1).join('\n')}`
        if (code !== undefined) err.code = code
        reject(err)
      }
      if (closedReason) return fail(`${method}：${closedReason}`)
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        fail(`CDP ${method} 超时（${timeout}ms 没有回应）`)
      }, timeout)
      pending.set(id, { method, resolve, fail, timer })
      input.write(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }) + '\0')
    })
  }

  /** 订阅事件：handler(params, sessionId)；返回取消订阅的函数 */
  function on(event, handler) {
    if (!listeners.has(event)) listeners.set(event, new Set())
    listeners.get(event).add(handler)
    return () => listeners.get(event)?.delete(handler)
  }

  /** 等一个事件（可按 sessionId、filter 过滤），返回它的 params */
  function waitForEvent(event, { sessionId, filter, timeoutMs: timeout = timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        off()
        waiters.delete(fail)
      }
      const fail = (reason) => {
        done()
        reject(new Error(`等 CDP 事件 ${event}：${reason}`))
      }
      const timer = setTimeout(() => fail(`超时（${timeout}ms）`), timeout)
      const off = on(event, (params, sid) => {
        if (sessionId && sid !== sessionId) return
        if (filter && !filter(params, sid)) return
        done()
        resolve(params)
      })
      if (closedReason) return fail(closedReason)
      waiters.add(fail)
    })
  }

  function close() {
    shutdown('CDP 已关闭')
    input.destroy()
    output.destroy()
  }

  return {
    send,
    on,
    waitForEvent,
    close,
    get closed() {
      return Boolean(closedReason)
    }
  }
}

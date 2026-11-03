// OpenAI 兼容的聊天接口（默认 DeepSeek），只做「发消息、拿回 JSON」这一件事。
// key 绝不进错误信息和日志：所有报错文字都过一遍 redact。
import type { AiSettings, AiUsage, ChatJsonFn, ChatMessage } from './types'

export const EMPTY_USAGE: AiUsage = { requests: 0, promptTokens: 0, completionTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0 }

export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    requests: a.requests + b.requests,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    cacheHitTokens: a.cacheHitTokens + b.cacheHitTokens,
    cacheMissTokens: a.cacheMissTokens + b.cacheMissTokens
  }
}

export type AiErrorCode = 'auth' | 'rate-limit' | 'http' | 'network' | 'timeout' | 'bad-json' | 'aborted'

export class AiError extends Error {
  code: AiErrorCode
  status?: number
  constructor(code: AiErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'AiError'
    this.code = code
    this.status = status
  }
}

const RETRYABLE = new Set<AiErrorCode>(['rate-limit', 'http', 'network', 'timeout'])

/**
 * 模型回的 JSON 文本先整理一下再解析：去掉 ```json 包裹；去掉混进来的特殊词元。
 * 实测 deepseek-flash 偶尔回 {"ok":<|endoftext|>true}（2026-11-01，6 次里 1 次），不去掉就整批解析失败。
 */
export function cleanJsonText(s: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(s)
  return (m ? m[1] : s).replace(/<\|[A-Za-z0-9_]+\|>/g, '')
}

export function createChatJson(
  settings: AiSettings,
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number; maxRetries?: number; retryDelaysMs?: number[]; sleep?: (ms: number) => Promise<void> } = {}
): ChatJsonFn {
  const fetchImpl = opts.fetchImpl ?? fetch
  const timeoutMs = opts.timeoutMs ?? 120000
  const maxRetries = opts.maxRetries ?? 2
  const delays = opts.retryDelaysMs ?? [1000, 3000]
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const endpoint = `${settings.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const redact = (s: string) => (settings.apiKey ? s.split(settings.apiKey).join('***') : s)

  const once = async (messages: ChatMessage[], signal?: AbortSignal): Promise<{ data: unknown; usage: AiUsage; retryAfterMs?: number }> => {
    const ctrl = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      ctrl.abort()
    }, timeoutMs)
    const onAbort = () => ctrl.abort()
    signal?.addEventListener('abort', onAbort)
    try {
      let res: Response
      try {
        res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
          body: JSON.stringify({
            model: settings.model,
            messages,
            response_format: { type: 'json_object' },
            temperature: 0.2,
            stream: false,
            ...(settings.disableThinking ? { thinking: { type: 'disabled' } } : {})
          }),
          signal: ctrl.signal
        })
      } catch (e) {
        if (signal?.aborted) throw new AiError('aborted', '已取消')
        if (timedOut) throw new AiError('timeout', `接口 ${Math.round(timeoutMs / 1000)} 秒没有响应`)
        throw new AiError('network', redact(`连不上接口：${e instanceof Error ? e.message : String(e)}`))
      }
      if (res.status === 401 || res.status === 403) throw new AiError('auth', `接口拒绝访问（HTTP ${res.status}），检查 API key`, res.status)
      if (res.status === 429) {
        const sec = Number(res.headers.get('retry-after'))
        const err = new AiError('rate-limit', '请求太频繁（HTTP 429）', 429) as AiError & { retryAfterMs?: number }
        if (Number.isFinite(sec) && sec > 0) err.retryAfterMs = sec * 1000
        throw err
      }
      if (!res.ok) {
        const text = (await res.text().catch(() => '')).slice(0, 200)
        throw new AiError('http', redact(`接口返回 HTTP ${res.status}${text ? `：${text}` : ''}`), res.status)
      }
      let body: { choices?: { message?: { content?: unknown } }[]; usage?: Record<string, number> }
      try {
        body = await res.json()
      } catch {
        throw new AiError('bad-json', '接口返回的不是 JSON')
      }
      const content = body.choices?.[0]?.message?.content
      if (typeof content !== 'string') throw new AiError('bad-json', '接口返回里没有内容')
      let data: unknown
      try {
        data = JSON.parse(cleanJsonText(content))
      } catch {
        throw new AiError('bad-json', '模型返回的内容不是合法 JSON')
      }
      const u = body.usage || {}
      return {
        data,
        usage: {
          requests: 1,
          promptTokens: u.prompt_tokens || 0,
          completionTokens: u.completion_tokens || 0,
          cacheHitTokens: u.prompt_cache_hit_tokens || 0,
          cacheMissTokens: u.prompt_cache_miss_tokens || 0
        }
      }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return async (messages, callOpts = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const { data, usage } = await once(messages, callOpts.signal)
        return { data, usage }
      } catch (e) {
        const err = e instanceof AiError ? e : new AiError('network', redact(String(e)))
        if (!RETRYABLE.has(err.code) || attempt >= maxRetries || callOpts.signal?.aborted) throw err
        const retryAfter = (err as AiError & { retryAfterMs?: number }).retryAfterMs
        await sleep(retryAfter ?? delays[Math.min(attempt, delays.length - 1)] ?? 1000)
      }
    }
  }
}

/** DeepSeek 高峰：UTC 周一至周五 01:00–04:00、06:00–10:00（官方价格页，2026-10-31） */
export function isPeak(date: Date): boolean {
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = date.getUTCHours()
  return (h >= 1 && h < 4) || (h >= 6 && h < 10)
}

// 每百万 token 的高峰价（美元）；非高峰减半
const PRICES: Record<string, { miss: number; hit: number; out: number }> = {
  'deepseek-flash': { miss: 0.3, hit: 0.006, out: 1.2 },
  'deepseek-v4-pro': { miss: 1.32, hit: 0.044, out: 3.96 }
}

export function estimateCostUsd(usage: AiUsage, model: string, peak = true): number {
  const p = PRICES[model] ?? PRICES['deepseek-flash']
  const factor = peak ? 1 : 0.5
  const known = usage.cacheHitTokens + usage.cacheMissTokens > 0
  const miss = known ? usage.cacheMissTokens : usage.promptTokens
  const hit = known ? usage.cacheHitTokens : 0
  return ((miss * p.miss + hit * p.hit + usage.completionTokens * p.out) / 1e6) * factor
}

const ERROR_TEXT: Record<AiErrorCode, string> = {
  auth: 'API key 无效',
  'rate-limit': '请求太频繁',
  http: '接口出错',
  network: '连不上接口',
  timeout: '接口超时',
  'bad-json': '返回格式不对',
  aborted: '已取消'
}

/**
 * 测试连接：拿回一个 JSON 对象就算可用（地址、key、模型名、JSON 输出都没问题）。
 * 不要求模型原样回 {"ok": true}：实测 deepseek-flash 偶尔回别的字段，那不是连接问题，不该报「返回格式不对」。
 */
export async function testConnection(chat: ChatJsonFn): Promise<{ ok: boolean; message: string }> {
  const messages: ChatMessage[] = [
    { role: 'system', content: '这是连接测试。只输出 json：{"ok": true}' },
    { role: 'user', content: '测试' }
  ]
  // 模型偶尔回一次坏的 JSON（见 cleanJsonText）：只为这个再试一次，别的错误直接报
  for (let attempt = 0; ; attempt++) {
    try {
      const { data } = await chat(messages)
      return data !== null && typeof data === 'object' && !Array.isArray(data) ? { ok: true, message: '可用' } : { ok: false, message: '返回格式不对' }
    } catch (e) {
      if (e instanceof AiError && e.code === 'bad-json' && attempt === 0) continue
      return { ok: false, message: e instanceof AiError ? ERROR_TEXT[e.code] : '连不上接口' }
    }
  }
}

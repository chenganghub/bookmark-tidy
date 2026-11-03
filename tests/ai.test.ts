import { describe, expect, it, vi } from 'vitest'
import { addUsage, AiError, cleanJsonText, createChatJson, EMPTY_USAGE, estimateCostUsd, isPeak, testConnection } from '../src/core/ai'
import type { AiSettings } from '../src/core/types'

const KEY = 'sk-SECRET-KEY-should-never-leak-0123456789'
const settings: AiSettings = { baseUrl: 'https://api.deepseek.com/', apiKey: KEY, model: 'deepseek-flash', disableThinking: true }

const ok = (content: string, usage: Record<string, number> = {}) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200, headers: { 'content-type': 'application/json' } })

const noSleep = { sleep: async () => {}, retryDelaysMs: [0, 0] }

describe('createChatJson', () => {
  it('请求地址、请求头和请求体', async () => {
    const fetchImpl = vi.fn(async () => ok('{"a":1}', { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 6 }))
    const chat = createChatJson(settings, { fetchImpl: fetchImpl as unknown as typeof fetch })
    const r = await chat([{ role: 'user', content: '你好' }])
    expect(r.data).toEqual({ a: 1 })
    expect(r.usage).toEqual({ requests: 1, promptTokens: 10, completionTokens: 5, cacheHitTokens: 4, cacheMissTokens: 6 })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.deepseek.com/chat/completions')
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ model: 'deepseek-flash', response_format: { type: 'json_object' }, stream: false, thinking: { type: 'disabled' } })
    expect(body.messages).toEqual([{ role: 'user', content: '你好' }])
  })

  it('不关思考模式时不带 thinking 字段', async () => {
    const fetchImpl = vi.fn(async () => ok('{}'))
    await createChatJson({ ...settings, disableThinking: false }, { fetchImpl: fetchImpl as unknown as typeof fetch })([])
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.thinking).toBeUndefined()
  })

  it('去掉 ```json 包裹', async () => {
    const chat = createChatJson(settings, { fetchImpl: (async () => ok('```json\n{"x":[1,2]}\n```')) as unknown as typeof fetch })
    expect((await chat([])).data).toEqual({ x: [1, 2] })
  })

  it('去掉混进 JSON 里的特殊词元（实测回过 {"ok":<|endoftext|>true}）', async () => {
    const chat = createChatJson(settings, { fetchImpl: (async () => ok('{"ok":<|endoftext|>true}')) as unknown as typeof fetch })
    expect((await chat([])).data).toEqual({ ok: true })
    expect(cleanJsonText('{"a":"x<|im_end|>"}')).toBe('{"a":"x"}')
  })

  it('401 / 403 不重试，抛 auth', async () => {
    for (const status of [401, 403]) {
      const fetchImpl = vi.fn(async () => new Response('bad key', { status }))
      const chat = createChatJson(settings, { fetchImpl: fetchImpl as unknown as typeof fetch, ...noSleep })
      await expect(chat([])).rejects.toMatchObject({ code: 'auth', status })
      expect(fetchImpl).toHaveBeenCalledTimes(1)
    }
  })

  it('429 重试，并按 Retry-After 等待', async () => {
    const waits: number[] = []
    let n = 0
    const fetchImpl = vi.fn(async () => (n++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : ok('{"ok":true}')))
    const chat = createChatJson(settings, { fetchImpl: fetchImpl as unknown as typeof fetch, sleep: async (ms) => void waits.push(ms) })
    expect((await chat([])).data).toEqual({ ok: true })
    expect(waits).toEqual([7000])
  })

  it('5xx 重试，重试次数用完抛 http', async () => {
    const fetchImpl = vi.fn(async () => new Response('boom', { status: 503 }))
    const chat = createChatJson(settings, { fetchImpl: fetchImpl as unknown as typeof fetch, maxRetries: 2, ...noSleep })
    await expect(chat([])).rejects.toMatchObject({ code: 'http', status: 503 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('网络错误重试后成功', async () => {
    let n = 0
    const fetchImpl = vi.fn(async () => {
      if (n++ < 2) throw new TypeError('Failed to fetch')
      return ok('{"done":1}')
    })
    const chat = createChatJson(settings, { fetchImpl: fetchImpl as unknown as typeof fetch, ...noSleep })
    expect((await chat([])).data).toEqual({ done: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('超时抛 timeout', async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch
    const chat = createChatJson(settings, { fetchImpl: hang, timeoutMs: 10, maxRetries: 0 })
    await expect(chat([])).rejects.toMatchObject({ code: 'timeout' })
  })

  it('取消后抛 aborted，不再重试', async () => {
    const fetchImpl = vi.fn(((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as unknown as typeof fetch)
    const ctrl = new AbortController()
    const p = createChatJson(settings, { fetchImpl, ...noSleep })([], { signal: ctrl.signal })
    ctrl.abort()
    await expect(p).rejects.toMatchObject({ code: 'aborted' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('内容不是 JSON 抛 bad-json，不重试', async () => {
    const fetchImpl = vi.fn(async () => ok('这不是 json'))
    await expect(createChatJson(settings, { fetchImpl: fetchImpl as unknown as typeof fetch, ...noSleep })([])).rejects.toMatchObject({ code: 'bad-json' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('任何错误信息里都没有 key', async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => new Response(`invalid key ${KEY}`, { status: 500 }),
      async () => new Response(`key ${KEY}`, { status: 401 }),
      async () => {
        throw new TypeError(`connect failed for ${KEY}`)
      },
      async () => ok(`not json ${KEY}`)
    ]
    for (const impl of cases) {
      const err = await createChatJson(settings, { fetchImpl: impl as unknown as typeof fetch, maxRetries: 0 })([]).catch((e) => e)
      expect(err).toBeInstanceOf(AiError)
      expect(String(err.message)).not.toContain(KEY)
      expect(JSON.stringify(err)).not.toContain(KEY)
    }
  })
})

describe('用量和费用', () => {
  it('addUsage 逐项相加', () => {
    const u = { requests: 1, promptTokens: 10, completionTokens: 2, cacheHitTokens: 3, cacheMissTokens: 7 }
    expect(addUsage(addUsage(EMPTY_USAGE, u), u)).toEqual({ requests: 2, promptTokens: 20, completionTokens: 4, cacheHitTokens: 6, cacheMissTokens: 14 })
  })

  it('isPeak：UTC 工作日 01–04、06–10 点', () => {
    expect(isPeak(new Date('2026-10-30T09:59:00Z'))).toBe(true) // 周五
    expect(isPeak(new Date('2026-10-30T10:00:00Z'))).toBe(false)
    expect(isPeak(new Date('2026-10-30T05:30:00Z'))).toBe(false)
    expect(isPeak(new Date('2026-10-31T02:00:00Z'))).toBe(false) // 周六
    expect(isPeak(new Date('2026-11-02T00:59:00Z'))).toBe(false) // 周一
    expect(isPeak(new Date('2026-11-02T01:00:00Z'))).toBe(true)
  })

  it('estimateCostUsd：有缓存字段按命中 / 未命中算，没有按全部未命中算', () => {
    const noCache = { requests: 1, promptTokens: 1_000_000, completionTokens: 1_000_000, cacheHitTokens: 0, cacheMissTokens: 0 }
    expect(estimateCostUsd(noCache, 'deepseek-flash')).toBeCloseTo(1.5, 6)
    expect(estimateCostUsd(noCache, 'deepseek-flash', false)).toBeCloseTo(0.75, 6)
    const cached = { requests: 1, promptTokens: 1_000_000, completionTokens: 0, cacheHitTokens: 500_000, cacheMissTokens: 500_000 }
    expect(estimateCostUsd(cached, 'deepseek-flash')).toBeCloseTo(0.153, 6)
    expect(estimateCostUsd(noCache, 'deepseek-v4-pro')).toBeCloseTo(5.28, 6)
    expect(estimateCostUsd(noCache, '别的模型')).toBeCloseTo(1.5, 6)
  })
})

describe('testConnection', () => {
  it('拿回 JSON 对象就算可用；模型没照抄 {"ok": true} 也算（实测会这样）', async () => {
    expect(await testConnection(async () => ({ data: { ok: true }, usage: EMPTY_USAGE }))).toEqual({ ok: true, message: '可用' })
    expect(await testConnection(async () => ({ data: { status: 'ok' }, usage: EMPTY_USAGE }))).toEqual({ ok: true, message: '可用' })
  })
  it('坏 JSON 再试一次；两次都坏才报格式不对', async () => {
    let n = 0
    const once = await testConnection(async () => {
      if (n++ === 0) throw new AiError('bad-json', '模型返回的内容不是合法 JSON')
      return { data: { ok: true }, usage: EMPTY_USAGE }
    })
    expect(once).toEqual({ ok: true, message: '可用' })
    expect(n).toBe(2)
    let m = 0
    const twice = await testConnection(async () => {
      m++
      throw new AiError('bad-json', 'x')
    })
    expect(twice).toEqual({ ok: false, message: '返回格式不对' })
    expect(m).toBe(2)
  })

  it('出错给短句；不是对象算格式不对', async () => {
    const r = await testConnection(async () => {
      throw new AiError('auth', 'x')
    })
    expect(r).toEqual({ ok: false, message: 'API key 无效' })
    expect(await testConnection(async () => ({ data: 'ok', usage: EMPTY_USAGE }))).toEqual({ ok: false, message: '返回格式不对' })
    expect((await testConnection(async () => ({ data: [1], usage: EMPTY_USAGE }))).ok).toBe(false)
  })
})

// 三段 AI 调用的分批、并发、重试。每批成功立刻回调（调用方存起来），中途断了不白跑。
import { addUsage, EMPTY_USAGE } from './ai'
import { buildClassifyMessages, buildDescribeMessages, buildSplitMessages, buildTaxonomyMessages, parseClassify, parseDescribe, parseSplit, parseTaxonomy } from './prompts'
import type { AiUsage, ChatJsonFn, ClassifyOutput, DescribeInput, DescribeOutput, ItemType, StageProgress, TaxonomyNode } from './types'

/** 缺的超过这个比例就整批重试一次 */
const MISSING_RETRY_RATIO = 0.2

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** 按并发上限跑任务；signal 中止后不再启动新任务 */
async function pool(tasks: (() => Promise<void>)[], concurrency: number, signal?: AbortSignal): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < tasks.length && !signal?.aborted) await tasks[next++]()
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker))
}

interface BatchResult<T> {
  items: T[]
  missing: string[]
}

/** 一批：调一次，解析失败或缺得多就重试一次；两次都不理想时取缺得少的那次。中止后不再重试 */
async function runBatch<R extends BatchResult<unknown>>(
  ids: string[],
  call: () => Promise<{ data: unknown; usage: AiUsage }>,
  parse: (data: unknown) => R,
  addCost: (u: AiUsage) => void,
  signal?: AbortSignal
): Promise<R | undefined> {
  let best: R | undefined
  for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt++) {
    try {
      const { data, usage } = await call()
      addCost(usage)
      const r = parse(data)
      if (!best || r.missing.length < best.missing.length) best = r
      if (r.missing.length <= ids.length * MISSING_RETRY_RATIO) return r
    } catch {
      // 网络和 HTTP 的重试 ai.ts 已经做过；这里只管整批再来一次
    }
  }
  return best
}

export async function runDescribe(
  items: DescribeInput[],
  chat: ChatJsonFn,
  opts: {
    batchSize?: number
    concurrency?: number
    onProgress?: (p: StageProgress) => void
    onBatch?: (outs: DescribeOutput[]) => void | Promise<void>
    signal?: AbortSignal
  } = {}
): Promise<{ results: DescribeOutput[]; failedIds: string[]; usage: AiUsage }> {
  const batches = chunk(items, opts.batchSize ?? 40)
  let usage = EMPTY_USAGE
  const results: DescribeOutput[] = []
  const failedIds: string[] = []
  const progress: StageProgress = { stage: 'describe', totalBatches: batches.length, doneBatches: 0, failedBatches: 0, usage }
  opts.onProgress?.({ ...progress })

  await pool(
    batches.map((batch) => async () => {
      const ids = batch.map((b) => b.id)
      const r = await runBatch(
        ids,
        () => chat(buildDescribeMessages(batch), { signal: opts.signal }),
        (data) => parseDescribe(data, ids),
        (u) => (usage = addUsage(usage, u)),
        opts.signal
      )
      if (r && r.items.length) {
        results.push(...r.items)
        failedIds.push(...r.missing)
        await opts.onBatch?.(r.items)
      } else {
        failedIds.push(...ids)
        progress.failedBatches++
      }
      progress.doneBatches++
      progress.usage = usage
      opts.onProgress?.({ ...progress })
    }),
    opts.concurrency ?? 2,
    opts.signal
  )
  return { results, failedIds, usage }
}

export async function runTaxonomy(
  items: { type: ItemType; tags: string[]; desc: string; path: string }[],
  chat: ChatJsonFn,
  opts: { maxTop: number; existingFolders: string[]; lockedFolders: string[]; emoji: boolean; onProgress?: (p: StageProgress) => void; signal?: AbortSignal }
): Promise<{ folders: TaxonomyNode[]; issues: string[]; usage: AiUsage }> {
  let usage = EMPTY_USAGE
  const progress: StageProgress = { stage: 'taxonomy', totalBatches: 1, doneBatches: 0, failedBatches: 0, usage }
  opts.onProgress?.({ ...progress })
  const messages = buildTaxonomyMessages(items, opts)
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await chat(messages, { signal: opts.signal })
      usage = addUsage(usage, r.usage)
      const parsed = parseTaxonomy(r.data, opts)
      if (parsed.folders.length) {
        opts.onProgress?.({ ...progress, doneBatches: 1, usage })
        return { ...parsed, usage }
      }
      lastError = new Error('模型没有给出目录')
    } catch (e) {
      lastError = e
      if (opts.signal?.aborted) break
    }
  }
  opts.onProgress?.({ ...progress, doneBatches: 1, failedBatches: 1, usage })
  throw lastError instanceof Error ? lastError : new Error('目录设计失败')
}

export async function runClassify(
  items: { id: string; title: string; desc: string; tags: string[]; type: ItemType }[],
  paths: string[],
  chat: ChatJsonFn,
  opts: { batchSize?: number; concurrency?: number; onProgress?: (p: StageProgress) => void; signal?: AbortSignal; descs?: Record<string, string> } = {}
): Promise<{ results: ClassifyOutput[]; failedIds: string[]; usage: AiUsage }> {
  const batches = chunk(items, opts.batchSize ?? 80)
  let usage = EMPTY_USAGE
  const results: ClassifyOutput[] = []
  const failedIds: string[] = []
  const progress: StageProgress = { stage: 'classify', totalBatches: batches.length, doneBatches: 0, failedBatches: 0, usage }
  opts.onProgress?.({ ...progress })

  await pool(
    batches.map((batch) => async () => {
      const ids = batch.map((b) => b.id)
      const r = await runBatch(
        ids,
        () => chat(buildClassifyMessages(paths, batch, opts.descs), { signal: opts.signal }),
        (data) => parseClassify(data, ids, paths),
        (u) => (usage = addUsage(usage, u)),
        opts.signal
      )
      if (r && r.items.length) {
        results.push(...r.items)
        failedIds.push(...r.missing)
      } else {
        failedIds.push(...ids)
        progress.failedBatches++
      }
      progress.doneBatches++
      progress.usage = usage
      opts.onProgress?.({ ...progress })
    }),
    opts.concurrency ?? 2,
    opts.signal
  )
  return { results, failedIds, usage }
}

/**
 * 第四段：把一个太大的目录拆成 2～maxParts 个更细的。一次调用；给出的目录不到 2 个、或缺的超过两成就重试一次。
 * 失败不抛错：返回空的 folders，调用方保留原目录（预览里会提示条数超了）。
 */
export async function runSplit(
  path: string,
  items: { id: string; title: string; desc: string; tags: string[] }[],
  chat: ChatJsonFn,
  opts: { taken: string[]; lockedFolders: string[]; maxParts?: number; signal?: AbortSignal }
): Promise<{ folders: TaxonomyNode[]; assign: Record<string, string>; usage: AiUsage; issues: string[] }> {
  const ids = items.map((i) => i.id)
  const maxParts = opts.maxParts ?? 4
  let usage = EMPTY_USAGE
  const r = await runBatch(
    ids,
    () => chat(buildSplitMessages(path, items, { maxParts, taken: opts.taken }), { signal: opts.signal }),
    (data) => {
      const p = parseSplit(data, ids, { maxParts, taken: opts.taken, lockedFolders: opts.lockedFolders })
      // 不到 2 个目录等于没拆：当成整批都缺，触发重试
      return p.folders.length >= 2 ? p : { ...p, items: [], missing: ids }
    },
    (u) => (usage = addUsage(usage, u)),
    opts.signal
  )
  if (!r || r.folders.length < 2 || !r.items.length) return { folders: [], assign: {}, usage, issues: [] }
  return { folders: r.folders, assign: Object.fromEntries(r.items.map((i) => [i.id, i.folder])), usage, issues: r.issues }
}

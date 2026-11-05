// 全项目共用的数据类型和模块边界（契约）。
// 规则：src/core 下的模块是纯 TS，不碰 browser / chrome 全局；浏览器 API 通过参数传进来（BookmarksApi、KV、fetch）。
// 只用可擦除的 TS 语法（不用 enum、namespace、参数属性），这样 Node 24 能直接 import（tools/ 用得到）。

// ---------------------------------------------------------------- 书签

export type RootType = 'bookmarks-bar' | 'other' | 'mobile' | 'managed'

/** chrome.bookmarks.BookmarkTreeNode 的子集 */
export interface BookmarkNode {
  id: string
  parentId?: string
  index?: number
  title: string
  url?: string
  dateAdded?: number
  dateLastUsed?: number
  dateGroupModified?: number
  /** Chrome 134+：书签栏 / 其他书签 / 移动设备 / 管理员配置。同一类可能有多个（账号版和本机版） */
  folderType?: RootType
  /** Chrome 134+：是否同步到账号 */
  syncing?: boolean
  unmodifiable?: 'managed'
  children?: BookmarkNode[]
}

/** 用到的 chrome.bookmarks 子集。真实环境传 browser.bookmarks，测试传 tests/helpers/fake-bookmarks.ts */
export interface BookmarksApi {
  getTree(): Promise<BookmarkNode[]>
  get(idOrIdList: string | string[]): Promise<BookmarkNode[]>
  getChildren(id: string): Promise<BookmarkNode[]>
  create(bookmark: { parentId?: string; index?: number; title?: string; url?: string }): Promise<BookmarkNode>
  move(id: string, destination: { parentId?: string; index?: number }): Promise<BookmarkNode>
  update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkNode>
  remove(id: string): Promise<void>
}

/** 拍平后的一条书签 */
export interface FlatBookmark {
  id: string
  parentId: string
  index: number
  title: string
  url: string
  /** 根文件夹之下的文件夹名，如 ['css框架', 'css']；直接放在根文件夹下为 [] */
  path: string[]
  /** 和 path 对应的文件夹 id */
  folderIds: string[]
  rootId: string
  rootType: RootType
  /** 直接在根文件夹（书签栏等）下 = 1 */
  depth: number
  /** 毫秒；没有为 0 */
  dateAdded: number
  /** 毫秒；没有打开记录为 0（Chrome 114 起才记录） */
  dateLastUsed: number
}

/** 拍平后的一个文件夹（不含根文件夹本身） */
export interface FlatFolder {
  id: string
  parentId: string
  index: number
  title: string
  /** 含自己，如 ['css框架', 'css'] */
  path: string[]
  rootId: string
  rootType: RootType
  /** 根文件夹的直接子文件夹 = 1 */
  depth: number
  /** 父文件夹名；父是根文件夹时为 '' */
  parentTitle: string
  directBookmarks: number
  subFolders: number
  /** 含所有子孙 */
  totalBookmarks: number
  unmodifiable: boolean
}

/** 根文件夹（书签栏、其他书签、移动设备书签……） */
export interface RootInfo {
  id: string
  title: string
  rootType: RootType
  syncing: boolean
  bookmarks: number
  topFolders: number
  looseBookmarks: number
}

export interface FlatTree {
  roots: RootInfo[]
  bookmarks: FlatBookmark[]
  folders: FlatFolder[]
}

// ---------------------------------------------------------------- 体检（rules.ts）

/** 体检的输入：FlatTree 满足它；tools/audit-bookmarks.mjs 从书签文件拼出同样的结构 */
export interface AuditInput {
  roots: { rootType: string; bookmarks: number; topFolders: number; looseBookmarks: number }[]
  bookmarks: { id: string; title: string; url: string; depth: number; rootType: string; dateAdded: number; dateLastUsed: number }[]
  folders: { id: string; title: string; parentTitle: string; depth: number; rootType: string; directBookmarks: number; subFolders: number }[]
}

/** 体检汇总。字段和 `node tools/audit-bookmarks.mjs --json` 一致，用来对账（accept B1） */
export interface AuditSummary {
  bookmarks: number
  folders: number
  /** 按 rootType 汇总（同类的多个根合并） */
  roots: Record<string, { bookmarks: number; topFolders: number; looseBookmarks: number }>
  maxFolderDepth: number
  folderIssues: {
    empty: number
    singleBookmark: number
    bigFlat50: number
    nestedSameName: number
    defaultName: number
    duplicateNameGroups: number
  }
  duplicates: { exact: { groups: number; extra: number }; normalized: { groups: number; extra: number } }
  urls: {
    protocols: Record<string, number>
    intranet: number
    domains: number
    singleUseDomains: number
    topDomains: { domain: string; count: number }[]
  }
  titles: {
    empty: number
    isUrl: number
    messagePrefix: number
    countPrefix: number
    siteSuffix: number
    cleanable: number
    long: number
    vague: number
  }
  usage: { hasLastUsed: number; usedIn30d: number; usedIn180d: number; cold: number }
  addedByYear: Record<string, number>
}

/** 每项体检对应的条目 id，给界面列清单用 */
export interface AuditIssues {
  emptyFolders: string[]
  singleBookmarkFolders: string[]
  bigFlatFolders: string[]
  nestedSameNameFolders: string[]
  defaultNameFolders: string[]
  /** 每组是同名文件夹的 id */
  duplicateNameFolderGroups: string[][]
  /** 每组是规范化后网址相同的书签 id */
  duplicateGroups: string[][]
  messagePrefix: string[]
  countPrefix: string[]
  siteSuffix: string[]
  cleanable: string[]
  longTitle: string[]
  vagueTitle: string[]
  emptyTitle: string[]
  urlAsTitle: string[]
  notHttp: string[]
  intranet: string[]
  cold: string[]
}

// ---------------------------------------------------------------- 抓网页（fetcher.ts）

export type FetchStatus =
  | 'ok' // 正常
  | 'redirect' // 跳到了别的地址（域名或路径变了），内容照常取
  | 'login' // 401，或跳到登录页，或标题像登录页
  | 'blocked' // 403 / 429 / 其他 4xx：被拦（常见于不带 cookie 的反爬），不算失效，也不当成要登录
  | 'dead' // 404 / 410：失效
  | 'server-error' // 5xx：先不算失效
  | 'unreachable' // DNS 失败、连不上、证书错误（fetch 抛 TypeError）
  | 'timeout'

export type SkipReason =
  | 'not-http' // 非 http(s)
  | 'intranet' // 内网 / 本机
  | 'action-word' // 路径或参数里有 logout、unsubscribe 这类操作词
  | 'credential-param' // 参数名像凭证（token、ticket、sign……）
  | 'random-token' // 路径或参数值里有长随机串
  | 'locked' // 在锁定文件夹里
  | 'excluded-folder' // 用户排除的文件夹
  | 'excluded-domain' // 用户排除的域名

export interface PageInfo {
  /** 书签里的原始网址（缓存键） */
  url: string
  status: FetchStatus
  httpStatus?: number
  finalUrl?: string
  title?: string
  description?: string
  siteName?: string
  lang?: string
  fetchedAt: number
  error?: string
}

export interface FetchPlan {
  /** 同一网址的几条书签合并成一项 */
  toFetch: { url: string; bookmarkIds: string[] }[]
  /** 7 天内抓过的 */
  cached: { url: string; bookmarkIds: string[] }[]
  skipped: { url: string; bookmarkIds: string[]; reason: SkipReason }[]
}

export interface FetchProgress {
  total: number
  done: number
  failed: number
  running: number
  paused: boolean
}

// ---------------------------------------------------------------- AI（ai.ts / prompts.ts / pipeline.ts）

export interface AiSettings {
  /** OpenAI 兼容接口地址，不带 /chat/completions，如 https://api.deepseek.com */
  baseUrl: string
  apiKey: string
  model: string
  /** 关思考模式：请求体带 {"thinking":{"type":"disabled"}}（DeepSeek 文档） */
  disableThinking: boolean
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AiUsage {
  requests: number
  promptTokens: number
  completionTokens: number
  /** DeepSeek 返回的缓存命中 / 未命中 token；没有就是 0 */
  cacheHitTokens: number
  cacheMissTokens: number
}

/** 注入式的聊天函数：pipeline 只依赖它，测试时传假的 */
export type ChatJsonFn = (messages: ChatMessage[], opts?: { signal?: AbortSignal }) => Promise<{ data: unknown; usage: AiUsage }>

export type ItemType = '文章' | '文档' | '工具' | '代码仓库' | '视频' | '课程' | '社区' | '后台' | '其他'

/** 第一段「说明」的输入（已脱敏） */
export interface DescribeInput {
  id: string
  title: string
  /** 只含域名 + 路径，已脱敏 */
  url: string
  /** 网页简介，已脱敏，≤ 200 字 */
  desc: string
  /** 当前文件夹路径，如 'css框架/css' */
  path: string
}

export interface DescribeOutput {
  id: string
  /** 一句话说明，≤ 40 字 */
  desc: string
  /** 建议的干净标题，≤ 30 字 */
  title: string
  /** 1～3 个 */
  tags: string[]
  type: ItemType
}

/** 第二段「目录设计」的结果 */
export interface TaxonomyNode {
  name: string
  /** 一句话定义：放什么 */
  desc: string
  emoji?: string
  children?: TaxonomyNode[]
}

/** 第三段「归类」的结果；path 是目录树上的路径，如 '前端基础/JS 技巧' */
export interface ClassifyOutput {
  id: string
  path: string
  confidence: number
}

export interface StageProgress {
  /** split：归类后某个末级目录超过 40 条，再拆细 */
  stage: 'describe' | 'taxonomy' | 'classify' | 'split'
  totalBatches: number
  doneBatches: number
  failedBatches: number
  usage: AiUsage
}

// ---------------------------------------------------------------- 本地保存的书签说明（store.ts）

export interface BookmarkMeta {
  desc: string
  title: string
  tags: string[]
  type: ItemType
  /** 用户手改过：之后跑 AI 不覆盖（accept F5） */
  manual?: boolean
  updatedAt: number
}

// ---------------------------------------------------------------- 整理方案（plan.ts）

export type SpecialTarget = 'inbox' | 'cleanup' // 「待整理」/「待清理」

export interface PlanFolder {
  /** 方案内唯一键（不是 Chrome id） */
  key: string
  name: string
  desc: string
  emoji?: string
  children: PlanFolder[]
}

export type PlanItemReason =
  | 'ai' // AI 归类
  | 'low-confidence' // 置信度 < 0.6
  | 'not-in-tree' // AI 给的目标不在目录树上
  | 'ai-failed' // 这条的 AI 批次失败
  | 'dead' // 抓取结果是失效
  | 'duplicate' // 规范化后重复，保留一条，其余去「待清理」
  | 'manual' // 用户在预览里改过

export interface PlanItem {
  bookmarkId: string
  /** 生成方案时这条的状态，应用前预检用 */
  base: { parentId: string; title: string; url: string }
  /** PlanFolder.key，或 'inbox' / 'cleanup' */
  target: string
  confidence: number
  reason: PlanItemReason
  /** cleanTitle 的结果（和原标题不同才有） */
  ruleTitle?: string
  /** AI 建议的标题（和原标题不同才有） */
  aiTitle?: string
  useRuleTitle: boolean
  useAiTitle: boolean
  /** 取消勾选 = 这条不动 */
  enabled: boolean
  /** 置信度不够进待整理时，AI 给的目录（方案目录 key）：应用后待处理里预选它 */
  guess?: string
}

export interface PlanOptions {
  /** 书签栏顶层最多几个文件夹，默认 8 */
  maxTop: number
  /** 文件夹名前加 emoji，默认 false */
  emoji: boolean
  /** 规则清理标题并写回，默认 true */
  ruleTitles: boolean
  /** 锁定的文件夹 id：不发给 AI、不移动、不改标题（含子孙） */
  lockedFolderIds: string[]
  /** 书签栏上直接散放的书签不动，默认 true */
  keepLooseBarItems: boolean
}

export interface Plan {
  id: string
  createdAt: number
  /** 新目录建在哪个书签栏（有多个时取本机的那个） */
  barRootId: string
  /** 「待整理」「待清理」「整理前的空文件夹」放在哪个「其他书签」 */
  otherRootId: string
  options: PlanOptions
  folders: PlanFolder[]
  items: PlanItem[]
  /** 方案涉及的旧文件夹：整理后如果空了，移进「其他书签/整理前的空文件夹」 */
  oldFolderIds: string[]
  /** 生成方案时整棵树的指纹（snapshot.ts 的 treeFingerprint） */
  treeFingerprint: string
}

// ---------------------------------------------------------------- 快照、应用、撤销（snapshot.ts / apply.ts）

export interface SnapshotNode {
  id: string
  parentId?: string
  index?: number
  title: string
  url?: string
}

export interface Snapshot {
  id: string
  createdAt: number
  nodes: SnapshotNode[]
}

export type ApplyStatus = 'running' | 'done' | 'failed' | 'undoing' | 'undone'

export interface ApplyReport {
  moved: number
  renamed: number
  createdFolders: number
  movedOldFolders: number
  /** 预检或执行时发现已经变了、没处理的 */
  skipped: { bookmarkId: string; reason: 'missing' | 'moved' | 'retitled' | 'url-changed' | 'locked' | 'changed-during-apply' }[]
  /** 应用后读回整棵树，和方案对不上的 */
  mismatches: { bookmarkId: string; expectedParentId: string; actualParentId?: string }[]
}

export interface UndoReport {
  restored: number
  /** 应用后被删掉、按快照重建的：快照 id → 新 id */
  rebuilt: { snapshotId: string; newId: string; title: string }[]
  /** 应用后新建、留在原处的书签 id */
  keptExtras: string[]
  /** 方案新建、因为里面有新书签而保留的目录 id */
  keptFolders: string[]
  removedFolders: number
}

export interface ApplyLog {
  applyId: string
  planId: string
  snapshotId: string
  status: ApplyStatus
  startedAt: number
  updatedAt: number
  total: number
  done: number
  /** 方案新建的目录：PlanFolder.key / 特殊目录名 → Chrome id */
  createdFolders: Record<string, string>
  error?: { step: number; message: string }
  report?: ApplyReport
  /** 撤销时重建的节点：快照 id → 新 id（撤销中断后重跑用） */
  undoIdMap: Record<string, string>
  undoReport?: UndoReport
  /** bookmark-ux：这次应用完成时，因为方案里没勾才新记进「你定过位置的」的 id；撤销这次应用时拿掉 */
  placedIds?: string[]
}

/** apply.ts 需要的存储；store.ts 用 chrome.storage.local 实现，测试用内存实现 */
export interface ApplyStore {
  saveSnapshot(snapshot: Snapshot): Promise<void>
  getSnapshot(id: string): Promise<Snapshot | undefined>
  saveLog(log: ApplyLog): Promise<void>
  getLog(applyId: string): Promise<ApplyLog | undefined>
  /** 最近一次应用的日志（任何状态） */
  getLatestLog(): Promise<ApplyLog | undefined>
}

// ---------------------------------------------------------------- 存储（store.ts）

/** chrome.storage.local 的子集；测试用内存实现 */
export interface KV {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
  remove(keys: string | string[]): Promise<void>
}

export interface Settings {
  ai: AiSettings
  maxTop: number
  emoji: boolean
  ruleTitles: boolean
  keepLooseBarItems: boolean
  lockedFolderIds: string[]
  /** 第一次打开时，按这些名字预选锁定的顶层文件夹（默认 ['受保护资料']，见 decisions.md） */
  defaultLockedNames: string[]
  excludeFolderIds: string[]
  excludeDomains: string[]
  theme: 'auto' | 'light' | 'dark'
  view: 'cards' | 'list'
  /** 二期：收藏时自动整理（一期的整理应用过之后才开始） */
  autoFile: boolean
  /** 自动整理后弹系统通知 */
  autoNotify: boolean
  /** 自动放进目录的把握下限，低于它进「待整理」（默认值来自离线校准，见 tools/e2e/calibrate.mjs） */
  autoThreshold: number
  /** 收藏时可以把正文片段发给 AI 的公开站点（域名，含子域名） */
  textDomains: string[]
  /** 不读正文、请求里只给标题和域名的站点（另加内网和锁定文件夹里出现过的站点） */
  privateDomains: string[]
  /** 工具栏图标上显示还没放好的新收藏数 */
  badge: boolean
}

// ---------------------------------------------------------------- 二期：收藏即整理（auto.ts / autofile.ts）

/** 收藏后等着处理的一条（chrome.storage.session） */
export interface AutoJob {
  bookmarkId: string
  url: string
  /** 收藏那一刻的父文件夹、位置、标题：处理时比对，判断用户在收藏气泡里改过没有 */
  parentId: string
  index: number
  title: string
  /** 收到 onCreated 的时间 */
  createdAt: number
  dueAt: number
}

export type AutoStatus = 'filed' | 'inbox' | 'undone' | 'moved-by-user'

// ---------------------------------------------------------------- bookmark-ux：待处理（triage.ts）和手动操作（manual.ts）

/** 「放到」的一个选项：书签栏下前两层的文件夹，path 写成「父 / 子」 */
export interface FolderChoice {
  id: string
  path: string
}

export type CleanupReason =
  | { kind: 'dead'; httpStatus?: number } // 抓取结果是失效（404、410）
  | { kind: 'duplicate'; otherPath: string } // 待清理以外还有同一网址的一条
  | { kind: 'unreachable' } // 连不上
  | { kind: 'other' } // 原因已经不在了（另一条没了、只在待清理里互为重复、链接又能打开）

export interface TriageEntry {
  bookmark: FlatBookmark
  /** 拿不准放哪的：AI 当时猜的目录（还在、能放的才有） */
  guess?: FolderChoice
  /** 建议删除的：为什么建议删 */
  reason?: CleanupReason
}

/** 一组空文件夹：最上层那个和它的全部子孙（都没有书签），ids 深的在前（删除顺序） */
export interface EmptyGroup {
  folder: FlatFolder
  ids: string[]
}

export interface Triage {
  /** 拿不准放哪：「待整理」和「整理前的空文件夹」里的书签 */
  unsure: TriageEntry[]
  /** 建议删除：「待清理」里的书签 */
  cleanup: TriageEntry[]
  empty: EmptyGroup[]
}

/** 删掉的一个节点：没有 url 的是文件夹。index 是删那一步之前那一刻的位置 */
export interface RemovedNode {
  id: string
  parentId: string
  index: number
  title: string
  url?: string
}

/** 待处理和卡片上的一次手动操作，结果条的「撤销」用（只在管理页内存里留最近一次） */
export interface ManualChange {
  /** 按执行顺序；from.index 是移那一步之前那一刻的位置。撤销倒着来 */
  moved: { id: string; from: { parentId: string; index: number }; to: string }[]
  /** 按执行顺序（删空文件夹时深的在前）。撤销倒着来 */
  removed: RemovedNode[]
  /** 删掉的书签所在文件夹的祖先链（不含根）：撤销时文件夹也没了就按它重建 */
  folders: Record<string, RemovedNode>
  /** 移动：这次新记进「你定过位置的」的 id，撤销时移出去。删除：删之前就在里面的 id，撤销重建时新 id 记回去 */
  placed: string[]
  /** 移动前的自动整理记录：撤销时写回去 */
  records: Record<string, AutoRecord>
  /** 操作时已经不在的、出错的、删空文件夹时里面又有了东西的 */
  skipped: number
  /** 撤销时重建出来的：旧 id → 新 id。撤销中途出错，再点一次从这里接着做 */
  rebuilt: Record<string, string>
}

/** 移到现有文件夹，或新建一个（同一个父文件夹下已有同名、没锁定的就直接用它） */
export type MoveTarget = { folderId: string } | { newFolder: { parentId: string; title: string } }

/** 自动整理动过的一条（chrome.storage.local），撤销和统计用 */
export interface AutoRecord {
  bookmarkId: string
  at: number
  /** save：收藏时；button：弹窗里的「整理」 */
  source: 'save' | 'button'
  batchId?: string
  from: { parentId: string; index: number; title: string }
  to: { parentId: string; title: string }
  /** 放到的目录路径（显示用）；进待整理时是「待整理」 */
  path: string
  confidence: number
  status: AutoStatus
  /** 进待整理时 AI 给的目录的文件夹 id（在候选里的才记）：待处理里预选它 */
  guessFolderId?: string
}

export interface AutoStats {
  filed: number
  toInbox: number
  undone: number
  movedAgain: number
  omnibox: number
  buttonRuns: number
}

/** 收藏时读到的正文，只存在本机 */
export interface SavedText {
  url: string
  text: string
  savedAt: number
}

/** 合并请求（说明 + 归类）的输入，已脱敏 */
export interface FileInput {
  id: string
  title: string
  /** 域名 + 路径；私有站点只有域名 */
  url: string
  /** 网页简介，≤ 200 字 */
  desc: string
  /** 正文片段：只有白名单公开站点、并且核对过是不带 Cookie 也能看到的版本时才有 */
  excerpt?: string
}

export interface FileOutput extends DescribeOutput {
  /** 候选目录里的路径；放不进时为 '' */
  path: string
  confidence: number
}

// ---------------------------------------------------------------- 界面用的流程接口（workflow.ts 实现；界面的演示模式用假实现）

export interface FetchRun {
  progress(): FetchProgress
  pause(): void
  resume(): void
  stop(): void
  done: Promise<FetchProgress>
}

export interface Workflow {
  /** 读整棵树并拍平 */
  loadTree(): Promise<{ nodes: BookmarkNode[]; flat: FlatTree }>
  audit(): Promise<{ summary: AuditSummary; issues: AuditIssues }>
  /** 书签变化时回调（chrome.bookmarks 的增删改移事件），返回取消监听的函数 */
  onTreeChanged(callback: () => void): () => void

  getSettings(): Promise<Settings>
  saveSettings(patch: Partial<Settings>): Promise<Settings>
  /** 在点击事件里调用：申请抓网页要的网址权限；已有返回 true */
  ensureSitePermission(): Promise<boolean>
  /** 发一个最小请求测接口和 key */
  testAi(): Promise<{ ok: boolean; message: string }>

  getMeta(): Promise<Record<string, BookmarkMeta>>
  saveManualMeta(bookmarkId: string, patch: Partial<Pick<BookmarkMeta, 'desc' | 'tags' | 'title'>>): Promise<void>
  getPageInfos(): Promise<Record<string, PageInfo>>

  planFetch(): Promise<FetchPlan>
  startFetch(plan: FetchPlan, onProgress: (p: FetchProgress) => void): FetchRun

  /** 第一段：给还没有说明（且不是手改过）的书签写说明 */
  describe(onProgress: (p: StageProgress) => void, signal?: AbortSignal): Promise<{ usage: AiUsage; failedIds: string[] }>
  /** 先给还没有说明的写说明（和 describe 同一个范围，plan.ts 的 describeScope；describeFailed 是没写成的条数），再第二、三段 + 生成方案 */
  buildPlan(options: PlanOptions, onProgress: (p: StageProgress) => void, signal?: AbortSignal): Promise<{ plan: Plan; usage: AiUsage; issues: string[]; describeFailed: number }>
  getPlan(): Promise<Plan | undefined>
  savePlan(plan: Plan): Promise<void>

  /** onSnapshot 在快照存好、动第一条书签之前调用：界面在这里触发下载备份文件（accept E3） */
  apply(plan: Plan, onProgress: (done: number, total: number) => void, onSnapshot?: (snapshotId: string) => void): Promise<ApplyLog>
  /** 继续一次中断的应用（会重新预检） */
  continueApply(applyId: string, onProgress: (done: number, total: number) => void): Promise<ApplyLog>
  undo(applyId: string, onProgress: (done: number, total: number) => void): Promise<ApplyLog>
  getLatestApply(): Promise<ApplyLog | undefined>
  /** 快照导出成 JSON 文本（下载备份用） */
  exportSnapshot(snapshotId: string): Promise<string>
  /** 从备份文件恢复：解析 JSON，走和撤销同一套对齐逻辑 */
  restoreFromBackup(json: string, onProgress: (done: number, total: number) => void): Promise<UndoReport>

  /** 估算费用（美元），按高峰价 */
  estimateCost(usage: AiUsage): number

  // ---- bookmark-ux：待处理和手动操作，都在改书签的锁里跑
  /** 拿不准放哪、建议删除、空文件夹三类清单 */
  triage(): Promise<Triage>
  /** 移动书签；移动的记进「你定过位置的」 */
  moveBookmarks(ids: string[], target: MoveTarget): Promise<ManualChange>
  /** 删书签。给了 onBackup 就先把整棵树的快照（和应用前的备份同格式）交给它，它抛错就不删 */
  removeBookmarks(ids: string[], onBackup?: (json: string) => void | Promise<void>): Promise<ManualChange>
  /** 删空文件夹：深的先删，里面有东西的跳过 */
  removeFolders(ids: string[]): Promise<ManualChange>
  /** 撤销一次手动操作；中途出错再调一次从断点接着做 */
  revertChange(change: ManualChange): Promise<{ restored: number; skipped: number }>
}

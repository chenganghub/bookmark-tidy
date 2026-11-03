// 演示数据：像真的中文技术书签，分在 8 个文件夹里，带说明和各种状态。只在 ?demo=1 时加载。
import type { BookmarkMeta, BookmarkNode, FetchStatus, ItemType, PageInfo } from '../../core/types'

type Row = [title: string, url: string, desc?: string, tags?: string[], type?: ItemType, status?: FetchStatus]

const DAY = 86400000
export const DEMO_NOW = Date.parse('2026-10-31T12:00:00+08:00')

const bar: [string, Row[], [string, Row[]][]?][] = [
  [
    'AI',
    [
      ['ChatGPT', 'https://chatgpt.com/', '和 ChatGPT 对话，写代码、查资料、改文案时用', ['AI', '对话'], '工具'],
      ['DeepSeek 开放平台', 'https://platform.deepseek.com/usage', '看 DeepSeek API 用量、管理 key', ['AI', 'API'], '后台', 'login'],
      ['Cursor - The AI Code Editor', 'https://cursor.com/', '带 AI 补全和对话的代码编辑器', ['AI', '编辑器'], '工具'],
      ['(17 封私信 / 20 条消息) 2万字 OpenClaw 保姆教程 - 知乎', 'https://zhuanlan.zhihu.com/p/1928374650', 'OpenClaw 从安装、配置到日常用法的完整教程', ['Agent', 'AI'], '文章', 'blocked'],
      ['MCP 服务器导航 - mcp.so', 'https://mcp.so/', '收录各类 MCP 服务器，找现成工具接入时用', ['MCP', 'AI'], '工具'],
      ['Prompt Engineering Guide', 'https://www.promptingguide.ai/zh', '提示词写法的系统教程，写复杂提示词前翻', ['提示词'], '文档'],
      ['Hugging Face – The AI community building the future.', 'https://huggingface.co/', '找开源模型和数据集', ['模型', 'AI'], '社区'],
      ['Claude', 'https://claude.ai/', '和 Claude 对话，分析长文档时用', ['AI', '对话'], '工具']
    ]
  ],
  [
    '前端资源',
    [
      ['MDN Web Docs', 'https://developer.mozilla.org/zh-CN/', '查 HTML、CSS、JS 的标准用法', ['文档', 'Web'], '文档'],
      ['Can I use... Support tables for HTML5, CSS3, etc', 'https://caniuse.com/', '查 CSS 和 JS 特性的浏览器兼容性', ['兼容性'], '工具'],
      ['进军高级前端开发工程师必备的知识图谱 - SHOW TIME - SegmentFault 思否', 'https://segmentfault.com/a/1190000012345678', '前端进阶知识点的总目录，查漏补缺时翻', ['学习路线'], '文章'],
      ['web前端技术体系大全 - 个人文章 - SegmentFault 思否', 'https://segmentfault.com/a/1190000023456789', '前端技术栈的全景整理', ['学习路线'], '文章'],
      ['Vite | 下一代的前端工具链', 'https://cn.vitejs.dev/', 'Vite 的配置项和插件写法', ['Vite', '构建'], '文档'],
      ['GitHub - vuejs/core: 🖖 Vue.js is a progressive JavaScript framework', 'https://github.com/vuejs/core', 'Vue 3 源码仓库，看实现和 issue', ['Vue', '源码'], '代码仓库'],
      ['一个 Vue 3 UI 框架 | Element Plus', 'https://element-plus.org/zh-CN/', 'Vue 3 组件库文档', ['Vue', '组件库'], '文档'],
      ['pnpm 基本详细使用教程（安装、卸载、使用、可能遇到的问题及解决办法）_window pnpm安装-CSDN博客', 'https://blog.csdn.net/weixin_45678901/article/details/131234567', 'pnpm 的安装、常用命令和常见报错的解决办法', ['pnpm', '包管理'], '文章']
    ]
  ],
  [
    'css框架',
    [
      ['修改ElementUI样式的几种方式 - 公瑾当年 - 博客园', 'https://www.cnblogs.com/gongjin/p/12345678.html', '深度选择器、全局覆盖、自定义主题三种改法', ['CSS', 'Element'], '文章'],
      ['Tailwind CSS - Rapidly build modern websites', 'https://tailwindcss.com/', '原子化 CSS 框架文档', ['CSS'], '文档'],
      ['🌈掌握CSS：超级有用的CSS资源汇总(2023) - 掘金', 'https://juejin.cn/post/7212345678901234567', 'CSS 学习资源和工具合集', ['CSS'], '文章'],
      ['animate.css源码 - 前端极客 - 博客园', 'https://www.cnblogs.com/geek/p/23456789.html', 'animate.css 的实现原理', ['CSS', '动画'], '文章'],
      ['UnoCSS: The instant on-demand Atomic CSS engine', 'https://unocss.dev/', '按需生成的原子化 CSS 引擎', ['CSS'], '工具']
    ],
    [
      [
        'css',
        [
          ['如何使fixed元素相对于父元素定位 - 爱代码三千 - 博客园', 'https://www.cnblogs.com/aidaima/p/34567890.html', 'fixed 相对父元素定位的几种办法', ['CSS', '定位'], '文章'],
          ['父元素有transform样式 则子元素fixed定位失效_zhaohanqq的博客-CSDN博客', 'https://blog.csdn.net/zhaohanqq/article/details/101234567', 'transform 让 fixed 失效的原因和绕法', ['CSS', '定位'], '文章'],
          ['深度理解div+css布局嵌套盒子 - 妮儿jk - 博客园', 'https://www.cnblogs.com/nierjk/p/45678901.html', '盒模型嵌套布局的讲解', ['CSS', '布局'], '文章'],
          ['(1条消息) css：子元素设置display:inline-block出现的问题_飞翔的哔哔鸡的博客-CSDN博客', 'https://blog.csdn.net/feixiang/article/details/112345678', 'inline-block 间隙问题的成因和解决', ['CSS'], '文章']
        ]
      ]
    ]
  ],
  [
    'js处理',
    [
      ['区分slice,splice和split方法 - 生旦净末丑 - 博客园', 'https://www.cnblogs.com/sdjmc/p/56789012.html', '三个容易混的方法的区别', ['JS'], '文章'],
      ['js判断对象是否为空对象的几种方法 - 星朝 - 博客园', 'https://www.cnblogs.com/xingchao/p/67890123.html', '判断空对象的几种写法', ['JS'], '文章'],
      ['JS使用reduce方法数组去重原理解析 - 简书', 'https://www.jianshu.com/p/a1b2c3d4e5f6', '用 reduce 给数组去重的写法', ['JS', '数组'], '文章'],
      ['Storage事件无法触发解决_demo_author的博客-CSDN博客', 'https://blog.csdn.net/demo_author/article/details/98765432', '同页面改 localStorage 不触发 storage 事件的原因', ['JS', '存储'], '文章'],
      ['(52条消息) js数组转化成树结构_讲解', 'https://blog.csdn.net/tree/article/details/123450987', '扁平数组转成树的写法', ['JS', '数组'], '文章'],
      ['H5 notification浏览器桌面通知_OBKoro1分享 - SegmentFault 思否', 'https://segmentfault.com/a/1190000034567890', '用 Notification API 弹浏览器桌面通知', ['JS', '通知'], '文章', 'dead'],
      ['淘宝网站上的 HTTP 缓存问题两则 - 紫云飞 - 博客园', 'https://www.cnblogs.com/ziyunfei/p/78901234.html', 'HTTP 缓存踩坑的两个案例', ['HTTP', '缓存'], '文章']
    ]
  ],
  [
    '小程序',
    [
      ['微信开放文档', 'https://developers.weixin.qq.com/miniprogram/dev/framework/', '小程序官方开发文档', ['小程序'], '文档'],
      ['微信小程序网络请求封装 - 个人文章 - SegmentFault 思否', 'https://segmentfault.com/a/1190000045678901', '把 wx.request 包一层：统一拦截、报错和加载状态', ['小程序', '请求'], '文章'],
      ['微信小程序之转发功能（附效果图和源码） - 简书', 'https://www.jianshu.com/p/f6e5d4c3b2a1', '小程序分享转发的实现', ['小程序'], '文章'],
      ['小程序分页加载onReachBottom上拉触底加载--小程序走过的坑（6）（最新版） - zhanxingdong的博客 - CSDN博客', 'https://blog.csdn.net/zhanxingdong/article/details/80123456', '上拉触底分页加载的写法和坑', ['小程序', '分页'], '文章'],
      ['突破微信小程序模板消息限制，实现无限制主动推送 - Dreawer微信小程序联盟 - CSDN博客', 'https://blog.csdn.net/dreawer/article/details/79123456', '绕开模板消息限制的推送方案', ['小程序', '推送'], '文章', 'dead'],
      ['微信公众平台', 'https://mp.weixin.qq.com/', '小程序后台：发布、数据和配置', ['小程序', '后台'], '后台', 'login']
    ]
  ],
  [
    'uniapp',
    [
      ['uni-app官网', 'https://uniapp.dcloud.net.cn/', 'uni-app 官方文档', ['uniapp'], '文档'],
      ['uniapp权限检查,拉起系统授权_uniapp打开系统设置权限_Jungle前端的博客-CSDN博客', 'https://blog.csdn.net/jungle/article/details/120987654', '检查 App 权限，没有就跳到系统设置去开', ['uniapp', '权限'], '文章'],
      ['uniapp全局组件全局使用(不在每个页面template使用，仅支持H5)，函数式调用全局组件方法_前端薛小帅的博客-CSDN博客', 'https://blog.csdn.net/xuexiaoshuai/article/details/119876543', '函数式调用全局组件的做法', ['uniapp', '组件'], '文章'],
      ['GraceUI - uni-app 组件库', 'https://www.graceui.com/', 'uni-app 的 UI 组件库', ['uniapp', '组件库'], '文档'],
      ['DCloud 插件市场', 'https://ext.dcloud.net.cn/', '找 uni-app 插件', ['uniapp', '插件'], '工具']
    ]
  ],
  [
    '文档编辑器及富文本',
    [
      ['前端实现根据模版导出word【docxtemplater】 - ^Mao^ - 博客园', 'https://www.cnblogs.com/mao/p/89012345.html', '用 docxtemplater 往 Word 模板里填数据再导出', ['Word', '导出'], '文章'],
      ['TinyMCE | The Most Trusted WYSIWYG Editor', 'https://www.tiny.cloud/', '老牌富文本编辑器', ['富文本'], '工具'],
      ['Tiptap - Dev Toolkit Editor Suite', 'https://tiptap.dev/', '基于 ProseMirror 的无头编辑器框架', ['富文本'], '文档'],
      ['文档工具解析：前端如何选择最适合的文档生成器？_docusaurus-CSDN博客', 'https://blog.csdn.net/docs/article/details/134567890', '对比几种文档站生成器', ['文档站'], '文章'],
      ['ONLYOFFICE Docs', 'https://www.onlyoffice.com/zh/office-suite.aspx', '在线编辑 Word、Excel 的文档服务', ['在线编辑'], '工具']
    ]
  ],
  [
    '受保护资料',
    [
      ['团队周报', 'https://example.feishu.cn/docx/AbCdEfGh1234567890IjKlMnOp'],
      ['需求池', 'https://example.feishu.cn/base/QrStUvWx0987654321'],
      ['GitLab', 'https://gitlab.example.com/']
    ]
  ]
]

const loose: Row[] = [
  ['Gmail', 'https://mail.google.com/mail/u/0/#inbox', '邮箱', ['邮件'], '工具', 'login'],
  ['GitHub', 'https://github.com/', '代码托管', ['代码'], '工具']
]

const other: Row[] = [
  ['localhost:5173', 'http://localhost:5173/'],
  ['作为一名前端架构师，我是怎么搭建前端工程化滴 - 知乎', 'https://zhuanlan.zhihu.com/p/345678901', '讲前端工程化怎么落地：规范、脚手架、构建和发布', ['工程化', '架构'], '文章', 'blocked'],
  ['MDN Web Docs - 首页', 'https://developer.mozilla.org/zh-CN/?utm_source=chrome', '查 HTML、CSS、JS 的标准用法', ['文档', 'Web'], '文档']
]

export function demoSeed(): { tree: BookmarkNode[]; meta: Record<string, BookmarkMeta>; pages: Record<string, PageInfo> } {
  let next = 100
  let n = 0
  const meta: Record<string, BookmarkMeta> = {}
  const pages: Record<string, PageInfo> = {}
  const link = ([title, url, desc, tags, type, status]: Row, locked = false): BookmarkNode => {
    const id = String(next++)
    n++
    // 添加时间分布在 2019～2026，每 5 条里有 1 条最近打开过
    const dateAdded = DEMO_NOW - ((n * 37) % 2500) * DAY - n * 3600000
    const node: BookmarkNode = { id, title, url, dateAdded }
    if (n % 5 === 0) node.dateLastUsed = DEMO_NOW - (n % 20) * DAY
    // 少数几条故意不给说明，演示「还没写说明」
    if (desc && !locked && n % 17 !== 0) meta[id] = { desc, title: '', tags: tags ?? [], type: type ?? '其他', updatedAt: DEMO_NOW }
    // 大约四分之三抓过网页，剩下的留给「抓取网页信息」演示
    if (!locked && url.startsWith('http') && !url.includes('localhost') && n % 4 !== 0) {
      pages[url] = { url, status: status ?? 'ok', httpStatus: status === 'dead' ? 404 : status === 'blocked' ? 403 : 200, title, description: desc, fetchedAt: DEMO_NOW }
    }
    return node
  }
  const folder = (title: string, kids: BookmarkNode[]): BookmarkNode => ({ id: String(next++), title, dateAdded: DEMO_NOW - 1800 * DAY, children: kids })

  const barNodes: BookmarkNode[] = bar.map(([title, rows, subs]) => {
    const locked = title === '受保护资料'
    return folder(title, [...rows.map((r) => link(r, locked)), ...(subs ?? []).map(([t, rs]) => folder(t, rs.map((r) => link(r))))])
  })
  barNodes.push(...loose.map((r) => link(r)))
  const tree: BookmarkNode[] = [
    {
      id: '0',
      title: '',
      children: [
        { id: '1', title: '书签栏', folderType: 'bookmarks-bar', syncing: false, children: barNodes },
        { id: '2', title: '其他书签', folderType: 'other', syncing: false, children: other.map((r) => link(r)) },
        { id: '3', title: '移动设备书签', folderType: 'mobile', syncing: false, children: [] }
      ]
    }
  ]
  return { tree, meta, pages }
}

/** 演示用的「网页内容」：按种子数据回状态和简介 */
export function demoPageOf(url: string): { status: FetchStatus; title: string; desc: string } | undefined {
  const all: Row[] = [...bar.flatMap(([, rows, subs]) => [...rows, ...(subs ?? []).flatMap(([, rs]) => rs)]), ...loose, ...other]
  const row = all.find((r) => r[1] === url)
  return row ? { status: row[5] ?? 'ok', title: row[0], desc: row[2] ?? '' } : undefined
}

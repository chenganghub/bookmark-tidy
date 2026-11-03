import { defineConfig } from 'wxt'

// 抓网页要的网址权限是可选权限，用户点「抓取网页信息」时才申请。
// e2e 构建（npm run build:e2e）直接给全部网址权限：自动化测试里没法点授权弹窗。
const ALL_SITES = ['http://*/*', 'https://*/*']

export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  manifest: ({ mode }) => ({
    name: '书签整理',
    description: '把乱掉的 Chrome 书签重新分类，给每条写一句说明；收藏时自动放好；改动能撤销。',
    // 二期加的：scripting（收藏时读当前页正文）、notifications（放好后通知、能撤销）、
    // alarms（后台被停掉时把等着处理的收藏叫醒）、unlimitedStorage（本机存正文）
    permissions: ['bookmarks', 'storage', 'favicon', 'scripting', 'notifications', 'alarms', 'unlimitedStorage'],
    host_permissions: ['https://api.deepseek.com/*', ...(mode === 'e2e' ? ALL_SITES : [])],
    optional_host_permissions: ALL_SITES,
    // 地址栏输入「s 空格 关键词」搜书签
    omnibox: { keyword: 's' },
    // 图标由 npm run icons 生成到 public/icon/；点图标打开弹窗（entrypoints/popup）
    action: { default_title: '书签整理', default_icon: { 16: 'icon/16.png', 32: 'icon/32.png' } }
  })
})

// 本地测试服务器（e2e 用，零依赖）：记下每个请求的方法、路径和请求头，回一个带 title 和 description 的小网页。
// 配合 launch({ hostRules: 'MAP site.bt-test 127.0.0.1' }) 用，验证抓网页时不带 Cookie（accept C2）。
import http from 'node:http'

const PAGE = '<!doctype html><html lang="zh-CN"><head><title>e2e 测试页</title><meta name="description" content="本地测试服务器"></head><body></body></html>'

/** 在 127.0.0.1 的随机端口上启动；requests 是收到的请求（按到达顺序） */
export async function startServer() {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: { ...req.headers }, at: Date.now() })
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    port,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

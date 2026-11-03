import { defineConfig } from 'vitest/config'

// 核心逻辑（src/core）是纯 TS，不依赖浏览器全局，用 node 环境测。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts']
  }
})

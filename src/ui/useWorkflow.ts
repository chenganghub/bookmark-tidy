// 选真假实现：地址带 ?demo=1 时用演示数据（内存书签，不碰真实书签），两边都按需加载。
import type { Workflow } from '../core/types'

export const params = new URLSearchParams(location.search)
export const isDemo = params.has('demo')

export async function getWorkflow(): Promise<Workflow> {
  if (isDemo) return (await import('./demo/workflow')).createDemoWorkflow()
  return (await import('../core/workflow')).createWorkflow()
}

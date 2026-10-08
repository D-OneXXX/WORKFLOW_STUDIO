import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { WorkflowPanel } from '../client/app.js'
import { zh } from '../client/locales/zh.js'
import type { ClientContextLike, WireResult, WorkflowRpc } from '../client/remote.js'
import type { ConnectorCatalog, WorkflowGraph } from '../client/types.js'

async function request<T>(method: string, body: unknown): Promise<WireResult<T>> {
  try {
    const response = await fetch(`/api/${method}`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workflow-studio': '1' }, body: JSON.stringify(body) })
    return await response.json() as WireResult<T>
  } catch (error) {
    return { ok: false, error: { message: `本地服务连接失败：${error instanceof Error ? error.message : String(error)}` } }
  }
}
const rpc: WorkflowRpc = {
  save: body => request('save', body), list: body => request('list', body), load: body => request('load', body),
  remove: body => request('delete', body), run: body => request('run', body),
}
const ctx: ClientContextLike = {
  slots: { inject: () => () => {}, register: () => undefined }, layout: { selectPanel: () => {} }, effect: () => undefined,
  locale: { register: () => () => {}, bind: () => (key, params) => {
    let text: string = zh[key as keyof typeof zh] ?? key
    for (const [name, value] of Object.entries(params ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  } },
}
const graph: WorkflowGraph = {
  nodes: [
    { id: 'input', kind: 'input', label: '输入文本', params: { input: 'Hello workflow' }, position: { x: 40, y: 100 } },
    { id: 'code', kind: 'code', label: '转为大写', params: { code: 'return input.toUpperCase()' }, position: { x: 270, y: 100 } },
    { id: 'output', kind: 'output', label: '输出', position: { x: 500, y: 100 } },
  ],
  edges: [{ id: 'a', source: 'input', target: 'code' }, { id: 'b', source: 'code', target: 'output' }],
}
const sample = { name: '本地执行示例', description: '输入文本 → 转大写 → 输出；独立进程真实执行', graph }

async function main(): Promise<void> {
  // The executor list is read from the standalone HTTP surface rather than the
  // Typert RPC: `scripts/lint.mjs` pins the wire vocabulary at exactly five
  // methods, and an illegal name there is a fatal host load failure. A panel
  // that gets no catalogue simply shows no dropdown.
  const catalog = await request<ConnectorCatalog>('connectors', {})
  createRoot(document.getElementById('root')!).render(
    <React.Fragment>
      <div className="standalone-banner">工作流独立版 · 本地保存与执行 · 大模型节点由已配置的连接器交给 agent 程序执行。代码节点具有本机用户权限，请仅运行自己信任的代码。</div>
      <WorkflowPanel ctx={ctx} rpc={rpc} mountError={undefined} sampleOverride={sample}
        importDocument={document => request<{ id: string }>('import', document)}
        connectors={catalog.ok ? catalog.value : undefined} />
    </React.Fragment>,
  )
}

void main()

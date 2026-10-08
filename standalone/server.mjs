import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WorkflowStore } from './store.mjs'
import { runGraph, stopAllRuns } from './runner.mjs'
import { ConnectorRegistry } from './connectors.mjs'
import { translateDescription, translateRequestSchema } from './translator.mjs'

const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * Validate a translate request, and fail with a sentence the panel can show.
 *
 * A zod dump would be accurate and useless here: this endpoint is called by a
 * button click, so its errors end up in front of someone writing words, not
 * reading stack traces. The node ids are checked against the graph because the
 * browser may have been left open while the graph was edited elsewhere.
 */
function readTranslateRequest(body) {
  const parsed = translateRequestSchema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new Error(`翻译请求不完整：${issue?.path?.join('.') ?? 'body'}——${issue?.message ?? '格式不对'}`)
  }
  const request = parsed.data
  const ids = new Set(request.graph.nodes.map((node) => node.id))
  if (!ids.has(request.nodeId)) throw new Error(`节点 ${request.nodeId} 已不在当前图上，请重新选中它`)
  if (request.pin !== undefined && !ids.has(request.pin.nodeId)) {
    throw new Error(`要指定的节点 ${request.pin.nodeId} 已不在当前图上`)
  }
  return request
}

export async function createStudioServer({ dataDir = join(root, 'data') } = {}) {
  const store = await WorkflowStore.open(dataDir)
  // Connector secrets exist only here, in the server process. The worker child
  // asks this registry to run an agent step and receives only a result.
  const connectors = await ConnectorRegistry.load(dataDir)
  const server = createServer(async (request, response) => {
    const reply = (status, data) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(JSON.stringify(data))
    }
    try {
      const allowedHost = `127.0.0.1:${server.address().port}`
      if (request.headers.host !== allowedHost) return reply(403, { ok: false, error: { message: '只允许本机地址访问' } })
      const path = new URL(request.url, `http://${allowedHost}`).pathname
      if (path.startsWith('/api/')) {
        if (request.method !== 'POST') return reply(405, { ok: false, error: { message: '使用 POST' } })
        if (request.headers['x-workflow-studio'] !== '1' ||
            (request.headers.origin && request.headers.origin !== `http://${allowedHost}`)) {
          return reply(403, { ok: false, error: { message: '拒绝跨来源调用' } })
        }
        if (!request.headers['content-type']?.startsWith('application/json')) return reply(415, { ok: false, error: { message: '需要 JSON 请求' } })
        const chunks = []; let size = 0
        for await (const chunk of request) {
          size += chunk.length
          if (size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB')
          chunks.push(chunk)
        }
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        let value
        switch (path) {
          case '/api/list': value = store.list(); break
          case '/api/save': value = await store.save(body); break
          case '/api/load': value = store.load(body.id); break
          case '/api/delete': value = await store.remove(body.id); break
          case '/api/import': value = await store.import(body); break
          case '/api/export': value = store.export(body.id); break
          case '/api/run': {
            const graph = body.graph ?? store.load(body.id)?.graph
            if (!graph) throw new Error('找不到要运行的工作流')
            value = await runGraph(graph, { registry: connectors }); break
          }
          // Ids and labels only — never command lines, endpoints, or env. The
          // property panel needs this to fill the executor dropdown, and it
          // stays off the Typert surface, which lint pins at exactly 5 methods.
          case '/api/connectors': value = connectors.listPublic(); break
          // Plain-language configuration, translated at edit time only: the run
          // path never calls this. The connector is the workflow's default, and
          // its key stays here in the server process — the browser sends words,
          // not a prompt it built itself, so it cannot reach the registry.
          case '/api/translate': {
            const request = readTranslateRequest(body)
            value = await translateDescription({
              ...request,
              callAgent: ({ prompt }) => connectors.callAgent({ prompt, depth: 1 }),
            })
            break
          }
          default: return reply(404, { ok: false, error: { message: '接口不存在' } })
        }
        return reply(200, { ok: true, value })
      }
      if (request.method !== 'GET') return reply(405, { ok: false, error: { message: '使用 GET' } })
      const files = { '/': ['index.html', 'text/html'], '/app.js': ['dist/app.js', 'text/javascript'] }
      const file = files[path]
      if (!file) return reply(404, { ok: false, error: { message: '页面不存在' } })
      const bytes = await readFile(join(root, file[0]))
      response.writeHead(200, { 'content-type': `${file[1]}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      response.end(bytes)
    } catch (error) { reply(400, { ok: false, error: { code: 'standalone/error', message: error.message } }) }
  })
  return { server, store, connectors, close: () => new Promise(resolveClose => { stopAllRuns(); server.close(resolveClose); server.closeIdleConnections() }) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.WORKFLOW_STUDIO_DATA_DIR ?? join(root, 'data')
  const port = Number(process.env.WORKFLOW_STUDIO_PORT ?? 43180)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须是 0–65535 的整数')
  const app = await createStudioServer({ dataDir })
  app.server.on('error', error => { console.error(`独立服务启动失败：${error.message}`); process.exitCode = 1 })
  app.server.listen(port, '127.0.0.1', () => {
    console.log(`工作流独立版：http://127.0.0.1:${app.server.address().port}`)
    console.log(`数据目录：${resolve(dataDir)}`)
  })
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void app.close() })
}

/**
 * Inbound MCP server: lets an agent program drive this studio.
 *
 * This is the other direction to the connector registry. Outbound, a workflow
 * asks an agent to do a step (`connectors.mjs`). Inbound, an agent lists,
 * runs and checks workflows here. The two must not be confused: the `mcp`
 * connector *kind* is an outbound adapter for a Harness agent, whereas this
 * file is an inbound server.
 *
 * ## Transport
 *
 * stdio, newline-delimited JSON-RPC 2.0, per the MCP base protocol
 * (https://modelcontextprotocol.io/specification/2025-06-18/basic/transports):
 *
 *   - one message per line; messages contain no embedded newlines
 *   - nothing that is not a valid MCP message is ever written to stdout
 *   - human-readable logging goes to stderr
 *   - the client owns the process lifetime and closes stdin to end the session
 *
 * Because the client launched this process, the origin and header checks the
 * HTTP server needs are not relevant here; the loopback-only rule still applies
 * to anything this server itself calls.
 *
 * ## Recursion
 *
 * A workflow can run an agent, and that agent can connect back here and run
 * another workflow. The parent stamps `WORKFLOW_STUDIO_DEPTH` into the agent's
 * environment; this server reads it and refuses to start runs past
 * MAX_DELEGATION_DEPTH, which is what closes the guard opened in phase A.
 */

import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import { WorkflowStore } from './store.mjs'
import { ConnectorRegistry, MAX_DELEGATION_DEPTH } from './connectors.mjs'
import { runGraph } from './runner.mjs'

const PROTOCOL_VERSION = '2025-06-18'
const root = fileURLToPath(new URL('.', import.meta.url))

/**
 * Reported in the handshake. Read from `package.json` rather than written out
 * here, so a release bump cannot leave an agent looking at a stale version.
 */
function serverInfo() {
  try {
    const file = readFileSync(resolve(root, '..', 'package.json'), 'utf8')
    return { name: 'dsh-workflow-studio', version: JSON.parse(file).version ?? '0.0.0' }
  } catch {
    // A minimal install (or a relocated file) must not stop the server talking.
    return { name: 'dsh-workflow-studio', version: 'unknown' }
  }
}

const SERVER_INFO = serverInfo()

/** Terminal states a run can be left in. */
const FINISHED = new Set(['completed', 'error', 'cancelled'])

/**
 * In-memory run registry.
 *
 * Phase C replaces this with the persisted ledger; until then it answers
 * `workflow.status` for runs this server started, which is all the tool
 * promises. Entries are capped so a long-lived session cannot grow without
 * bound.
 */
export class RunRegistry {
  #runs = new Map()
  #limit = 200

  start(runId, workflowId) {
    this.#runs.set(runId, { runId, workflowId: workflowId ?? null, status: 'running', startedAt: new Date().toISOString() })
    this.#trim()
    return this.#runs.get(runId)
  }

  finish(runId, patch) {
    const entry = this.#runs.get(runId)
    if (entry === undefined) return
    Object.assign(entry, patch, { finishedAt: new Date().toISOString() })
  }

  get(runId) {
    return this.#runs.get(runId) ?? null
  }

  #trim() {
    while (this.#runs.size > this.#limit) {
      const oldest = [...this.#runs.entries()].find(([, value]) => FINISHED.has(value.status))
      if (oldest === undefined) return
      this.#runs.delete(oldest[0])
    }
  }
}

/** The three tools this server exposes. */
export const TOOLS = [
  {
    name: 'workflow.list',
    title: '列出工作流',
    description: 'List saved workflows: id, name, description, node count and last-updated time, newest first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: { workflows: { type: 'array' } }, required: ['workflows'], additionalProperties: true },
  },
  {
    name: 'workflow.run',
    title: '运行工作流',
    description:
      'Run a saved workflow by id, or an inline graph. Optionally override the input node\'s text. '
      + 'By default this waits for the run to finish and returns its result; pass wait=false to get a '
      + 'runId immediately and poll workflow.status.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Saved workflow id. Ignored when graph is provided.' },
        graph: { type: 'object', description: 'A complete workflow graph, used instead of id.' },
        input: { type: 'string', description: 'Replaces the input node text for this run.' },
        wait: { type: 'boolean', description: 'Wait for completion. Defaults to true.' },
      },
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { runId: { type: 'string' }, status: { type: 'string' } }, required: ['runId', 'status'], additionalProperties: true },
  },
  {
    name: 'workflow.status',
    title: '查询运行状态',
    description: 'Report the state of a run this server started: running, completed, error or cancelled, with its result once finished.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { runId: { type: 'string' }, status: { type: 'string' } }, required: ['runId', 'status'], additionalProperties: true },
  },
]

/**
 * Handle one decoded JSON-RPC message.
 * @returns the reply to write, or undefined for a notification.
 */
export function createHandler({ store, registry, runs, depth }) {
  const tools = new Map(TOOLS.map((tool) => [tool.name, tool]))

  async function callTool(name, args) {
    if (name === 'workflow.list') {
      return { workflows: await store.list() }
    }
    if (name === 'workflow.run') {
      const graph = args.graph ?? (await store.load(args.id ?? ''))?.graph
      if (graph === undefined || graph === null) {
        throw new ToolFailure('找不到要运行的工作流：请提供 id 或 graph')
      }
      const working = structuredClone(graph)
      if (typeof args.input === 'string') {
        const inputNode = working.nodes.find((node) => node.kind === 'input')
        if (inputNode === undefined) throw new ToolFailure('该工作流没有输入节点，无法注入 input')
        inputNode.params = { ...inputNode.params, input: args.input }
      }
      const runId = randomUUID()
      runs.start(runId, args.id ?? null)

      const settle = (result) => {
        runs.finish(runId, {
          status: result.stopReason,
          // The runner mints its own id; keep it so a ledger written by phase C
          // can join an MCP-facing run to the engine run behind it.
          engineRunId: result.runId ?? null,
          agentsStarted: result.agentsStarted,
          value: result.value ?? null,
          error: result.error ?? null,
        })
        return result
      }

      if (args.wait === false) {
        // Fire and record; the caller polls workflow.status.
        void runGraph(working, { registry, depth }).then(settle, (error) => {
          runs.finish(runId, { status: 'error', error: String(error?.message ?? error) })
        })
        return { runId, status: 'running', wait: false }
      }
      const result = settle(await runGraph(working, { registry, depth }))
      return {
        runId,
        status: result.stopReason,
        value: result.value ?? null,
        error: result.error ?? null,
        agentsStarted: result.agentsStarted ?? 0,
        progress: result.progress ?? [],
      }
    }
    if (name === 'workflow.status') {
      const entry = runs.get(String(args.runId ?? ''))
      if (entry === null) throw new ToolFailure('没有找到该 runId。状态只保留本服务本次会话启动的运行。')
      return entry
    }
    throw new ToolFailure(`未知工具：${name}`)
  }

  return async function handle(message) {
    const { id, method, params } = message
    const isRequest = id !== undefined && id !== null
    // A notification never gets a reply, whatever its method.
    if (!isRequest) return undefined

    if (method === 'initialize') {
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
    }
    if (method === 'ping') return ok(id, {})

    if (method === 'tools/list') {
      // Three tools: no pagination, so no cursor.
      return ok(id, { tools: TOOLS })
    }

    if (method === 'tools/call') {
      const name = String(params?.name ?? '')
      if (!tools.has(name)) return error(id, -32602, `未知工具：${name}`)
      // The recursion guard: refuse before any workflow starts.
      if (name === 'workflow.run' && depth >= MAX_DELEGATION_DEPTH) {
        return ok(id, failure(`委派深度已达上限 ${MAX_DELEGATION_DEPTH} 层，拒绝再启动工作流`))
      }
      try {
        const value = await callTool(name, params?.arguments ?? {})
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          structuredContent: value,
          isError: false,
        })
      } catch (toolError) {
        // A tool that fails while executing is a result with isError, not a
        // protocol error; only malformed requests use JSON-RPC error codes.
        const text = toolError instanceof ToolFailure
          ? toolError.message
          : String(toolError?.message ?? toolError)
        return ok(id, failure(text.slice(0, 2000)))
      }
    }

    return error(id, -32601, `方法不支持：${String(method)}`)
  }
}

/** A deliberate tool-level failure, reported as isError rather than -32603. */
class ToolFailure extends Error {}

const ok = (id, result) => ({ jsonrpc: '2.0', id, result })
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } })
const failure = (message) => ({ content: [{ type: 'text', text: message }], isError: true })

/**
 * Serve one MCP session over the given streams.
 * Exported so the tests can drive it with in-memory pipes.
 */
export async function serveMcp({ input = process.stdin, output = process.stdout, log = () => undefined, ...context } = {}) {
  const handle = createHandler(context)
  const lines = createInterface({ input, crlfDelay: Infinity })

  for await (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let message
    try {
      message = JSON.parse(trimmed)
    } catch {
      output.write(`${JSON.stringify(error(null, -32700, '解析失败：不是有效 JSON'))}\n`)
      continue
    }
    try {
      const reply = await handle(message)
      if (reply === undefined) continue
      // One frame per line. JSON.stringify escapes embedded newlines in string
      // values, so a workflow name or log message cannot split a frame.
      output.write(`${JSON.stringify(reply)}\n`)
    } catch (unexpected) {
      log(`处理消息失败：${unexpected?.message ?? unexpected}`)
      output.write(`${JSON.stringify(error(message?.id ?? null, -32603, '内部错误'))}\n`)
    }
  }
}

/** Parse WORKFLOW_STUDIO_DEPTH defensively; a bad value means "top level". */
function readDepth(value) {
  const parsed = Number(value ?? '0')
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0
}

/**
 * A workflow library that re-reads `workflows.json` on every request.
 *
 * An MCP session outlives the browser edits that change the library: a snapshot
 * taken at startup would hide a workflow the user just saved, or keep offering
 * one they just deleted. The file is small and writes are rename-atomic, so a
 * re-read costs less than being wrong. This server only ever reads it, so
 * concurrent writes from the HTTP server cannot be lost.
 */
function liveLibrary(directory) {
  return {
    list: async () => (await WorkflowStore.open(directory)).list(),
    load: async (id) => (await WorkflowStore.open(directory)).load(id),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.WORKFLOW_STUDIO_DATA_DIR ?? join(root, 'data')
  const depth = readDepth(process.env.WORKFLOW_STUDIO_DEPTH)
  // stdout carries the protocol only; every diagnostic goes to stderr.
  const log = (text) => process.stderr.write(`[workflow-studio] ${text}\n`)
  try {
    const store = liveLibrary(dataDir)
    // Connectors are a config file an operator edits, so it is read at startup;
    // a change needs a restart, which is also how an MCP client respawns us.
    const registry = await ConnectorRegistry.load(dataDir)
    log(`已连接数据目录 ${resolve(dataDir)}；连接器 ${registry.listPublic().connectors.length} 个；委派深度 ${depth}/${MAX_DELEGATION_DEPTH}`)
    await serveMcp({ store, registry, runs: new RunRegistry(), depth, log })
  } catch (startupError) {
    log(`启动失败：${startupError?.message ?? startupError}`)
    process.exitCode = 1
  }
}

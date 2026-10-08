/**
 * Outbound connector registry: the thing that replaces the worker's
 * "no model connector configured" stub.
 *
 * A connector is a row in `connectors.json`, not a line of code, so wiring up a
 * newly installed agent program is a config edit. Three generic kinds exist —
 * `cli`, `http`, `mcp`. Phase A implements `cli`; the other two are recognised
 * and rejected with a message that says so, rather than silently missing.
 *
 * ## Where the secrets live
 *
 * This module runs in the **server** process. A worker child process never
 * learns a command line, an endpoint, or an environment value: it sends
 * `{ type: 'agent-invoke', nodeId, prompt }` over IPC and receives only a
 * result back. That is what keeps the existing posture — the worker's
 * environment is a small whitelist because it also executes untrusted user code
 * nodes — from degrading.
 *
 * Nothing here writes prompt or response text to the server console. Failure
 * detail is bounded and redacted, because a CLI's stderr can echo back the very
 * environment values it was given.
 */

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

/** An agent node gets five minutes, not the 30 seconds local code gets. */
export const DEFAULT_AGENT_TIMEOUT_MS = 300_000
/** Workflow → agent → workflow → … is capped before it can nest further. */
export const MAX_DELEGATION_DEPTH = 3
/** Bound a chatty CLI before it can exhaust the server's memory. */
export const MAX_OUTPUT_BYTES = 1024 * 1024

const CONNECTOR_FILE = 'connectors.json'

const connectorSchema = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(['cli', 'http', 'mcp']),
  label: z.string().min(1).max(80).optional(),
  command: z.string().min(1).max(500).optional(),
  args: z.array(z.string().max(500)).max(32).optional(),
  /** How the prompt reaches the CLI: on stdin, or appended as one argument. */
  promptVia: z.enum(['stdin', 'arg']).optional(),
  /** `text` wraps stdout into the contract; `json` requires the CLI to emit it. */
  outputFormat: z.enum(['text', 'json']).optional(),
  timeoutMs: z.number().int().min(1_000).max(3_600_000).optional(),
  env: z.record(z.string(), z.string().max(2_000)).optional(),
  url: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  /**
   * `http`: the *name* of an environment variable in the server process that
   * holds the key. Naming a variable instead of storing a token keeps the
   * secret out of `connectors.json`, which sits on disk next to workflows.
   */
  apiKeyEnv: z.string().max(200).optional(),
  /** `http`: extra static request headers. */
  headers: z.record(z.string(), z.string().max(500)).optional(),
})

const registryFileSchema = z.object({
  defaultConnector: z.string().max(80).optional(),
  connectors: z.array(connectorSchema),
})

/** What the browser is allowed to see: enough to fill a dropdown, nothing more. */
const agentResultSchema = z.object({
  output: z.unknown(),
  summary: z.string().max(4_000),
})

/**
 * Environment handed to a spawned agent CLI.
 *
 * Deliberately not `process.env`: the server process may hold Harness and
 * provider credentials that the agent program has no business reading. A
 * connector can still opt specific values in through its own `env`.
 */
function cliEnvironment(connector, depth) {
  const inherited = ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']
  const base = Object.fromEntries(
    inherited.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  )
  return {
    ...base,
    ...(connector.env ?? {}),
    // Inbound calls (phase B) read this to enforce the delegation cap.
    WORKFLOW_STUDIO_DEPTH: String(depth),
  }
}

/** Strip anything that looks like a credential from text shown to a human. */
function redact(text) {
  return String(text)
    .replace(/(api[_-]?key|authorization|bearer|token|secret|password)(\s*[:=]\s*)\S+/gi, '$1$2[redacted]')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .slice(0, 300)
}

/** A duration a human can read: 1.5 秒 rather than the rounded 2 秒. */
function seconds(ms) {
  return `${(ms / 1000).toFixed(1).replace(/\.0$/, '')} 秒`
}

/** A connector-level failure the run should report, never a stack trace. */
export class ConnectorError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConnectorError'
  }
}

export class ConnectorRegistry {
  #connectors = new Map()
  #defaultId

  static empty() {
    return new ConnectorRegistry()
  }

  /**
   * Read the registry from a data directory.
   * A missing file is normal — it means no connector is configured yet, which is
   * exactly the state phase A shipped in. A malformed file is not: it fails
   * loudly at startup rather than half-working.
   */
  static async load(dataDir) {
    const registry = new ConnectorRegistry()
    let raw
    try {
      raw = await readFile(join(dataDir, CONNECTOR_FILE), 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return registry
      throw new ConnectorError(`连接器配置无法读取：${redact(error.message)}`)
    }
    let parsed
    try {
      parsed = registryFileSchema.parse(JSON.parse(raw))
    } catch (error) {
      throw new ConnectorError(`连接器配置无效：${redact(error.message)}`)
    }
    for (const connector of parsed.connectors) registry.#add(connector)
    registry.#defaultId = parsed.defaultConnector ?? [...registry.#connectors.keys()][0]
    if (registry.#defaultId !== undefined && !registry.#connectors.has(registry.#defaultId)) {
      throw new ConnectorError(`默认连接器 "${registry.#defaultId}" 不在 connectors 列表里`)
    }
    return registry
  }

  #add(connector) {
    if (this.#connectors.has(connector.id)) {
      throw new ConnectorError(`连接器 id 重复：${connector.id}`)
    }
    // `kind` decides which fields are required; zod cannot say this cleanly.
    if (connector.kind === 'cli' && connector.command === undefined) {
      throw new ConnectorError(`cli 连接器 ${connector.id} 缺少 command`)
    }
    if (connector.kind === 'http' && connector.url === undefined) {
      throw new ConnectorError(`http 连接器 ${connector.id} 缺少 url`)
    }
    if (connector.kind === 'mcp' && connector.command === undefined) {
      throw new ConnectorError(`mcp 连接器 ${connector.id} 缺少 command`)
    }
    this.#connectors.set(connector.id, connector)
  }

  get size() {
    return this.#connectors.size
  }

  get defaultId() {
    return this.#defaultId
  }

  /** Ids and labels only. Never command lines, endpoints, or environment. */
  listPublic() {
    return {
      defaultId: this.#defaultId ?? null,
      connectors: [...this.#connectors.values()].map((connector) => ({
        id: connector.id,
        kind: connector.kind,
        label: connector.label ?? connector.id,
      })),
    }
  }

  /** Per-node budget used to size the run's overall timeout. */
  timeoutFor(executorId) {
    const connector = this.#connectors.get(executorId ?? '')
    return connector?.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
  }

  /**
   * Run one agent step.
   * @param prompt - the interpolated prompt text.
   * @param executor - connector id from the node, or undefined for the default.
   * @param depth - how many workflow generations are already on the stack.
   */
  async callAgent({ prompt, executor, depth = 1 }) {
    if (depth > MAX_DELEGATION_DEPTH) {
      throw new ConnectorError(
        `委派深度已达上限 ${MAX_DELEGATION_DEPTH} 层，已拒绝：这通常意味着 agent 又回调了工作流`,
      )
    }
    const id = executor ?? this.#defaultId
    if (id === undefined) {
      throw new ConnectorError(
        '独立版尚未配置大模型连接器；请在 data/connectors.json 的 connectors 中添加一条',
      )
    }
    const connector = this.#connectors.get(id)
    if (connector === undefined) {
      throw new ConnectorError(`找不到执行器连接器 "${id}"`)
    }
    if (connector.kind === 'mcp') {
      throw new ConnectorError(
        `连接器 ${id} 的 mcp 适配器尚未实现：Harness agent 接入属于后续阶段`,
      )
    }
    const started = Date.now()
    const invoke = connector.kind === 'http' ? runHttp : runCli
    const result = await invoke(connector, String(prompt ?? ''), depth + 1)
    return { ...result, connectorId: id, ms: Date.now() - started }
  }
}

/**
 * Split the configured command line into program plus fixed arguments.
 *
 * Never handed to a shell. Quoting is supported because a program path may
 * contain spaces (`C:\Program Files\nodejs\node.exe`), and a plain whitespace
 * split would silently truncate such a connector to `C:\Program`.
 */
function argvFor(connector) {
  const tokens = []
  const pattern = /"([^"]*)"|(\S+)/g
  for (const match of connector.command.trim().matchAll(pattern)) {
    tokens.push(match[1] ?? match[2])
  }
  const [program, ...fixed] = tokens
  if (program === undefined) throw new ConnectorError(`连接器 ${connector.id} 的 command 是空的`)
  return { program, args: [...fixed, ...(connector.args ?? [])] }
}

/**
 * Turn raw CLI stdout into the `{ output, summary }` contract.
 * A CLI that cannot honour it is a failed node, not a silent string.
 */
function toContract(connector, stdout) {
  const text = stdout.trim()
  if (connector.outputFormat === 'json') {
    let value
    try {
      value = JSON.parse(text)
    } catch {
      throw new ConnectorError(`${connector.id} 声称输出 JSON，但无法解析`)
    }
    const parsed = agentResultSchema.safeParse(value)
    if (!parsed.success) {
      throw new ConnectorError(
        `${connector.id} 的返回不符合 { output, summary } 契约：${redact(parsed.error.issues[0]?.message ?? '')}`,
      )
    }
    return { output: parsed.data.output, summary: parsed.data.summary }
  }
  if (text.length === 0) throw new ConnectorError(`${connector.id} 没有产生任何输出`)
  return { output: text, summary: text.split(/\r?\n/)[0].slice(0, 200) }
}

/** Spawn one agent CLI invocation and wait for it. */
function runCli(connector, prompt, depth) {
  const { program, args } = argvFor(connector)
  const spawnArgs = connector.promptVia === 'arg' ? [...args, prompt] : args

  return new Promise((resolve, reject) => {
    let child
    try {
      // `shell: false` is load-bearing: the prompt is data, never syntax.
      child = spawn(program, spawnArgs, {
        shell: false,
        windowsHide: true,
        env: cliEnvironment(connector, depth),
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      reject(new ConnectorError(`${connector.id} 无法启动：${redact(error.message)}`))
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const limit = connector.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS

    const timer = setTimeout(() => {
      fail(`执行超过 ${seconds(limit)}，已终止 ${connector.id}`)
    }, limit)

    function fail(message) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      reject(new ConnectorError(message))
    }
    function succeed() {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // `toContract` rejects non-conforming output, and this runs inside a
      // child-process event handler — an escaping throw would be an uncaught
      // exception that takes the server down instead of failing one node.
      try {
        resolve(toContract(connector, stdout))
      } catch (error) {
        reject(error instanceof ConnectorError ? error : new ConnectorError(redact(error?.message ?? error)))
      }
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8')
      if (stdout.length > MAX_OUTPUT_BYTES) fail(`${connector.id} 输出超过 1 MB 上限`)
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-2_000)
    })
    child.on('error', (error) => fail(`${connector.id} 启动失败：${redact(error.message)}`))
    child.on('close', (code, signal) => {
      if (code === 0) succeed()
      else fail(`${connector.id} 退出码 ${signal ?? code}${stderr ? `：${redact(stderr)}` : ''}`)
    })

    if (connector.promptVia !== 'arg') {
      child.stdin.on('error', () => undefined)
      child.stdin.end(prompt)
    }
  })
}

/**
 * Call a cloud agent over HTTP, using the OpenAI-compatible chat shape.
 *
 * The key is read from a named variable in *this* process, so it never has to be
 * written into `connectors.json`. Failures carry a status code only — a response
 * body can echo credentials back, and this message reaches the run log.
 */
async function runHttp(connector, prompt, depth) {
  const key = connector.apiKeyEnv === undefined ? undefined : process.env[connector.apiKeyEnv]
  if (connector.apiKeyEnv !== undefined && (key === undefined || key.length === 0)) {
    throw new ConnectorError(`${connector.id} 需要环境变量 ${connector.apiKeyEnv}，当前未设置`)
  }
  const limit = connector.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
  const headers = {
    'content-type': 'application/json',
    // Lets a peer service apply the same delegation cap this process enforces.
    'x-workflow-depth': String(depth),
    ...(connector.headers ?? {}),
  }
  if (key !== undefined) headers.authorization = `Bearer ${key}`

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limit)
  let response
  let raw
  try {
    response = await fetch(connector.url, {
      method: 'POST',
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        ...(connector.model === undefined ? {} : { model: connector.model }),
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    raw = (await response.text()).slice(0, MAX_OUTPUT_BYTES)
  } catch (error) {
    throw new ConnectorError(
      `${connector.id} 请求失败：${error?.name === 'AbortError' ? `超过 ${seconds(limit)}` : redact(error?.message ?? error)}`,
    )
  } finally {
    clearTimeout(timer)
  }
  if (response.ok !== true) throw new ConnectorError(`${connector.id} 返回 HTTP ${response.status}`)
  return httpContract(connector, raw)
}

/**
 * Read the assistant text out of a chat response.
 * Accepts a chat-completion body, a bare `{ output, summary }` contract, or
 * plain text; anything empty is a failed node rather than an empty success.
 */
function httpContract(connector, raw) {
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    const text = String(raw).trim()
    if (text.length === 0) throw new ConnectorError(`${connector.id} 没有产生任何输出`)
    return { output: text, summary: text.split(/\r?\n/)[0].slice(0, 200) }
  }
  const content = payload?.choices?.[0]?.message?.content
  if (typeof content === 'string' && content.trim().length > 0) {
    const text = content.trim()
    return { output: text, summary: text.split(/\r?\n/)[0].slice(0, 200) }
  }
  const parsed = agentResultSchema.safeParse(payload)
  if (parsed.success) return { output: parsed.data.output, summary: parsed.data.summary }
  throw new ConnectorError(`${connector.id} 的响应里没有可用的文本内容`)
}

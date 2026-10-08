import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compile } from '../lib/shared/compiler.js'
import { graphSchema } from '../lib/host/schemas.js'
import { ConnectorError, ConnectorRegistry, DEFAULT_AGENT_TIMEOUT_MS } from './connectors.mjs'

/** Budget for a run that never calls an agent. Unchanged from before. */
const BASE_TIMEOUT_MS = 30_000
/** Local code is cheap; two at a time is plenty. */
const MAX_NORMAL_RUNS = 2
/**
 * An agent run is long and expensive, so it gets its own slot rather than
 * competing with local code for the two existing ones.
 */
const MAX_AGENT_RUNS = 1

const normalRuns = new Set()
const agentRuns = new Set()

/** Kill everything in flight; used by the server's shutdown path. */
export function stopAllRuns() {
  for (const child of [...normalRuns, ...agentRuns]) child.kill()
}

/**
 * Total budget for one run: the base, plus one per-node agent allowance.
 *
 * v0.1 rejects fan-out, so nodes never overlap and the sum is the honest
 * worst case rather than a guess.
 */
export function timeoutForGraph(graph, registry) {
  let total = BASE_TIMEOUT_MS
  for (const node of graph.nodes) {
    if (node.kind !== 'llm') continue
    total += registry?.timeoutFor(node.executor) ?? DEFAULT_AGENT_TIMEOUT_MS
  }
  return total
}

export function runGraph(value, { timeoutMs, registry, depth = 1 } = {}) {
  const graph = graphSchema.parse(value)
  const { script, order } = compile(graph)
  // A caller that supplies no registry gets an empty one, so "no connector is
  // configured" is worded in exactly one place.
  const connectors = registry ?? ConnectorRegistry.empty()
  const usesAgents = graph.nodes.some(node => node.kind === 'llm')
  const pool = usesAgents ? agentRuns : normalRuns
  const limit = usesAgents ? MAX_AGENT_RUNS : MAX_NORMAL_RUNS
  if (pool.size >= limit) {
    throw new Error(usesAgents
      ? '已有一个使用执行器的工作流正在运行，请稍后重试'
      : '已有两个工作流正在运行，请稍后重试')
  }
  const budget = timeoutMs ?? timeoutForGraph(graph, connectors)
  const runId = randomUUID()
  /**
   * Node id → connector id, kept beside the script instead of inside it. The
   * worker reports which node is asking by way of `opts.phase`, so the compiled
   * script — and therefore the options the Harness engine receives — is
   * untouched.
   */
  const executors = new Map(graph.nodes
    .filter(node => node.kind === 'llm')
    .map(node => [node.id, node.executor ?? undefined]))

  return new Promise(resolve => {
    const progress = []
    let agentsStarted = 0
    let finished = false

    /** One progress line. Never call it with prompt or response text. */
    const push = (kind, text) => {
      if (progress.length >= 2000) return
      progress.push({ seq: progress.length + 1, kind,
        ...(kind === 'phase' && order.includes(text) ? { nodeId: text } : {}), message: text })
    }

    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      execArgv: ['--max-old-space-size=128'], windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
      // Do not propagate Harness or provider credentials to local code. The
      // connector registry lives only in this process, and the worker never
      // sees a command line, an endpoint, or an environment value.
      env: Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    })
    pool.add(child)

    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      // Release the quota slot here, not only on `exit`. A killed child reports
      // its exit asynchronously, so with a single agent slot the next agent run
      // could be refused by a run that had already finished.
      pool.delete(child)
      child.kill()
      resolve({ runId, agentsStarted, progress, value: null, ...result })
    }
    const timer = setTimeout(() => finish({
      stopReason: 'cancelled', error: `执行超时（${budget / 1000} 秒），已终止独立执行进程`,
    }), budget)

    /**
     * Perform one agent step on the worker's behalf.
     * Only metadata goes into the progress log; the prompt and the response
     * body stay out of it, because that log is returned to the browser and kept
     * with the run record.
     */
    async function invokeAgent({ callId, nodeId, prompt }) {
      agentsStarted += 1
      const executor = executors.get(nodeId)
      push('log', `调用执行器 ${executor ?? '默认'}：${nodeId || '未知节点'}`)
      let reply
      try {
        const result = await connectors.callAgent({ prompt, executor, depth })
        push('log', `执行器 ${result.connectorId} 完成，用时 ${result.ms}ms，摘要 ${result.summary.slice(0, 80)}`)
        reply = { ok: true, value: { output: result.output, summary: result.summary } }
      } catch (error) {
        const message = error instanceof ConnectorError
          ? error.message
          : `执行器 ${executor ?? '默认'} 调用失败`
        push('log', `执行器失败：${message}`)
        reply = { ok: false, error: message }
      }
      if (finished || !child.connected) return
      child.send({ type: 'agent-reply', callId, ...reply })
    }

    child.on('message', message => {
      if (message.type === 'progress') push(message.kind, String(message.message).slice(0, 2000))
      else if (message.type === 'result') finish(message.result)
      else if (message.type === 'agent-invoke') void invokeAgent(message)
    })
    child.on('error', error => finish({ stopReason: 'error', error: error.message }))
    child.on('exit', (code, signal) => {
      pool.delete(child)
      finish({ stopReason: 'error', error: `执行进程退出：${signal ?? code}` })
    })
    child.send({ script }, error => { if (error) finish({ stopReason: 'error', error: error.message }) })
  })
}

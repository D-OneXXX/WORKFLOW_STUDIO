import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { compile } from '../lib/shared/compiler.js'
import { graphSchema } from '../lib/host/schemas.js'

const active = new Set()
export function stopAllRuns() { for (const child of active) child.kill() }

export function runGraph(value, { timeoutMs = 30_000 } = {}) {
  const graph = graphSchema.parse(value)
  const { script, order } = compile(graph)
  if (active.size >= 2) throw new Error('已有两个工作流正在运行，请稍后重试')
  const runId = randomUUID()
  return new Promise(resolve => {
    const progress = []
    let finished = false
    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      execArgv: ['--max-old-space-size=128'], windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'advanced',
      // Do not propagate Harness or provider credentials to local code.
      env: Object.fromEntries(['PATH', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE'].filter(k => process.env[k]).map(k => [k, process.env[k]])),
    })
    active.add(child)
    const finish = (result) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      child.kill()
      resolve({ runId, agentsStarted: 0, progress, value: null, ...result })
    }
    const timer = setTimeout(() => finish({ stopReason: 'cancelled', error: `执行超时（${timeoutMs / 1000} 秒），已终止独立执行进程` }), timeoutMs)
    child.on('message', message => {
      if (message.type === 'progress' && progress.length < 2000) {
        const text = String(message.message).slice(0, 2000)
        progress.push({ seq: progress.length + 1, kind: message.kind,
          ...(message.kind === 'phase' && order.includes(text) ? { nodeId: text } : {}), message: text })
      } else if (message.type === 'result') finish(message.result)
    })
    child.on('error', error => finish({ stopReason: 'error', error: error.message }))
    child.on('exit', (code, signal) => {
      active.delete(child)
      finish({ stopReason: 'error', error: `执行进程退出：${signal ?? code}` })
    })
    child.send({ script }, error => { if (error) finish({ stopReason: 'error', error: error.message }) })
  })
}

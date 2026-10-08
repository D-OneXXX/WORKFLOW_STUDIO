// A separate process bounds faults/time, not filesystem permissions.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let progressCount = 0
const send = value => { if (process.connected) process.send(value) }
const progress = kind => message => {
  if (progressCount++ < 2000) send({ type: 'progress', kind, message: String(message).slice(0, 2000) })
}

/** Agent calls waiting on the parent process to do the actual work. */
const pending = new Map()
let callSeq = 0

process.on('message', message => {
  if (message?.type !== 'agent-reply') return
  const settle = pending.get(message.callId)
  if (settle === undefined) return
  pending.delete(message.callId)
  if (message.ok) settle.resolve(message.value)
  else settle.reject(new Error(String(message.error ?? '执行器调用失败').slice(0, 4000)))
})

/**
 * The outbound agent step.
 *
 * This process holds no connector at all: no command line, no endpoint, no
 * credential. It asks the parent, which owns the registry, and gets back only a
 * result. That matters because the same process also runs untrusted user code
 * nodes, and its environment is a small whitelist for exactly that reason.
 *
 * The node id travels as `opts.phase`, which is already how this project names
 * a node in a progress marker, so the compiled script needs no extra field and
 * the Harness engine keeps receiving the options it documents.
 */
async function agent(prompt, opts) {
  if (!process.connected) {
    throw new Error('独立版尚未配置大模型连接器；请使用本地示例，Harness 接口将在后续阶段接入')
  }
  const nodeId = typeof opts?.phase === 'string' ? opts.phase : ''
  const callId = ++callSeq
  return await new Promise((resolve, reject) => {
    pending.set(callId, { resolve, reject })
    // Node hands the callback `null` on a *successful* send, so the guard has
    // to be falsy-checked. Testing `=== undefined` here rejects every call with
    // null the moment it is delivered, and the node fails with "null".
    process.send({ type: 'agent-invoke', callId, nodeId, prompt: String(prompt ?? '') }, error => {
      if (!error) return
      pending.delete(callId)
      reject(error)
    })
  })
}

process.once('message', async ({ script }) => {
  try {
    const execute = new AsyncFunction('agent', 'phase', 'log', 'args', script)
    const value = await execute(agent, progress('phase'), progress('log'), {})
    send({ type: 'result', result: { stopReason: 'completed', value } })
  } catch (error) {
    send({ type: 'result', result: { stopReason: 'error', error: String(error?.message ?? error).slice(0, 4000) } })
  }
})

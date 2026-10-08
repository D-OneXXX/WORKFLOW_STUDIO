// A separate process bounds faults/time, not filesystem permissions.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
let progressCount = 0
const send = value => { if (process.connected) process.send(value) }
const progress = kind => message => {
  if (progressCount++ < 2000) send({ type: 'progress', kind, message: String(message).slice(0, 2000) })
}
process.once('message', async ({ script }) => {
  try {
    const execute = new AsyncFunction('agent', 'phase', 'log', 'args', script)
    const value = await execute(
      async () => { throw new Error('独立版尚未配置大模型连接器；请使用本地示例，Harness 接口将在后续阶段接入') },
      progress('phase'), progress('log'), {},
    )
    send({ type: 'result', result: { stopReason: 'completed', value } })
  } catch (error) {
    send({ type: 'result', result: { stopReason: 'error', error: String(error?.message ?? error).slice(0, 4000) } })
  }
})

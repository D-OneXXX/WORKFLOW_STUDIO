/**
 * Phase B of the manager-mode plan: the inbound MCP server.
 *
 * The server is spawned as a real child process and driven over its actual
 * stdio, because the transport framing is part of what is being tested: one
 * JSON-RPC frame per line, nothing but frames on stdout, diagnostics on stderr.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const SERVER = join(ROOT, 'standalone', 'mcp.mjs')
const FAKE = 'tests/fixtures/agent-fake.mjs'
const PROGRAM = `"${process.execPath.replace(/\\/g, '/')}"`

/** Seed a data directory with two workflows and a fake CLI connector. */
async function fixture({ depth } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-mcp-'))
  const codeGraph = {
    nodes: [
      { id: 'in', kind: 'input', params: { input: 'seed' } },
      { id: 'shout', kind: 'code', params: { code: 'return `上了:${input}`' } },
      { id: 'out', kind: 'output' },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'shout' }, { id: 'e2', source: 'shout', target: 'out' }],
  }
  const agentGraph = {
    nodes: [
      { id: 'in', kind: 'input', params: { input: 'raw' } },
      { id: 'ask', kind: 'llm', executor: 'fake', params: { prompt: '处理 {{in}}' } },
      { id: 'out', kind: 'output' },
    ],
    edges: [{ id: 'e1', source: 'in', target: 'ask' }, { id: 'e2', source: 'ask', target: 'out' }],
  }
  // Distinct timestamps, so the newest-first ordering the tool promises is
  // deterministic rather than dependent on a stable-sort tie.
  const base = Date.now()
  const stamp = (offset) => new Date(base + offset).toISOString()
  await writeFile(join(dir, 'workflows.json'), JSON.stringify([
    { id: 'wf-code', name: '代码流程', graph: codeGraph, createdAt: stamp(0), updatedAt: stamp(0) },
    { id: 'wf-agent', name: '执行器流程', graph: agentGraph, createdAt: stamp(1_000), updatedAt: stamp(1_000) },
  ]))
  await writeFile(join(dir, 'connectors.json'), JSON.stringify({
    defaultConnector: 'fake',
    connectors: [{
      id: 'fake', kind: 'cli', command: `${PROGRAM} ${FAKE}`, args: ['--mode', 'json'],
      outputFormat: 'json', timeoutMs: 15_000,
    }],
  }))

  const child = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      WORKFLOW_STUDIO_DATA_DIR: dir,
      ...(depth === undefined ? {} : { WORKFLOW_STUDIO_DEPTH: String(depth) }),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  const stderr = []
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  /** Frames received, so a test can assert nothing unexpected was written. */
  const frames = []
  const waiters = new Map()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    let at = buffer.indexOf('\n')
    while (at >= 0) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.length > 0) frames.push(line)
      at = buffer.indexOf('\n')
    }
  })

  const session = { child, frames, stderr, badFrames: [], unmatched: [], nextId: 0, closed: false }

  /** Fire a notification. It must not be awaited: a reply would be a protocol bug. */
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`)
  }

  async function request(method, params) {
    const id = ++session.nextId
    const pending = new Promise((resolveFrame, rejectFrame) => {
      waiters.set(id, { resolve: resolveFrame, reject: rejectFrame })
      setTimeout(() => {
        if (waiters.has(id)) {
          waiters.delete(id)
          rejectFrame(new Error(`${method} 未在期限内响应`))
        }
      }, 20_000)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    return pending
  }

  // Route arriving frames to their waiting request. Anything unclaimed is kept
  // where a test can still see it, rather than silently dropped.
  const interval = setInterval(() => {
    while (frames.length > 0) {
      const raw = frames.shift()
      let message
      try {
        message = JSON.parse(raw)
      } catch {
        session.badFrames.push(raw)
        continue
      }
      const waiter = waiters.get(message.id)
      if (waiter === undefined) {
        session.unmatched.push(raw)
        continue
      }
      waiters.delete(message.id)
      waiter.resolve(message)
    }
  }, 5)

  const close = async () => {
    clearInterval(interval)
    if (session.closed) return
    session.closed = true
    child.stdin.end()
    await new Promise((done) => {
      child.once('close', done)
      setTimeout(() => { child.kill(); done() }, 3_000)
    })
  }

  return {
    dir, request, notify, close, frames, stderr, writeRaw: (text) => child.stdin.write(text),
    // Same array references the router appends to, so a test can inspect them.
    badFrames: session.badFrames, unmatched: session.unmatched,
  }
}

/** The standard initialize exchange, so each test starts from a live session. */
async function openSession(options) {
  const session = await fixture(options)
  const initialized = await session.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' },
  })
  // A notification must never be awaited: the server is correct to not reply.
  session.notify('notifications/initialized')
  await new Promise((done) => setTimeout(done, 50))
  return { session, initialized }
}

const callTool = (session, name, args) =>
  session.request('tools/call', { name, ...(args === undefined ? {} : { arguments: args }) })

const structured = (reply) => reply.result.structuredContent

test('the handshake reports a protocol version, capabilities and server info', async () => {
  const { session, initialized } = await openSession({})
  try {
    assert.equal(initialized.result.protocolVersion, '2025-06-18')
    assert.equal(initialized.result.serverInfo.name, 'dsh-workflow-studio')
    // The handshake version is read from package.json, so a release bump cannot
    // leave an agent being told a version that was never shipped.
    const { version } = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
    assert.equal(initialized.result.serverInfo.version, version)
    assert.ok(initialized.result.capabilities.tools, 'tools capability must be declared')
    assert.equal(initialized.error, undefined)
  } finally {
    await session.close()
  }
})

test('notifications get no reply, and tools/list exposes exactly the three tools', async () => {
  const { session } = await openSession({})
  try {
    const listed = await session.request('tools/list', {})
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['workflow.list', 'workflow.run', 'workflow.status'])
    for (const tool of listed.result.tools) {
      assert.equal(typeof tool.description, 'string')
      assert.ok(tool.description.length > 20, `${tool.name} needs a description an agent can act on`)
      assert.equal(tool.inputSchema.type, 'object')
    }
  } finally {
    await session.close()
  }
})

test('workflow.list returns the saved library', async () => {
  const { session } = await openSession({})
  try {
    const reply = await callTool(session, 'workflow.list')
    assert.equal(reply.result.isError, false)
    const names = structured(reply).workflows.map((row) => row.name)
    assert.deepEqual(names, ['执行器流程', '代码流程'])
    assert.equal(structured(reply).workflows[0].nodeCount, 3)
  } finally {
    await session.close()
  }
})

test('an agent client sees workflows the browser saved after the handshake', async () => {
  const { session } = await openSession({})
  try {
    assert.equal(structured(await callTool(session, 'workflow.list')).workflows.length, 2)

    // The operator keeps editing in the browser while this session stays open:
    // one workflow is added, the old ones are gone. A snapshot taken at startup
    // would show an agent a library that no longer exists.
    await writeFile(join(session.dir, 'workflows.json'), JSON.stringify([{
      id: 'wf-late',
      name: '后建的',
      graph: {
        nodes: [
          { id: 'in', kind: 'input', params: { input: 'x' } },
          { id: 'work', kind: 'code', params: { code: 'return input' } },
          { id: 'out', kind: 'output' },
        ],
        edges: [
          { id: 'e1', source: 'in', target: 'work' },
          { id: 'e2', source: 'work', target: 'out' },
        ],
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date(Date.now() + 5_000).toISOString(),
    }]))

    const after = structured(await callTool(session, 'workflow.list')).workflows
    assert.deepEqual(after.map((row) => row.name), ['后建的'])

    // The removal reaches workflow.run too, not only the list.
    const stale = await callTool(session, 'workflow.run', { id: 'wf-code' })
    assert.equal(stale.result.isError, true, 'a deleted workflow must not still run')
    assert.match(stale.result.content[0].text, /找不到要运行的工作流/)

    const added = structured(await callTool(session, 'workflow.run', { id: 'wf-late', input: '新值' }))
    assert.equal(added.status, 'completed')
    assert.equal(added.value.value, '新值')
  } finally {
    await session.close()
  }
})

test('workflow.run executes a saved workflow and can override its input', async () => {
  const { session } = await openSession({})
  try {
    const reply = await callTool(session, 'workflow.run', { id: 'wf-code', input: '注入值' })
    const value = structured(reply)
    assert.equal(value.status, 'completed', JSON.stringify(value.error))
    assert.equal(value.value.value, '上了:注入值', 'the input override must reach the run')
    assert.match(value.runId, /^[0-9a-f-]{36}$/)
  } finally {
    await session.close()
  }
})

test('workflow.run drives an agent node through the connector registry', async () => {
  const { session } = await openSession({})
  try {
    const reply = await callTool(session, 'workflow.run', { id: 'wf-agent', input: '数据' })
    const value = structured(reply)
    assert.equal(value.status, 'completed', JSON.stringify(value.error))
    // v0.4.1 interpolation plus the fake CLI echo: the agent saw the real value.
    assert.equal(value.value.value.output, 'handled: 处理 数据')
    assert.equal(value.agentsStarted, 1)
  } finally {
    await session.close()
  }
})

test('wait:false returns immediately and workflow.status reports the outcome', async () => {
  const { session } = await openSession({})
  try {
    const started = structured(await callTool(session, 'workflow.run', { id: 'wf-code', wait: false }))
    assert.equal(started.status, 'running')
    assert.equal(started.wait, false)

    let entry
    for (let attempt = 0; attempt < 40; attempt += 1) {
      entry = structured(await callTool(session, 'workflow.status', { runId: started.runId }))
      if (entry.status !== 'running') break
      await new Promise((done) => setTimeout(done, 100))
    }
    assert.equal(entry.status, 'completed', JSON.stringify(entry))
    assert.equal(entry.value.value, '上了:seed')
    assert.ok(entry.engineRunId, 'the engine run id should be recorded alongside ours')
  } finally {
    await session.close()
  }
})

test('an unknown runId is a tool result with isError, not a protocol error', async () => {
  const { session } = await openSession({})
  try {
    const reply = await callTool(session, 'workflow.status', { runId: 'nope' })
    assert.equal(reply.error, undefined, 'must not become a JSON-RPC error')
    assert.equal(reply.result.isError, true)
    assert.match(reply.result.content[0].text, /没有找到该 runId/)
  } finally {
    await session.close()
  }
})

test('a workflow that cannot be found is reported as a tool failure', async () => {
  const { session } = await openSession({})
  try {
    const reply = await callTool(session, 'workflow.run', { id: 'ghost' })
    assert.equal(reply.result.isError, true)
    assert.match(reply.result.content[0].text, /找不到要运行的工作流/)
  } finally {
    await session.close()
  }
})

test('protocol misuse uses JSON-RPC error codes', async () => {
  const { session } = await openSession({})
  try {
    const unknownMethod = await session.request('tools/launch', {})
    assert.equal(unknownMethod.error.code, -32601)

    const unknownTool = await session.request('tools/call', { name: 'workflow.delete', arguments: {} })
    assert.equal(unknownTool.error.code, -32602, 'an unknown tool name is an invalid request')

    session.writeRaw('this is not json\n')
    // The -32700 reply has id null, so no waiter claims it; it lands in unmatched.
    let malformed = null
    for (let attempt = 0; attempt < 40 && malformed === null; attempt += 1) {
      await new Promise((done) => setTimeout(done, 50))
      if (session.unmatched.length > 0) malformed = session.unmatched.shift()
    }
    assert.notEqual(malformed, null, 'a parse failure must be answered')
    assert.equal(JSON.parse(malformed).error.code, -32700)
    assert.equal(session.badFrames.length, 0, 'the server must not emit a non-JSON frame on stdout')
  } finally {
    await session.close()
  }
})

test('stdout carries only single-line frames and stderr carries the logs', async () => {
  const { session } = await openSession({})
  try {
    await callTool(session, 'workflow.list')
    const reply = await callTool(session, 'workflow.run', { id: 'wf-code' })
    // A value containing a newline must not split a frame.
    const newlineReply = await callTool(session, 'workflow.run', { id: 'wf-code', input: '两\n行' })
    assert.equal(newlineReply.result.isError, false)

    assert.ok(session.frames.every((frame) => !frame.includes('\n')), 'frames are line-delimited by construction')
    for (const frame of session.frames) JSON.parse(frame)
    assert.ok(!reply.result.structuredContent.value.value.includes('\n'))
    assert.ok(
      session.stderr.join('').includes('已连接数据目录'),
      `expected a startup log on stderr, got: ${session.stderr.join('')}`,
    )
  } finally {
    await session.close()
  }
})

test('the delegation cap refuses a run started by an agent that is already too deep', async () => {
  const { session } = await openSession({ depth: 3 })
  try {
    const reply = await callTool(session, 'workflow.run', { id: 'wf-code' })
    assert.equal(reply.result.isError, true)
    assert.match(reply.result.content[0].text, /委派深度已达上限 3 层/)
    // Reading is still allowed; only starting new work is capped.
    assert.equal((await callTool(session, 'workflow.list')).result.isError, false)
  } finally {
    await session.close()
  }
})

test('a run one level below the cap is still allowed', async () => {
  const { session } = await openSession({ depth: 2 })
  try {
    const reply = await callTool(session, 'workflow.run', { id: 'wf-code' })
    assert.equal(reply.result.structuredContent.status, 'completed')
  } finally {
    await session.close()
  }
})

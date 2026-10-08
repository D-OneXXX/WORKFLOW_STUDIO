/**
 * The `http` connector adapter: a cloud agent program, called outbound.
 *
 * Verified against a local stub rather than a real provider, because no model
 * key exists on this machine. The stub speaks the OpenAI-compatible shape the
 * adapter targets, and deliberately echoes a credential-shaped string in an
 * error body to prove that text never travels onward to a caller.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorRegistry } from '../standalone/connectors.mjs'

const SECRET = 'sk-TOPSECRET-123456787890'.slice(0, 24)

/**
 * Start a stub endpoint and a one-connector registry aimed at it.
 * @param respond - (request, response, body) how the stub should answer.
 * @param connector - extra fields merged into the connector entry.
 */
async function harness(respond, connector = {}) {
  const requests = []
  const sockets = new Set()
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({
        authorization: request.headers.authorization ?? null,
        depth: request.headers['x-workflow-depth'] ?? null,
        contentType: request.headers['content-type'] ?? null,
        body: body.length === 0 ? null : JSON.parse(body),
      })
      respond(request, response, body)
    })
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const url = `http://127.0.0.1:${port}/v1/chat`

  const dir = await mkdtemp(join(tmpdir(), 'wfs-http-'))
  await writeFile(join(dir, 'connectors.json'), JSON.stringify({
    defaultConnector: 'cloud',
    connectors: [{
      id: 'cloud', kind: 'http', url, model: 'test-model', apiKeyEnv: 'WFS_TEST_KEY', timeoutMs: 5_000,
      ...connector,
    }],
  }))
  process.env.WFS_TEST_KEY = SECRET
  const registry = await ConnectorRegistry.load(dir)

  async function close() {
    delete process.env.WFS_TEST_KEY
    // Sockets the client abandoned would otherwise keep `close()` pending.
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
  return { registry, requests, close, url }
}

const replies = (payload) => (request, response) => {
  response.writeHead(200, { 'content-type': 'application/json' })
  response.end(JSON.stringify(payload))
}

test('a chat completion becomes the { output, summary } contract', async () => {
  const ctx = await harness(replies({ choices: [{ message: { content: '第一段答案\n第二段细节' } }] }))
  try {
    const result = await ctx.registry.callAgent({ prompt: '做什么', depth: 1 })
    assert.equal(result.output, '第一段答案\n第二段细节')
    assert.equal(result.summary, '第一段答案', 'the first line becomes the summary')
    assert.equal(result.connectorId, 'cloud')

    const sent = ctx.requests[0]
    assert.equal(sent.authorization, `Bearer ${SECRET}`, 'the key comes from the named env var')
    assert.equal(sent.depth, '2', 'the callee sits one generation deeper')
    assert.equal(sent.contentType, 'application/json')
    assert.equal(sent.body.model, 'test-model')
    assert.deepEqual(sent.body.messages, [{ role: 'user', content: '做什么' }])
  } finally {
    await ctx.close()
  }
})

test('a response that already carries the contract is accepted', async () => {
  const ctx = await harness(replies({ output: { structured: true }, summary: '直接给了契约' }))
  try {
    const result = await ctx.registry.callAgent({ prompt: 'x' })
    assert.deepEqual(result.output, { structured: true })
    assert.equal(result.summary, '直接给了契约')
  } finally {
    await ctx.close()
  }
})

test('a plain-text body is wrapped rather than rejected', async () => {
  const ctx = await harness((request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('just words from the service')
  })
  try {
    assert.equal((await ctx.registry.callAgent({ prompt: 'x' })).output, 'just words from the service')
  } finally {
    await ctx.close()
  }
})

test('a non-2xx response fails the node without echoing the body', async () => {
  const ctx = await harness((request, response) => {
    response.writeHead(500, { 'content-type': 'application/json' })
    // A provider error body can echo the credential that was sent.
    response.end(JSON.stringify({ error: { message: `revoked key ${SECRET}` } }))
  })
  try {
    const error = await ctx.registry.callAgent({ prompt: 'x' }).catch((e) => e)
    assert.match(error.message, /返回 HTTP 500/)
    assert.ok(!error.message.includes(SECRET), 'the response body must not be surfaced')
  } finally {
    await ctx.close()
  }
})

test('an empty completion payload is a failure, not an empty success', async () => {
  const ctx = await harness(replies({ choices: [{ message: { content: '   ' } }] }))
  try {
    await assert.rejects(() => ctx.registry.callAgent({ prompt: 'x' }), /没有可用的文本内容/)
  } finally {
    await ctx.close()
  }
})

test('a missing key variable is reported by name, before any request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-http2-'))
  await writeFile(join(dir, 'connectors.json'), JSON.stringify({
    connectors: [{ id: 'cloud', kind: 'http', url: 'http://127.0.0.1:9/v1/chat', apiKeyEnv: 'WFS_ABSENT_KEY' }],
  }))
  const registry = await ConnectorRegistry.load(dir)
  delete process.env.WFS_ABSENT_KEY
  await assert.rejects(
    () => registry.callAgent({ prompt: 'x' }),
    /需要环境变量 WFS_ABSENT_KEY，当前未设置/,
  )
})

test('an endpoint that never answers is cut off at its own timeout', async () => {
  // Accepts the connection and stays silent.
  const ctx = await harness(() => undefined, { timeoutMs: 1_000 })
  try {
    const started = Date.now()
    await assert.rejects(() => ctx.registry.callAgent({ prompt: 'x' }), /请求失败：超过 1 秒/)
    assert.ok(Date.now() - started < 4_000, 'abandoned promptly rather than hanging')
  } finally {
    await ctx.close()
  }
})

test('an unreachable endpoint fails readably instead of throwing a raw cause', async () => {
  const ctx = await harness(replies({ choices: [{ message: { content: 'x' } }] }))
  try {
    const dir = await mkdtemp(join(tmpdir(), 'wfs-http3-'))
    await writeFile(join(dir, 'connectors.json'), JSON.stringify({
      connectors: [{ id: 'dead', kind: 'http', url: 'http://127.0.0.1:9/v1/chat', timeoutMs: 3_000 }],
    }))
    const registry = await ConnectorRegistry.load(dir)
    const error = await registry.callAgent({ prompt: 'x' }).catch((e) => e)
    assert.match(error.message, /^dead 请求失败：/)
  } finally {
    await ctx.close()
  }
})

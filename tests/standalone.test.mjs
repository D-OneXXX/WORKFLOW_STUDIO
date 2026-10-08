import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkflowStore, parseInterchange } from '../standalone/store.mjs'
import { runGraph } from '../standalone/runner.mjs'
import { createStudioServer } from '../standalone/server.mjs'

const graph = (code = 'return input.toUpperCase()') => ({
  nodes: [{ id: 'input', kind: 'input', params: { input: 'hello' } },
    { id: 'code', kind: 'code', params: { code } }, { id: 'output', kind: 'output' }],
  edges: [{ id: 'a', source: 'input', target: 'code' }, { id: 'b', source: 'code', target: 'output' }],
})

test('records survive reopen; export/import preserves graph with new identity', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-'))
  try {
    const store = await WorkflowStore.open(dir)
    const saved = await store.save({ name: '测试', graph: graph() })
    const reopened = await WorkflowStore.open(dir)
    assert.equal(reopened.list()[0].id, saved.id)
    const exported = reopened.export(saved.id)
    const imported = await reopened.import(exported)
    assert.notEqual(imported.id, saved.id)
    assert.deepEqual(reopened.load(imported.id).graph, graph())
    assert.equal(reopened.list().length, 2)
    await reopened.remove(saved.id)
    assert.equal((await WorkflowStore.open(dir)).list().length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('invalid or future interchange documents are rejected', () => {
  assert.throws(() => parseInterchange({ format: 'dsh-workflow-studio', version: 2, workflow: { name: 'x', graph: graph() } }))
  assert.throws(() => parseInterchange({ format: 'dsh-workflow-studio', version: 1, workflow: { name: 'x', graph: { nodes: [], edges: [] } } }))
})

test('real subprocess executes code and records phases', async () => {
  const result = await runGraph(graph())
  assert.equal(result.stopReason, 'completed')
  assert.equal(result.value.value, 'HELLO')
  assert.ok(result.progress.some(p => p.nodeId === 'code'))
})

test('independent false-arm output returns the output that actually ran', async () => {
  const input = { nodes: [
    { id: 'input', kind: 'input', params: { input: 'short' } },
    { id: 'branch', kind: 'branch', params: { condition: { type: 'len_gt', value: '500' } } },
    { id: 'yes', kind: 'output' }, { id: 'no', kind: 'output' },
  ], edges: [
    { id: 'a', source: 'input', target: 'branch' },
    { id: 'b', source: 'branch', target: 'yes', sourceHandle: 'true' },
    { id: 'c', source: 'branch', target: 'no', sourceHandle: 'false' },
  ] }
  const result = await runGraph(input)
  assert.deepEqual(result.value, { value: 'short', output: 'no' })
})

test('infinite loop is terminated; next run still works', async () => {
  const result = await runGraph(graph('while (true) {}'), { timeoutMs: 400 })
  assert.equal(result.stopReason, 'cancelled')
  assert.match(result.error, /超时/)
  assert.equal((await runGraph(graph())).stopReason, 'completed')
})

test('LLM node reports unavailable connector instead of simulated output', async () => {
  const input = graph()
  input.nodes[1] = { id: 'code', kind: 'llm', params: { prompt: '{{input}}' } }
  const result = await runGraph(input)
  assert.equal(result.stopReason, 'error')
  assert.match(result.error, /大模型连接器/)
})

test('HTTP persists workflows and rejects cross-origin and missing-header mutations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-http-'))
  const app = await createStudioServer({ dataDir: dir })
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${app.server.address().port}`
  const request = (method, body, extra = {}) => fetch(`${base}/api/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-workflow-studio': '1', ...extra }, body: JSON.stringify(body),
  })
  try {
    assert.equal((await request('save', { name: 'x', graph: graph() }, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await request('list', {}, { 'x-workflow-studio': '' })).status, 403)
    const saved = await (await request('save', { name: 'x', graph: graph() })).json()
    assert.equal(saved.ok, true)
    const rows = await (await request('list', {})).json()
    assert.equal(rows.value[0].id, saved.value.id)
    assert.equal((await request('run', { graph: graph() }).then(r => r.json())).value.value.value, 'HELLO')
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }) }
})

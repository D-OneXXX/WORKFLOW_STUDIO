/**
 * Phase A of the manager-mode plan: outbound connectors.
 *
 * Everything runs against `tests/fixtures/agent-fake.mjs`, a stand-in agent CLI,
 * so no model quota is spent. The fixtures exist mainly to prove the security
 * posture the standalone stage started with still holds now that the server can
 * spawn real programs: a connector's command line, endpoint and environment
 * never reach the worker, which also executes untrusted user code.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConnectorRegistry, ConnectorError, MAX_DELEGATION_DEPTH } from '../standalone/connectors.mjs'
import { runGraph, timeoutForGraph } from '../standalone/runner.mjs'
import { WorkflowStore } from '../standalone/store.mjs'

const FAKE = 'tests/fixtures/agent-fake.mjs'
/** Quoted on purpose: a program path may contain spaces. */
const PROGRAM = `"${process.execPath.replace(/\\/g, '/')}"`

/** Build a registry in a throwaway data directory from mode names. */
async function registryFor(modes, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-conn-'))
  const connectors = Object.entries(modes).map(([id, mode]) => ({
    id,
    kind: 'cli',
    command: `${PROGRAM} ${FAKE}`,
    args: ['--mode', mode],
    timeoutMs: 4_000,
    ...(mode === 'text' || mode === 'empty' ? {} : { outputFormat: 'json' }),
    ...(extra[id] ?? {}),
  }))
  await writeFile(join(dir, 'connectors.json'), JSON.stringify({ defaultConnector: connectors[0].id, connectors }))
  return ConnectorRegistry.load(dir)
}

const llmGraph = (executor, prompt = 'summarise the text above') => ({
  nodes: [
    { id: 'input', kind: 'input', params: { input: 'hello' } },
    { id: 'agent', kind: 'llm', params: { prompt }, ...(executor ? { executor } : {}) },
    { id: 'output', kind: 'output' },
  ],
  edges: [{ id: 'a', source: 'input', target: 'agent' }, { id: 'b', source: 'agent', target: 'output' }],
})

test('a cli connector returns the { output, summary } contract', async () => {
  const registry = await registryFor({ json: 'json' })
  const result = await registry.callAgent({ prompt: 'task one', executor: 'json', depth: 1 })
  assert.equal(result.output, 'handled: task one')
  assert.equal(result.summary, 'fake agent finished')
  assert.equal(result.connectorId, 'json')
})

test('text output is wrapped into the contract, first line becomes the summary', async () => {
  const registry = await registryFor({ text: 'text' })
  const result = await registry.callAgent({ prompt: 'x', executor: 'text', depth: 1 })
  assert.match(result.output, /second line/)
  assert.equal(result.summary, 'first line is the summary')
})

test('a response missing `summary` fails the contract instead of passing through', async () => {
  const registry = await registryFor({ garbage: 'garbage' })
  await assert.rejects(
    () => registry.callAgent({ prompt: 'x', executor: 'garbage', depth: 1 }),
    /契约/,
  )
})

test('an agent that prints nothing is a failure, not an empty success', async () => {
  const registry = await registryFor({ empty: 'empty' })
  await assert.rejects(() => registry.callAgent({ prompt: 'x', executor: 'empty', depth: 1 }), /没有产生任何输出/)
})

test('a failing agent reports its exit code with credential-shaped stderr redacted', async () => {
  const registry = await registryFor({ fail: 'fail' })
  await assert.rejects(
    () => registry.callAgent({ prompt: 'x', executor: 'fail', depth: 1 }),
    (error) => {
      assert.match(error.message, /退出码 3/)
      assert.ok(!error.message.includes('LEAKME-1234567890'), 'the api key must not survive redaction')
      assert.match(error.message, /api_key=\[redacted\]/)
      return true
    },
  )
})

test('an agent that overruns its own timeout is killed', async () => {
  const registry = await registryFor({ slow: 'slow' }, { slow: { timeoutMs: 1_000 } })
  const started = Date.now()
  await assert.rejects(
    () => registry.callAgent({ prompt: 'x', executor: 'slow', depth: 1 }),
    /执行超过 1\.5 秒|执行超过 1 秒/,
  )
  const elapsed = Date.now() - started
  assert.ok(elapsed < 3_000, `killed promptly, took ${elapsed}ms`)
})

test('promptVia "arg" hands the prompt as an argument rather than on stdin', async () => {
  const registry = await registryFor({ byArg: 'prompt-arg' }, { byArg: { promptVia: 'arg' } })
  const result = await registry.callAgent({ prompt: 'passed-as-arg', executor: 'byArg', depth: 1 })
  assert.equal(result.output, 'arg: passed-as-arg')
})

test('delegation deeper than the cap is refused before anything spawns', async () => {
  const registry = await registryFor({ json: 'json' })
  await assert.rejects(
    () => registry.callAgent({ prompt: 'x', executor: 'json', depth: MAX_DELEGATION_DEPTH + 1 }),
    /委派深度已达上限 3 层/,
  )
})

test('an mcp connector is recognised but not yet implemented', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-kinds-'))
  await writeFile(join(dir, 'connectors.json'), JSON.stringify({ connectors: [
    { id: 'harness', kind: 'mcp', command: 'harness-mcp-bridge' },
  ] }))
  const registry = await ConnectorRegistry.load(dir)
  // The kind is known to the schema, so it survives loading and only fails when
  // actually invoked — with a message that says which stage owns it.
  assert.deepEqual(registry.listPublic().connectors, [{ id: 'harness', kind: 'mcp', label: 'harness' }])
  await assert.rejects(
    () => registry.callAgent({ prompt: 'x', executor: 'harness' }),
    /mcp 适配器尚未实现/,
  )
})

test('a connector is rejected when a required field for its kind is missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-kinds2-'))
  await writeFile(join(dir, 'connectors.json'), JSON.stringify({ connectors: [{ id: 'bad', kind: 'http' }] }))
  await assert.rejects(() => ConnectorRegistry.load(dir), /http 连接器 bad 缺少 url/)
})

test('an unconfigured deployment still says so rather than simulating output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-none-'))
  const registry = await ConnectorRegistry.load(dir)
  assert.deepEqual(registry.listPublic(), { defaultId: null, connectors: [] })
  await assert.rejects(
    () => registry.callAgent({ prompt: 'x' }),
    /尚未配置大模型连接器/,
  )
})

test('listPublic exposes no command line, endpoint, or environment', async () => {
  const registry = await registryFor({ json: 'json' }, { json: { env: { API_KEY: 'DO-NOT-LEAK' } } })
  const publicView = JSON.stringify(registry.listPublic())
  assert.ok(!publicView.includes('DO-NOT-LEAK'), 'connector env must stay server-side')
  assert.ok(!publicView.includes('agent-fake'), 'command line must stay server-side')
  assert.ok(!publicView.includes('ProgramMain'), 'program path must stay server-side')
})

test('a connector env value reaches the agent, and so does the delegation depth', async () => {
  const registry = await registryFor({ probe: 'env' }, { probe: { env: { WORKFLOW_STUDIO_TEST_SECRET: 'agent-only-secret' } } })
  const result = await registry.callAgent({ prompt: 'x', executor: 'probe', depth: 2 })
  assert.equal(result.output.secret, 'agent-only-secret', 'opted-in env reaches the agent')
  assert.equal(result.output.depth, '3', 'the agent sees one generation deeper')
  assert.equal(result.output.harnessToken, null, 'the parent process token must not be inherited')
})

test('the worker never sees connector secrets, even though it runs user code', async () => {
  const registry = await registryFor({ json: 'json' }, { json: { env: { WORKFLOW_STUDIO_TEST_SECRET: 'server-side-only' } } })
  process.env.HARNESS_PROVIDER_TOKEN = 'parent-only'
  try {
    // A code node can read the worker's own environment: `process` is a global
    // there. This is exactly why credentials stay in the parent process.
    const graph = {
      nodes: [
        { id: 'input', kind: 'input', params: { input: 'hello' } },
        { id: 'agent', kind: 'llm', params: { prompt: '{{input}}' } },
        { id: 'spy', kind: 'code', params: { code: 'return Object.keys(process.env).sort().join(",")' } },
        { id: 'output', kind: 'output' },
      ],
      edges: [
        { id: 'a', source: 'input', target: 'agent' },
        { id: 'b', source: 'agent', target: 'spy' },
        { id: 'c', source: 'spy', target: 'output' },
      ],
    }
    const result = await runGraph(graph, { registry })
    assert.equal(result.stopReason, 'completed', result.error ?? '')
    const workerEnv = String(result.value.value)
    assert.ok(!workerEnv.includes('WORKFLOW_STUDIO_TEST_SECRET'), 'connector env leaked into the worker')
    assert.ok(!workerEnv.includes('HARNESS_PROVIDER_TOKEN'), 'parent credential leaked into the worker')
    assert.equal(result.agentsStarted, 1)
  } finally {
    delete process.env.HARNESS_PROVIDER_TOKEN
  }
})

test('an agent node runs end to end and its prompt text stays out of the log', async () => {
  const registry = await registryFor({ json: 'json' })
  const result = await runGraph(llmGraph('json'), { registry })
  assert.equal(result.stopReason, 'completed', result.error ?? '')
  // The run value is `{ value, output }`: the node's result, and the id of the
  // output node that produced it. The agent step hands on its contract object.
  assert.equal(result.value.output, 'output')
  assert.deepEqual(result.value.value, { output: 'handled: summarise the text above', summary: 'fake agent finished' })
  assert.equal(result.agentsStarted, 1)
  const log = JSON.stringify(result.progress)
  assert.ok(!log.includes('summarise'), 'the prompt text must not be logged')
  assert.ok(!log.includes('handled:'), 'the agent response body must not be logged')
  assert.match(log, /调用执行器 json：agent/)
})

/**
 * The gap that made this whole path half-useless: before v0.4.1 the compiler
 * JSON-stringified an llm prompt, so `{{node-id}}` reached the agent as the
 * literal variable name (`input_n`) instead of the upstream value. Kept here as
 * an end-to-end assertion through a real connector call, with the compiler-level
 * coverage in `tests/compiler.test.mjs`.
 */
test('an llm prompt interpolates the upstream value through the connector', async () => {
  const registry = await registryFor({ json: 'json' })
  const result = await runGraph(llmGraph('json', 'say {{input}}'), { registry })
  assert.equal(result.stopReason, 'completed', result.error ?? '')
  assert.equal(result.value.value.output, 'handled: say hello')
})

test('an unresolvable connector fails the run with a readable reason', async () => {
  const registry = await registryFor({ json: 'json' })
  const result = await runGraph(llmGraph('nope'), { registry })
  assert.equal(result.stopReason, 'error')
  assert.match(result.error, /找不到执行器连接器 "nope"/)
})

test('the run budget grows by each agent node and leaves code-only runs at 30s', async () => {
  const registry = await registryFor({ json: 'json' }, { json: { timeoutMs: 1_500 } })
  assert.equal(timeoutForGraph(llmGraph('json'), registry), 30_000 + 1_500)
  const twoAgents = {
    nodes: [
      { id: 'input', kind: 'input', params: { input: 'x' } },
      { id: 'a1', kind: 'llm', executor: 'json' },
      { id: 'a2', kind: 'llm', executor: 'json' },
      { id: 'output', kind: 'output' },
    ],
    edges: [
      { id: 'e1', source: 'input', target: 'a1' },
      { id: 'e2', source: 'a1', target: 'a2' },
      { id: 'e3', source: 'a2', target: 'output' },
    ],
  }
  assert.equal(timeoutForGraph(twoAgents, registry), 30_000 + 3_000)
  const codeOnly = {
    nodes: [{ id: 'input', kind: 'input', params: { input: 'x' } }, { id: 'output', kind: 'output' }],
    edges: [{ id: 'e', source: 'input', target: 'output' }],
  }
  assert.equal(timeoutForGraph(codeOnly, registry), 30_000)
})

test('an agent run gets its own slot instead of consuming a code slot', async () => {
  const registry = await registryFor({ slow: 'slow', json: 'json' }, { slow: { timeoutMs: 3_000 } })
  const first = runGraph(llmGraph('slow'), { registry })
  await new Promise(resolve => setTimeout(resolve, 300))
  // Same quota bucket: a second agent run is refused while the first sleeps.
  assert.throws(() => runGraph(llmGraph('slow'), { registry }), /使用执行器的工作流正在运行/)
  // A plain code run must not be blocked by the agent slot. If another test
  // file happens to hold both code slots at this instant, that is contention
  // for the *code* bucket, which is not what this test is about.
  const codeOnly = {
    nodes: [{ id: 'input', kind: 'input', params: { input: 'x' } }, { id: 'output', kind: 'output' }],
    edges: [{ id: 'e', source: 'input', target: 'output' }],
  }
  let codeError
  try {
    assert.equal((await runGraph(codeOnly, { registry })).stopReason, 'completed')
  } catch (error) {
    codeError = error
    assert.ok(!/使用执行器/.test(codeError.message), 'the agent slot must not gate code runs')
  }
  const settled = await first
  assert.equal(settled.stopReason, 'error')
  assert.match(settled.error, /执行超过 3 秒/)
})

test('node.executor survives save, export and import as a version-1 document', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-store-'))
  const store = await WorkflowStore.open(dir)
  const saved = await store.save({ name: '绑定执行器', graph: llmGraph('codex-local') })
  const loaded = store.load(saved.id)
  assert.equal(loaded.graph.nodes[1].executor, 'codex-local')
  const document = store.export(saved.id)
  assert.equal(document.version, 1, 'an optional field is not a schema revision')
  const reimported = await store.import(document)
  const record = store.load(reimported.id)
  assert.equal(record.graph.nodes[1].executor, 'codex-local')
})

test('a connector file that is malformed fails loudly at load, not half-working', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-bad-'))
  await writeFile(join(dir, 'connectors.json'), '{ not json')
  await assert.rejects(() => ConnectorRegistry.load(dir), /连接器配置无效/)

  await writeFile(join(dir, 'connectors.json'), JSON.stringify({ connectors: [{ id: 'x', kind: 'cli' }] }))
  await assert.rejects(() => ConnectorRegistry.load(dir), /缺少 command/)

  await writeFile(join(dir, 'connectors.json'), JSON.stringify({
    defaultConnector: 'ghost', connectors: [{ id: 'x', kind: 'cli', command: 'node' }],
  }))
  await assert.rejects(() => ConnectorRegistry.load(dir), /不在 connectors 列表里/)
})

test('ConnectorError is the only failure type an agent step raises', async () => {
  const registry = await registryFor({ json: 'json' })
  const error = await registry.callAgent({ prompt: 'x', executor: 'missing' }).catch(e => e)
  assert.ok(error instanceof ConnectorError, `got ${error?.constructor?.name}`)
  assert.equal(error.name, 'ConnectorError')
})

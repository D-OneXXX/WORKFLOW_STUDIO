/**
 * The explicit round-chain spec, §7 acceptance.
 *
 * The claim this file exists to defend is the spec's central one: a repetition is
 * **drawn**, not configured, so nothing about running it is new. The official
 * template therefore has to compile like any hand-drawn chain, run under a fake
 * CLI with no connector bound per node, survive a save with its groups attached,
 * and stay byte-identical at the compiled level however the canvas happens to be
 * folded.
 *
 * No model quota is spent here: every agent step goes through
 * `tests/fixtures/agent-fake.mjs`.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { compile } from '../lib/shared/compiler.js'
import {
  EXTRA_TEMPLATES,
  ROUND_CHAIN_DESCRIPTION,
  ROUND_CHAIN_NAME,
  roundChainGraph,
} from '../lib/shared/sample.js'
import {
  copySelection,
  foldView,
  groupSelection,
  isGroupBlock,
  mergeWorkflow,
  paste,
  setCollapsed,
  unknownExecutors,
} from '../lib/shared/graph-edit.js'
import { graphSchema } from '../lib/host/schemas.js'
import { ConnectorRegistry } from '../standalone/connectors.mjs'
import { runGraph } from '../standalone/runner.mjs'
import { WorkflowStore } from '../standalone/store.mjs'

const PROGRAM = `"${process.execPath.replace(/\\/g, '/')}"`

/** What the panel passes as the group's fallback title, in the active locale. */
const roundTitle = (round) => `第 ${round} 轮`

/** A registry whose default connector is the fake CLI, so no model is called. */
async function fakeRegistry() {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-chain-'))
  const connectors = [{
    id: 'fake',
    kind: 'cli',
    command: `${PROGRAM} tests/fixtures/agent-fake.mjs`,
    args: ['--mode', 'json'],
    timeoutMs: 4_000,
    outputFormat: 'json',
  }]
  await writeFile(join(dir, 'connectors.json'), JSON.stringify({ defaultConnector: 'fake', connectors }))
  return { registry: await ConnectorRegistry.load(dir), dir }
}

test('the official template is a listable, schema-valid, compilable chain', () => {
  const graph = roundChainGraph()
  assert.deepEqual(EXTRA_TEMPLATES.map((template) => template.name), [ROUND_CHAIN_NAME])
  assert.equal(EXTRA_TEMPLATES[0].description, ROUND_CHAIN_DESCRIPTION)

  // The validator is what a save goes through, and it strips anything it does not
  // declare — so passing it is also proof nothing was silently dropped.
  const parsed = graphSchema.parse(graph)
  assert.deepEqual(parsed.nodes.map((node) => node.id), ['topic', 'round1', 'round2', 'judge', 'round3', 'out'])

  const { order, outputId } = compile(graph)
  assert.deepEqual(order, ['topic', 'round1', 'round2', 'judge', 'round3', 'out'])
  assert.equal(outputId, 'out', 'both arms rejoin at the one output node')
})

test('every round ships its plain words and its formal config, and binds no connector', () => {
  const graph = roundChainGraph()
  const described = graph.nodes.filter((node) => node.params?.description !== undefined)
  assert.equal(described.length, 4, 'the three rounds and the judge all carry a description')
  for (const node of described) {
    // `descriptionApplied` equal to `description` is what keeps the panel from
    // opening with every node flagged 待重新生成.
    assert.equal(node.params.descriptionApplied, node.params.description, node.id)
    assert.ok(node.params.description.length > 0)
  }
  // The formal fields are filled in too, which is why the template runs untouched.
  for (const node of graph.nodes.filter((row) => row.kind === 'llm')) {
    assert.ok((node.params?.prompt ?? '').length > 0, `${node.id} has a prompt`)
  }
  assert.deepEqual(graph.nodes.find((node) => node.kind === 'branch')?.params?.condition, {
    type: 'len_gt', value: '500',
  })
  assert.equal(
    graph.nodes.some((node) => node.executor !== undefined),
    false,
    'binding a connector id here would fail on a machine that has never installed it',
  )
})

test('descriptions change nothing at run time: the script is the same without them', () => {
  const withWords = compile(roundChainGraph()).script
  const stripped = structuredClone(roundChainGraph())
  for (const node of stripped.nodes) {
    if (node.params === undefined) continue
    delete node.params.description
    delete node.params.descriptionApplied
  }
  assert.equal(compile(stripped).script, withWords)
})

test('the template runs its three rounds against a fake CLI', async () => {
  const { registry, dir } = await fakeRegistry()
  try {
    const result = await runGraph(roundChainGraph(), { registry })
    assert.equal(result.stopReason, 'completed', result.error ?? '')
    assert.equal(result.agentsStarted, 3, 'one agent step per drawn round')
    const phases = result.progress.filter((row) => row.kind === 'phase').map((row) => row.message)
    assert.deepEqual(phases, ['compile', 'round1', 'round2', 'round3', 'out'])
    assert.equal(result.value.output, 'out', 'the run reports which output node produced the value')
    assert.match(String(result.value.value.output), /润色/, 'the value is the polish round reply')
    // Every round went through the deployment default: the log names no per-node
    // executor, and the connector that answered is the registry's default one.
    assert.equal(result.progress.filter((row) => /调用执行器 默认/.test(row.message ?? '')).length, 3)
    assert.equal(result.progress.filter((row) => /执行器 fake 完成/.test(row.message ?? '')).length, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the other arm runs too: judge true ends the chain at the output', async () => {
  const { registry, dir } = await fakeRegistry()
  try {
    const graph = roundChainGraph()
    // Same node set, same wires, condition pointed the other way. The upstream
    // text is short, so this arm is the one a real model would also take.
    graph.nodes.find((node) => node.kind === 'branch').params.condition = { type: 'len_lt', value: '500' }
    const result = await runGraph(graph, { registry })
    assert.equal(result.stopReason, 'completed', result.error ?? '')
    assert.equal(result.agentsStarted, 2, 'the polish round is not reached')
    const phases = result.progress.filter((row) => row.kind === 'phase').map((row) => row.message)
    assert.deepEqual(phases, ['compile', 'round1', 'round2', 'out'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the judge measures the reply: a long draft exits the chain early', async () => {
  const { registry, dir } = await fakeRegistry()
  try {
    const graph = roundChainGraph()
    // 3000 characters in, and the fake CLI echoes its prompt, so round 2 answers
    // well past the 500 threshold. This is the case the compiler used to miss: the
    // branch was handed the { output, summary } object and compared 15 characters.
    graph.nodes[0].params.input = '长'.repeat(3000)
    const result = await runGraph(graph, { registry })
    assert.equal(result.stopReason, 'completed', result.error ?? '')
    assert.equal(result.agentsStarted, 2, 'the polish round is skipped once the text is long enough')
    const phases = result.progress.filter((row) => row.kind === 'phase').map((row) => row.message)
    assert.deepEqual(phases, ['compile', 'round1', 'round2', 'out'])
    assert.match(String(result.value.value.output), /批评/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('groups and membership are stored, not just drawn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'wfs-store-'))
  try {
    const store = await WorkflowStore.open(dir)
    const graph = groupSelection(roundChainGraph(), ['round1', 'round2'], roundTitle).graph
    const groupId = graph.groups[0].id
    assert.equal(graph.nodes.filter((node) => node.groupId === groupId).length, 2)

    const saved = await store.save({ name: ROUND_CHAIN_NAME, graph })
    // A second `open`: each store instance reads the file once.
    const reloaded = (await WorkflowStore.open(dir)).load(saved.id)
    assert.equal(reloaded.graph.groups.length, 1, 'the group list survived')
    assert.equal(reloaded.graph.groups[0].id, groupId)
    assert.equal(reloaded.graph.groups[0].collapsed, true)
    assert.deepEqual(
      reloaded.graph.nodes.filter((node) => node.groupId === groupId).map((node) => node.id),
      ['round1', 'round2'],
    )
    assert.equal(reloaded.graph.nodes.find((node) => node.id === 'topic').groupId, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('folding the rounds is a view: the same script either way', () => {
  const graph = roundChainGraph()
  const grouped = groupSelection(graph, ['round1', 'round2'], roundTitle).graph
  const folded = setCollapsed(grouped, grouped.groups[0].id, true)
  const expanded = setCollapsed(grouped, grouped.groups[0].id, false)

  assert.equal(compile(folded).script, compile(graph).script)
  assert.equal(compile(folded).script, compile(expanded).script)

  const view = foldView(folded)
  const blocks = view.nodes.filter(isGroupBlock)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].count, 2)
  assert.deepEqual(
    view.nodes.filter((node) => !isGroupBlock(node)).map((node) => node.id),
    ['topic', 'judge', 'round3', 'out'],
  )
  // topic → round1 and round2 → judge converge on the block; the wire between the
  // two rounds is internal and vanishes.
  assert.deepEqual(
    view.edges.filter((edge) => edge.source === blocks[0].id || edge.target === blocks[0].id)
      .map((edge) => `${edge.source}->${edge.target}`).sort(),
    [`group:${grouped.groups[0].id}->judge`, `topic->group:${grouped.groups[0].id}`],
  )
})

test('importing the template next to itself keeps one input and warns about nothing', () => {
  const current = roundChainGraph()
  const merged = mergeWorkflow(current, roundChainGraph())
  assert.equal(merged.droppedInputs, 1, 'a second input node would make the graph uncompilable')
  assert.equal(merged.graph.nodes.filter((node) => node.kind === 'input').length, 1)
  assert.equal(merged.graph.nodes.length, 11, 'six nodes minus the dropped input')
  assert.deepEqual(merged.entries.length, 1, 'one node is where the existing chain should connect')
  // The template binds no connector, so an import onto any machine is clean.
  assert.deepEqual(unknownExecutors(merged.graph, ['fake']), [])
  assert.throws(() => compile(merged.graph), /不连通/, 'an unwired import is refused, not silently run')
})

test('a pasted round that names a missing connector is reported, and still fails loudly', () => {
  const graph = roundChainGraph()
  const clipboard = copySelection(graph, ['round1', 'round2'])
  clipboard.nodes = clipboard.nodes.map((node) => ({ ...node, executor: 'expensive' }))
  const result = paste(graph, clipboard)
  assert.deepEqual(
    unknownExecutors(result.graph, ['fake']).map((row) => row.executor),
    ['expensive', 'expensive'],
    'both pasted rounds are reported by name at the moment they appear',
  )
})

test('a missing connector is never quietly replaced by one that happens to exist', async () => {
  const { registry, dir } = await fakeRegistry()
  try {
    const graph = roundChainGraph()
    graph.nodes.find((node) => node.id === 'round1').executor = 'expensive'
    const result = await runGraph(graph, { registry })
    assert.equal(result.stopReason, 'error')
    assert.match(result.error, /找不到执行器连接器 "expensive"/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

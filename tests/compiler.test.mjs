/**
 * Compiler tests: accepted shapes, every §5 rejection case, and a live
 * double-branch execution of the compiled script in a sandbox.
 *
 * Run with `npm test`, which builds `lib/` first so these import real output.
 * The file is executed directly rather than through `node --test`: the test
 * runner spawns a child process per file, which the DSH file sandbox denies.
 * `scripts/test.mjs` runs every `tests/*.test.mjs` in this process.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { compile, CompileError, CONDITION_LABEL } from '../lib/shared/compiler.js'

/** Build a graph from terse node/edge tuples. */
function graph(nodes, edges) {
  return {
    nodes: nodes.map((node) => (typeof node === 'string' ? { id: node, kind: 'code' } : node)),
    edges: edges.map((edge, index) => ({
      id: `e${index}`,
      source: edge[0],
      target: edge[1],
      sourceHandle: edge[2] ?? null,
    })),
  }
}

/** Expect `compile` to reject with a message containing `fragment`. */
function rejects(input, fragment) {
  assert.throws(
    () => compile(input),
    (error) => {
      assert.ok(error instanceof CompileError, `expected CompileError, got ${error}`)
      assert.ok(
        error.message.includes(fragment),
        `expected message to contain ${JSON.stringify(fragment)}, got ${JSON.stringify(error.message)}`,
      )
      return true
    },
  )
}

/**
 * Execute a compiled script body the way the workflow guest would, with
 * controllable `agent` responses.
 * @returns the script's returned value plus the recorded progress markers.
 */
async function runScript(script, { respond = () => 'stub' } = {}) {
  const phases = []
  const logs = []
  const body = `${script}\n`
  const factory = new Function(
    'agent',
    'phase',
    'log',
    'parallel',
    'pipeline',
    'args',
    `return (async () => {\n${body}})()`,
  )
  const agent = async (prompt, options) => respond(prompt, options)
  const phase = (title) => phases.push(title)
  const log = (message) => logs.push(message)
  const value = await factory(agent, phase, log, undefined, undefined, undefined)
  return { value, phases, logs }
}

test('linear chain compiles and executes', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'hello world' } },
        { id: 'step-1', kind: 'code', params: { code: 'return input.toUpperCase()' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'step-1'],
        ['step-1', 'out'],
      ],
    ),
  )
  assert.deepEqual(result.order, ['in', 'step-1', 'out'])
  assert.equal(result.outputId, 'out')

  const ran = await runScript(result.script)
  assert.equal(ran.value.value, 'HELLO WORLD')
  assert.equal(ran.value.output, 'out')
  // The input node carries no phase of its own; code and the compile opener do.
  assert.ok(ran.phases.includes('compile'))
  assert.ok(ran.phases.includes('step-1'))
})

test('interpolation resolves hyphenated node ids', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'abc' } },
        { id: 'n-true', kind: 'code', params: { code: 'return input + "-T"' } },
        { id: 'n-false', kind: 'code', params: { code: 'return input + "-F"' } },
        {
          id: 'br',
          kind: 'branch',
          params: { condition: { type: 'len_gt', value: '100' } },
        },
        { id: 'join', kind: 'output' },
      ],
      [
        ['in', 'br'],
        ['br', 'n-true', 'true'],
        ['br', 'n-false', 'false'],
        ['n-true', 'join'],
        ['n-false', 'join'],
      ],
    ),
  )
  // A hyphenated id must become a valid JavaScript identifier rather than a
  // syntax error, and the false arm is the one that runs here.
  const ran = await runScript(result.script)
  assert.equal(ran.value.value, 'abc-F')
})

test('interpolation of a hyphenated id reaches the generated variable', async () => {
  // The regression this guards: `{{n-true}}` must interpolate to the sanitized
  // identifier `n_true`, not to a bare `n` or an undeclared name.
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'seed' } },
        { id: 'n-true', kind: 'code', params: { code: 'return input + "-T"' } },
        { id: 'n-false', kind: 'code', params: { code: 'return input + "-F"' } },
        { id: 'br', kind: 'branch', params: { condition: { type: 'eq', value: 'seed' } } },
        { id: 'use', kind: 'code', params: { code: 'return "got:" + {{n-true}}' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'br'],
        ['br', 'n-true', 'true'],
        ['br', 'n-false', 'false'],
        ['n-true', 'use'],
        ['n-false', 'use'],
        ['use', 'out'],
      ],
    ),
  )
  assert.match(result.script, /n_true/)
  const ran = await runScript(result.script)
  // The true arm runs (seed equals "seed") and feeds `use`.
  assert.equal(ran.value.value, 'got:seed-T')
})

test('branch true arm runs and rejoins a shared output', async () => {
  const input = 'y'.repeat(600)
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input } },
        { id: 'br', kind: 'branch', params: { condition: { type: 'len_gt', value: '500' } } },
        { id: 'long', kind: 'code', params: { code: 'return "LONG:" + input.length' } },
        { id: 'short', kind: 'code', params: { code: 'return "SHORT:" + input.length' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'br'],
        ['br', 'long', 'true'],
        ['br', 'short', 'false'],
        ['long', 'out'],
        ['short', 'out'],
      ],
    ),
  )
  const ran = await runScript(result.script)
  assert.equal(ran.value.value, 'LONG:600')
})

test('branch arms with independent outputs compile and return an arm result', async () => {
  const build = (input) =>
    compile(
      graph(
        [
          { id: 'in', kind: 'input', params: { input } },
          { id: 'br', kind: 'branch', params: { condition: { type: 'len_gt', value: '500' } } },
          { id: 'long', kind: 'code', params: { code: 'return "LONG"' } },
          { id: 'short', kind: 'code', params: { code: 'return "SHORT"' } },
          { id: 'out-long', kind: 'output' },
          { id: 'out-short', kind: 'output' },
        ],
        [
          ['in', 'br'],
          ['br', 'long', 'true'],
          ['br', 'short', 'false'],
          ['long', 'out-long'],
          ['short', 'out-short'],
        ],
      ),
    )

  // outputId is the static canonical output; runtime returns the arm that ran.
  const long = build('y'.repeat(600))
  assert.equal(long.outputId, 'out-long')
  const longRun = await runScript(long.script)
  assert.equal(longRun.value.value, 'LONG')

  const short = build('short')
  assert.equal(short.outputId, 'out-long')
  const shortRun = await runScript(short.script)
  assert.equal(shortRun.value.output, 'out-short')
  assert.equal(shortRun.value.value, 'SHORT')
})

test('node ids that collide with JavaScript reserved words still compile', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'seed' } },
        { id: 'class', kind: 'code', params: { code: 'return input + ":class"' } },
        { id: 'new', kind: 'code', params: { code: 'return input + ":new"' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'class'],
        ['class', 'new'],
        ['new', 'out'],
      ],
    ),
  )
  const ran = await runScript(result.script)
  assert.equal(ran.value.value, 'seed:class:new')
})

test('all four condition operators compile', () => {
  for (const type of Object.keys(CONDITION_LABEL)) {
    const value = type === 'len_gt' || type === 'len_lt' ? '10' : 'needle'
    const result = compile(
      graph(
        [
          { id: 'in', kind: 'input', params: { input: 'needle' } },
          { id: 'br', kind: 'branch', params: { condition: { type, value } } },
          { id: 'a', kind: 'code', params: { code: 'return "A"' } },
          { id: 'b', kind: 'code', params: { code: 'return "B"' } },
          { id: 'out', kind: 'output' },
        ],
        [
          ['in', 'br'],
          ['br', 'a', 'true'],
          ['br', 'b', 'false'],
          ['a', 'out'],
          ['b', 'out'],
        ],
      ),
    )
    assert.match(result.script, /if \(String\(/)
  }
})

test('rejects a cycle', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'b', kind: 'code', params: { code: 'return input' } },
        { id: 'c', kind: 'output' },
      ],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'b'],
      ],
    ),
    '存在环',
  )
})

test('rejects fan-out', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'b', kind: 'code', params: { code: 'return input' } },
        { id: 'c', kind: 'code', params: { code: 'return input' } },
        { id: 'd', kind: 'output' },
      ],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'd'],
        ['c', 'd'],
      ],
    ),
    '扇出',
  )
})

test('rejects nested branches', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'br1', kind: 'branch', params: { condition: { type: 'eq', value: 'x' } } },
        { id: 'mid', kind: 'code', params: { code: 'return input' } },
        { id: 'br2', kind: 'branch', params: { condition: { type: 'eq', value: 'y' } } },
        { id: 't', kind: 'code', params: { code: 'return input' } },
        { id: 'f', kind: 'code', params: { code: 'return input' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['a', 'br1'],
        ['br1', 'mid', 'true'],
        ['br1', 'out', 'false'],
        ['mid', 'br2'],
        ['br2', 't', 'true'],
        ['br2', 'f', 'false'],
        ['t', 'out'],
        ['f', 'out'],
      ],
    ),
    '分支嵌套',
  )
})

test('rejects a branch missing its false edge', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'br', kind: 'branch', params: { condition: { type: 'eq', value: 'x' } } },
        { id: 't', kind: 'code', params: { code: 'return input' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['a', 'br'],
        ['br', 't', 'true'],
        ['t', 'out'],
      ],
    ),
    'false 出边',
  )
})

test('rejects a branch whose edges carry no handle', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'br', kind: 'branch', params: { condition: { type: 'eq', value: 'x' } } },
        { id: 't', kind: 'code', params: { code: 'return input' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['a', 'br'],
        ['br', 't'],
        ['t', 'out'],
      ],
    ),
    'true / false 分支端口',
  )
})

test('branch arms cannot rejoin at structurally different nodes', () => {
  // Any shape where the two arms would stop at different join nodes forces an
  // intermediate node to have two outgoing edges, so the fan-out rule rejects it
  // first. This asserts the shape is rejected, whichever rule fires.
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'br', kind: 'branch', params: { condition: { type: 'eq', value: 'x' } } },
        { id: 't', kind: 'code', params: { code: 'return input' } },
        { id: 'f', kind: 'code', params: { code: 'return input' } },
        { id: 'j1', kind: 'code', params: { code: 'return input' } },
        { id: 'j2', kind: 'code', params: { code: 'return input' } },
        { id: 'out1', kind: 'output' },
        { id: 'out2', kind: 'output' },
      ],
      [
        ['a', 'br'],
        ['br', 't', 'true'],
        ['br', 'f', 'false'],
        ['t', 'j1'],
        ['f', 'j2'],
        ['j1', 'j2'],
        ['j1', 'out1'],
        ['j2', 'out2'],
      ],
    ),
    '扇出',
  )
})

test('rejects a graph with no input node', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'code', params: { code: 'return 1' } },
        { id: 'out', kind: 'output' },
      ],
      [['a', 'out']],
    ),
    '缺少输入节点',
  )
})

test('rejects a graph with no output node', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'b', kind: 'code', params: { code: 'return input' } },
      ],
      [['a', 'b']],
    ),
    '缺少输出节点',
  )
})

test('rejects an interpolation referencing an unknown node', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'b', kind: 'code', params: { code: 'return {{ghost}}' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['a', 'b'],
        ['b', 'out'],
      ],
    ),
    '不存在的节点',
  )
})

test('rejects an unreachable node', () => {
  rejects(
    graph(
      [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'b', kind: 'output' },
        { id: 'orphan', kind: 'code', params: { code: 'return 1' } },
      ],
      [['a', 'b']],
    ),
    '不连通',
  )
})

test('rejects duplicate node ids and dangling edges', () => {
  rejects(
    { nodes: [{ id: 'x', kind: 'input' }, { id: 'x', kind: 'output' }], edges: [] },
    '节点 ID 重复',
  )
  rejects(
    {
      nodes: [
        { id: 'a', kind: 'input', params: { input: '' } },
        { id: 'b', kind: 'output' },
      ],
      edges: [{ id: 'e', source: 'a', target: 'ghost' }],
    },
    '不存在的目标节点',
  )
})

test('rejects an empty workflow', () => {
  rejects({ nodes: [], edges: [] }, '工作流为空')
})

test('demo workflow: llm outline then length branch rejoining one output', async () => {
  const result = compile({
    nodes: [
      { id: 'topic', kind: 'input', params: { input: '量子计算' }, position: { x: 0, y: 0 } },
      {
        id: 'outline',
        kind: 'llm',
        label: '写大纲',
        params: { prompt: '请为主题「{{topic}}」写一份大纲' },
        position: { x: 1, y: 0 },
      },
      {
        id: 'check',
        kind: 'branch',
        label: '字数>500?',
        params: { condition: { type: 'len_gt', value: '500' } },
        position: { x: 2, y: 0 },
      },
      { id: 'out', kind: 'output', label: '输出', position: { x: 3, y: 0 } },
    ],
    edges: [
      { id: 'e1', source: 'topic', target: 'outline' },
      { id: 'e2', source: 'outline', target: 'check' },
      { id: 'e3', source: 'check', target: 'out', sourceHandle: 'true' },
      { id: 'e4', source: 'check', target: 'out', sourceHandle: 'false' },
    ],
  })

  // The prompt template must have interpolated the hyphen-free input id.
  assert.match(result.script, /请为主题「/) 

  const long = await runScript(result.script, {
    respond: () => '大'.repeat(600),
  })
  assert.equal(long.value.stopReason, undefined)
  assert.equal(String(long.value.value).length, 600)
  assert.deepEqual(long.value.output, 'out')

  const short = await runScript(result.script, { respond: () => '短大纲' })
  assert.equal(short.value.value, '短大纲')
})

/**
 * Prompt interpolation. These pin the behaviour that `{{node-id}}` in an `llm`
 * prompt was missing: the compiler used to `JSON.stringify` the whole
 * interpolated template, so the agent received the variable *name* as text.
 */

test('an llm prompt receives the upstream value, not the variable name', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'hello world' } },
        { id: 'ask', kind: 'llm', params: { prompt: 'say {{in}} now' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'ask'],
        ['ask', 'out'],
      ],
    ),
  )
  const seen = []
  const ran = await runScript(result.script, {
    respond: (prompt) => {
      seen.push(prompt)
      return 'answered'
    },
  })
  assert.deepEqual(seen, ['say hello world now'])
  assert.equal(ran.value.value, 'answered')
})

test('a prompt with no reference stays a plain string literal', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'x' } },
        { id: 'ask', kind: 'llm', params: { prompt: 'no refs here' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'ask'],
        ['ask', 'out'],
      ],
    ),
  )
  assert.match(result.script, /agent\("no refs here"/)
})

test('an upstream agent contract object contributes its output to a prompt', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'seed' } },
        { id: 'first', kind: 'llm', params: { prompt: 'step one {{in}}' } },
        { id: 'second', kind: 'llm', params: { prompt: 'step two {{first}}' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'first'],
        ['first', 'second'],
        ['second', 'out'],
      ],
    ),
  )
  const seen = []
  await runScript(result.script, {
    respond: (prompt) => {
      seen.push(prompt)
      // What an agent node really returns under the phase A result contract.
      return { output: 'OUTLINE-TEXT', summary: 'one line' }
    },
  })
  assert.deepEqual(seen, ['step one seed', 'step two OUTLINE-TEXT'])
})

test('a value containing quote characters is text, not script', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: 'x"); injected(); ("' } },
        { id: 'ask', kind: 'llm', params: { prompt: 'value={{in}}' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'ask'],
        ['ask', 'out'],
      ],
    ),
  )
  const seen = []
  const ran = await runScript(result.script, {
    respond: (prompt) => {
      seen.push(prompt)
      return 'ok'
    },
  })
  // The whole payload must arrive verbatim inside the prompt string, never as
  // code: the literal parts are JSON-encoded and the value is only referenced.
  assert.deepEqual(seen, ['value=x"); injected(); ("'])
  assert.equal(ran.value.value, 'ok')
})

test('a null upstream becomes empty text rather than "null"', async () => {
  const result = compile(
    graph(
      [
        { id: 'in', kind: 'input', params: { input: '' } },
        { id: 'ask', kind: 'llm', params: { prompt: '[{{in}}]' } },
        { id: 'out', kind: 'output' },
      ],
      [
        ['in', 'ask'],
        ['ask', 'out'],
      ],
    ),
  )
  const seen = []
  await runScript(result.script, {
    respond: (prompt) => {
      seen.push(prompt)
      return 'ok'
    },
  })
  assert.deepEqual(seen, ['[]'])
})

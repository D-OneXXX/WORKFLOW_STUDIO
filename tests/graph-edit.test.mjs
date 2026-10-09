/**
 * The rules behind copy/paste, cross-workflow import and node-group folding.
 *
 * These are pure functions, so every acceptance criterion in the round-chain spec
 * can be asserted directly — above all that folding is a view: the same graph must
 * compile to the same script collapsed or not.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearUnknownExecutors,
  copySelection,
  dropEmptyGroups,
  foldView,
  groupLabel,
  groupSelection,
  isGroupBlock,
  mergeWorkflow,
  paste,
  renameGroup,
  setCollapsed,
  ungroup,
  unknownExecutors,
} from '../lib/shared/graph-edit.js'
import { compile } from '../lib/shared/compiler.js'

/**
 * The fallback title a group gets when no member has a label to borrow.
 *
 * The real caller passes a formatter bound to the active locale (`group.round`),
 * which is why this pure module takes the wording instead of holding it.
 */
const roundTitle = (round) => `第 ${round} 轮`

/** input → draft → critique → branch → (true) output / (false) polish → output */
const chain = () => ({
  nodes: [
    { id: 'in', kind: 'input', label: '主题', params: { input: '远程学习' }, position: { x: 0, y: 0 } },
    {
      id: 'r1', kind: 'llm', label: '初稿', executor: 'cheap',
      params: { prompt: '把 {{in}} 写成初稿', description: '先写一版初稿', descriptionApplied: '先写一版初稿' },
      position: { x: 200, y: 0 },
    },
    { id: 'r2', kind: 'llm', label: '批评改写', params: { prompt: '批评并改写 {{r1}}' }, position: { x: 400, y: 0 } },
    { id: 'q', kind: 'branch', label: '质量过关吗', params: { condition: { type: 'len_gt', value: '500' } }, position: { x: 600, y: 0 } },
    { id: 'r3', kind: 'llm', label: '润色', params: { prompt: '润色 {{r2}}' }, position: { x: 800, y: 120 } },
    { id: 'out', kind: 'output', label: '输出', position: { x: 1000, y: 0 } },
  ],
  edges: [
    { id: 'e1', source: 'in', target: 'r1' },
    { id: 'e2', source: 'r1', target: 'r2' },
    { id: 'e3', source: 'r2', target: 'q' },
    { id: 'e4', source: 'q', target: 'out', sourceHandle: 'true' },
    { id: 'e5', source: 'q', target: 'r3', sourceHandle: 'false' },
    { id: 'e6', source: 'r3', target: 'out' },
  ],
})

test('a copy carries only the edges between the selected nodes', () => {
  const graph = chain()
  const before = JSON.stringify(graph)
  const clipboard = copySelection(graph, ['r1', 'r2'])
  assert.deepEqual(clipboard.nodes.map((node) => node.id), ['r1', 'r2'])
  assert.deepEqual(clipboard.edges.map((edge) => edge.id), ['e2'], 'the edge inside the selection comes along')
  assert.equal(JSON.stringify(graph), before, 'the source graph is untouched: nothing is cut')
})

test('pasting re-keys every id, keeps labels, and carries the plain-language fields', () => {
  const graph = chain()
  const result = paste(graph, copySelection(graph, ['r1', 'r2']))
  assert.equal(result.pasted.length, 2)

  const ids = new Set(graph.nodes.map((node) => node.id))
  for (const id of result.pasted) assert.ok(!ids.has(id), `${id} must be brand new`)
  assert.deepEqual(
    result.pasted.map((id) => result.graph.nodes.find((node) => node.id === id).label),
    ['初稿', '批评改写'],
    'labels are kept as they are; the canvas has always allowed duplicates',
  )

  const [first, second] = result.pasted
  const copied = result.graph.edges.filter(
    (edge) => (edge.source === first && edge.target === second) || (edge.source === second && edge.target === first),
  )
  assert.equal(copied.length, 1, 'the internal edge survived')

  const pastedDraft = result.graph.nodes.find((node) => node.id === first)
  assert.equal(pastedDraft.executor, 'cheap', 'the connector binding follows the node')
  assert.equal(pastedDraft.params.description, '先写一版初稿')
  assert.equal(pastedDraft.params.descriptionApplied, '先写一版初稿')
  assert.equal(pastedDraft.groupId, undefined)

  const offset = result.graph.nodes.find((node) => node.id === first).position
  assert.ok(offset.x > 200 && offset.y > 0, `the paste must not sit on the original: ${JSON.stringify(offset)}`)
})

test('the input node is skipped, and the entry point is named instead', () => {
  const graph = chain()
  const result = paste(graph, copySelection(graph, ['in', 'r1', 'r2']))
  assert.equal(result.droppedInputs, 1, 'a second input would make the graph uncompilable')
  assert.equal(result.entries.length, 1, 'exactly one node is where the previous round should connect')
  assert.equal(result.graph.nodes.filter((node) => node.kind === 'input').length, 1)
  assert.equal(result.entries[0], result.pasted[0], 'the entry is the copy of the selection head')

  // Sitting unconnected on the canvas, the pasted round is not runnable — which
  // is why the UI has to name the entry point rather than silently wire it. A
  // guessed connection from the host input would be a second outgoing edge, and
  // the compiler rejects fan-out.
  assert.throws(() => compile(result.graph), /不连通/)
})

test('two pastes of the same copy land apart instead of stacking invisibly', () => {
  const graph = chain()
  const clipboard = copySelection(graph, ['r1', 'r2'])
  const once = paste(graph, clipboard, 1)
  const twice = paste(once.graph, clipboard, 2)
  const spot = (result) => result.graph.nodes.find((node) => node.id === result.pasted[0]).position
  assert.notDeepEqual(spot(twice), spot(once))
})

test('a merged workflow never collides with the ids already on the canvas', () => {
  const current = chain()
  const incoming = chain()
  const result = mergeWorkflow(current, incoming)
  const ids = result.graph.nodes.map((node) => node.id)
  assert.equal(new Set(ids).size, ids.length, 'every id is unique after the merge')
  assert.ok(result.pasted.every((id) => current.nodes.every((node) => node.id !== id)))
  const rightMostBefore = Math.max(...current.nodes.map((node) => node.position.x))
  assert.ok(
    result.pasted.every((id) => result.graph.nodes.find((node) => node.id === id).position.x > rightMostBefore),
    'imported content is placed past what is already there',
  )
  assert.equal(result.graph.groups, undefined, 'the source group list is not carried over')
})

test('bindings to connectors this machine lacks are reported, never replaced', () => {
  const graph = chain()
  assert.deepEqual(unknownExecutors(graph, ['cheap']), [])
  const stale = unknownExecutors(graph, ['other'])
  assert.deepEqual(stale, [{ nodeId: 'r1', label: '初稿', executor: 'cheap' }])

  const cleared = clearUnknownExecutors(graph, ['other'])
  assert.equal(cleared.nodes.find((node) => node.id === 'r1').executor, undefined)
  assert.equal(unknownExecutors(cleared, ['other']).length, 0)
  assert.equal(clearUnknownExecutors(cleared, ['other']) === cleared, true, 'a no-op returns the same graph')
})

test('grouping takes at least two nodes and names the block after its lead', () => {
  const graph = chain()
  assert.equal(groupSelection(graph, ['r1'], roundTitle).groupId, undefined, 'one node is not a round')

  const grouped = groupSelection(graph, ['r1', 'r2'], roundTitle)
  assert.equal(grouped.graph.groups.length, 1)
  assert.equal(grouped.graph.groups[0].collapsed, true, 'a new round arrives folded, which is the point')
  assert.equal(grouped.graph.groups[0].label, '初稿', 'the first llm or branch label names the block')
  assert.deepEqual(
    grouped.graph.nodes.filter((node) => node.groupId === grouped.groupId).map((node) => node.id),
    ['r1', 'r2'],
  )
  assert.equal(
    groupLabel([{ id: 'x', kind: 'code' }], roundTitle(3)),
    '第 3 轮',
    'a code-only round is titled with the wording the caller passed in',
  )
  assert.equal(
    groupLabel([{ id: 'x', kind: 'code' }, { id: 'y', kind: 'llm', label: '润色' }], roundTitle(1)),
    '润色',
    'a labelled member still names the block',
  )
})

test('a group outlives its members only as long as it has one', () => {
  const grouped = groupSelection(chain(), ['r1', 'r2'], roundTitle).graph
  const groupId = grouped.groups[0].id

  // Deleting one of two rounds leaves the round standing: dissolving it is the
  // user's decision, not a side effect of a delete.
  const oneLeft = dropEmptyGroups({
    ...grouped,
    nodes: grouped.nodes.filter((node) => node.id !== 'r1'),
    edges: grouped.edges.filter((edge) => edge.source !== 'r1' && edge.target !== 'r1'),
  })
  assert.equal(oneLeft.groups.length, 1, 'a round with one member is still a round')
  assert.equal(oneLeft.groups[0].id, groupId)

  // Deleting the last one must not leave a record behind: the canvas draws nothing
  // for it, but it would still be saved with a title that names nodes that are gone.
  const emptied = dropEmptyGroups({
    ...oneLeft,
    nodes: oneLeft.nodes.filter((node) => node.id !== 'r2'),
    edges: oneLeft.edges.filter((edge) => edge.source !== 'r2' && edge.target !== 'r2'),
  })
  assert.deepEqual(emptied.groups, [], 'the emptied group is no longer in the document')
  assert.equal(emptied.nodes.some((node) => node.groupId === groupId), false)
  // The same holds for a chain that stays compilable: dropping the last member of
  // a round must not leave the record behind, whatever else the graph can do.
  const tail = {
    nodes: [
      { id: 'in', kind: 'input', params: { input: 'x' } },
      { id: 'r', kind: 'llm', label: '改写', params: { prompt: '{{in}}' }, groupId: 'g1' },
      { id: 'out', kind: 'output' },
    ],
    edges: [{ id: 'a', source: 'in', target: 'r' }, { id: 'b', source: 'r', target: 'out' }],
    groups: [{ id: 'g1', label: '第 1 轮', collapsed: true }],
  }
  const cleaned = dropEmptyGroups({ ...tail, nodes: tail.nodes.filter((node) => node.id !== 'r') })
  assert.deepEqual(cleaned.groups, [], 'the group named a node that no longer exists')
  assert.equal(compile({ ...cleaned, edges: [{ id: 'a2', source: 'in', target: 'out' }] }).order.length, 2)

  // Nothing to prune means the same object comes back, so a delete that touches no
  // group cannot churn the document.
  const withoutGroups = chain()
  assert.equal(dropEmptyGroups(withoutGroups) === withoutGroups, true, 'no groups at all: returned as it was')
  assert.equal(dropEmptyGroups(oneLeft) === oneLeft, true, 'a group that still has members: returned as it was')
})

test('re-grouping moves nodes and drops the round they left behind', () => {
  const graph = chain()
  const first = groupSelection(graph, ['r1', 'r2'], roundTitle).graph
  const second = groupSelection(first, ['r1', 'r2', 'q'], roundTitle).graph
  assert.equal(second.groups.length, 1, 'the emptied group is not left dangling')
  assert.equal(second.nodes.filter((node) => node.groupId === first.groups[0].id).length, 0)

  const opened = ungroup(second, second.groups[0].id)
  assert.equal(opened.groups.length, 0)
  assert.equal(opened.nodes.every((node) => node.groupId === undefined), true)
})

test('collapsing and renaming are the only things a fold writes', () => {
  const graph = groupSelection(chain(), ['r1', 'r2'], roundTitle).graph
  const opened = setCollapsed(graph, graph.groups[0].id, false)
  assert.equal(opened.groups[0].collapsed, false)
  assert.equal(JSON.stringify(opened.nodes), JSON.stringify(graph.nodes), 'no node moved or changed')

  const renamed = renameGroup(graph, graph.groups[0].id, '第一轮')
  assert.equal(renamed.groups[0].label, '第一轮')
})

test('a folded block hides its members and takes over their outer edges', () => {
  const graph = {
    ...chain(),
    edges: [
      ...chain().edges,
      // A node outside the round feeding a member: its stub lands on the block.
      { id: 'e9', source: 'out', target: 'r1' },
    ],
  }
  const grouped = groupSelection(graph, ['r1', 'r2'], roundTitle).graph
  const view = foldView(grouped)

  const visible = view.nodes.filter((node) => !isGroupBlock(node)).map((node) => node.id)
  assert.deepEqual(visible.sort(), ['in', 'out', 'q', 'r3'])
  const blocks = view.nodes.filter(isGroupBlock)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0].count, 2)
  assert.deepEqual(blocks[0].kinds, ['llm'])
  assert.equal(blocks[0].id, `group:${grouped.groups[0].id}`)

  const touching = view.edges.filter((edge) => edge.source === blocks[0].id || edge.target === blocks[0].id)
  // in → r1, r1 → r2 (internal, gone), r2 → q, out → r1
  assert.deepEqual(
    touching.map((edge) => `${edge.source}->${edge.target}`).sort(),
    [`group:${grouped.groups[0].id}->q`, `in->group:${grouped.groups[0].id}`, `out->group:${grouped.groups[0].id}`],
    'outer edges converge on the block and the internal edge disappears',
  )
})

test('an unfolded graph is drawn exactly as it is stored', () => {
  const graph = chain()
  assert.deepEqual(foldView(graph), { nodes: graph.nodes, edges: graph.edges })
  const grouped = groupSelection(graph, ['r1', 'r2'], roundTitle).graph
  assert.deepEqual(foldView(setCollapsed(grouped, grouped.groups[0].id, false)), {
    nodes: grouped.nodes,
    edges: grouped.edges,
  })
})

test('folding changes nothing the compiler sees', () => {
  const graph = chain()
  const grouped = groupSelection(graph, ['r1', 'r2'], roundTitle).graph
  const folded = setCollapsed(grouped, grouped.groups[0].id, true)
  const unfolded = setCollapsed(grouped, grouped.groups[0].id, false)

  // The claim in full: the same workflow, however it is drawn, compiles the same.
  assert.equal(compile(folded).script, compile(graph).script)
  assert.equal(compile(folded).script, compile(unfolded).script)
  assert.deepEqual(compile(folded).order, compile(graph).order)

  // And folding never rewrites the model it is drawn from.
  const before = JSON.stringify(grouped)
  foldView(folded)
  assert.equal(JSON.stringify(grouped), before)
})

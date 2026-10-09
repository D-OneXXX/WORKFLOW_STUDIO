/**
 * Graph operations behind multi-select copy/paste, cross-workflow import, and
 * node-group folding.
 *
 * Kept free of React and of the store, for two reasons: these are the rules the
 * acceptance criteria are written against — new ids, internal edges only, folding
 * changes nothing the compiler sees — and a rule you can call is a rule you can
 * test. The canvas and the state hook only arrange calls to this module.
 *
 * Two invariants hold throughout:
 *
 * 1. **Folding is a projection.** `foldView` computes what to draw; it never
 *    removes a node or an edge from the graph, so `compile(graph)` is identical
 *    collapsed or expanded, and a run cannot be affected by how the canvas looks.
 * 2. **A copy is a copy, not a reference.** Pasted and imported nodes are ordinary
 *    nodes afterwards: editable, connectable, deletable, groupable. There is no
 *    live link back to the source workflow, which is deliberate — "change one place
 *    and every round changes" is exactly the hidden behaviour round chains avoid.
 */

import type { WorkflowEdge, WorkflowGraph, WorkflowNode, WorkflowNodeGroup } from './types.js'
import { mintNodeId } from './document-session.js'

/** A selected subset, ready to paste. */
export interface NodeClipboard {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** What a paste or merge produced, in terms the UI can show. */
export interface PasteOutcome {
  graph: WorkflowGraph
  /** The new node ids, in copy order. */
  pasted: string[]
  /**
   * How many `input` nodes were dropped, because a graph may only have one.
   * Keeping them would leave a canvas showing a graph that refuses to compile.
   */
  droppedInputs: number
  /**
   * Pasted nodes with no incoming edge among the pasted set — where the host
   * input or the previous round should be connected.
   */
  entries: string[]
}

/** The horizontal gap a merged workflow is placed past, in canvas units. */
const MERGE_GAP = 120
/** Diagonal step per consecutive paste, so repeats do not stack invisibly. */
const PASTE_STEP = 48

const positionOf = (node: WorkflowNode, index: number): { x: number; y: number } =>
  node.position ?? { x: 80 + (index % 4) * 230, y: 80 + Math.floor(index / 4) * 150 }

const positionOfX = (node: WorkflowNode, index: number): number => positionOf(node, index).x
const positionOfY = (node: WorkflowNode, index: number): number => positionOf(node, index).y

/** The right-most x of a graph, or 0 when it is empty. */
function rightEdge(graph: WorkflowGraph): number {
  if (graph.nodes.length === 0) return 0
  return Math.max(...graph.nodes.map((node, index) => positionOf(node, index).x))
}

/** A collision-free edge id, mirroring what the canvas mints for drawn edges. */
function mintEdgeId(
  source: string,
  target: string,
  handle: string | null | undefined,
  taken: Set<string>,
): string {
  const base = `e-${source}-${handle ?? 'out'}-${target}`
  let id = base
  let counter = 1
  while (taken.has(id)) id = `${base}-${++counter}`
  taken.add(id)
  return id
}

/**
 * Take a snapshot of the selected nodes.
 *
 * Edges between two selected nodes come along; edges that leave the selection do
 * not — the original graph keeps them untouched, which is what "组外边不复制"
 * means in practice: nothing is cut, the copy simply does not carry them.
 */
export function copySelection(graph: WorkflowGraph, ids: readonly string[]): NodeClipboard {
  const wanted = new Set(ids)
  return {
    nodes: graph.nodes.filter((node) => wanted.has(node.id)).map((node) => ({ ...node })),
    edges: graph.edges
      .filter((edge) => wanted.has(edge.source) && wanted.has(edge.target))
      .map((edge) => ({ ...edge })),
  }
}

/** Give each node a fresh id and rebuild the edges that connect them. */
function rekey(
  graph: WorkflowGraph,
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  shift: { x: number; y: number },
): { added: WorkflowNode[]; addedEdges: WorkflowEdge[]; byOldId: Map<string, string> } {
  const taken = new Set(graph.nodes.map((node) => node.id))
  const takenEdges = new Set(graph.edges.map((edge) => edge.id))
  const byOldId = new Map<string, string>()
  const added: WorkflowNode[] = []

  nodes.forEach((node, index) => {
    const id = mintNodeId(node.kind, [...taken])
    taken.add(id)
    byOldId.set(node.id, id)
    const source = positionOf(node, index)
    added.push({
      ...node,
      id,
      // A copy belongs to the source's group only in the source. Grouping is a
      // decision about this canvas, made again here.
      groupId: undefined,
      position: { x: source.x + shift.x, y: source.y + shift.y },
    })
  })

  const addedEdges: WorkflowEdge[] = []
  for (const edge of edges) {
    const source = byOldId.get(edge.source)
    const target = byOldId.get(edge.target)
    if (source === undefined || target === undefined) continue
    addedEdges.push({
      ...edge,
      id: mintEdgeId(source, target, edge.sourceHandle, takenEdges),
      source,
      target,
    })
  }
  return { added, addedEdges, byOldId }
}

/**
 * Paste a copied subset into the graph.
 *
 * `input` nodes are skipped rather than duplicated, for the reason above. Guessing
 * a replacement connection is deliberately not offered: if the host input already
 * has an outgoing edge, wiring a second one from it is a fan-out, and fan-out is
 * what the compiler rejects. The entry points are returned so the UI can say where
 * to connect instead.
 */
export function paste(graph: WorkflowGraph, clipboard: NodeClipboard, generation = 1): PasteOutcome {
  const inputs = clipboard.nodes.filter((node) => node.kind === 'input')
  const kept = clipboard.nodes.filter((node) => node.kind !== 'input')
  const dropped = new Set(inputs.map((node) => node.id))
  const edges = clipboard.edges.filter(
    (edge) => !dropped.has(edge.source) && !dropped.has(edge.target),
  )
  const step = PASTE_STEP * generation
  const { added, addedEdges } = rekey(graph, kept, edges, { x: step, y: step })

  const pasted = added.map((node) => node.id)
  const incoming = new Set(addedEdges.map((edge) => edge.target))
  const entries = pasted.filter((id) => !incoming.has(id))

  return {
    graph: {
      ...graph,
      nodes: [...graph.nodes, ...added],
      edges: [...graph.edges, ...addedEdges],
    },
    pasted,
    droppedInputs: inputs.length,
    entries,
  }
}

/**
 * Merge a whole saved workflow into the current graph, placed to the right.
 *
 * Same re-keying rules as a paste, so an imported round is indistinguishable from
 * one built by hand. The source's `groups` are not carried over: their members got
 * fresh ids and no membership here, and a dangling group list would be worse than
 * folding the round again.
 */
export function mergeWorkflow(current: WorkflowGraph, incoming: WorkflowGraph): PasteOutcome {
  const shiftX = rightEdge(current) + MERGE_GAP
  const leftmost = incoming.nodes.length === 0
    ? 0
    : Math.min(...incoming.nodes.map((node, index) => positionOf(node, index).x))
  const moved = incoming.nodes.map((node, index) => {
    const position = positionOf(node, index)
    return { ...node, position: { x: position.x - leftmost + shiftX, y: position.y } }
  })
  return paste(current, { nodes: moved, edges: incoming.edges }, 1)
}

/**
 * Node bindings that name a connector this machine does not have.
 *
 * Reported when an import or a paste finishes, so the user learns it at the moment
 * the nodes appear rather than halfway through a run. Nothing is substituted: a
 * missing connector fails its node loudly, because running the step written for one
 * model on whatever else happens to be installed is the kind of silent behaviour an
 * explicit round chain exists to prevent.
 */
export function unknownExecutors(
  graph: WorkflowGraph,
  known: readonly string[],
): { nodeId: string; label: string; executor: string }[] {
  const available = new Set(known)
  return graph.nodes
    .filter((node) => node.executor !== undefined && node.executor !== '' && !available.has(node.executor))
    .map((node) => ({ nodeId: node.id, label: node.label ?? node.id, executor: node.executor as string }))
}

/** Clear those bindings, which leaves each node on the deployment default. */
export function clearUnknownExecutors(graph: WorkflowGraph, known: readonly string[]): WorkflowGraph {
  const stale = new Set(unknownExecutors(graph, known).map((row) => row.nodeId))
  if (stale.size === 0) return graph
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (stale.has(node.id) ? { ...node, executor: undefined } : node)),
  }
}

/**
 * The default block title: the first llm or branch label, else this round's
 * localized fallback.
 *
 * The fallback text is handed in rather than written here. This module is pure and
 * shared by both languages, so a literal 第 N 轮 would put Chinese-only wording into
 * the English UI — and the `group.round` key in the locale files would be dead.
 */
export function groupLabel(members: readonly WorkflowNode[], roundTitle: string): string {
  const lead = members.find((node) => node.kind === 'llm' || node.kind === 'branch')
  if (lead?.label !== undefined && lead.label.length > 0) return lead.label
  return roundTitle
}

/**
 * Fold the selected nodes into a new collapsed group.
 *
 * Fewer than two nodes is not a group. One node cannot sit in two groups, so the
 * selection's previous membership is replaced, and a group this move empties is
 * dropped rather than left as an empty list entry. Nesting is out of scope: a group
 * inside a group needs a fold order, and the round chains this is for are flat.
 *
 * @param roundTitle - names a group that has no label to borrow, given its round
 *   number; supplied by the caller so it comes from the active locale.
 */
export function groupSelection(
  graph: WorkflowGraph,
  ids: readonly string[],
  roundTitle: (round: number) => string,
): { graph: WorkflowGraph; groupId?: string } {
  const selected = new Set(ids)
  const members = graph.nodes.filter((node) => selected.has(node.id))
  if (members.length < 2) return { graph }

  const groups = graph.groups ?? []
  const id = mintNodeId('group', groups.map((group) => group.id))
  const survivors = groups.filter((group) =>
    graph.nodes.some((node) => node.groupId === group.id && !selected.has(node.id)),
  )

  return {
    groupId: id,
    graph: {
      ...graph,
      nodes: graph.nodes.map((node) => (selected.has(node.id) ? { ...node, groupId: id } : node)),
      groups: [...survivors, { id, label: groupLabel(members, roundTitle(survivors.length + 1)), collapsed: true }],
    },
  }
}

/**
 * Drop group records that no longer have a member node.
 *
 * Deleting the last node of a round leaves the group behind in the document: the
 * canvas shows nothing (a folded block is drawn from its members), yet the record
 * is saved, and its title is stale. A group down to one member is *kept* — it is
 * still a round the user made, and dissolving it is their call, not a side effect
 * of a delete.
 */
export function dropEmptyGroups(graph: WorkflowGraph): WorkflowGraph {
  const groups = graph.groups ?? []
  const kept = groups.filter((group) => graph.nodes.some((node) => node.groupId === group.id))
  return kept.length === groups.length ? graph : { ...graph, groups: kept }
}

/** Take the nodes out of a group and drop the group. */
export function ungroup(graph: WorkflowGraph, groupId: string): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => (node.groupId === groupId ? { ...node, groupId: undefined } : node)),
    groups: (graph.groups ?? []).filter((group) => group.id !== groupId),
  }
}

/** Collapse or expand one group. */
export function setCollapsed(graph: WorkflowGraph, groupId: string, collapsed: boolean): WorkflowGraph {
  return {
    ...graph,
    groups: (graph.groups ?? []).map((group) => (group.id === groupId ? { ...group, collapsed } : group)),
  }
}

/** Rename a folded block. */
export function renameGroup(graph: WorkflowGraph, groupId: string, label: string): WorkflowGraph {
  return {
    ...graph,
    groups: (graph.groups ?? []).map((group) => (group.id === groupId ? { ...group, label } : group)),
  }
}

/**
 * A collapsed group as the canvas draws it.
 *
 * Its `id` carries a prefix so it cannot collide with a real node id, and it is a
 * separate type rather than a `WorkflowNode` wearing a fake `kind`: the graph model
 * has no group node, and pretending otherwise is how a view artefact ends up in a
 * compiled script.
 */
export interface GroupBlock {
  id: string
  isGroup: true
  /** The group's id, without the canvas prefix. */
  groupId: string
  label: string
  position: { x: number; y: number }
  /** How many nodes this block hides. */
  count: number
  kinds: string[]
}

export type ViewNode = WorkflowNode | GroupBlock
export const isGroupBlock = (node: ViewNode): node is GroupBlock => (node as GroupBlock).isGroup === true

/** Prefixed ids keep a block and a node from sharing one address. */
export const GROUP_PREFIX = 'group:'
export const flowIdOfGroup = (groupId: string): string => `${GROUP_PREFIX}${groupId}`
export const groupIdOf = (flowId: string): string | undefined =>
  flowId.startsWith(GROUP_PREFIX) ? flowId.slice(GROUP_PREFIX.length) : undefined

/**
 * The graph as it should be drawn.
 *
 * Members of a collapsed group are replaced by one block spanning their bounding
 * box, and every edge that touched a member now touches the block — which is all
 * "对外边收敛为块的输入/输出桩" means. An internal edge disappears, because both
 * of its ends became the same block.
 *
 * The block shows its stubs but is **not connectable**. Which member a new edge
 * should reach is not derivable from a collapsed group, and inventing an answer
 * would edit nodes the user cannot see, so wiring happens after expanding.
 */
export function foldView(graph: WorkflowGraph): { nodes: ViewNode[]; edges: WorkflowEdge[] } {
  const collapsed = new Set(
    (graph.groups ?? []).filter((group) => group.collapsed === true).map((group) => group.id),
  )
  if (collapsed.size === 0) return { nodes: graph.nodes, edges: graph.edges }

  const blockOf = new Map<string, string>()
  for (const node of graph.nodes) {
    if (node.groupId !== undefined && collapsed.has(node.groupId)) {
      blockOf.set(node.id, flowIdOfGroup(node.groupId))
    }
  }

  const nodes: ViewNode[] = []
  const members = new Map<string, WorkflowNode[]>()
  for (const node of graph.nodes) {
    const block = blockOf.get(node.id)
    if (block === undefined) {
      nodes.push(node)
      continue
    }
    const list = members.get(block)
    if (list === undefined) members.set(block, [node])
    else list.push(node)
  }

  const groups = graph.groups ?? []
  for (const [block, list] of members) {
    const groupId = groupIdOf(block) as string
    const group: WorkflowNodeGroup | undefined = groups.find((row) => row.id === groupId)
    const xs = list.map(positionOfX)
    const ys = list.map(positionOfY)
    nodes.push({
      id: block,
      isGroup: true,
      groupId,
      label: group?.label ?? groupId,
      position: { x: Math.min(...xs), y: Math.min(...ys) },
      count: list.length,
      kinds: [...new Set(list.map((node) => node.kind))],
    })
  }

  const seen = new Set<string>()
  const edges: WorkflowEdge[] = []
  for (const edge of graph.edges) {
    const source = blockOf.get(edge.source) ?? edge.source
    const target = blockOf.get(edge.target) ?? edge.target
    if (source === target) continue
    const key = `${source}|${edge.sourceHandle ?? 'out'}|${target}`
    if (seen.has(key)) continue
    seen.add(key)
    edges.push({ id: key, source, target, sourceHandle: edge.sourceHandle ?? null })
  }
  return { nodes, edges }
}

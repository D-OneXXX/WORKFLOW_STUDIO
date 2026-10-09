/**
 * The node canvas: React Flow wired to the studio's graph state.
 *
 * `Handle` ids are exactly the wire values the compiler expects — `true` and
 * `false` for a branch arm, a single default handle otherwise — so what the user
 * draws is what the compiler reads.
 *
 * Selection belongs to the studio state, not to React Flow. The nodes are supplied
 * from the graph on every render, so a Shift-click or a marquee drag arrives as
 * `select` changes that are applied straight back through `onSelectMany` — one
 * code path, and no second copy of "what is selected" to disagree with the first.
 *
 * What is drawn is `foldView(graph)`, never the graph itself: a collapsed round is
 * one block whose stubs stand for its members' outer edges. The block is **not
 * connectable**, because which member a new edge should reach is not derivable from
 * a folded group and guessing would edit nodes the user cannot see.
 */

import * as React from 'react'
import {
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react'

import {
  foldView,
  GROUP_PREFIX,
  groupIdOf,
  isGroupBlock,
  type GroupBlock,
  type ViewNode,
} from './graph-edit.js'
import type { NodeKind, WorkflowEdge, WorkflowGraph, WorkflowNode } from './types.js'

/** Data carried by each rendered node. */
interface StudioNodeData extends Record<string, unknown> {
  kind: NodeKind
  label: string
  params: WorkflowNode['params']
  status: 'idle' | 'active' | 'done' | 'error'
}

/** Data carried by a folded round. */
interface StudioGroupData extends Record<string, unknown> {
  label: string
  count: number
  kinds: string[]
}

const KIND_BADGE: Record<NodeKind, string> = {
  input: 'IN',
  llm: 'LLM',
  code: 'CODE',
  branch: 'IF',
  output: 'OUT',
}

/** Short preview of a node's most meaningful parameter. */
function preview(data: StudioNodeData): string {
  const params = data.params ?? {}
  switch (data.kind) {
    case 'input':
      return params.input ?? ''
    case 'llm':
      return params.prompt ?? ''
    case 'code':
      return params.code ?? ''
    case 'branch': {
      const condition = params.condition
      return condition ? `${condition.type} ${condition.value}` : ''
    }
    case 'output':
      return params.outputValue ?? ''
    default:
      return ''
  }
}

/** One canvas node; a single component covers all five kinds. */
function StudioNodeView({ data, selected }: NodeProps): React.ReactElement {
  const node = data as StudioNodeData
  const classes = ['wfs-node']
  if (selected) classes.push('wfs-node-selected')
  if (node.status === 'active') classes.push('wfs-node-active')
  if (node.status === 'done') classes.push('wfs-node-done')
  if (node.status === 'error') classes.push('wfs-node-error')

  const body: React.ReactNode[] = [
    React.createElement('div', { className: 'wfs-node-kind', key: 'kind' }, KIND_BADGE[node.kind]),
    React.createElement('div', { className: 'wfs-node-label', key: 'label' }, node.label || node.kind),
    React.createElement(
      'div',
      { className: 'wfs-node-id', key: 'id' },
      String(data.id ?? ''),
    ),
  ]
  const text = preview(node)
  if (text.length > 0) {
    body.push(React.createElement('div', { className: 'wfs-node-preview', key: 'preview' }, text))
  }

  const handles: React.ReactNode[] = []
  if (node.kind !== 'input') {
    handles.push(
      React.createElement(Handle, {
        key: 'in',
        type: 'target',
        position: Position.Left,
        id: 'in',
      }),
    )
  }
  if (node.kind === 'branch') {
    handles.push(
      React.createElement(Handle, {
        key: 'true',
        type: 'source',
        position: Position.Right,
        id: 'true',
        style: { top: '32%' },
      }),
      React.createElement(Handle, {
        key: 'false',
        type: 'source',
        position: Position.Right,
        id: 'false',
        style: { top: '72%' },
      }),
      React.createElement('span', { className: 'wfs-handle-label wfs-handle-label-true', key: 't' }, 'true'),
      React.createElement('span', { className: 'wfs-handle-label wfs-handle-label-false', key: 'f' }, 'false'),
    )
  } else if (node.kind !== 'output') {
    handles.push(
      React.createElement(Handle, {
        key: 'out',
        type: 'source',
        position: Position.Right,
        id: 'out',
      }),
    )
  }

  // `data-kind` is the only styling hook the node carries: styles.css maps it to
  // the kind colour, the badge, and the handle ring, so recolouring stays in CSS.
  return React.createElement('div', { className: classes.join(' '), 'data-kind': node.kind }, ...body, ...handles)
}

/**
 * A collapsed round: one block standing for the nodes inside it. It shows the
 * stubs its members have, but accepts no new connection — expand it to wire
 * through, so a drawn edge always lands on a node the user can see.
 */
function StudioGroupView({ data, selected }: NodeProps): React.ReactElement {
  const group = data as StudioGroupData
  const classes = ['wfs-group']
  if (selected) classes.push('wfs-group-selected')
  return React.createElement(
    'div',
    { className: classes.join(' '), 'data-testid': 'group-block' },
    React.createElement(Handle, { key: 'in', type: 'target', position: Position.Left, id: 'in', isConnectable: false }),
    React.createElement(Handle, { key: 'out', type: 'source', position: Position.Right, id: 'out', isConnectable: false }),
    React.createElement('div', { className: 'wfs-group-kind', key: 'k' }, group.kinds.join(' · ').toUpperCase()),
    React.createElement('div', { className: 'wfs-group-label', key: 'l' }, group.label),
    React.createElement('div', { className: 'wfs-group-count', key: 'c' }, `${group.count} 个节点`),
    React.createElement('div', { className: 'wfs-group-hint', key: 'h' }, '双击展开'),
  )
}

const NODE_TYPES = { studio: StudioNodeView, group: StudioGroupView }

/** Convert one studio node, or one folded block, into React Flow's shape. */
function toFlowNode(
  node: ViewNode,
  index: number,
  selected: boolean,
  statusOf: (id: string) => StudioNodeData['status'],
): Node {
  if (isGroupBlock(node)) {
    const block = node as GroupBlock
    return {
      id: block.id,
      type: 'group',
      position: block.position,
      selected,
      draggable: true,
      data: { label: block.label, count: block.count, kinds: block.kinds } satisfies StudioGroupData,
    }
  }
  const real = node as WorkflowNode
  return {
    id: real.id,
    type: 'studio',
    position: real.position ?? { x: 80 + (index % 4) * 230, y: 80 + Math.floor(index / 4) * 150 },
    selected,
    data: {
      kind: real.kind,
      label: real.label ?? real.kind,
      params: real.params,
      status: statusOf(real.id),
    } satisfies StudioNodeData,
  }
}

/** Convert the studio edges into React Flow's shape. */
function toFlowEdges(graph: { edges: WorkflowEdge[] }): Edge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    // A folded block has one stub handle, whatever arm the edge came from.
    targetHandle: edge.target.startsWith(GROUP_PREFIX) ? null : 'in',
    label: edge.source.startsWith(GROUP_PREFIX) ? undefined : (edge.sourceHandle ?? undefined),
  }))
}

/** Stable, collision-free id for a new edge. */
function edgeId(connection: Connection): string {
  return `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`
}

interface CanvasProps {
  graph: WorkflowGraph
  /** The selected node and block ids, owned by the studio state. */
  selection: string[]
  statusOf: (id: string) => StudioNodeData['status']
  onSelect(id: string | undefined): void
  /** Replace the selection after a marquee drag or a multi-click. */
  onSelectMany(ids: string[]): void
  onConnect(edge: WorkflowEdge): void
  onRemoveEdge(id: string): void
  onRemoveNode(id: string): void
  onMoveNode(id: string, position: { x: number; y: number }): void
  /** Expand or collapse the round under a double-clicked block. */
  onToggleGroup(groupId: string, collapsed: boolean): void
  /** Shown on the block's stubs; the panel owns the wording. */
  groupHint?: string
}

function CanvasInner(props: CanvasProps): React.ReactElement {
  const { graph, selection, statusOf } = props
  const flow = useReactFlow()
  const selected = new Set(selection)

  const view = React.useMemo(() => foldView(graph), [graph])
  const nodes = React.useMemo(
    () => view.nodes.map((node, index) => toFlowNode(node, index, selected.has(node.id), statusOf)),
    [view, selection, statusOf],
  )
  const edges = React.useMemo(() => toFlowEdges(view), [view])

  const onNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      // Selection changes arrive as a batch describing the whole gesture, so the
      // set is applied once rather than node by node.
      const selects = changes.filter((change) => change.type === 'select')
      if (selects.length > 0) {
        const next = new Set(selection)
        for (const change of selects) {
          if (change.type !== 'select') continue
          if (change.selected) next.add(change.id)
          else next.delete(change.id)
        }
        props.onSelectMany([...next])
      }
      for (const change of changes) {
        if (change.type === 'position' && change.position !== undefined) {
          props.onMoveNode(change.id, change.position)
        } else if (change.type === 'remove') {
          // A member of a collapsed round is invisible here, so the Delete key can
          // only ever address a node the user can see.
          props.onRemoveNode(change.id)
        }
      }
    },
    [props, selection],
  )

  const onEdgesChange = React.useCallback(
    (changes: EdgeChange[]) => {
      for (const change of changes) {
        if (change.type === 'remove') props.onRemoveEdge(change.id)
      }
    },
    [props],
  )

  const onConnect = React.useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target) return
      if (connection.source === connection.target) return
      // Neither end may be a folded block: see the note on StudioGroupView.
      if (connection.source.startsWith(GROUP_PREFIX) || connection.target.startsWith(GROUP_PREFIX)) return
      props.onConnect({
        id: edgeId(connection),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
      })
    },
    [props],
  )

  const onNodeDoubleClick = React.useCallback(
    (_event: React.MouseEvent, node: Node) => {
      const groupId = groupIdOf(node.id)
      if (groupId === undefined) return
      props.onToggleGroup(groupId, false)
      // Bring the members into view, so the expansion is not off-screen.
      void flow.fitView({ nodes: [{ id: node.id }], duration: 200, maxZoom: 1.2 })
    },
    [flow, props],
  )

  return React.createElement(
    ReactFlow,
    {
      nodes,
      edges,
      nodeTypes: NODE_TYPES,
      onNodesChange,
      onEdgesChange,
      onConnect,
      onNodeDoubleClick,
      onPaneClick: () => props.onSelect(undefined),
      onNodeClick: (event: React.MouseEvent, node: Node) => {
        // Only a plain click means "just this one". A modifier click is an additive
        // gesture, and React Flow has already reported it as a `select` change — which
        // `onNodesChange` applies — so replacing the set here would undo the add.
        if (event.shiftKey || event.ctrlKey || event.metaKey) return
        props.onSelect(node.id)
      },
      // Shift drags the marquee, and Ctrl/Cmd-click or Shift-click adds a node to the
      // selection. Named here so the keys are a decision, not an accident.
      selectionKeyCode: 'Shift',
      multiSelectionKeyCode: ['Meta', 'Control', 'Shift'],
      zoomActivationKeyCode: 'Meta',
      deleteKeyCode: ['Backspace', 'Delete'],
      fitView: true,
      proOptions: { hideAttribution: true },
      minZoom: 0.25,
      maxZoom: 2,
    },
    React.createElement(Background, { gap: 18, size: 1 }),
    React.createElement(MiniMap, { pannable: true, zoomable: true }),
    React.createElement(Controls, { showInteractive: false }),
  )
}

/** Canvas with the provider React Flow's hooks require. */
export function Canvas(props: CanvasProps): React.ReactElement {
  return React.createElement(
    ReactFlowProvider,
    null,
    React.createElement(CanvasInner, props),
  )
}

export { KIND_BADGE }
export type { StudioNodeData }

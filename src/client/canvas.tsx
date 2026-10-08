/**
 * The node canvas: React Flow wired to the studio's graph state.
 *
 * `Handle` ids are exactly the wire values the compiler expects — `true` and
 * `false` for a branch arm, a single default handle otherwise — so what the user
 * draws is what the compiler reads.
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

import type { NodeKind, WorkflowEdge, WorkflowGraph, WorkflowNode } from './types.js'

/** Data carried by each rendered node. */
interface StudioNodeData extends Record<string, unknown> {
  kind: NodeKind
  label: string
  params: WorkflowNode['params']
  status: 'idle' | 'active' | 'done' | 'error'
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

const NODE_TYPES = { studio: StudioNodeView }

/** Convert the studio graph into React Flow's shape. */
function toFlowNodes(
  graph: WorkflowGraph,
  selectedId: string | undefined,
  statusOf: (id: string) => StudioNodeData['status'],
): Node[] {
  return graph.nodes.map((node, index) => ({
    id: node.id,
    type: 'studio',
    position: node.position ?? { x: 80 + (index % 4) * 230, y: 80 + Math.floor(index / 4) * 150 },
    selected: node.id === selectedId,
    data: {
      kind: node.kind,
      label: node.label ?? node.kind,
      params: node.params,
      status: statusOf(node.id),
    } satisfies StudioNodeData,
  }))
}

/** Convert the studio edges into React Flow's shape. */
function toFlowEdges(graph: WorkflowGraph): Edge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: 'in',
    label: edge.sourceHandle ?? undefined,
  }))
}

/** Stable, collision-free id for a new edge. */
function edgeId(connection: Connection): string {
  return `e-${connection.source}-${connection.sourceHandle ?? 'out'}-${connection.target}`
}

interface CanvasProps {
  graph: WorkflowGraph
  selectedId: string | undefined
  statusOf: (id: string) => StudioNodeData['status']
  onSelect(id: string | undefined): void
  onConnect(edge: WorkflowEdge): void
  onRemoveEdge(id: string): void
  onRemoveNode(id: string): void
  onMoveNode(id: string, position: { x: number; y: number }): void
}

function CanvasInner(props: CanvasProps): React.ReactElement {
  const { graph, selectedId, statusOf } = props
  const flow = useReactFlow()

  const nodes = React.useMemo(
    () => toFlowNodes(graph, selectedId, statusOf),
    [graph, selectedId, statusOf],
  )
  const edges = React.useMemo(() => toFlowEdges(graph), [graph])

  const onNodesChange = React.useCallback(
    (changes: NodeChange[]) => {
      for (const change of changes) {
        if (change.type === 'position' && change.position !== undefined) {
          props.onMoveNode(change.id, change.position)
        } else if (change.type === 'remove') {
          props.onRemoveNode(change.id)
        } else if (change.type === 'select' && change.selected) {
          props.onSelect(change.id)
        }
      }
    },
    [props],
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
      props.onConnect({
        id: edgeId(connection),
        source: connection.source,
        target: connection.target,
        sourceHandle: connection.sourceHandle ?? null,
      })
    },
    [props],
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
      onPaneClick: () => props.onSelect(undefined),
      onNodeClick: (_event: React.MouseEvent, node: Node) => props.onSelect(node.id),
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

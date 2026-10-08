/**
 * Client-side view types.
 *
 * Mirrors the host schemas structurally. A type-only import from the host build
 * would be accurate but would couple the browser bundle to host module
 * resolution, so the shapes are restated here and the host remains the single
 * runtime validator.
 */

export type NodeKind = 'input' | 'llm' | 'code' | 'branch' | 'output'
export type ConditionType = 'len_gt' | 'len_lt' | 'contains' | 'eq'

export interface WorkflowCondition {
  type: ConditionType
  value: string
}

export interface NodeParams {
  input?: string
  prompt?: string
  code?: string
  condition?: WorkflowCondition
  outputValue?: string
}

export interface WorkflowNode {
  id: string
  kind: NodeKind
  label?: string
  params?: NodeParams
  position?: { x: number; y: number }
}

export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
}

export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

export interface WorkflowRecord {
  id: string
  name: string
  description?: string
  graph: WorkflowGraph
  createdAt: string
  updatedAt: string
}

export interface WorkflowSummary {
  id: string
  name: string
  description?: string
  nodeCount: number
  updatedAt: string
}

export interface RunProgress {
  seq: number
  kind: 'phase' | 'log'
  nodeId?: string
  message: string
}

export interface RunResult {
  runId: string
  stopReason: 'completed' | 'cancelled' | 'error'
  value: unknown
  error?: string
  agentsStarted: number
  progress: RunProgress[]
}

/** Where a node's status colour comes from while a run is in flight. */
export type NodeStatus = 'idle' | 'active' | 'done' | 'error'

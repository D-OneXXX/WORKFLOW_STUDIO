/**
 * Shared host↔client wire contract for the workflow studio.
 *
 * This module is deliberately dependency-free and free of host-only imports so
 * both builds can include it: the Host half validates against it, and the
 * Client half types its calls with it.
 */

/** The five node kinds v0.1 supports. */
export type NodeKind = 'input' | 'llm' | 'code' | 'branch' | 'output'

/** Condition operators a `branch` node may use. */
export type ConditionType = 'len_gt' | 'len_lt' | 'contains' | 'eq'

/** A condition evaluated by a `branch` node against its resolved input. */
export interface WorkflowCondition {
  type: ConditionType
  /** Threshold for `len_gt`/`len_lt`; operand for `contains`/`eq`. */
  value: string
}

/** Per-kind node configuration. Fields not relevant to a kind are ignored. */
export interface NodeParams {
  /** `input`: literal text seeded into the run. */
  input?: string
  /** `llm`: prompt template; `{{node-id}}` interpolates an upstream value. */
  prompt?: string
  /** `code`: JavaScript body; must `return` a value. Receives `input`. */
  code?: string
  /** `branch`: the condition selecting the `true` or `false` edge. */
  condition?: WorkflowCondition
  /** `output`: label used for the run's final value. */
  outputValue?: string
}

/** One node on the canvas. */
export interface WorkflowNode {
  id: string
  kind: NodeKind
  /** User-facing label, shown on the canvas and in logs. */
  label?: string
  params?: NodeParams
  /** Canvas geometry, opaque to the compiler. */
  position?: { x: number; y: number }
}

/** One directed edge. `sourceHandle` is `true`/`false` for branch arms. */
export interface WorkflowEdge {
  id: string
  source: string
  target: string
  sourceHandle?: string | null
}

/** A complete workflow document. */
export interface WorkflowGraph {
  nodes: WorkflowNode[]
  edges: WorkflowEdge[]
}

/** A stored workflow record. */
export interface WorkflowRecord {
  id: string
  name: string
  description?: string
  graph: WorkflowGraph
  /** ISO-8601 creation timestamp. */
  createdAt: string
  updatedAt: string
}

/** Summary row for the workflow list. */
export interface WorkflowSummary {
  id: string
  name: string
  description?: string
  nodeCount: number
  updatedAt: string
}

/** Successful save result. */
export interface SaveResult {
  id: string
  updatedAt: string
}

/** One progress line emitted while a run executes. */
export interface RunProgress {
  /** Monotonic sequence for ordering. */
  seq: number
  /** `phase` markers carry a node id; `log` markers carry free text. */
  kind: 'phase' | 'log'
  /** Node id the marker refers to, when known. */
  nodeId?: string
  message: string
}

/** Terminal outcome of a run. */
export interface RunResult {
  runId: string
  stopReason: 'completed' | 'cancelled' | 'error'
  value: unknown
  error?: string
  agentsStarted: number
  progress: RunProgress[]
}

/** Request payloads, one per method. */
export interface SaveRequest {
  id?: string
  name: string
  description?: string
  graph: WorkflowGraph
}

export interface LoadRequest {
  id: string
}

export interface DeleteRequest {
  id: string
}

export interface RunRequest {
  id?: string
  graph?: WorkflowGraph
  /** Working directory handed to the spawned agents. */
  cwd?: string
  /** Overrides the compiled script for advanced callers. */
  script?: string
}

/**
 * The workflow RPC surface, in the order the brief fixes them.
 * Method names are `workflow/save`, `workflow/list`, `workflow/load`,
 * `workflow/delete`, `workflow/run`.
 */
export interface WorkflowRemoteApi {
  'workflow/save': (request: SaveRequest) => Promise<SaveResult>
  'workflow/list': () => Promise<WorkflowSummary[]>
  'workflow/load': (request: LoadRequest) => Promise<WorkflowRecord | null>
  'workflow/delete': (request: DeleteRequest) => Promise<{ deleted: boolean }>
  'workflow/run': (request: RunRequest) => Promise<RunResult>
}

/** The storage domain name; must match /^[a-z][a-z0-9_]*$/. */
export const WORKFLOW_DOMAIN = 'dsh_workflow'

/** The workflow node kinds, for UI iteration and validation. */
export const NODE_KINDS: readonly NodeKind[] = ['input', 'llm', 'code', 'branch', 'output']

/** The branch condition operators, for UI iteration and validation. */
export const CONDITION_TYPES: readonly ConditionType[] = ['len_gt', 'len_lt', 'contains', 'eq']

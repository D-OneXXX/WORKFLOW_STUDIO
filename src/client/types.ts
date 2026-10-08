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
  /** `branch`/`llm`/`code`: the user's plain-language words for this node. */
  description?: string
  /**
   * The `description` the current formal field was translated from. Empty string
   * means the field was hand-edited in expert mode. See `contract.ts`.
   */
  descriptionApplied?: string
}

export interface WorkflowNode {
  id: string
  kind: NodeKind
  label?: string
  params?: NodeParams
  position?: { x: number; y: number }
  /** `llm`: connector id that executes this node; absent means the default. */
  executor?: string
  /** The node group this node belongs to. Folding only — never compiled. */
  groupId?: string
}

/**
 * A foldable node group. View state: the graph the compiler sees is unchanged by
 * folding, so a workflow behaves identically collapsed or expanded.
 */
export interface WorkflowNodeGroup {
  id: string
  label?: string
  collapsed?: boolean
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
  groups?: WorkflowNodeGroup[]
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

/**
 * One outbound connector, as the panel is allowed to see it.
 * Command lines, endpoints and environment never leave the server process.
 */
export interface ConnectorOption {
  id: string
  kind: 'cli' | 'http' | 'mcp'
  label: string
}

/** The executor catalogue backing the property panel's dropdown. */
export interface ConnectorCatalog {
  defaultId: string | null
  connectors: ConnectorOption[]
}

/** One candidate offered when a description could mean two nodes. */
export interface TranslateCandidate {
  id: string
  label: string
  kind: NodeKind
}

/** What a translation produced. Shown for confirmation; never stored directly. */
export type TranslateOutcome =
  | { status: 'ok'; config: { type?: ConditionType; value?: string; prompt?: string; code?: string } }
  | { status: 'untranslatable'; reason: string }
  | { status: 'ambiguous'; term: string; candidates: TranslateCandidate[] }

/** The `POST /api/translate` call, wired only where connectors exist. */
export interface TranslateRequest {
  kind: 'branch' | 'llm' | 'code'
  nodeId: string
  description: string
  graph: WorkflowGraph
  pin?: { term: string; nodeId: string }
}

/**
 * A remote call result, shaped like `WireResult` in `remote.ts`. Restated so
 * this module stays the dependency-free type mirror the rest of the client
 * imports.
 */
export type TranslateResult =
  | { ok: true; value: TranslateOutcome }
  | { ok: false; error: { code?: string; message?: string } }

export type TranslateCall = (request: TranslateRequest) => Promise<TranslateResult>

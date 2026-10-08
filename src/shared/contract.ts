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
  /**
   * `branch`/`llm`/`code`: the user's own words for what the node does.
   *
   * Kept beside the formal field, never instead of it: the formal field is the
   * only thing the compiler reads, so a run costs no tokens and behaves
   * deterministically, while the words stay available for re-translating.
   */
  description?: string
  /**
   * The `description` whose translation produced the current formal field.
   *
   * This is what makes the two staleness states distinguishable after the
   * document is closed and reopened:
   *
   * - equal to `description` — the formal field is the confirmed translation.
   * - different and non-empty — the words were edited, so the configuration is
   *   out of date and can be regenerated.
   * - the empty string — the formal field was edited by hand in expert mode,
   *   so the words are marked 已手动修改 and nothing further is suggested.
   *
   * The field is never re-derived from the formal configuration, which cannot
   * round-trip: `500` and "超过500字" are not comparable as text.
   */
  descriptionApplied?: string
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
  /**
   * `llm`: connector id that executes this node. Absent means the deployment's
   * default connector. The compiled script never carries it — the runner keeps
   * a node-id map beside the script, so the Harness engine's `agent()` options
   * stay exactly as that engine documents them.
   */
  executor?: string
  /**
   * The node group this node belongs to, for folding only. See `WorkflowNodeGroup`.
   */
  groupId?: string
}

/**
 * A foldable node group — a round of an explicit round chain, usually.
 *
 * **View state only.** Folding hides nodes in the editor; it never changes the
 * graph the compiler sees, so a workflow compiles to the same script whether it
 * is folded or not, and a run behaves identically. Both this list and
 * `WorkflowNode.groupId` are optional, which is why an added round chain opens
 * in older builds and the interchange format keeps its `version: 1`.
 */
export interface WorkflowNodeGroup {
  id: string
  /** Block title when folded. Defaults to the first llm/branch label. */
  label?: string
  /** Collapsed into a single block. Absent means expanded. */
  collapsed?: boolean
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
  /** Folding layout; ignored by the compiler. */
  groups?: WorkflowNodeGroup[]
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

/**
 * Plain-language configuration, reached over the standalone HTTP surface
 * (`POST /api/translate`) and **not** over Typert: `scripts/lint.mjs` pins the
 * wire vocabulary at five methods, and an illegal name there is a fatal host
 * load failure. The plugin edition has no connector registry, so it has no
 * translation either.
 */
export interface TranslateRequest {
  /** Only these three kinds have anything to translate. */
  kind: 'branch' | 'llm' | 'code'
  /** The node being configured, so the node list can exclude it. */
  nodeId: string
  description: string
  /** The graph on screen, not the saved one: the node is usually unsaved. */
  graph: WorkflowGraph
  /**
   * A term the user resolved by picking a candidate after an `ambiguous`
   * answer, so the retry cannot ask the same question again.
   */
  pin?: { term: string; nodeId: string }
}

/** One candidate offered when a description could mean two nodes. */
export interface TranslateCandidate {
  id: string
  label: string
  kind: NodeKind
}

/**
 * What a translation produced. Nothing here is stored: the panel shows it and
 * the user confirms.
 */
export type TranslateOutcome =
  | {
      status: 'ok'
      /** The formal field to write, already normalized to what the compiler reads. */
      config: { type?: ConditionType; value?: string; prompt?: string; code?: string }
    }
  | { status: 'untranslatable'; reason: string }
  | { status: 'ambiguous'; term: string; candidates: TranslateCandidate[] }

/** The storage domain name; must match /^[a-z][a-z0-9_]*$/. */
export const WORKFLOW_DOMAIN = 'dsh_workflow'

/** The workflow node kinds, for UI iteration and validation. */
export const NODE_KINDS: readonly NodeKind[] = ['input', 'llm', 'code', 'branch', 'output']

/** The branch condition operators, for UI iteration and validation. */
export const CONDITION_TYPES: readonly ConditionType[] = ['len_gt', 'len_lt', 'contains', 'eq']

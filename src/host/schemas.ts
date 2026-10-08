/**
 * Zod schemas for every workflow payload.
 *
 * These are the single source of truth for the RPC contract: the Host half
 * parses request and result values with them, and the exported TypeScript types
 * are inferred from them so the two can never drift. Only the Host half imports
 * this module — the Client half uses the inferred types, so no zod copy reaches
 * the browser bundle.
 */

import { z } from 'zod'

/** The five node kinds v0.1 supports. */
export const nodeKindSchema = z.enum(['input', 'llm', 'code', 'branch', 'output'])

/** The branch condition operators. */
export const conditionTypeSchema = z.enum(['len_gt', 'len_lt', 'contains', 'eq'])

/** One branch condition. */
export const conditionSchema = z.object({
  type: conditionTypeSchema,
  value: z.string(),
})

/** Per-kind node parameters. */
export const nodeParamsSchema = z.object({
  input: z.string().optional(),
  prompt: z.string().optional(),
  code: z.string().optional(),
  condition: conditionSchema.optional(),
  outputValue: z.string().optional(),
  /**
   * The user's plain-language words for a branch/llm/code node. Optional, so an
   * older document stays valid and the interchange format keeps `version: 1`.
   */
  description: z.string().max(2_000).optional(),
  /**
   * Which `description` the current formal field was translated from. The empty
   * string means the field was edited by hand; see `contract.ts`.
   */
  descriptionApplied: z.string().max(2_000).optional(),
})

/**
 * A foldable node group — a round of an explicit round chain, usually.
 *
 * Purely view state: the compiler never reads it, so folding cannot change what
 * a run does. It still has to be *declared*, because zod drops undeclared keys
 * and the folding layout would otherwise vanish silently on every save.
 */
export const nodeGroupSchema = z.object({
  id: z.string().min(1).max(80),
  label: z.string().max(80).optional(),
  collapsed: z.boolean().optional(),
})

/**
 * One canvas node.
 *
 * `executor` binds an `llm` node to a connector id. It is optional, so an older
 * document stays valid and the interchange format keeps its `version: 1` —
 * adding an optional field is not a schema revision. `groupId` follows the same
 * rule.
 */
export const nodeSchema = z.object({
  id: z.string().min(1),
  kind: nodeKindSchema,
  label: z.string().optional(),
  params: nodeParamsSchema.optional(),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  executor: z.string().min(1).max(80).optional(),
  groupId: z.string().min(1).max(80).optional(),
})

/** One canvas edge. */
export const edgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: z.string().nullish(),
})

/** A complete workflow document. */
export const graphSchema = z.object({
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  groups: z.array(nodeGroupSchema).optional(),
})

/** A stored workflow record. */
export const recordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  graph: graphSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
})

/** A list row. */
export const summarySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  nodeCount: z.number().int().nonnegative(),
  updatedAt: z.string(),
})

/** Progress markers streamed back with a run result. */
export const progressSchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: z.enum(['phase', 'log']),
  nodeId: z.string().optional(),
  message: z.string(),
})

/** Terminal outcome of a run. */
export const runResultSchema = z.object({
  runId: z.string(),
  stopReason: z.enum(['completed', 'cancelled', 'error']),
  value: z.unknown(),
  error: z.string().optional(),
  agentsStarted: z.number().int().nonnegative(),
  progress: z.array(progressSchema),
})

/** `workflow/save` request and result. */
export const saveRequestSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  graph: graphSchema,
})
export const saveResultSchema = z.object({ id: z.string(), updatedAt: z.string() })

/** `workflow/list` request (no fields) and result. */
export const listRequestSchema = z.unknown()
export const listResultSchema = z.array(summarySchema)

/** `workflow/load` request and result. */
export const loadRequestSchema = z.object({ id: z.string().min(1) })
export const loadResultSchema = recordSchema.nullable()

/** `workflow/delete` request and result. */
export const deleteRequestSchema = z.object({ id: z.string().min(1) })
export const deleteResultSchema = z.object({ deleted: z.boolean() })

/** `workflow/run` request and result. */
export const runRequestSchema = z.object({
  id: z.string().optional(),
  graph: graphSchema.optional(),
  cwd: z.string().optional(),
  script: z.string().optional(),
})

/** Inferred shared types, re-exported for both halves. */
export type NodeKind = z.infer<typeof nodeKindSchema>
export type ConditionType = z.infer<typeof conditionTypeSchema>
export type WorkflowCondition = z.infer<typeof conditionSchema>
export type NodeParams = z.infer<typeof nodeParamsSchema>
export type WorkflowNode = z.infer<typeof nodeSchema>
export type WorkflowEdge = z.infer<typeof edgeSchema>
export type WorkflowGraph = z.infer<typeof graphSchema>
export type WorkflowRecord = z.infer<typeof recordSchema>
export type WorkflowSummary = z.infer<typeof summarySchema>
export type RunProgress = z.infer<typeof progressSchema>
export type RunResult = z.infer<typeof runResultSchema>
export type SaveRequest = z.infer<typeof saveRequestSchema>
export type SaveResult = z.infer<typeof saveResultSchema>
export type LoadRequest = z.infer<typeof loadRequestSchema>
export type DeleteRequest = z.infer<typeof deleteRequestSchema>
export type RunRequest = z.infer<typeof runRequestSchema>

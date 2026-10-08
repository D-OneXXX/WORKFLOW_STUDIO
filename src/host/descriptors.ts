/**
 * The Host half's Typert contribution: five strict invocations, one per wire
 * method, each with a zod codec for its request and result.
 *
 * Shape verified against @deepseek-ai/dsh-typert-protocol 0.2.0-rc.2:
 *   * `TypertCodec` strict mode is `{ mode: 'strict', typeSymbol: string,
 *     create: () => TypertSchema }`.
 *   * `create()` returns a schema *instance* (anything with `parse`), so a zod
 *     schema is passed straight through.
 *   * `typeSymbol` is a plain string, not a JS symbol.
 *   * Namespace, method, and wire segments must match /^[A-Za-z0-9_$.-]+$/,
 *     which is why the wire method is `workflow/save` (one segment, no nesting).
 */

import {
  deleteRequestSchema,
  deleteResultSchema,
  listRequestSchema,
  listResultSchema,
  loadRequestSchema,
  loadResultSchema,
  runRequestSchema,
  runResultSchema,
  saveRequestSchema,
  saveResultSchema,
} from './schemas.js'
import {
  strictCodec,
  type TypertCodecLike,
  type TypertContributionLike,
  type TypertInvocationLike,
  type TypertSchemaLike,
} from '../shared/descriptors.js'
import {
  invocationId,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PACKAGE,
  WORKFLOW_SERVICE,
  type WorkflowMethod,
} from '../shared/wire.js'

/**
 * Build one invocation descriptor from the shared endpoint vocabulary.
 *
 * The Cordis service key and the wire namespace are both `workflowStudio`, and
 * the wire method keeps its brief-mandated `workflow/...` spelling.
 *
 * The request is the only declared parameter: an AbortSignal travels out of band
 * through `cancellation`, never inside `args`, so declaring a `signal` parameter
 * here would make the host demand a field the client never sends.
 */
function hostInvocation(
  method: string,
  request: { typeSymbol: string; create: () => TypertSchemaLike },
  result: { typeSymbol: string; create: () => TypertSchemaLike },
): TypertInvocationLike {
  return {
    id: invocationId(method as WorkflowMethod),
    service: WORKFLOW_SERVICE,
    // Its own wire field, validated by the same character rule as `method`.
    namespace: WORKFLOW_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        codec: strictCodec(request.typeSymbol, request.create) as TypertCodecLike,
      },
    ],
    result: strictCodec(result.typeSymbol, result.create) as TypertCodecLike,
  }
}

/**
 * The five invocations, with real zod parsing on both sides of the wire.
 *
 * The first argument is the bare `method` wire name. It must not contain a
 * slash: `namespace` and `method` are validated separately against
 * `/^[A-Za-z0-9_$.-]+$/`, and the brief's `workflow/...` spelling survives only
 * in the invocation `id`.
 */
export const WORKFLOW_INVOCATIONS: readonly TypertInvocationLike[] = [
  hostInvocation(
    'save',
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/save:request`, create: () => saveRequestSchema },
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/save:result`, create: () => saveResultSchema },
  ),
  hostInvocation(
    'list',
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/list:request`, create: () => listRequestSchema },
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/list:result`, create: () => listResultSchema },
  ),
  hostInvocation(
    'load',
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/load:request`, create: () => loadRequestSchema },
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/load:result`, create: () => loadResultSchema },
  ),
  hostInvocation(
    'delete',
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/delete:request`, create: () => deleteRequestSchema },
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/delete:result`, create: () => deleteResultSchema },
  ),
  hostInvocation(
    'run',
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/run:request`, create: () => runRequestSchema },
    { typeSymbol: `${WORKFLOW_PACKAGE}#workflow/run:result`, create: () => runResultSchema },
  ),
]

/** The contribution the Host registers with `ctx.typert`. */
export const TYPERT: TypertContributionLike = {
  package: WORKFLOW_PACKAGE,
  face: 'host',
  // No separately named schema exports; the codecs above carry the schemas.
  schemas: [],
  model: { services: [], events: [], objects: [] },
  invocations: WORKFLOW_INVOCATIONS,
}

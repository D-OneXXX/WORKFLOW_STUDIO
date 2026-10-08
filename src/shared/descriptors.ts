/**
 * Structural Typert contract types.
 *
 * The endpoint names, package identity, and namespace live in `./wire.ts`, which
 * both halves import; this module adds the descriptor *shapes* and carries no
 * zod import so the client bundle stays free of it.
 *
 * Shape notes, verified against @deepseek-ai/dsh-typert-protocol 0.2.0-rc.2:
 *   * `TypertCodec` in strict mode is
 *     `{ mode: 'strict', typeSymbol: string, create: () => TypertSchema }`.
 *   * `TypertSchema` is any `{ parse(value: unknown): Output }`, which a zod
 *     schema satisfies, so `create` returns the schema.
 *   * `typeSymbol` is a plain string, not a symbol.
 *   * An AbortSignal travels through `cancellation`, never inside `args`.
 */

import { invocationId, WORKFLOW_NAMESPACE, WORKFLOW_PACKAGE, WORKFLOW_SERVICE } from './wire.js'
import type { WorkflowMethod } from './wire.js'

// Re-exported so a host module can take the descriptor shapes and the endpoint
// vocabulary from one module.
export {
  invocationId,
  WORKFLOW_METHODS,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PACKAGE,
  WORKFLOW_SERVICE,
} from './wire.js'

/** The minimal shape a Typert schema must satisfy. */
export interface TypertSchemaLike<T = unknown> {
  parse(value: unknown): T
}

/** The strict-mode codec, structurally compatible with the real `TypertCodec`. */
export interface TypertCodecLike<T = unknown> {
  mode: 'strict'
  typeSymbol: string
  create: () => TypertSchemaLike<T>
  decode?: (value: unknown) => unknown
  encode?: (value: unknown, writeBytes: (bytes: Uint8Array, path: readonly (string | number)[]) => null) => unknown
}

/** One parameter of an invocation. */
export interface TypertParameterLike {
  name: string
  wire: string
  source: 'json'
  codec: TypertCodecLike
  acceptsUndefined?: boolean
}

/** One invocation descriptor, structurally compatible with the real type. */
export interface TypertInvocationLike {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: TypertParameterLike[]
  result: TypertCodecLike
  mode?: 'stream'
}

/** The contribution object a client mounts and a host registers. */
export interface TypertContributionLike {
  package: string
  face: 'host' | 'client'
  schemas: readonly { name: string; create: () => TypertSchemaLike }[]
  model: {
    services: readonly unknown[]
    events: readonly unknown[]
    objects: readonly unknown[]
  }
  invocations: readonly TypertInvocationLike[]
}

/**
 * Build a strict codec for one endpoint.
 * @param typeSymbol - the conventional `<package>#<endpoint>` identity.
 * @param create - factory returning the zod schema for this endpoint.
 */
export function strictCodec<T>(typeSymbol: string, create: () => TypertSchemaLike<T>): TypertCodecLike<T> {
  return { mode: 'strict', typeSymbol, create }
}

/**
 * Build one invocation descriptor with a single JSON `request` parameter.
 * @param method - the wire method name.
 * @param request - codec for the request payload.
 * @param result - codec for the result payload.
 */
export function invocation(
  method: WorkflowMethod,
  request: TypertCodecLike,
  result: TypertCodecLike,
): TypertInvocationLike {
  return {
    id: invocationId(method),
    service: WORKFLOW_SERVICE,
    // The namespace is its own wire field and must satisfy the same character
    // rule as the method; the slash lives only in the human-readable id.
    namespace: WORKFLOW_NAMESPACE,
    method,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'request', wire: 'request', source: 'json', codec: request }],
    result,
  }
}

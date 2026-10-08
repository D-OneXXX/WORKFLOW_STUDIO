/**
 * Client-side remote layer.
 *
 * Two things must both happen before any method is callable:
 *
 *   1. `ctx.remote.$mount(contribution)` registers the descriptors and creates
 *      the `remote.workflowStudio` namespace. It returns a promise and must be
 *      awaited.
 *   2. Each method is then read off `ctx.remote[namespace]`.
 *
 * If the mount never happens the namespace is simply `undefined` — the page
 * provides no throwing stubs — which is why `createWorkflowRpc` reports
 * `remote/unavailable` instead of throwing.
 *
 * The client deliberately does not import zod: parameter codecs are validated
 * only for their `mode`/`typeSymbol`/`create` shape, `create()` is never called
 * on this side, and a result codec of `{ mode: 'src-json' }` is accepted
 * verbatim.
 */

import {
  invocationId,
  WORKFLOW_METHODS,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PACKAGE,
  WORKFLOW_SERVICE,
} from './constants.js'

/** Failure shape reported by the transport, or synthesized locally. */
export interface RemoteFailure {
  code?: string
  message?: string
}

/** A carrier result: the transport resolves, it does not reject, on failure. */
export type WireResult<T> = { ok: true; value: T } | { ok: false; error: RemoteFailure }

/** The five methods, as the UI consumes them. */
export interface WorkflowRpc {
  save<T>(request: unknown): Promise<WireResult<T>>
  list<T>(request: unknown): Promise<WireResult<T>>
  load<T>(request: unknown): Promise<WireResult<T>>
  remove<T>(request: unknown): Promise<WireResult<T>>
  run<T>(request: unknown): Promise<WireResult<T>>
}

/** Render a transport failure as a message the UI can display. */
export function failureMessage(failure: RemoteFailure | undefined): string {
  if (!failure) return '远程调用失败'
  const code = failure.code ? `[${failure.code}] ` : ''
  return `${code}${failure.message ?? '远程调用失败'}`
}

/** A client parameter codec: strict shape, never actually invoked here. */
interface CodecLike {
  mode: 'strict'
  typeSymbol: string
  create(): { parse(value: unknown): unknown }
}

/** One descriptor the client mounts for a host endpoint. */
interface InvocationLike {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: { name: string; wire: string; source: 'json'; codec: CodecLike }[]
  result: { mode: 'src-json' }
}

/** The contribution object `$mount` accepts. */
export interface ContributionLike {
  package: string
  descriptors: InvocationLike[]
}

/** The per-namespace method table the page exposes. */
type RemoteNamespace = Record<string, (request: unknown) => Promise<unknown>>

/** The `ctx.remote` face this plugin depends on. */
export interface RemoteServiceLike {
  $mount(contribution: unknown): Promise<unknown>
  [namespace: string]: unknown
}

/** The client Cordis context faces this plugin uses. */
export interface ClientContextLike {
  remote?: RemoteServiceLike
  slots: {
    inject(key: string, callback: () => unknown): () => void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  layout: { selectPanel(id: string | null): void }
  locale?: {
    register(namespace: string, dicts: Record<string, unknown>): () => void
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string
  }
  effect(callback: () => unknown, label?: string): unknown
}

/** A pass-through codec for one declared parameter. */
function parameterCodec(method: string): CodecLike {
  return {
    mode: 'strict',
    typeSymbol: `${WORKFLOW_PACKAGE}#${WORKFLOW_NAMESPACE}/${method}:request`,
    // Never called on the client; the host owns real validation.
    create: () => ({ parse: (value: unknown) => value }),
  }
}

/** Build the contribution describing the five host endpoints. */
export function buildContribution(): ContributionLike {
  return {
    package: WORKFLOW_PACKAGE,
    descriptors: WORKFLOW_METHODS.map((method) => ({
      id: invocationId(method),
      service: WORKFLOW_SERVICE,
      // The namespace is its own wire field; the client reaches the methods as
      // `ctx.remote[WORKFLOW_NAMESPACE][method]`.
      namespace: WORKFLOW_NAMESPACE,
      method,
      invocation: { kind: 'direct' as const },
      parameters: [{ name: 'request', wire: 'request', source: 'json' as const, codec: parameterCodec(method) }],
      // A result codec may be `src-json`; only parameter codecs are checked.
      result: { mode: 'src-json' as const },
    })),
  }
}

/**
 * Mount the contribution, then return the typed method facade.
 * @param ctx - the client context.
 * @throws when the remote service is absent or the mount is rejected.
 */
export async function mountWorkflowRpc(ctx: ClientContextLike): Promise<WorkflowRpc> {
  const remote = ctx.remote
  if (remote === undefined || typeof remote.$mount !== 'function') {
    throw new Error('remote service unavailable')
  }
  await remote.$mount(buildContribution())

  const call =
    (method: string) =>
    async <T>(request: unknown): Promise<WireResult<T>> => {
      // Re-read the namespace per call: it is created by $mount and torn down
      // with the plugin's fiber. An unmounted namespace is `undefined`, not a
      // throwing stub.
      const namespace = remote[WORKFLOW_NAMESPACE] as RemoteNamespace | undefined
      const invoke = namespace?.[method]
      if (typeof invoke !== 'function') {
        return {
          ok: false,
          error: {
            code: 'remote/unavailable',
            message: `远程方法不可用：${WORKFLOW_NAMESPACE}.${method}`,
          },
        }
      }
      try {
        return (await invoke(request)) as WireResult<T>
      } catch (error) {
        return {
          ok: false,
          error: {
            code: 'remote/threw',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    }

  return {
    save: call('save'),
    list: call('list'),
    load: call('load'),
    remove: call('delete'),
    run: call('run'),
  }
}

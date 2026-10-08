/**
 * The workflow studio Host service.
 *
 * Shaped after the shipped `PluginInventoryGateway`: a `TypertRemoteService`
 * subclass instantiated by Cordis from a class definition, with its dependencies
 * read from `this.ctx`. The service key doubles as the Typert namespace, which is
 * what the gateway's binding check compares against.
 *
 * Every wire result is parsed with the same zod schema the descriptor declares,
 * so a malformed result fails loudly rather than becoming a silent type lie.
 */

import { SessionId } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, type TypertContextLike } from '@deepseek-ai/dsh-typert-protocol'

import { compile, CompileError } from '../shared/compiler.js'
import { WORKFLOW_NAMESPACE, WORKFLOW_SERVICE } from '../shared/descriptors.js'
import { newWorkflowId, parseRecord, WorkflowStore, type DomainLike } from './domain.js'
import { TYPERT } from './descriptors.js'
import {
  deleteResultSchema,
  listResultSchema,
  loadResultSchema,
  runResultSchema,
  saveResultSchema,
  type DeleteRequest,
  type LoadRequest,
  type RunProgress,
  type RunRequest,
  type RunResult,
  type SaveRequest,
  type WorkflowRecord,
} from './schemas.js'

/** How long a single run may take before the plugin cancels it. */
export const RUN_TIMEOUT_MS = 15 * 60 * 1000

/** The workflow Engine seam, narrowed to what this service calls. */
interface WorkflowRunLike {
  readonly id: string
  readonly result: Promise<{
    value: unknown
    stopReason: 'completed' | 'cancelled' | 'error'
    error?: string
    agentsStarted: number
  }>
  cancel(reason?: string): void
  dispose(): Promise<void>
}

interface WorkflowEngineLike {
  start(request: {
    script: string
    meta: { name: string; description: string }
    parent: unknown
    signal?: AbortSignal
  }): WorkflowRunLike
}

interface AgentHandleLike {
  agent: unknown
  dispose(): Promise<void>
}

interface AgentServiceLike {
  create(options: {
    sessionId: unknown
    meta?: { cwd?: string }
  }): Promise<AgentHandleLike>
}

interface StorageDomainService {
  open(spec: unknown): Promise<DomainLike>
}

interface TypertRegistryService {
  register(contribution: unknown): { (): Promise<void> } | void
}

/**
 * The Host half. Cordis instantiates it, so all dependencies are resolved here
 * rather than passed by a caller.
 */
export class WorkflowStudioGateway extends TypertRemoteService {
  /**
   * Services that must be live before this plugin activates.
   *
   * `workflowEngine` is deliberately NOT here. A hard dependency makes Cordis
   * hold the whole entry in `pending (waiting for service: workflowEngine)` when
   * no engine is mounted at the composition root — which silently costs the
   * panel, editor, and library, none of which need an engine. It is resolved
   * per run through `ctx.get('workflowEngine')` in {@link run} instead, so only
   * that one method reports the problem.
   */
  static inject = ['storageDomain', 'agents', 'typert']

  /**
   * The Typert wire namespace. The base class defaults this to the Cordis
   * service key, so a descriptor declaring a *different* namespace — as this one
   * does, `workflow` versus the `workflowStudio` key — is rejected by the
   * gateway with `binding-invalid` unless the namespace is passed through
   * explicitly. Declared as a static constant and read inside the constructor so
   * no instance field is touched before `super()`.
   */
  static readonly namespace = WORKFLOW_NAMESPACE

  /**
   * Resolves once the storage domain is open and the contribution registered,
   * or rejects when setup failed. It is kept already-caught so a setup failure
   * can never surface as an unhandled rejection: that would be a FATAL host load
   * failure, exiting the whole Harness process and pushing Desktop into safe
   * mode — a bad outcome for a plugin-level problem.
   */
  readonly #ready: Promise<WorkflowStore>
  #setupError: Error | undefined

  constructor(ctx: TypertContextLike) {
    super(ctx, WORKFLOW_SERVICE, { namespace: WorkflowStudioGateway.namespace })
    this.#ready = this.#initialize()
    // Attach the handler immediately; deleting the flag would recreate the
    // unhandled-rejection hazard.
    void this.#ready.catch(() => undefined)
  }

  /** Open the plugin's own domain and register the Client-facing contribution. */
  async #initialize(): Promise<WorkflowStore> {
    try {
      const context = this.ctx as unknown as {
        storageDomain: StorageDomainService
        typert: TypertRegistryService
      }
      // Imported lazily so the module resolves from the Harness installation.
      const { defineDomain, domainTable } = (await import('@deepseek-ai/dsh-storage-domain')) as unknown as {
        defineDomain(spec: unknown): unknown
        domainTable(schema: unknown): unknown
      }
      const { recordSchema } = await import('./schemas.js')

      const domain = await context.storageDomain.open(
        defineDomain({
          name: 'dsh_workflow',
          version: 1,
          layout: 'single',
          tables: { workflows: domainTable(recordSchema) },
        }),
      )
      this.ctx.effect(() => () => void domain.close(), 'workflow-studio: close dsh_workflow domain')

      // register() ties the contribution's lifetime to this plugin's fiber.
      // An invalid descriptor throws here; that is a bug in this plugin, and it
      // must degrade to failing RPC calls rather than killing the process.
      await context.typert.register(TYPERT)

      return new WorkflowStore(domain)
    } catch (error) {
      this.#setupError = error instanceof Error ? error : new Error(String(error))
      throw this.#setupError
    }
  }

  /** The store, or a descriptive error when setup failed. */
  async #requireStore(): Promise<WorkflowStore> {
    try {
      return await this.#ready
    } catch {
      throw new Error(`workflow-studio 初始化失败：${this.#setupError?.message ?? 'unknown error'}`)
    }
  }

  /** `workflow/save` — validate the DAG, then persist it. */
  async save(request: SaveRequest): Promise<unknown> {
    const store = await this.#requireStore()
    // Compiling first means an uncompilable DAG is never stored.
    compile(request.graph)

    const existing = request.id ? store.get(request.id) : undefined
    const now = new Date().toISOString()
    const record: WorkflowRecord = {
      id: existing?.id ?? request.id ?? newWorkflowId(),
      name: request.name,
      ...(request.description !== undefined ? { description: request.description } : {}),
      graph: request.graph,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    await store.put(record)
    return saveResultSchema.parse({ id: record.id, updatedAt: record.updatedAt })
  }

  /** `workflow/list` — summaries, newest first. */
  async list(): Promise<unknown> {
    const store = await this.#requireStore()
    const rows = store.list().map((record) => ({
      id: record.id,
      name: record.name,
      ...(record.description !== undefined ? { description: record.description } : {}),
      nodeCount: record.graph.nodes.length,
      updatedAt: record.updatedAt,
    }))
    return listResultSchema.parse(rows)
  }

  /** `workflow/load` — one record, or null when the id is unknown. */
  async load(request: LoadRequest): Promise<unknown> {
    const store = await this.#requireStore()
    const record = store.get(request.id)
    return loadResultSchema.parse(record === undefined ? null : parseRecord(record))
  }

  /** `workflow/delete` — true when a record was removed. */
  async delete(request: DeleteRequest): Promise<unknown> {
    const store = await this.#requireStore()
    return deleteResultSchema.parse({ deleted: await store.remove(request.id) })
  }

  /** `workflow/run` — compile, start a run, and wait for its result. */
  async run(request: RunRequest): Promise<unknown> {
    const store = await this.#requireStore()
    const context = this.ctx as unknown as {
      agents: AgentServiceLike
      get(name: string): WorkflowEngineLike | undefined
      on(event: string, listener: (...args: any[]) => void): () => void
    }

    // Resolved per run rather than injected: see the `inject` note above. A
    // missing engine is reported as a plain RPC failure for this method only.
    const engine = context.get('workflowEngine')
    if (engine === undefined) {
      throw new Error(
        'workflowEngine 服务不可用：请在 profile 组合中挂载 @deepseek-ai/dsh-workflow-ptc（本插件的 cordis.patch.yml 已包含该行）',
      )
    }

    const record = request.id ? store.get(request.id) : undefined
    const graph = request.graph ?? record?.graph
    if (graph === undefined) {
      throw new Error(
        request.id ? `找不到工作流 ${request.id}，无法运行` : '运行请求既没有 graph 也没有 id',
      )
    }

    const compiled = compile(graph)
    const script = request.script ?? compiled.script
    const scope = compiled.order
    const progress: RunProgress[] = []
    let seq = 0

    const push = (kind: RunProgress['kind'], message: string): void => {
      seq += 1
      // A phase title is the node id: `phase()` takes exactly one argument in
      // this Harness version, so the id is the only channel that reaches here.
      const nodeId = kind === 'phase' && scope.includes(message) ? message : undefined
      progress.push({ seq, kind, ...(nodeId !== undefined ? { nodeId } : {}), message })
    }

    // The engine enforces no overall elapsed-time limit, so cancel on a timer.
    const controller = new AbortController()
    const timer = setTimeout(() => {
      push('log', `运行超过 ${RUN_TIMEOUT_MS / 60000} 分钟，已超时取消`)
      controller.abort()
    }, RUN_TIMEOUT_MS)

    // The engine dereferences `parent.session` synchronously, so `parent` must
    // be a real live Agent — and the caller owns disposing it.
    let handle: AgentHandleLike
    try {
      handle = await context.agents.create({
        sessionId: SessionId(`workflow-studio-${Date.now().toString(36)}`),
        ...(request.cwd !== undefined ? { meta: { cwd: request.cwd } } : {}),
      })
    } catch (error) {
      clearTimeout(timer)
      throw error
    }

    let run: WorkflowRunLike
    try {
      run = engine.start({
        script,
        meta: {
          name: `workflow-studio:${record?.name ?? 'inline'}`.slice(0, 120),
          description: 'Visual workflow studio run',
        },
        parent: handle.agent,
        signal: controller.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      await handle.dispose().catch(() => undefined)
      throw error
    }

    // Bridge engine lifecycle events into the returned progress list.
    const offPhase = context.on('workflow/phase', (info: { id: string }, title: unknown) => {
      if (info.id === run.id) push('phase', String(title))
    })
    const offLog = context.on('workflow/log', (info: { id: string }, message: unknown) => {
      if (info.id === run.id) push('log', String(message))
    })

    try {
      const settled = await run.result
      const result: RunResult = {
        runId: run.id,
        stopReason: settled.stopReason,
        value: settled.value,
        ...(settled.error !== undefined ? { error: settled.error } : {}),
        agentsStarted: settled.agentsStarted,
        progress,
      }
      return runResultSchema.parse(result)
    } finally {
      clearTimeout(timer)
      offPhase()
      offLog()
      // Every path must release both the run and the parent agent it owns.
      await run.dispose().catch(() => undefined)
      await handle.dispose().catch(() => undefined)
    }
  }
}

export default WorkflowStudioGateway

/** Human-readable compile failure, for a caller that wants to render it. */
export function describeCompileError(error: unknown): string {
  if (error instanceof CompileError) return error.message
  return error instanceof Error ? error.message : String(error)
}

/**
 * Workflow editor state: the graph, the selected node, the saved library, and
 * the connection to the host RPC facade.
 *
 * Kept out of the React components so the panel stays presentational and the
 * data flow stays reviewable in one place.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { DocumentSession, mintNodeId } from './document-session.js'

import { compile, CompileError } from '../shared/compiler.js'
import { SAMPLE_DESCRIPTION, SAMPLE_NAME, sampleGraph } from '../shared/sample.js'
import { failureMessage, type ClientContextLike, type WorkflowRpc } from './remote.js'
import type {
  NodeKind,
  RunResult,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowSummary,
} from './types.js'

/** Node kinds in palette order. */
const KINDS: NodeKind[] = ['input', 'llm', 'code', 'branch', 'output']

/** Sensible starting parameters for a freshly added node. */
function defaultParams(kind: NodeKind): WorkflowNode['params'] {
  switch (kind) {
    case 'input':
      return { input: '在此输入起始文本' }
    case 'llm':
      return { prompt: '请根据以下内容完成任务：\n{{input}}' }
    case 'code':
      return { code: 'return input' }
    case 'branch':
      return { condition: { type: 'len_gt', value: '500' } }
    case 'output':
      return {}
    default:
      return {}
  }
}

/** Public state and actions the panel renders. */
export interface StudioState {
  graph: WorkflowGraph
  name: string
  description: string
  currentId: string | undefined
  selectedId: string | undefined
  library: WorkflowSummary[]
  run: RunResult | undefined
  running: boolean
  status: { kind: 'idle' | 'ok' | 'warn' | 'error'; text: string } | undefined
  dirty: boolean
  t: (key: string, params?: Record<string, unknown>) => string
  setName(value: string): void
  selectNode(id: string | undefined): void
  addNode(kind: NodeKind): void
  updateNode(id: string, patch: Partial<WorkflowNode>): void
  updateParams(id: string, patch: NonNullable<WorkflowNode['params']>): void
  removeNode(id: string): void
  connect(edge: WorkflowEdge): void
  removeEdge(id: string): void
  moveNode(id: string, position: { x: number; y: number }): void
  newWorkflow(): void
  loadSample(): void
  validate(): void
  save(): Promise<void>
  open(id: string): Promise<void>
  remove(id: string): Promise<void>
  refreshLibrary(): Promise<void>
  runWorkflow(): Promise<void>
}

/**
 * Build the editor state.
 * @param ctx - the client context, used for the locale service.
 * @param rpc - the mounted remote facade, or undefined when the mount failed.
 * @param mountError - why the mount failed, so the panel can say so.
 */
export function useStudio(
  ctx: ClientContextLike,
  rpc: WorkflowRpc | undefined,
  mountError: string | undefined,
  sampleOverride?: { name: string; description: string; graph: WorkflowGraph },
): StudioState {
  const session = useRef(new DocumentSession()).current
  const saving = useRef(false)
  const bind = useMemo(() => {
    const translate = ctx.locale?.bind('workflow-studio')
    return (key: string, params?: Record<string, unknown>): string => {
      if (!translate) return key
      const value = translate(key, params)
      // The locale service echoes the key when a dictionary entry is missing.
      return typeof value === 'string' ? value : key
    }
  }, [ctx])

  const [graph, setGraph] = useState<WorkflowGraph>(() => ({ nodes: [], edges: [] }))
  const [name, setName] = useState('未命名工作流')
  const [description, setDescription] = useState('')
  const [currentId, setCurrentId] = useState<string | undefined>(undefined)
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined)
  const [library, setLibrary] = useState<WorkflowSummary[]>([])
  const [run, setRun] = useState<RunResult | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<StudioState['status']>(undefined)

  /** One typed call, or a synthesized failure when the mount never happened. */
  const call = useCallback(
    async <T>(
      endpoint: string,
      request: unknown,
    ): Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }> => {
      if (rpc === undefined) {
        return {
          ok: false,
          error: {
            code: 'remote/unmounted',
            message: mountError !== undefined ? `${bind('error.noRemote')}: ${mountError}` : bind('error.noRemote'),
          },
        }
      }
      const method = rpc[endpoint as keyof WorkflowRpc]
      return (await method.call(rpc, request)) as
        | { ok: true; value: T }
        | { ok: false; error: { code: string; message: string } }
    },
    [bind, mountError, rpc],
  )

  const refreshLibrary = useCallback(async () => {
    const result = await call<WorkflowSummary[]>('list', {})
    if (result.ok) setLibrary(result.value)
    else setStatus({ kind: 'error', text: failureMessage(result.error) })
  }, [call])

  useEffect(() => {
    if (mountError !== undefined) {
      setStatus({ kind: 'error', text: `${bind('error.noRemote')}: ${mountError}` })
      return
    }
    void refreshLibrary()
  }, [bind, mountError, refreshLibrary])

  /** Apply a graph edit and mark the document dirty. */
  const edit = useCallback((next: (current: WorkflowGraph) => WorkflowGraph) => {
    session.edit()
    setGraph((current) => next(current))
    setDirty(true)
    setStatus(undefined)
  }, [])

  const addNode = useCallback(
    (kind: NodeKind) => {
      const id = mintNodeId(kind, graph.nodes.map(node => node.id))
      const count = graph.nodes.length
      edit((current) => ({
        ...current,
        nodes: [
          ...current.nodes,
          {
            id,
            kind,
            label: bind(`kind.${kind}`),
            params: defaultParams(kind),
            position: { x: 80 + (count % 4) * 230, y: 80 + Math.floor(count / 4) * 150 },
          },
        ],
      }))
      setSelectedId(id)
    },
    [bind, edit, graph.nodes],
  )

  const updateNode = useCallback(
    (id: string, patch: Partial<WorkflowNode>) => {
      edit((current) => ({
        ...current,
        nodes: current.nodes.map((node) => (node.id === id ? { ...node, ...patch } : node)),
      }))
    },
    [edit],
  )

  const updateParams = useCallback(
    (id: string, patch: NonNullable<WorkflowNode['params']>) => {
      edit((current) => ({
        ...current,
        nodes: current.nodes.map((node) =>
          node.id === id ? { ...node, params: { ...node.params, ...patch } } : node,
        ),
      }))
    },
    [edit],
  )

  const removeNode = useCallback(
    (id: string) => {
      edit((current) => ({
        nodes: current.nodes.filter((node) => node.id !== id),
        edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id),
      }))
      setSelectedId((selected) => (selected === id ? undefined : selected))
    },
    [edit],
  )

  const connect = useCallback(
    (edge: WorkflowEdge) => {
      edit((current) => {
        // One edge per source handle: replacing keeps a branch to two arms.
        const edges = current.edges.filter(
          (existing) =>
            !(existing.source === edge.source && (existing.sourceHandle ?? null) === (edge.sourceHandle ?? null)),
        )
        return { ...current, edges: [...edges, edge] }
      })
    },
    [edit],
  )

  const removeEdge = useCallback(
    (id: string) => {
      edit((current) => ({ ...current, edges: current.edges.filter((edge) => edge.id !== id) }))
    },
    [edit],
  )

  const moveNode = useCallback(
    (id: string, position: { x: number; y: number }) => {
      edit((current) => ({
        ...current,
        nodes: current.nodes.map((node) => (node.id === id ? { ...node, position } : node)),
      }))
    },
    [edit],
  )

  const newWorkflow = useCallback(() => {
    session.replace()
    setGraph({ nodes: [], edges: [] })
    setName('未命名工作流')
    setDescription('')
    setCurrentId(undefined)
    setSelectedId(undefined)
    setRun(undefined)
    setDirty(false)
    setStatus(undefined)
  }, [])

  const loadSample = useCallback(() => {
    session.replace()
    setGraph(sampleOverride ? structuredClone(sampleOverride.graph) : sampleGraph())
    setName(sampleOverride?.name ?? SAMPLE_NAME)
    setDescription(sampleOverride?.description ?? SAMPLE_DESCRIPTION)
    setCurrentId(undefined)
    setSelectedId(undefined)
    setRun(undefined)
    setDirty(true)
    setStatus(undefined)
  }, [sampleOverride])

  const validate = useCallback(() => {
    try {
      const compiled = compile(graph)
      setStatus({ kind: 'ok', text: `${bind('status.compiled')} · ${compiled.order.length} nodes` })
    } catch (error) {
      const message = error instanceof CompileError ? error.message : String(error)
      setStatus({ kind: 'error', text: message })
    }
  }, [bind, graph])

  const save = useCallback(async () => {
    if (saving.current) return
    if (name.trim().length === 0) {
      setStatus({ kind: 'error', text: bind('error.noName') })
      return
    }
    const stamp = session.stamp()
    saving.current = true
    setStatus({ kind: 'warn', text: bind('status.saving') })
    try {
      const result = await call<{ id: string; updatedAt: string }>('save', {
      ...(currentId !== undefined ? { id: currentId } : {}),
      name: name.trim(),
      description,
      graph,
    })
      if (result.ok) {
        if (session.sameDocument(stamp)) {
          setCurrentId(result.value.id)
          setDirty(!session.unchanged(stamp))
          setStatus(session.unchanged(stamp) ? { kind: 'ok', text: bind('status.saved') } : undefined)
        }
        await refreshLibrary()
      } else if (session.sameDocument(stamp)) {
        setStatus({ kind: 'error', text: `${bind('error.saveFailed')}: ${failureMessage(result.error)}` })
      }
    } finally { saving.current = false }
  }, [bind, call, currentId, description, graph, name, refreshLibrary])

  const open = useCallback(
    async (id: string) => {
      session.replace()
      const stamp = session.stamp()
      const result = await call<
        { id: string; name: string; description?: string; graph: WorkflowGraph } | null
      >('load', { id })
      if (!session.unchanged(stamp)) return
      if (!result.ok) {
        setStatus({ kind: 'error', text: `${bind('error.loadFailed')}: ${failureMessage(result.error)}` })
        return
      }
      if (result.value === null) {
        setStatus({ kind: 'warn', text: bind('error.loadFailed') })
        return
      }
      // The displayed document changes here. Invalidate any save started while
      // the previous graph was still visible during this load request.
      session.replace()
      setGraph(result.value.graph)
      setName(result.value.name)
      setDescription(result.value.description ?? '')
      setCurrentId(result.value.id)
      setSelectedId(undefined)
      setRun(undefined)
      setDirty(false)
      setStatus(undefined)
    },
    [bind, call],
  )

  const remove = useCallback(
    async (id: string) => {
      const stamp = session.stamp()
      const result = await call<{ deleted: boolean }>('remove', { id })
      if (!result.ok) {
        setStatus({ kind: 'error', text: `${bind('error.deleteFailed')}: ${failureMessage(result.error)}` })
        return
      }
      if (currentId === id && session.sameDocument(stamp)) setCurrentId(undefined)
      await refreshLibrary()
    },
    [bind, call, currentId, refreshLibrary],
  )

  const runWorkflow = useCallback(async () => {
    const stamp = session.stamp()
    // Compile here too, so the user sees the rejection without a round trip.
    try {
      compile(graph)
    } catch (error) {
      const message = error instanceof CompileError ? error.message : String(error)
      setStatus({ kind: 'error', text: message })
      return
    }

    setRunning(true)
    setRun(undefined)
    setStatus({ kind: 'warn', text: bind('run.running') })
    try {
      // `meta` accepts no cwd and this panel has no parent session, so the run
      // uses the host's default working directory.
      const result = await call<RunResult>('run', { graph })
      if (!session.unchanged(stamp)) return
      if (result.ok) {
        setRun(result.value)
        setStatus({
          kind: result.value.stopReason === 'completed' ? 'ok' : 'error',
          text: `${bind(`run.${result.value.stopReason}`)}${
            result.value.error ? `: ${result.value.error}` : ''
          }`,
        })
      } else {
        setStatus({ kind: 'error', text: `${bind('error.runFailed')}: ${failureMessage(result.error)}` })
      }
    } finally {
      setRunning(false)
    }
  }, [bind, call, graph])
  return {
    graph,
    name,
    description,
    currentId,
    selectedId,
    library,
    run,
    running,
    status,
    dirty,
    t: bind,
    setName: value => { session.edit(); setName(value); setDirty(true); setStatus(undefined) },
    selectNode: setSelectedId,
    addNode,
    updateNode,
    updateParams,
    removeNode,
    connect,
    removeEdge,
    moveNode,
    newWorkflow,
    loadSample,
    validate,
    save,
    open,
    remove,
    refreshLibrary,
    runWorkflow,
  }
}

/** Node kinds in palette order, re-exported for the sidebar. */
export { KINDS }

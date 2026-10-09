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
import {
  EXTRA_TEMPLATES,
  SAMPLE_DESCRIPTION,
  SAMPLE_NAME,
  sampleGraph,
} from '../shared/sample.js'
import { failureMessage, type ClientContextLike, type WorkflowRpc } from './remote.js'
import {
  clearUnknownExecutors,
  copySelection,
  dropEmptyGroups,
  flowIdOfGroup,
  groupIdOf,
  mergeWorkflow,
  paste,
  renameGroup as renameGroupOf,
  setCollapsed,
  ungroup as ungroupOf,
  unknownExecutors,
  groupSelection,
  type NodeClipboard,
} from './graph-edit.js'
import type {
  ConnectorCatalog,
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
  /**
   * The node the property panel edits: exactly one selected node, and nothing
   * when several are selected. Two nodes named 大纲 is allowed on the canvas; the
   * panel editing "both at once" is not.
   */
  selectedId: string | undefined
  /** The selected node ids, in the order they were selected. */
  selection: string[]
  /** A folded block under the cursor or click, when the selection is one. */
  selectedGroupId: string | undefined
  /** True once something has been copied, so `粘贴` has a target. */
  canPaste: boolean
  library: WorkflowSummary[]
  run: RunResult | undefined
  running: boolean
  status: { kind: 'idle' | 'ok' | 'warn' | 'error'; text: string } | undefined
  dirty: boolean
  t: (key: string, params?: Record<string, unknown>) => string
  setName(value: string): void
  selectNode(id: string | undefined): void
  /** Replace the selection outright, which is what a marquee drag does. */
  selectMany(ids: string[]): void
  /** Copy the current selection to the editor clipboard. */
  copy(): void
  /** Paste the clipboard in, with all-new ids. */
  paste(): void
  importWorkflow(id: string): Promise<void>
  groupSelection(): void
  ungroup(groupId: string): void
  setGroupCollapsed(groupId: string, collapsed: boolean): void
  renameGroup(groupId: string, label: string): void
  /** Drop the bindings that name a connector this machine does not have. */
  clearUnknownBindings(): void
  addNode(kind: NodeKind): void
  updateNode(id: string, patch: Partial<WorkflowNode>): void
  updateParams(id: string, patch: NonNullable<WorkflowNode['params']>): void
  removeNode(id: string): void
  connect(edge: WorkflowEdge): void
  removeEdge(id: string): void
  moveNode(id: string, position: { x: number; y: number }): void
  newWorkflow(): void
  /**
   * The built-in starting points. The first is whatever this deployment calls its
   * example; the explicit round-chain template and any later ones follow it.
   */
  templates: readonly { name: string; description: string }[]
  loadTemplate(index: number): void
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
 * @param sampleOverride - the standalone edition's first-run example.
 * @param connectors - the local connector catalogue, used only to tell an import
 *   which executor bindings this machine cannot honour. Absent means unknown,
 *   which is reported as a warning rather than as a clean import.
 */
export function useStudio(
  ctx: ClientContextLike,
  rpc: WorkflowRpc | undefined,
  mountError: string | undefined,
  sampleOverride?: { name: string; description: string; graph: WorkflowGraph },
  connectors?: ConnectorCatalog,
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
  /**
   * The selection is a set, and the panel target is derived from it: exactly one
   * selected node. Keeping one array rather than a set plus a separate "current"
   * id is what stops the highlight and the property panel disagreeing after a
   * marquee drag.
   */
  const [selection, setSelection] = useState<string[]>([])
  const [clipboard, setClipboard] = useState<NodeClipboard>()
  /** How many times the current clipboard has been pasted, for the offset step. */
  const pasteCount = useRef(0)
  const [library, setLibrary] = useState<WorkflowSummary[]>([])
  const [run, setRun] = useState<RunResult | undefined>(undefined)
  const [running, setRunning] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [status, setStatus] = useState<StudioState['status']>(undefined)

  /** The one node the property panel edits, or nothing when several are picked. */
  const selectedId = selection.length === 1 ? selection[0] : undefined
  /**
   * A folded block counts as a selection of its own. Its id carries a prefix, so a
   * block can never be mistaken for a node — including by a click.
   */
  const selectedGroupId = selection.length === 1 ? groupIdOf(selection[0] ?? '') : undefined

  /**
   * Select one node, or nothing.
   *
   * Additive selection is not this action's job: React Flow reports a Ctrl/Cmd-click
   * and a marquee as `select` changes, which the canvas applies through `selectMany`.
   */
  const selectNode = useCallback((id: string | undefined) => {
    setSelection(id === undefined ? [] : [id])
  }, [])

  /** Marquee drag: whatever ended up inside the rectangle is the selection. */
  const selectMany = useCallback((ids: string[]) => setSelection(ids), [])

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
      setSelection([id])
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
      // `...current` matters: a graph is nodes, edges *and* groups, and rebuilding
      // the object from scratch here used to drop every group the moment any node
      // was deleted. A group whose last member goes is dropped on purpose — that one
      // has nothing left to draw.
      edit((current) => dropEmptyGroups({
        ...current,
        nodes: current.nodes.filter((node) => node.id !== id),
        edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id),
      }))
      setSelection((current) => current.filter((one) => one !== id))
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

  /** Copy the selected nodes. Nothing leaves the editor: this is an internal clipboard. */
  const copy = useCallback(() => {
    const nodes = selection.filter((id) => groupIdOf(id) === undefined)
    if (nodes.length === 0) {
      setStatus({ kind: 'warn', text: bind('status.copyEmpty') })
      return
    }
    setClipboard(copySelection(graph, nodes))
    pasteCount.current = 0
    setStatus({ kind: 'ok', text: bind('status.copied', { n: nodes.length }) })
  }, [bind, graph, selection])

  const pasteHere = useCallback(() => {
    if (clipboard === undefined) return
    pasteCount.current += 1
    const outcome = paste(graph, clipboard, pasteCount.current)
    edit(() => outcome.graph)
    setSelection(outcome.pasted)
    setStatus({
      kind: outcome.entries.length > 0 ? 'warn' : 'ok',
      // A paste always needs one more connection: the copy never brings the host
      // input with it, so say where to attach rather than leaving a dead group.
      text: outcome.entries.length > 0
        ? bind('status.pastedConnect', { n: outcome.pasted.length, where: outcome.entries[0] })
        : bind('status.pasted', { n: outcome.pasted.length }),
    })
  }, [bind, clipboard, edit, graph])

  /**
   * Pull a saved workflow into the current graph as a node group.
   *
   * The load is read-only: nothing here changes the library entry, and the merged
   * nodes are ordinary canvas nodes afterwards.
   */
  const importWorkflow = useCallback(
    async (id: string) => {
      const row = library.find((summary) => summary.id === id)
      const result = await call<{ name: string; graph: WorkflowGraph } | null>('load', { id })
      if (!result.ok) {
        setStatus({ kind: 'error', text: `${bind('error.loadFailed')}: ${failureMessage(result.error)}` })
        return
      }
      if (result.value === null) {
        setStatus({ kind: 'warn', text: bind('error.loadFailed') })
        return
      }
      const outcome = mergeWorkflow(graph, result.value.graph)
      edit(() => outcome.graph)
      setSelection(outcome.pasted)
      const stale = connectors === undefined
        ? []
        : unknownExecutors(outcome.graph, connectors.connectors.map((one) => one.id))
      setStatus({
        kind: stale.length > 0 ? 'error' : 'warn',
        text: stale.length > 0
          ? bind('status.importMissingConnector', {
            name: row?.name ?? result.value.name,
            nodes: stale.map((one) => `${one.label}→${one.executor}`).join('、'),
          })
          : bind('status.imported', {
            name: row?.name ?? result.value.name,
            n: outcome.pasted.length,
            dropped: outcome.droppedInputs,
          }),
      })
    },
    [bind, call, connectors, edit, graph, library],
  )

  /** The bindings an import found that this machine cannot honour, if any. */
  const staleBindings = useCallback((): string[] => {
    if (connectors === undefined) return []
    return unknownExecutors(graph, connectors.connectors.map((one) => one.id)).map((row) => row.nodeId)
  }, [connectors, graph])

  const clearUnknownBindings = useCallback(() => {
    if (connectors === undefined) return
    const before = staleBindings().length
    edit((current) => clearUnknownExecutors(current, connectors.connectors.map((one) => one.id)))
    setStatus({
      kind: before > 0 ? 'ok' : 'warn',
      text: before > 0 ? bind('status.bindingsCleared', { n: before }) : bind('status.noStaleBindings'),
    })
  }, [bind, connectors, edit, staleBindings])

  const groupNodes = useCallback(() => {
    const ids = selection.filter((id) => groupIdOf(id) === undefined)
    // The round number is only known inside the grouping, so the title comes as a
    // formatter bound to the active locale.
    const result = groupSelection(graph, ids, (round) => bind('group.round', { n: round }))
    if (result.groupId === undefined) {
      setStatus({ kind: 'warn', text: bind('status.groupNeedsTwo') })
      return
    }
    edit(() => result.graph)
    setSelection([flowIdOfGroup(result.groupId)])
    setStatus({ kind: 'ok', text: bind('status.grouped', { n: ids.length }) })
  }, [bind, edit, graph, selection])

  const ungroup = useCallback(
    (groupId: string) => {
      edit((current) => ungroupOf(current, groupId))
      setSelection([])
    },
    [edit],
  )

  const collapseGroup = useCallback(
    (groupId: string, collapsed: boolean) => {
      edit((current) => setCollapsed(current, groupId, collapsed))
    },
    [edit],
  )

  const labelGroup = useCallback(
    (groupId: string, label: string) => {
      edit((current) => renameGroupOf(current, groupId, label))
    },
    [edit],
  )

  const newWorkflow = useCallback(() => {
    session.replace()
    setGraph({ nodes: [], edges: [] })
    setName('未命名工作流')
    setDescription('')
    setCurrentId(undefined)
    setSelection([])
    // A clipboard from the previous document must not be pastable into this one.
    setClipboard(undefined)
    setRun(undefined)
    setDirty(false)
    setStatus(undefined)
  }, [])

  /**
   * The template list: this deployment's example first, then the shared ones.
   *
   * The standalone edition opens with a workflow that runs with no model at all,
   * so it stays the head of the list rather than being replaced by the shipped
   * templates.
   */
  const templates = useMemo(
    () => [
      {
        name: sampleOverride?.name ?? SAMPLE_NAME,
        description: sampleOverride?.description ?? SAMPLE_DESCRIPTION,
      },
      ...EXTRA_TEMPLATES.map(({ name, description }) => ({ name, description })),
    ],
    [sampleOverride],
  )

  const loadTemplate = useCallback(
    (index: number) => {
      const template = index === 0
        ? {
          name: sampleOverride?.name ?? SAMPLE_NAME,
          description: sampleOverride?.description ?? SAMPLE_DESCRIPTION,
          graph: sampleOverride ? structuredClone(sampleOverride.graph) : sampleGraph(),
        }
        : EXTRA_TEMPLATES[index - 1]
      if (template === undefined) return
      session.replace()
      setGraph(structuredClone(template.graph))
      setName(template.name)
      setDescription(template.description)
      setCurrentId(undefined)
      setSelection([])
      setClipboard(undefined)
      setRun(undefined)
      setDirty(true)
      setStatus({ kind: 'ok', text: bind('status.templateLoaded', { name: template.name }) })
    },
    [bind, sampleOverride, session],
  )

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
      setSelection([])
      setClipboard(undefined)
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
    selection,
    selectedGroupId,
    canPaste: clipboard !== undefined,
    library,
    run,
    running,
    status,
    dirty,
    t: bind,
    setName: value => { session.edit(); setName(value); setDirty(true); setStatus(undefined) },
    selectNode,
    selectMany,
    copy,
    paste: pasteHere,
    importWorkflow,
    groupSelection: groupNodes,
    ungroup,
    setGroupCollapsed: collapseGroup,
    renameGroup: labelGroup,
    clearUnknownBindings,
    addNode,
    updateNode,
    updateParams,
    removeNode,
    connect,
    removeEdge,
    moveNode,
    newWorkflow,
    templates,
    loadTemplate,
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

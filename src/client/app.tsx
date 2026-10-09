/**
 * The full-screen workflow panel: header actions, then three columns —
 * palette/library, canvas, and inspector plus run output.
 */

import * as React from 'react'

import { Canvas, type StudioNodeData } from './canvas.js'
import { StudioInspector } from './inspector.js'
import { RunPanel } from './run-panel.js'
import { StudioSidebar } from './sidebar.js'
import { useStudio } from './state.js'
import type { ClientContextLike, WorkflowRpc } from './remote.js'
import type { WireResult } from './remote.js'
import type { WorkflowGraph } from './types.js'
import type { ConnectorCatalog, TranslateCall } from './types.js'
import { compile } from '../shared/compiler.js'

// Both stylesheets are inlined as text by esbuild's `text` loader and injected
// with the panel, so unmounting the panel removes them.
import REACT_FLOW_CSS from '@xyflow/react/dist/style.css'
import STUDIO_CSS from './styles.css'

const h = React.createElement

interface PanelProps {
  ctx: ClientContextLike
  rpc: WorkflowRpc | undefined
  mountError: string | undefined
  sampleOverride?: { name: string; description: string; graph: WorkflowGraph }
  importDocument?: (document: unknown) => Promise<WireResult<{ id: string }>>
  /** Outbound connectors, when the deployment exposes them. */
  connectors?: ConnectorCatalog
  /**
   * Plain-language configuration, when the deployment can translate at all. The
   * standalone edition wires it to `POST /api/translate`; the Harness plugin has
   * no connector registry, so its panel keeps expert fields only.
   */
  translate?: TranslateCall
}

/** One header button. */
function Button(props: {
  label: string
  onClick(): void
  variant?: 'primary' | 'danger' | 'accent'
  disabled?: boolean
  /**
   * Hover text. The template buttons carry the template's own description here,
   * because the header shows a name and nothing else — what a template actually
   * draws on the canvas is the part that decides whether to click it.
   */
  hint?: string
}): React.ReactElement {
  const classes = ['wfs-button']
  if (props.variant === 'primary') classes.push('wfs-button-primary')
  if (props.variant === 'danger') classes.push('wfs-button-danger')
  if (props.variant === 'accent') classes.push('wfs-button-accent')
  return h(
    'button',
    {
      type: 'button',
      className: classes.join(' '),
      disabled: props.disabled ?? false,
      onClick: props.onClick,
      ...(props.hint === undefined ? {} : { title: props.hint }),
    },
    props.label,
  )
}

/** The panel body. */
export function WorkflowPanel({ ctx, rpc, mountError, sampleOverride, importDocument, connectors, translate }: PanelProps): React.ReactElement {
  const state = useStudio(ctx, rpc, mountError, sampleOverride, connectors)
  const fileInput = React.useRef<HTMLInputElement>(null)
  const [fileError, setFileError] = React.useState<string>()
  const [exportedJson, setExportedJson] = React.useState<string>()

  /**
   * The latest state, for the keydown listener below.
   *
   * `useStudio` returns a fresh object every render, so depending on it would
   * detach and re-attach the window listener on each one — correct, but pointless
   * churn on the hottest path in the editor. One binding instead, reading through a
   * ref that is refreshed after every render.
   */
  const latest = React.useRef(state)
  React.useEffect(() => {
    latest.current = state
  })

  /**
   * Ctrl/Cmd+C and Ctrl/Cmd+V on the canvas.
   *
   * While a text field has focus the keystroke belongs to the field: someone
   * copying a prompt out of the property panel must not have their node copied
   * instead. The paste target is the editor's own clipboard, not the system one,
   * because a workflow node has no representation outside this app that would mean
   * anything.
   */
  React.useEffect(() => {
    const editing = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable
    }
    const onKey = (event: KeyboardEvent) => {
      const studio = latest.current
      if (!(event.ctrlKey || event.metaKey) || editing(event.target)) return
      const key = event.key.toLowerCase()
      if (key === 'c' && studio.selection.length > 0) {
        event.preventDefault()
        studio.copy()
      } else if (key === 'v' && studio.canPaste) {
        event.preventDefault()
        studio.paste()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const exportDocument = () => {
    try {
      compile(state.graph)
      const document = { format: 'dsh-workflow-studio', version: 1,
        workflow: { name: state.name.trim() || '未命名工作流', description: state.description, graph: state.graph } }
      setExportedJson(JSON.stringify(document, null, 2))
      setFileError(undefined)
    } catch (error) { setFileError(error instanceof Error ? error.message : String(error)) }
  }
  const downloadDocument = () => {
    try {
      const url = URL.createObjectURL(new Blob([exportedJson ?? ''], { type: 'application/json' }))
      const link = window.document.createElement('a')
      link.href = url
      link.download = `${state.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 80) || 'workflow'}.json`
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setFileError(undefined)
    } catch (error) { setFileError(error instanceof Error ? error.message : String(error)) }
  }
  const { t, run, running } = state

  // Node colouring follows the recorded phase markers: everything before the
  // current phase is done, the current phase is active.
  const statusOf = React.useCallback(
    (id: string): StudioNodeData['status'] => {
      if (run === undefined) return 'idle'
      const phases = run.progress.filter((entry) => entry.kind === 'phase')
      const index = phases.findIndex((entry) => entry.nodeId === id || entry.message === id)
      if (index === -1) return 'idle'
      const last = phases.length - 1
      if (run.stopReason === 'error' && index === last) return 'error'
      if (index === last && running) return 'active'
      return 'done'
    },
    [run, running],
  )

  const status = state.status
  const statusClass =
    status === undefined
      ? ''
      : status.kind === 'ok'
        ? ' wfs-status-ok'
        : status.kind === 'warn'
          ? ' wfs-status-warn'
          : status.kind === 'error'
            ? ' wfs-status-error'
            : ''

  return h(
    'div',
    { className: 'wfs-root' },
    // Component-local styles: removing the panel removes them.
    h('style', { key: 'styles' }, `${REACT_FLOW_CSS}\n${STUDIO_CSS}`),
    h(
      'div',
      { className: 'wfs-header', key: 'header' },
      h('span', { className: 'wfs-title' }, t('panel.title')),
      h('span', { className: 'wfs-subtitle' }, t('panel.subtitle')),
      h('input', {
        className: 'wfs-input',
        style: { width: '220px' },
        value: state.name,
        'aria-label': t('panel.title'),
        onChange: (event: React.ChangeEvent<HTMLInputElement>) => state.setName(event.target.value),
      }),
      h('div', { className: 'wfs-spacer' }),
      state.dirty ? h('span', { className: 'wfs-status wfs-status-warn' }, t('status.dirty')) : null,
      h(Button, { label: t('action.new'), onClick: state.newWorkflow }),
      // The template list. The first entry keeps the label the panel has always
      // used; the explicit round chain follows it as its own named starting point.
      ...state.templates.map((template, index) => h(Button, {
        key: template.name,
        label: index === 0 ? t('action.sample') : template.name,
        hint: template.description,
        onClick: () => state.loadTemplate(index),
      })),
      h(Button, { label: t('action.compile'), onClick: state.validate }),
      h(Button, { label: t('action.save'), onClick: () => void state.save(), variant: 'primary' }),
      importDocument ? h(Button, { label: '导入 JSON', onClick: () => fileInput.current?.click(), disabled: running }) : null,
      importDocument ? h(Button, { label: '导出 JSON', onClick: exportDocument, disabled: state.graph.nodes.length === 0 }) : null,
      importDocument ? h('input', {
        ref: fileInput, type: 'file', accept: '.json,application/json', hidden: true,
        onChange: async (event: React.ChangeEvent<HTMLInputElement>) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (!file) return
          try {
            if (file.size > 2 * 1024 * 1024) throw new Error('文件超过 2 MB')
            const result = await importDocument(JSON.parse(await file.text()))
            if (!result.ok) throw new Error(result.error.message ?? '导入失败')
            await state.refreshLibrary()
            await state.open(result.value.id)
            setFileError(undefined)
          } catch (error) { setFileError(error instanceof Error ? error.message : String(error)) }
        },
      }) : null,
      h(Button, {
        label: running ? t('run.running') : t('action.run'),
        onClick: () => void state.runWorkflow(),
        disabled: running || state.graph.nodes.length === 0,
        // The reference paints run green so it never reads as the save action.
        variant: 'accent',
      }),
    ),
    fileError ? h('div', { className: 'wfs-status wfs-status-error', role: 'alert', style: { padding: '8px 14px' } }, fileError) : null,
    exportedJson !== undefined ? h('div', {
      role: 'dialog', 'aria-label': '导出工作流 JSON', 'aria-modal': true,
      style: { position: 'fixed', inset: '10% 12%', zIndex: 1000, padding: 20, background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, boxShadow: '0 0 0 100vmax #0008', display: 'flex', flexDirection: 'column', gap: 12 },
    },
      h('strong', null, '导出工作流 JSON'),
      h('span', null, '下载 JSON 文件，或复制以下内容并保存为 .json 文件。'),
      h('textarea', { 'aria-label': '导出内容', readOnly: true, value: exportedJson, className: 'wfs-textarea', style: { flex: 1 } }),
      h('div', { className: 'wfs-row' },
        h(Button, { label: '下载 JSON', onClick: downloadDocument, variant: 'primary' }),
        h(Button, { label: '关闭导出', onClick: () => setExportedJson(undefined) }),
      ),
    ) : null,
    status !== undefined
      ? h('div', { className: 'wfs-section', key: 'status', style: { padding: '8px 14px' } },
          h('span', { className: `wfs-status${statusClass}` }, status.text))
      : null,
    h(
      'div',
      { className: 'wfs-body', key: 'body' },
      h(StudioSidebar, { state }),
      h(
        'div',
        { className: 'wfs-canvas' },
        state.graph.nodes.length === 0
          ? h(
              'div',
              {
                style: {
                  position: 'absolute',
                  inset: 0,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: '13px',
                  pointerEvents: 'none',
                },
              },
              t('palette.hint'),
            )
          : null,
        h(Canvas, {
          graph: state.graph,
          selection: state.selection,
          statusOf,
          onSelect: state.selectNode,
          onSelectMany: state.selectMany,
          onConnect: state.connect,
          onRemoveEdge: state.removeEdge,
          onRemoveNode: state.removeNode,
          onMoveNode: state.moveNode,
          onToggleGroup: state.setGroupCollapsed,
        }),
        // The canvas toolbar: actions that only make sense with something picked,
        // so they appear on the selection rather than crowding the header.
        state.selection.length > 0
          ? h(
              'div',
              { className: 'wfs-selection-bar', key: 'selection' },
              state.selectedGroupId !== undefined
                ? h(Button, {
                  label: t('action.ungroup'),
                  onClick: () => state.ungroup(state.selectedGroupId as string),
                })
                : null,
              state.selection.length >= 2
                ? h(Button, { label: t('action.group'), onClick: state.groupSelection, variant: 'accent' })
                : null,
              h(Button, { label: t('action.copy'), onClick: state.copy, disabled: state.selectedGroupId !== undefined }),
              h(Button, { label: t('action.paste'), onClick: state.paste, disabled: !state.canPaste }),
              // A round is the selection as a whole, folded or not, so the count that
              // describes it is its members — "已选 1 个" would name a block that has
              // already been expanded back into nodes.
              h('span', { className: 'wfs-selection-count' }, state.selectedGroupId === undefined
                ? t('status.selected', { n: state.selection.length })
                : t('group.members', {
                  n: state.graph.nodes.filter((node) => node.groupId === state.selectedGroupId).length,
                })),
            )
          : null,
      ),
      h(
        'div',
        { className: 'wfs-column wfs-column-right' },
        h(StudioInspector, { state, connectors, translate }),
        h(RunPanel, { state }),
      ),
    ),
  )
}

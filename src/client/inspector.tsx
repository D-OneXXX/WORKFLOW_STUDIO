/**
 * Right column: the property editor for the selected node.
 *
 * Which fields appear depends on the node kind, matching the five kinds the
 * compiler understands: input text, prompt, code, condition, and output value.
 *
 * Three of those kinds — branch, llm, code — can also be configured by
 * description. The plain-language mode sends the user's words to the
 * `POST /api/translate` endpoint and shows what came back; nothing is written to
 * the node until the user confirms it, and the formal configuration stays the
 * only thing a run reads. Expert mode is the same set of fields as always, and
 * stays available whether or not a connector is configured.
 */

import * as React from 'react'

import type { StudioState } from './state.js'
import type {
  ConditionType,
  ConnectorCatalog,
  NodeParams,
  TranslateCall,
  TranslateOutcome,
  TranslateResult,
  WorkflowNode,
} from './types.js'

const h = React.createElement

/** Condition operators, in display order. */
const CONDITIONS: ConditionType[] = ['len_gt', 'len_lt', 'contains', 'eq']

/** The kinds that have a plain-language mode. */
const PLAIN_KINDS = ['branch', 'llm', 'code'] as const
type PlainKind = (typeof PLAIN_KINDS)[number]

type ConfigMode = 'plain' | 'expert'

/** One in-flight or finished translation for one node. */
interface Job {
  nodeId: string
  busy: boolean
  outcome?: TranslateOutcome
  error?: string
  /** The proposed formal fields, editable before it is confirmed. */
  preview?: NodeParams
  /**
   * Whether the user adjusted the preview. A confirmed-but-adjusted proposal is
   * no longer the translation of the description, so it is stored the same way an
   * expert-mode edit is: words kept, marked 已手动修改.
   */
  edited?: boolean
}

interface InspectorProps {
  state: StudioState
  /** Absent until a deployment reports connectors; then the dropdown appears. */
  connectors?: ConnectorCatalog
  /**
   * Absent where translation has no home — the Harness plugin has no connector
   * registry, so its panel shows expert fields only.
   */
  translate?: TranslateCall
}

/** One labelled field row. */
function Field(props: {
  label: string
  children: React.ReactNode
}): React.ReactElement {
  return h(
    'div',
    { className: 'wfs-field' },
    h('label', null, props.label),
    props.children,
  )
}

const isPlainKind = (kind: WorkflowNode['kind']): kind is PlainKind =>
  (PLAIN_KINDS as readonly string[]).includes(kind)

/**
 * The fields a confirmed translation would write, from the answer's `config`.
 * Branch answers carry a `type` and a `value`; the other two carry one string.
 */
function previewOf(kind: PlainKind, outcome: TranslateOutcome): NodeParams | undefined {
  if (outcome.status !== 'ok') return undefined
  const config = outcome.config
  if (kind === 'branch') {
    return { condition: { type: config.type ?? 'len_gt', value: config.value ?? '' } }
  }
  if (kind === 'llm') return { prompt: config.prompt ?? '' }
  return { code: config.code ?? '' }
}

/** The property editor. */
export function StudioInspector({
  state,
  connectors,
  translate,
}: InspectorProps): React.ReactElement {
  const { graph, selectedId, selectedGroupId, selection, t, updateNode, updateParams, removeNode } = state
  const selected: WorkflowNode | undefined = graph.nodes.find((candidate) => candidate.id === selectedId)

  // Mode is per node and per visit, so it is deliberately not stored on the node:
  // the document must not grow a field that says which box was open.
  const [modes, setModes] = React.useState<Record<string, ConfigMode>>({})
  const [job, setJob] = React.useState<Job>()

  /** A folded round: its title, and the way back out. */
  if (selectedGroupId !== undefined) {
    const group = (graph.groups ?? []).find((row) => row.id === selectedGroupId)
    const members = graph.nodes.filter((node) => node.groupId === selectedGroupId)
    if (group !== undefined) {
      return h(
        'div',
        { className: 'wfs-column wfs-column-right' },
        h(
          'div',
          { className: 'wfs-section' },
          h('div', { className: 'wfs-section-title' }, t('group.title')),
          h(Field, {
            label: t('group.label'),
            children: h('input', {
              className: 'wfs-input',
              value: group.label ?? '',
              onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
                state.renameGroup(group.id, event.target.value),
            }),
          }),
          h('div', { className: 'wfs-hint' }, t('group.members', { n: members.length })),
          h(
            'div',
            { className: 'wfs-row', style: { marginTop: '10px' } },
            h('button', {
              type: 'button',
              className: 'wfs-button wfs-button-primary',
              // The panel is the group's whether it is folded or not, so this is a
              // real toggle: the action is always the opposite of the current state,
              // never an 展开 that does nothing on an already-open round.
              onClick: () => state.setGroupCollapsed(group.id, group.collapsed !== true),
            }, group.collapsed === true ? t('group.expand') : t('group.collapse')),
            h('button', {
              type: 'button',
              className: 'wfs-button wfs-button-danger',
              onClick: () => state.ungroup(group.id),
            }, t('action.ungroup')),
          ),
          // The promise the folding design rests on: this is a view, so the
          // compiled script cannot differ between the two states.
          h('div', { className: 'wfs-hint', style: { marginTop: '10px' } }, t('group.viewOnly')),
        ),
      )
    }
  }

  if (selection.length > 1) {
    return h(
      'div',
      { className: 'wfs-column wfs-column-right' },
      h(
        'div',
        { className: 'wfs-section' },
        h('div', { className: 'wfs-section-title' }, t('props.title')),
        h('div', { className: 'wfs-hint' }, t('status.selected', { n: selection.length })),
        h('div', { className: 'wfs-hint' }, t('props.multiHint')),
      ),
    )
  }

  if (selected === undefined) {
    return h(
      'div',
      { className: 'wfs-column wfs-column-right' },
      h(
        'div',
        { className: 'wfs-section' },
        h('div', { className: 'wfs-section-title' }, t('props.title')),
        h('div', { className: 'wfs-empty' }, t('props.empty')),
      ),
    )
  }

  /**
   * A `const` alias with the narrowed type. Hoisted function declarations below
   * are analysed from the top of this scope, where `selected` is still optional,
   * so they would otherwise report a possible undefined on every use.
   */
  const node = selected

  const params = node.params ?? {}
  const words = params.description ?? ''
  const applied = params.descriptionApplied
  const active = job?.nodeId === node.id ? job : undefined

  // A deployment without a connector registry cannot translate, and the
  // fallback the spec asks for is the honest one: grey the helper out, leave
  // the real fields alone.
  const canTranslate = translate !== undefined
    && connectors !== undefined
    && connectors.connectors.length > 0
  const plainKind = isPlainKind(node.kind)
  const usable = plainKind && canTranslate

  /**
   * Default to describing, unless the node already holds a configuration the
   * user wrote by hand — then hiding it behind an empty description box would
   * be worse than the convenience.
   */
  const formalAlreadyAuthored = plainKind && (
    (node.kind === 'branch' && params.condition !== undefined)
    || (node.kind === 'llm' && (params.prompt ?? '').length > 0)
    || (node.kind === 'code' && (params.code ?? '').length > 0)
  )
  const mode: ConfigMode = modes[node.id]
    ?? (words.length > 0 || !formalAlreadyAuthored ? 'plain' : 'expert')
  const inPlain = usable && mode === 'plain'

  const setMode = (next: ConfigMode) => setModes((current) => ({ ...current, [node.id]: next }))

  /**
   * Write a formal field, marking the description as no longer matching it.
   *
   * The empty string is the agreed sentinel for 已手动修改: it keeps the user's
   * words for a later re-translation while saying that what the node now does
   * did not come from them.
   */
  const editFormal = (patch: NodeParams) => {
    updateParams(node.id, words.length > 0 ? { ...patch, descriptionApplied: '' } : patch)
  }

  async function generate(pin?: { term: string; nodeId: string }) {
    if (translate === undefined || words.trim().length === 0) return
    const kind = node.kind as PlainKind
    const text = words.trim()
    setJob({ nodeId: node.id, busy: true })
    let result: TranslateResult
    try {
      result = await translate({
        kind, nodeId: node.id, description: text, graph,
        ...(pin === undefined ? {} : { pin }),
      })
    } catch (error) {
      setJob({ nodeId: node.id, busy: false, error: `翻译调用失败：${String(error)}` })
      return
    }
    if (!result.ok) {
      setJob({ nodeId: node.id, busy: false, error: result.error.message ?? '翻译失败' })
      return
    }
    setJob({
      nodeId: node.id,
      busy: false,
      outcome: result.value,
      preview: previewOf(kind, result.value),
    })
  }

  /** The only place a translation becomes node state: the user's own click. */
  function confirmPreview() {
    if (active?.preview === undefined) return
    const text = words.trim()
    updateParams(node.id, {
      ...active.preview,
      description: text,
      // An adjusted proposal is the user's text no longer, so it is marked the
      // same way an expert-mode edit is.
      descriptionApplied: active.edited === true ? '' : text,
    })
    setJob(undefined)
  }

  const fields: React.ReactNode[] = [
    h(Field, {
      key: 'label',
      label: t('props.nodeLabel'),
      children: h('input', {
        className: 'wfs-input',
        value: node.label ?? '',
        onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
          updateNode(node.id, { label: event.target.value }),
      }),
    }),
  ]

  if (node.kind === 'input') {
    fields.push(
      h(Field, {
        key: 'input',
        label: t('props.input'),
        children: h('textarea', {
          className: 'wfs-textarea',
          value: params.input ?? '',
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            updateParams(node.id, { input: event.target.value }),
        }),
      }),
    )
  }

  if (node.kind === 'output') {
    fields.push(
      h(Field, {
        key: 'output',
        label: t('props.outputValue'),
        children: h('input', {
          className: 'wfs-input',
          value: params.outputValue ?? '',
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            updateParams(node.id, { outputValue: event.target.value }),
        }),
      }),
    )
  }

  if (plainKind) {
    fields.push(
      h(
        'div',
        { className: 'wfs-mode-tabs', key: 'mode' },
        ...([
          ['plain', t('props.modePlain')],
          ['expert', t('props.modeExpert')],
        ] as [ConfigMode, string][]).map(([value, label]) => h(
          'button',
          {
            key: value,
            type: 'button',
            className: 'wfs-mode-tab',
            'aria-selected': mode === value,
            disabled: value === 'plain' && !canTranslate,
            title: value === 'plain' && !canTranslate ? t('props.noConnector') : undefined,
            onClick: () => setMode(value),
          },
          label,
        )),
      ),
    )

    if (!canTranslate) {
      fields.push(h('div', { className: 'wfs-hint wfs-hint-warn', key: 'no-connector' }, t('props.noConnector')))
    }

    if (inPlain) {
      const stale = words.length > 0
        && applied !== undefined && applied !== '' && applied !== words
      const handEdited = applied === '' && words.length > 0
      fields.push(
        h(Field, {
          key: 'description',
          label: t('props.describe'),
          children: h('textarea', {
            className: 'wfs-textarea',
            rows: 4,
            // The server refuses anything longer; stopping the keystroke beats
            // showing someone a validation error after they wrote a paragraph.
            maxLength: 2_000,
            placeholder: t(`describe.${node.kind}`),
            value: words,
            onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
              // Deliberately only the words: the formal field stays as it is,
              // which is what makes it visibly out of date.
              updateParams(node.id, { description: event.target.value }),
          }),
        }),
        handEdited
          ? h('div', { className: 'wfs-badge', key: 'hand' }, t('props.handEdited'))
          : null,
        stale
          ? h('div', { className: 'wfs-badge wfs-badge-stale', key: 'stale' }, t('props.staleConfig'))
          : null,
        h(
          'div',
          { className: 'wfs-row', key: 'actions' },
          h('button', {
            type: 'button',
            className: 'wfs-button wfs-button-accent',
            disabled: active?.busy === true || words.trim().length === 0,
            onClick: () => { void generate() },
          }, active?.outcome?.status === 'ok' ? t('props.regenerate') : t('props.generate')),
          active?.busy === true
            ? h('div', { className: 'wfs-hint' }, t('props.translating'))
            : null,
        ),
        active?.error !== undefined
          ? h('div', { className: 'wfs-hint wfs-hint-err', key: 'error' }, active.error)
          : null,
        active?.outcome !== undefined ? plainOutcome(active.outcome, active.preview) : null,
        h('div', { className: 'wfs-hint', key: 'note' }, t('props.plainNote')),
      )
    }
  }

  /** The preview block: what was proposed, editable, waiting for one click. */
  function plainOutcome(outcome: TranslateOutcome, preview?: NodeParams): React.ReactElement {
    if (outcome.status === 'untranslatable') {
      return h('div', { className: 'wfs-preview wfs-preview-warn' },
        h('div', { className: 'wfs-preview-title' }, t('props.untranslatable')),
        h('div', { className: 'wfs-preview-body' }, outcome.reason))
    }
    if (outcome.status === 'ambiguous') {
      return h('div', { className: 'wfs-preview' },
        h('div', { className: 'wfs-preview-title' }, t('props.ambiguous')),
        h('div', { className: 'wfs-preview-body' },
          t('props.pickCandidate', { term: outcome.term })),
        h('div', { className: 'wfs-chips' },
          ...outcome.candidates.map((candidate) => h('button', {
            key: candidate.id,
            type: 'button',
            className: 'wfs-chip',
            onClick: () => { void generate({ term: outcome.term, nodeId: candidate.id }) },
          }, `${candidate.label} · ${candidate.id} · ${t(`kind.${candidate.kind}`)}`))))
    }
    return h('div', { className: 'wfs-preview' },
      h('div', { className: 'wfs-preview-title' }, t('props.preview')),
      // Editable on purpose: the usual reason a translation is wrong is one
      // number or one word, and fixing it here is cheaper than rephrasing the
      // description. Editing it then confirming marks the description as
      // hand-adjusted by the confirm below writing the same text.
      ...previewFields(preview),
      h('div', { className: 'wfs-row' },
        h('button', {
          type: 'button',
          className: 'wfs-button wfs-button-primary',
          onClick: confirmPreview,
        }, t('props.confirm')),
        h('button', {
          type: 'button',
          className: 'wfs-button',
          onClick: () => setJob(undefined),
        }, t('props.discard'))),
      h('div', { className: 'wfs-hint' }, t('props.previewHint')))
  }

  /** The three shapes a preview can have, each in its own widget. */
  function previewFields(preview?: NodeParams): React.ReactElement[] {
    if (preview === undefined || node.kind === undefined) return []
    /** Editing the preview is allowed; it just stops being the model's answer. */
    const adjust = (patch: NodeParams) => setJob((current) => (
      current === undefined ? current : { ...current, preview: patch, edited: true }
    ))
    if (node.kind === 'branch' && preview.condition !== undefined) {
      const condition = preview.condition
      return [
        h('select', {
          className: 'wfs-select',
          value: condition.type,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            adjust({ condition: { ...condition, type: event.target.value as ConditionType } }),
        }, ...CONDITIONS.map((type) => h('option', { key: type, value: type }, t(`condition.${type}`)))),
        h('input', {
          className: 'wfs-input',
          value: condition.value,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            adjust({ condition: { ...condition, value: event.target.value } }),
        }),
      ]
    }
    if (node.kind === 'llm' && preview.prompt !== undefined) {
      return [h('textarea', {
        className: 'wfs-textarea',
        rows: 6,
        value: preview.prompt,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => adjust({ prompt: event.target.value }),
      })]
    }
    if (node.kind === 'code' && preview.code !== undefined) {
      return [h('textarea', {
        className: 'wfs-textarea',
        rows: 7,
        value: preview.code,
        onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) => adjust({ code: event.target.value }),
      })]
    }
    return []
  }

  // Expert fields: exactly the formal configuration the compiler reads.
  if (node.kind === 'llm' && !inPlain) {
    fields.push(
      h(Field, {
        key: 'prompt',
        label: t('props.prompt'),
        children: h('textarea', {
          className: 'wfs-textarea',
          rows: 6,
          value: params.prompt ?? '',
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            editFormal({ prompt: event.target.value }),
        }),
      }),
      h('div', { className: 'wfs-hint', key: 'prompt-hint' }, t('props.promptHint')),
    )
  }

  if (node.kind === 'llm') {
    // The executor binding is a node field, but it only exists once a
    // deployment reports connectors — the Harness plugin has none yet.
    if (connectors !== undefined && connectors.connectors.length > 0) {
      const options = connectors.connectors.map((connector) =>
        h('option', { key: connector.id, value: connector.id }, `${connector.label} · ${connector.kind}`),
      )
      fields.push(
        h(Field, {
          key: 'executor',
          label: t('props.executor'),
          children: h(
            'select',
            {
              className: 'wfs-select',
              value: node.executor ?? '',
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
                updateNode(node.id, { executor: event.target.value === '' ? undefined : event.target.value }),
            },
            h('option', { key: '__default', value: '' }, t('props.executorDefault')),
            ...options,
          ),
        }),
        h('div', { className: 'wfs-hint', key: 'executor-hint' }, t('props.executorHint')),
      )
    }
  }

  if (node.kind === 'code' && !inPlain) {
    fields.push(
      h(Field, {
        key: 'code',
        label: t('props.code'),
        children: h('textarea', {
          className: 'wfs-textarea',
          rows: 7,
          value: params.code ?? '',
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            editFormal({ code: event.target.value }),
        }),
      }),
      h('div', { className: 'wfs-hint', key: 'code-hint' }, t('props.codeHint')),
    )
  }

  if (node.kind === 'branch' && !inPlain) {
    const condition = params.condition ?? { type: 'len_gt' as ConditionType, value: '500' }
    fields.push(
      h(Field, {
        key: 'condition-type',
        label: t('props.conditionType'),
        children: h(
          'select',
          {
            className: 'wfs-select',
            value: condition.type,
            onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
              editFormal({ condition: { ...condition, type: event.target.value as ConditionType } }),
          },
          ...CONDITIONS.map((type) =>
            h('option', { key: type, value: type }, t(`condition.${type}`)),
          ),
        ),
      }),
      h(Field, {
        key: 'condition-value',
        label: t('props.conditionValue'),
        children: h('input', {
          className: 'wfs-input',
          value: condition.value,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
            editFormal({ condition: { ...condition, value: event.target.value } }),
        }),
      }),
    )
  }

  return h(
    'div',
    { className: 'wfs-column wfs-column-right' },
    h('div', { className: 'wfs-section' }, h('div', { className: 'wfs-section-title' }, t('props.title')), ...fields),
    h(
      'div',
      { className: 'wfs-section' },
      h('div', { className: 'wfs-section-title' }, t('props.nodeId')),
      h('div', { className: 'wfs-node-id' }, node.id),
      h(
        'div',
        { className: 'wfs-row', style: { marginTop: '10px' } },
        h(
          'button',
          {
            type: 'button',
            className: 'wfs-button wfs-button-danger',
            onClick: () => removeNode(node.id),
          },
          t('props.deleteNode'),
        ),
      ),
    ),
  )
}

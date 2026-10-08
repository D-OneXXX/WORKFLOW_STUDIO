/**
 * Right column: the property editor for the selected node.
 *
 * Which fields appear depends on the node kind, matching the five kinds the
 * compiler understands: input text, prompt, code, condition, and output value.
 */

import * as React from 'react'

import type { StudioState } from './state.js'
import type { ConditionType, ConnectorCatalog, WorkflowNode } from './types.js'

const h = React.createElement

/** Condition operators, in display order. */
const CONDITIONS: ConditionType[] = ['len_gt', 'len_lt', 'contains', 'eq']

interface InspectorProps {
  state: StudioState
  /** Absent until a deployment reports connectors; then the dropdown appears. */
  connectors?: ConnectorCatalog
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

/** The property editor. */
export function StudioInspector({ state, connectors }: InspectorProps): React.ReactElement {
  const { graph, selectedId, t, updateNode, updateParams, removeNode } = state
  const node: WorkflowNode | undefined = graph.nodes.find((candidate) => candidate.id === selectedId)

  if (node === undefined) {
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

  const params = node.params ?? {}
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

  if (node.kind === 'llm') {
    fields.push(
      h(Field, {
        key: 'prompt',
        label: t('props.prompt'),
        children: h('textarea', {
          className: 'wfs-textarea',
          rows: 6,
          value: params.prompt ?? '',
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            updateParams(node.id, { prompt: event.target.value }),
        }),
      }),
    )
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

  if (node.kind === 'code') {
    fields.push(
      h(Field, {
        key: 'code',
        label: t('props.code'),
        children: h('textarea', {
          className: 'wfs-textarea',
          rows: 7,
          value: params.code ?? '',
          onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
            updateParams(node.id, { code: event.target.value }),
        }),
      }),
      h('div', { className: 'wfs-hint', key: 'code-hint' }, t('props.codeHint')),
    )
  }

  if (node.kind === 'branch') {
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
              updateParams(node.id, {
                condition: { ...condition, type: event.target.value as ConditionType },
              }),
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
            updateParams(node.id, { condition: { ...condition, value: event.target.value } }),
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

/**
 * Run output panel: the terminal result, the child-agent count, and the
 * progress markers the engine reported.
 *
 * A `phase` marker's message is a node id, because `phase()` takes exactly one
 * argument in this Harness version and the node id is the only channel that
 * reaches the observer. That is what drives the canvas node colouring.
 */

import * as React from 'react'

import type { StudioState } from './state.js'

const h = React.createElement

interface RunPanelProps {
  state: StudioState
}

/** Render any JSON value compactly. */
function renderValue(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** A small status chip. */
function Chip(props: { kind: 'ok' | 'warn' | 'error'; text: string }): React.ReactElement {
  const suffix = props.kind === 'ok' ? '-ok' : props.kind === 'warn' ? '-warn' : '-error'
  return h('span', { className: `wfs-status wfs-status${suffix}` }, props.text)
}

/** The run panel. */
export function RunPanel({ state }: RunPanelProps): React.ReactElement {
  const { run, running, running: isRunning, t } = state
  const showRunning = running || isRunning

  const head = showRunning
    ? h(Chip, { kind: 'warn', text: t('run.running') })
    : run === undefined
      ? h('span', { className: 'wfs-empty' }, t('run.empty'))
      : run.stopReason === 'completed'
        ? h(Chip, { kind: 'ok', text: t('run.completed') })
        : h(Chip, { kind: 'error', text: `${t(`run.${run.stopReason}`)}${run.error ? `: ${run.error}` : ''}` })

  const children: React.ReactNode[] = [
    h('div', { className: 'wfs-section-title', key: 'title' }, t('run.title')),
    h('div', { className: 'wfs-row', key: 'head' }, head),
  ]

  if (run !== undefined) {
    children.push(
      h(
        'div',
        { className: 'wfs-row', key: 'meta', style: { marginTop: '8px' } },
        h('span', { className: 'wfs-hint' }, `${t('run.agents')}: ${run.agentsStarted}`),
        h('span', { className: 'wfs-hint' }, `runId: ${run.runId}`),
      ),
      h('div', { className: 'wfs-section-title', key: 'value-title', style: { marginTop: '10px' } }, t('run.value')),
      h('pre', { className: 'wfs-pre', key: 'value' }, renderValue(run.value)),
    )

    if (run.progress.length > 0) {
      children.push(
        h(
          'ul',
          { className: 'wfs-log', key: 'log', style: { marginTop: '10px' } },
          ...run.progress.map((entry) =>
            h(
              'li',
              { key: entry.seq },
              h(
                'span',
                { className: 'wfs-log-node' },
                entry.kind === 'phase' ? (entry.nodeId ?? entry.message) : '·',
              ),
              h('span', null, entry.kind === 'phase' ? 'phase' : entry.message),
            ),
          ),
        ),
      )
    }
  }

  return h('div', { className: 'wfs-section' }, ...children)
}

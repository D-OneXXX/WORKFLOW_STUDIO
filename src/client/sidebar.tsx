/**
 * Left column: the node palette and the saved-workflow library.
 */

import * as React from 'react'

import { KINDS, type StudioState } from './state.js'
import type { NodeKind } from './types.js'

const h = React.createElement

interface SidebarProps {
  state: StudioState
}

/** Palette entry for one node kind. */
function PaletteItem(props: {
  kind: NodeKind
  title: string
  description: string
  onAdd(kind: NodeKind): void
}): React.ReactElement {
  const { kind, title, description, onAdd } = props
  return h(
    'button',
    {
      type: 'button',
      className: 'wfs-palette-item',
      // Drives the colour dot; see the `[data-kind]` rules in styles.css.
      'data-kind': kind,
      onClick: () => onAdd(kind),
    },
    h('span', { className: 'wfs-palette-name' }, title),
    h('span', { className: 'wfs-palette-desc' }, description),
  )
}

/** The palette plus the library list. */
export function StudioSidebar({ state }: SidebarProps): React.ReactElement {
  const { t, addNode, library, open, remove, currentId } = state
  const [picked, setPicked] = React.useState('')
  // Importing the workflow you are already editing would only duplicate its own
  // nodes, so the current document is not offered.
  const importable = library.filter((row) => row.id !== currentId)

  return h(
    'div',
    { className: 'wfs-column wfs-column-left' },
    h(
      'div',
      { className: 'wfs-section' },
      h('div', { className: 'wfs-section-title' }, t('palette.title')),
      ...KINDS.map((kind) =>
        h(PaletteItem, {
          key: kind,
          kind,
          title: t(`kind.${kind}`),
          description: t(`kind.${kind}.desc`),
          onAdd: addNode,
        }),
      ),
      h('div', { className: 'wfs-hint' }, t('palette.hint')),
    ),
    h(
      'div',
      { className: 'wfs-section' },
      h('div', { className: 'wfs-section-title' }, t('library.title')),
      // The carrier for "the next round can be different": another workflow comes
      // in as ordinary nodes on this canvas, with new ids and no live reference.
      importable.length > 0
        ? h(
            'div',
            { className: 'wfs-row', style: { marginBottom: '8px' } },
            h(
              'select',
              {
                className: 'wfs-select',
                'aria-label': t('action.importFromLibrary'),
                value: picked,
                onChange: (event: React.ChangeEvent<HTMLSelectElement>) => setPicked(event.target.value),
              },
              h('option', { value: '' }, t('library.pick')),
              ...importable.map((row) =>
                h('option', { key: row.id, value: row.id }, `${row.name} · ${row.nodeCount}`),
              ),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'wfs-button',
                disabled: picked.length === 0,
                onClick: () => { void state.importWorkflow(picked) },
              },
              t('action.importFromLibrary'),
            ),
          )
        : null,
      library.length === 0
        ? h('div', { className: 'wfs-empty' }, t('library.empty'))
        : h(
            'div',
            null,
            ...library.map((row) =>
              h(
                'div',
                {
                  key: row.id,
                  className: `wfs-list-item${row.id === currentId ? ' wfs-list-item-active' : ''}`,
                },
                h(
                  'span',
                  {
                    onClick: () => void open(row.id),
                    title: row.description ?? row.name,
                    style: { flex: '1 1 auto', cursor: 'pointer' },
                  },
                  row.name,
                ),
                h('span', { className: 'wfs-list-meta' }, `${row.nodeCount} ${t('library.nodes')}`),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'wfs-button wfs-button-danger',
                    title: t('action.delete'),
                    onClick: () => {
                      if (window.confirm(t('confirm.delete'))) void remove(row.id)
                    },
                  },
                  '×',
                ),
              ),
            ),
          ),
    ),
  )
}

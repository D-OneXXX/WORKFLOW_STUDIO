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
      onClick: () => onAdd(kind),
    },
    h('span', { className: 'wfs-palette-name' }, title),
    h('span', { className: 'wfs-palette-desc' }, description),
  )
}

/** The palette plus the library list. */
export function StudioSidebar({ state }: SidebarProps): React.ReactElement {
  const { t, addNode, library, open, remove, currentId } = state

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

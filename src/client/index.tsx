/**
 * Client half of the workflow studio plugin.
 *
 * The page's module table loads this bundle: `__ModuleLoader__.load` registers a
 * lazy factory whose id equals the package name, and React comes from the host
 * page rather than a second copy.
 *
 * Three registrations happen in `apply`:
 *   1. `ctx.remote.$mount(contribution)` creates the `remote.workflowStudio`
 *      namespace. Without it the namespace is `undefined` and every call fails.
 *   2. A `sidebar.panellist` list cell (order 200) — the sidebar entry.
 *   3. A `main` keyed cell under the same id — the full-screen panel that
 *      `ctx.layout.selectPanel(id)` opens.
 */

import { WorkflowPanel } from './app.js'
import { PANEL_ID, SIDEBAR_ORDER, SLOT_MAIN, SLOT_SIDEBAR } from './constants.js'
import { en } from './locales/en.js'
import { zh } from './locales/zh.js'
import { mountWorkflowRpc, type ClientContextLike, type WorkflowRpc } from './remote.js'

declare global {
  interface Window {
    __ModuleLoader__?: {
      load(module: { id: string; factory(require: (id: string) => unknown): unknown }): void
    }
  }
}

/** Locale namespace this plugin registers its dictionary under. */
const LOCALE_NAMESPACE = 'workflow-studio'

/** React as resolved from the page's module table, captured in `apply`. */
let React: typeof import('react') | undefined

/** The panel's props, shared by both slot cells. */
interface PanelProps {
  rpc: WorkflowRpc | undefined
  mountError: string | undefined
  ctx: ClientContextLike
}

/** Wire the plugin into the page. */
function factory(require: (id: string) => unknown): unknown {
  return {
    // `slots` renders the UI, `locale` translates it, `remote` carries the RPC.
    inject: ['slots', 'locale', 'remote'],

    async apply(ctx: ClientContextLike): Promise<void> {
      // React comes from the page's module table; a second copy would break
      // hooks inside the host application.
      React = require('react') as typeof import('react')

      // Localized text flows through the client locale service, so a language
      // switch updates the panel without a reload.
      ctx.locale?.register(LOCALE_NAMESPACE, { zh, en })

      let rpc: WorkflowRpc | undefined
      let mountError: string | undefined
      try {
        rpc = await mountWorkflowRpc(ctx)
      } catch (error) {
        // The panel still renders and reports the failure rather than the whole
        // plugin failing to activate.
        mountError = error instanceof Error ? error.message : String(error)
      }

      const props: PanelProps = { rpc, mountError, ctx }

      ctx.slots.inject(SLOT_SIDEBAR, () =>
        ctx.slots.register(
          { name: SLOT_SIDEBAR, id: PANEL_ID, order: SIDEBAR_ORDER, label: '' },
          PanelIcon,
        ),
      )

      ctx.slots.inject(SLOT_MAIN, () =>
        ctx.slots.register({ name: SLOT_MAIN, key: PANEL_ID }, () =>
          React!.createElement(WorkflowPanel, props),
        ),
      )
    },
  }
}

/**
 * The sidebar cell's own glyph. A plain inline SVG inherits the theme through
 * `currentColor`, so it reads correctly in both light and dark themes.
 */
function PanelIcon(): unknown {
  if (React === undefined) return null
  const h = React.createElement
  return h(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 20,
      height: 20,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 1.7,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
      focusable: false,
    },
    h('rect', { x: 2.5, y: 4, width: 7, height: 6, rx: 1.5 }),
    h('rect', { x: 14.5, y: 4, width: 7, height: 6, rx: 1.5 }),
    h('rect', { x: 8.5, y: 14, width: 7, height: 6, rx: 1.5 }),
    h('path', { d: 'M6 10v2.5h12V10' }),
    h('path', { d: 'M12 12.5V14' }),
  )
}

window.__ModuleLoader__?.load({ id: 'dsh-workflow-studio', factory })

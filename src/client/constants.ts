/** Shared client constants: panel identity and slot keys. */

export {
  invocationId,
  WORKFLOW_METHODS,
  WORKFLOW_NAMESPACE,
  WORKFLOW_PACKAGE,
  WORKFLOW_SERVICE,
} from '../shared/wire.js'

/** The sidebar cell id and the matching `main` keyed cell. */
export const PANEL_ID = 'workflow-studio'

/** Suggested order for the sidebar entry (the brief fixes 200). */
export const SIDEBAR_ORDER = 200

/** The sidebar's list slot for global panel icons. */
export const SLOT_SIDEBAR = 'sidebar.panellist'

/** The keyed central-panel slot addressed by sidebar entry id. */
export const SLOT_MAIN = 'main'

/**
 * Wire vocabulary shared by both halves.
 *
 * Dependency-free on purpose: the client bundle imports this module, so it must
 * not pull in zod or anything else the host build needs.
 *
 * `namespace` and `method` are SEPARATE wire fields, and the Typert registry
 * validates each one against `/^[A-Za-z0-9_$.-]+$/`:
 *
 *   validateWireName(subject, value) {
 *     if (value === "." || value === ".." || !/^[A-Za-z0-9_$.-]+$/.test(value))
 *       throw new Error(`typert: invalid ${subject} "${value}" — must contain
 *       only RPC endpoint segment characters`)
 *   }
 *
 * A forward slash is therefore illegal in either field. A descriptor written as
 * `method: 'workflow/save'` throws inside `ctx.typert.register()`, and because
 * that rejection is unhandled it becomes a FATAL host load failure — the entire
 * Harness process exits and Desktop recovers into safe mode, which blocks
 * third-party bundles. `assertWireVocabulary()` below applies the same rule at
 * module load so an illegal name fails in the test suite instead.
 */

/** The Cordis service key. Validated by segment rules (nonempty, no `#`). */
export const WORKFLOW_SERVICE = 'workflowStudio'

/** The Typert wire namespace. Reached as `ctx.remote[WORKFLOW_NAMESPACE]`. */
export const WORKFLOW_NAMESPACE = 'workflow'

/** The package identity used in the Typert contribution. */
export const WORKFLOW_PACKAGE = 'dsh-workflow-studio'

/** The five RPC endpoint methods, in the order the brief fixes them. */
export const WORKFLOW_METHODS = ['save', 'list', 'load', 'delete', 'run'] as const

/** One endpoint method name. */
export type WorkflowMethod = (typeof WORKFLOW_METHODS)[number]

/** The pattern every wire-name field must satisfy. */
export const WIRE_NAME_PATTERN = /^[A-Za-z0-9_$.-]+$/

/**
 * Throw when any wire name would be rejected by the registry.
 *
 * Runs at module load so an illegal name fails the tests and a local build
 * rather than at Harness startup.
 */
export function assertWireVocabulary(): void {
  const names: [string, string][] = [
    ['namespace', WORKFLOW_NAMESPACE],
    ...WORKFLOW_METHODS.map((method): [string, string] => ['method', method]),
  ]
  for (const [subject, value] of names) {
    if (value === '.' || value === '..' || !WIRE_NAME_PATTERN.test(value)) {
      throw new Error(
        `typert: invalid ${subject} "${value}" — must contain only RPC endpoint segment characters`,
      )
    }
  }
}

/** The full invocation id for one method, e.g. `dsh-workflow-studio#workflow/save`. */
export function invocationId(method: WorkflowMethod): string {
  return `${WORKFLOW_PACKAGE}#${WORKFLOW_NAMESPACE}/${method}`
}

assertWireVocabulary()

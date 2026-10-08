// Verify the plugin's REAL service class installs a `typertRemote` binding that
// agrees with its REAL descriptors.
//
// This guards a failure that cost a full debugging cycle: `TypertRemoteService`
// defaults `namespace` to the Cordis service key, so declaring a different wire
// namespace in the descriptors makes the API gateway reject EVERY call with
// `gateway/binding-invalid`. The binding's `serviceKey` and `namespace` must both
// match what the descriptors declare.
//
// Runs offline against the real protocol/cordis classes from the scratch probe
// install; see `npm run verify:descriptors` for the registry-side check.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const workspaceRoot = join(packageRoot, '..')
const localModules = join(packageRoot, 'node_modules')
const probeRoot = join(workspaceRoot, '.recon', 'npm8', 'node_modules')
const bundleRoot = join(workspaceRoot, '.recon', 'x', 'node_modules')

/**
 * Resolve a package directory.
 *
 * The package's OWN node_modules is checked first, and deliberately so: the host
 * bundle resolves its bare imports from there, and an `instanceof` check against
 * a second copy of the same class would fail spuriously.
 */
function resolvePackage(name, entry) {
  const bare = name.replace('@deepseek-ai/', '')
  const candidates = [
    join(localModules, name, entry),
    join(probeRoot, name, entry),
    join(bundleRoot, name, entry),
    join(workspaceRoot, '.recon', 'npm2', 'ex', `${bare}-0.2.0-rc.2`, 'package', entry),
    join(workspaceRoot, '.recon', 'npm3', 'ex', `${bare}-0.2.0-rc.2`, 'package', entry),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const cordisEntry = resolvePackage('@deepseek-ai/cordis', 'lib/index.js')
const protocolEntry = resolvePackage('@deepseek-ai/dsh-typert-protocol', 'lib/index.js')

if (cordisEntry === undefined || protocolEntry === undefined) {
  console.error('SKIP: probe install missing; run the staging step described in the README')
  console.error(`  cordis:   ${cordisEntry ?? 'not found'}`)
  console.error(`  protocol: ${protocolEntry ?? 'not found'}`)
  process.exit(0)
}

const { Context } = await import(pathToFileURL(cordisEntry).href)
const { TypertRemoteService } = await import(pathToFileURL(protocolEntry).href)

const { TYPERT, WORKFLOW_INVOCATIONS } = await import(
  pathToFileURL(join(here, '..', 'lib', 'host', 'descriptors.js')).href
)
const { WorkflowStudioGateway } = await import(
  pathToFileURL(join(here, '..', 'lib', 'index.js')).href
)

const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
  console.log(`${condition ? 'OK   ' : 'FAIL '} ${message}`)
}

check(typeof WorkflowStudioGateway === 'function', 'host entry exports the service class')
check(
  WorkflowStudioGateway.prototype instanceof TypertRemoteService,
  'service class extends TypertRemoteService (required for the typertRemote binding)',
)

// `inject` must not include workflowEngine: a hard dependency parks the whole
// plugin in `pending`, losing the panel and library for a run-only service.
const inject = WorkflowStudioGateway.inject ?? []
check(Array.isArray(inject), 'static inject is an array')
check(
  !inject.includes('workflowEngine'),
  `inject must not require workflowEngine (got: ${JSON.stringify(inject)})`,
)
for (const required of ['storageDomain', 'agents', 'typert']) {
  check(inject.includes(required), `inject requires ${required}`)
}

// Construct against a real Context. The async initialize() may reject in this
// offline environment (no storageDomain), which is fine: it is already caught,
// and the binding is installed synchronously by super().
const ctx = new Context()
let instance
try {
  instance = new WorkflowStudioGateway(ctx)
} catch (error) {
  failures.push(`constructing the service threw: ${error.message}`)
}

if (instance !== undefined) {
  const binding = instance.typertRemote
  check(binding !== undefined && binding !== null, 'typertRemote binding is installed')
  if (binding) {
    check(binding.service === instance, 'binding.service is the service instance itself')

    const descriptorServices = new Set(TYPERT.invocations.map((d) => d.service))
    const descriptorNamespaces = new Set(TYPERT.invocations.map((d) => d.namespace))

    check(
      descriptorServices.size === 1,
      `descriptors agree on one service key (got ${[...descriptorServices].join(', ')})`,
    )
    check(
      descriptorNamespaces.size === 1,
      `descriptors agree on one namespace (got ${[...descriptorNamespaces].join(', ')})`,
    )
    check(
      binding.serviceKey === [...descriptorServices][0],
      `binding.serviceKey "${binding.serviceKey}" matches descriptor service "${[...descriptorServices][0]}"`,
    )
    check(
      binding.namespace === [...descriptorNamespaces][0],
      `binding.namespace "${binding.namespace}" matches descriptor namespace "${[...descriptorNamespaces][0]}"`,
    )
    check(
      instance.name === binding.serviceKey,
      `service name "${instance.name}" equals binding.serviceKey "${binding.serviceKey}"`,
    )
    console.log(
      `\nclient call path: ctx.remote.${binding.namespace}.<method>(request)  (${WORKFLOW_INVOCATIONS.length} methods)`,
    )
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} binding problem(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nOK: service binding and descriptors agree; gateway binding checks will pass')

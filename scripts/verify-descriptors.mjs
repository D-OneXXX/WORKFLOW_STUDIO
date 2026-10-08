// Register the plugin's REAL contribution against the REAL Typert registry, to
// prove the descriptors pass the validators that crashed the host before.
//
// Uses the registry extracted from the shipped app bundle, so this is the same
// code the Harness process runs. The plugin's own descriptor module is imported
// from the built lib/ output.

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// The scratch space one level above this package holds both the packages
// extracted from the shipped app bundle and a probe install of the real registry
// and cordis (used earlier to prove the wire-name rule empirically).
const workspaceRoot = join(here, '..', '..')
const probeRoot = join(workspaceRoot, '.recon', 'npm8', 'node_modules')
const bundleRoot = join(workspaceRoot, '.recon', 'x', 'node_modules')

/** Prefer the probe install; fall back to the app-bundle extraction. */
function resolvePackage(name, entry) {
  const candidates = [join(probeRoot, name, entry), join(bundleRoot, name, entry)]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`cannot find ${name}/${entry}; looked in:\n  ${candidates.join('\n  ')}`)
}

const registryEntry = resolvePackage('@deepseek-ai/dsh-typert-registry', 'lib/index.js')
const cordisEntry = resolvePackage('@deepseek-ai/cordis', 'lib/index.js')

const { Context } = await import(pathToFileURL(cordisEntry).href)
const registryModule = await import(pathToFileURL(registryEntry).href)
const TypertRegistry = registryModule.default ?? registryModule.TypertRegistry

const { TYPERT, WORKFLOW_INVOCATIONS } = await import(
  pathToFileURL(join(here, '..', 'lib', 'host', 'descriptors.js')).href
)

console.log(`registry loaded: ${typeof TypertRegistry}`)
console.log(`descriptors: ${WORKFLOW_INVOCATIONS.length}`)

const ctx = new Context()
const registry = new TypertRegistry(ctx)

// The registry accepts exactly one contribution per package+face, so the whole
// real contribution is registered in a single call — the same call the plugin
// makes at activation. Registering descriptor-by-descriptor would fail with
// `package face ... is already registered`, which is a probe artefact.
const failures = []
try {
  registry.register(TYPERT)
  console.log(`ACCEPTED  contribution ${TYPERT.package} (${TYPERT.face}), ${TYPERT.invocations.length} invocations`)
} catch (error) {
  failures.push(`contribution: ${error.message}`)
  console.log(`REJECTED  contribution -> ${error.message}`)
}

// Every endpoint must be exactly two segments: the gateway splits on '/'.
for (const descriptor of WORKFLOW_INVOCATIONS) {
  const endpoint = registryModule.typertEndpoint(descriptor)
  const segments = endpoint.split('/')
  const ok = segments.length === 2 && segments[0] !== '' && segments[1] !== ''
  if (!ok) failures.push(`${descriptor.id}: endpoint "${endpoint}" is not 2 segments`)
  console.log(
    `${ok ? 'ROUTABLE ' : 'HAZARD   '} id=${descriptor.id}  service=${descriptor.service}  namespace=${descriptor.namespace}  method=${descriptor.method}  endpoint=${endpoint}  segments=${segments.length}`,
  )
}

// The client reaches methods through `remote.${namespace}` — confirm the name.
for (const descriptor of WORKFLOW_INVOCATIONS) {
  const expected = `remote.${descriptor.namespace}`
  if (!/^remote\.[A-Za-z0-9_$.-]+$/.test(expected)) {
    failures.push(`namespace ${descriptor.namespace} yields an unusable client key ${expected}`)
  }
}
console.log(`client call path: ctx.remote.${WORKFLOW_INVOCATIONS[0].namespace}.<method>(request)`)

if (failures.length > 0) {
  console.error(`\n${failures.length} problem(s):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nOK: contribution accepted by the real registry; every endpoint is 2-segment and routable')

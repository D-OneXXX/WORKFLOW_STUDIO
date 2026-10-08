// Structural checks on the bundle that `npm run typecheck` and the build cannot
// make: the manifest's DSH fields and the loader patch dialect.
//
// Deliberately dependency-free so it runs inside the sandbox without spawning
// anything.

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []

/** Record a failure rather than throwing, so every problem is reported at once. */
function check(condition, message) {
  if (!condition) failures.push(message)
}

const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

// --- manifest identity -------------------------------------------------------
check(manifest.name === 'dsh-workflow-studio', `unexpected package name: ${manifest.name}`)
check(
  manifest.name !== '@deepseek-ai/dsh-workflow',
  'package name must not collide with the official workflow engine package',
)
check(manifest.type === 'module', 'package must be ESM ("type": "module")')
check(manifest.private !== false, 'package should stay private')

// --- bundle patch ------------------------------------------------------------
const patchRel = manifest.dsh?.bundle?.patch
check(typeof patchRel === 'string', 'dsh.bundle.patch must point at the patch file')
if (typeof patchRel === 'string') {
  const patchPath = join(root, patchRel)
  check(existsSync(patchPath), `dsh.bundle.patch points at a missing file: ${patchRel}`)
  if (existsSync(patchPath)) {
    const patch = readFileSync(patchPath, 'utf8')
    check(patch.includes('dsh-workflow-studio'), 'patch must insert the plugin row')
    check(
      patch.includes('@deepseek-ai/dsh-workflow-ptc'),
      'patch must mount the workflow engine service at the root',
    )
    // The loader patch dialect is a top-level YAML array of entries; comments
    // and blank lines may precede the first entry.
    const lines = patch.split(/\r?\n/)
    const body = lines
      .filter((line) => !line.trimStart().startsWith('#') && line.trim().length > 0)
      .join('\n')
    check(body.startsWith('- '), 'patch must be a top-level YAML array of entries')
    check(!/^\s*\t/m.test(patch), 'patch must not use tab indentation')

    // An id-targeted override must also carry `name`; the documented dialect
    // silently ignores an entry that targets by id without one. Top-level
    // entries are the ones starting at column zero.
    const entryStarts = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => /^- /.test(line))
    for (let i = 0; i < entryStarts.length; i += 1) {
      const start = entryStarts[i].index
      const end = i + 1 < entryStarts.length ? entryStarts[i + 1].index : lines.length
      const entry = lines.slice(start, end).join('\n')
      if (/^- id:/.test(lines[start])) {
        check(
          /^\s+name:\s*\S/m.test(entry),
          `patch entry "${lines[start].trim()}" targets by id but has no name; the loader ignores it`,
        )
      }
    }
  }
}

// --- client half -------------------------------------------------------------
const client = manifest.dsh?.client
check(client !== undefined, 'dsh.client must be declared for the web build')
if (client !== undefined) {
  check(client.platform === 'web', 'dsh.client.platform must be "web"')
  check(Array.isArray(client.inject), 'dsh.client.inject must be an array')
  check(
    Array.isArray(client.inject) && client.inject.includes('@deepseek-ai/dsh-client-ui-sidebar'),
    'the client half registers into sidebar.panellist, so it must inject the sidebar package',
  )
}

// --- exports -----------------------------------------------------------------
check(manifest.exports?.['.'] === './lib/index.js', 'the host half must export lib/index.js')
check(manifest.exports?.['./client'] === './lib/client.js', 'the client half must export lib/client.js')

// --- storage domain naming ---------------------------------------------------
// The storage layer validates domain names with /^[a-z][a-z0-9_]*$/, so a
// hyphen in the domain name would throw at module load.
const domainSource = join(root, 'src/host/domain.ts')
if (existsSync(domainSource)) {
  const source = readFileSync(domainSource, 'utf8')
  const match = /WORKFLOW_DOMAIN = '([^']+)'/.exec(source)
  check(match !== null, 'could not read WORKFLOW_DOMAIN from src/host/domain.ts')
  if (match) {
    check(
      /^[a-z][a-z0-9_]*$/.test(match[1]),
      `domain name "${match[1]}" must match /^[a-z][a-z0-9_]*$/`,
    )
  }
}

// --- Typert wire vocabulary --------------------------------------------------
// The registry validates `namespace` and `method` against /^[A-Za-z0-9_$.-]+$/.
// An illegal name throws inside ctx.typert.register(), and that unhandled
// rejection is a FATAL host load failure: the Harness process exits and Desktop
// falls back to safe mode, which blocks third-party bundles. This check exists
// so that class of mistake fails here instead of at startup.
const wireSource = join(root, 'src/shared/wire.ts')
if (existsSync(wireSource)) {
  const source = readFileSync(wireSource, 'utf8')
  const pattern = /^[A-Za-z0-9_$.-]+$/
  const namespaceMatch = /WORKFLOW_NAMESPACE = '([^']+)'/.exec(source)
  check(namespaceMatch !== null, 'could not read WORKFLOW_NAMESPACE from src/shared/wire.ts')
  if (namespaceMatch) {
    check(
      pattern.test(namespaceMatch[1]),
      `wire namespace "${namespaceMatch[1]}" must match /^[A-Za-z0-9_$.-]+$/ (no slash)`,
    )
  }
  const methodsMatch = /WORKFLOW_METHODS = \[([^\]]+)\]/.exec(source)
  check(methodsMatch !== null, 'could not read WORKFLOW_METHODS from src/shared/wire.ts')
  if (methodsMatch) {
    const methods = [...methodsMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
    check(methods.length === 5, `expected 5 workflow methods, found ${methods.length}`)
    for (const method of methods) {
      check(
        pattern.test(method),
        `wire method "${method}" must match /^[A-Za-z0-9_$.-]+$/ (no slash)`,
      )
    }
  }
  check(
    source.includes('assertWireVocabulary()'),
    'src/shared/wire.ts should call assertWireVocabulary() at module load',
  )
}

if (failures.length > 0) {
  console.error(`lint failed (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('lint ok')

// Stage a small offline probe environment so `verify-binding.mjs` can import the
// built host bundle.
//
// The host build keeps `@deepseek-ai/*` external because the Harness process
// resolves those from its own installation. Offline there is nothing to resolve,
// so this creates minimal stubs for the few bare specifiers `lib/index.js`
// imports. The probe only exercises the Typert binding and the `inject` list, so
// the stub bodies are never called.

import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const workspaceRoot = join(here, '..', '..')
// Node resolves a bare specifier by walking up from the IMPORTING file, so the
// stubs and the real protocol/cordis must live under this package's own
// node_modules for `lib/index.js` to find them.
const scope = join(here, '..', 'node_modules', '@deepseek-ai')

/** Minimal modules that satisfy the host bundle's imports. */
const stubs = {
  '@deepseek-ai/dsh-session': {
    code: 'export function SessionId(id) { return id }\n',
  },
  '@deepseek-ai/dsh-storage-domain': {
    code: [
      'export function defineDomain(spec) { return spec }',
      'export function domainTable(valueSchema) { return { valueSchema } }',
      '',
    ].join('\n'),
  },
}

mkdirSync(scope, { recursive: true })

for (const [name, stub] of Object.entries(stubs)) {
  const bare = name.replace('@deepseek-ai/', '')
  const directory = join(scope, bare)
  mkdirSync(directory, { recursive: true })
  const manifest = {
    name,
    version: '0.0.0-probe-stub',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
  }
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  writeFileSync(join(directory, 'index.js'), stub.code, 'utf8')
  console.log(`staged stub ${name} -> ${directory}`)
}

// The real cordis and typert-protocol must also resolve as packages, because
// lib/index.js imports them as bare specifiers.
const realPackages = [
  ['@deepseek-ai/cordis', join(workspaceRoot, '.recon', 'npm5', 'ex', 'package')],
  ['@deepseek-ai/dsh-typert-protocol', join(workspaceRoot, '.recon', 'npm3', 'ex', 'dsh-typert-protocol-0.2.0-rc.2', 'package')],
  ['@deepseek-ai/dsh-typert-registry', join(workspaceRoot, '.recon', 'npm2', 'ex', 'dsh-typert-registry-0.2.0-rc.2', 'package')],
  ['@deepseek-ai/cosmokit', join(workspaceRoot, '.recon', 'npm8', 'node_modules', '@deepseek-ai', 'cosmokit')],
]

for (const [name, source] of realPackages) {
  if (!existsSync(source)) {
    console.log(`note: ${name} source not found at ${source} (skipped)`)
    continue
  }
  const bare = name.replace('@deepseek-ai/', '')
  const target = join(scope, bare)
  if (existsSync(target)) {
    console.log(`present: ${name}`)
    continue
  }
  cpSync(source, target, { recursive: true })
  console.log(`copied: ${name} -> ${target}`)
}

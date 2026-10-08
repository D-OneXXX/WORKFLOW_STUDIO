// Build then run every tests/*.test.mjs inside this process.
//
// Why not `node --test`: the built-in test runner spawns a child process for
// each test file, and the DSH workspace-write sandbox denies that spawn with
// EPERM. Importing the files here keeps the tests runnable inside the sandbox.
//
// The bundle build is imported rather than spawned for the same reason. That
// build does need a child process of its own (esbuild), so it is skipped when
// the artifacts are already present: set WORKFLOW_STUDIO_SKIP_BUILD=1 to run
// the tests against the current lib/ without rebuilding.

import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const skipBuild = process.env.WORKFLOW_STUDIO_SKIP_BUILD === '1'
const sharedOnly = process.env.WORKFLOW_STUDIO_SHARED_ONLY === '1'

if (!skipBuild) {
  await import(pathToFileURL(join(root, 'build.mjs')).href)
}

const required = sharedOnly
  ? ['lib/shared/compiler.js']
  : ['lib/shared/compiler.js', 'lib/index.js', 'lib/client.js']
const missing = required.filter((relative) => !existsSync(join(root, relative)))
if (missing.length > 0) {
  console.error(`missing build artifacts: ${missing.join(', ')}`)
  console.error('run `node build.mjs` (needs child-process access) before the tests')
  process.exit(1)
}

const testsDir = join(root, 'tests')
const files = readdirSync(testsDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => !sharedOnly || name.startsWith('compiler.'))
  .sort()

if (files.length === 0) {
  console.error('no test files found in tests/')
  process.exit(1)
}

for (const file of files) {
  await import(pathToFileURL(join(testsDir, file)).href)
}

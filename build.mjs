// Build every artifact with esbuild.
//
// Artifacts:
//   * lib/index.js   Host half, ESM, loaded by Cordis in the Harness process.
//   * lib/client.js  Client half, one IIFE bundle registered into the page's
//                    module table so React comes from the host page.
//   * lib/shared/*   Compiler, descriptors, and sample workflow.
//
// `.css` uses the `text` loader: @xyflow/react ships stylesheets, and without
// it esbuild emits a separate asset instead of folding them into the client
// bundle. `--shared-only` skips the two entry bundles.
//
// esbuild talks to a helper process over pipes, which the DSH workspace-write
// sandbox denies with EPERM; run this script with wider access.

import { build } from 'esbuild'

const sharedOptions = {
  bundle: true,
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
  target: ['es2022'],
}

/**
 * Compile the shared modules both halves import, plus the Host descriptor and
 * schema modules so the test suite can validate the REAL descriptor objects
 * rather than only the vocabulary constants.
 *
 * zod is bundled here (it is a devDependency, present at build time) so these
 * artifacts import standalone. The Host entry keeps zod external, because the
 * Harness process resolves it at runtime.
 */
async function buildShared() {
  await build({
    ...sharedOptions,
    entryPoints: {
      'lib/shared/compiler': 'src/shared/compiler.ts',
      'lib/shared/contract': 'src/shared/contract.ts',
      'lib/shared/descriptors': 'src/shared/descriptors.ts',
      'lib/shared/sample': 'src/shared/sample.ts',
      'lib/shared/wire': 'src/shared/wire.ts',
      'lib/shared/document-session': 'src/client/document-session.ts',
      'lib/host/descriptors': 'src/host/descriptors.ts',
      'lib/host/schemas': 'src/host/schemas.ts',
    },
    outdir: '.',
    format: 'esm',
    platform: 'neutral',
  })
}

/** Compile the Host half. */
async function buildHost() {
  await build({
    ...sharedOptions,
    entryPoints: ['src/host/index.ts'],
    outfile: 'lib/index.js',
    format: 'esm',
    platform: 'node',
    // Resolved by the Harness process from its own installation.
    external: ['@deepseek-ai/*', 'zod'],
  })
}

/** Compile the Client half into one page-registered bundle. */
async function buildClient() {
  await build({
    ...sharedOptions,
    entryPoints: ['src/client/index.tsx'],
    outfile: 'lib/client.js',
    format: 'iife',
    platform: 'browser',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    // @xyflow/react declares no side effects, so without this its stylesheet
    // import is dropped instead of being inlined as text.
    ignoreAnnotations: true,
    // The page's module table resolves React; bundling a second copy would
    // break hooks inside the host application.
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    define: { 'process.env.NODE_ENV': '"production"' },
  })
}

const sharedOnly = process.argv.includes('--shared-only')
export { buildShared, buildHost, buildClient, sharedOnly }

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  await buildShared()
  if (!sharedOnly) {
    await buildHost()
    await buildClient()
  }
  console.log(`build complete${sharedOnly ? ' (shared only)' : ''}`)
}

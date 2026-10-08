/**
 * Compile the standalone edition: the shared and host artifacts under `lib/`,
 * then the one browser bundle the local server serves.
 *
 * `buildStandalone` is exported so `standalone/dev.mjs` can rebuild without
 * duplicating these options; running this file directly does the whole build.
 */

import { build } from 'esbuild'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildShared } from '../build.mjs'

/** Rewrite `standalone/dist/app.js`. React is bundled: there is no host page here. */
export async function buildStandalone() {
  await build({
    entryPoints: ['src/standalone/index.tsx'],
    outfile: 'standalone/dist/app.js',
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    loader: { '.css': 'text' },
    ignoreAnnotations: true,
    define: { 'process.env.NODE_ENV': '"production"' },
    sourcemap: false,
    minify: true,
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildShared()
  await buildStandalone()
  console.log('standalone build complete; React is bundled locally')
}

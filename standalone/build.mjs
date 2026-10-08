import { build } from 'esbuild'
import { buildShared } from '../build.mjs'
await buildShared()
await build({ entryPoints: ['src/standalone/index.tsx'], outfile: 'standalone/dist/app.js', bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', jsx: 'automatic', loader: { '.css': 'text' },
  ignoreAnnotations: true, define: { 'process.env.NODE_ENV': '"production"' }, sourcemap: false, minify: true })
console.log('standalone build complete; React is bundled locally')

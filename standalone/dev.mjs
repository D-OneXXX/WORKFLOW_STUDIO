/**
 * Rebuild and keep the standalone edition running while the source changes.
 *
 * What happens on a change depends on what changed:
 *
 * * browser sources (`src/client`, `src/standalone`, the shared half of the UI)
 *   — the bundle is rewritten and **the server is left alone**. Refreshing the
 *   page is enough, and a run that is in flight, or an agent call that takes
 *   minutes, survives the rebuild.
 * * server sources (`standalone/*.mjs`, `src/host`, anything that lands in
 *   `lib/`) — the child process is replaced, because Node has already evaluated
 *   the old module graph and there is no honest way to swap it in place.
 * * `standalone/index.html` — nothing at all; it is read from disk per request.
 *
 * `lib/host/schemas.js` and `lib/shared/compiler.js` are what the store and the
 * runner import, so every rebuild regenerates them first.
 *
 * esbuild talks to a helper process over pipes, which the DSH workspace-write
 * sandbox denies with EPERM; this script needs the same wider access `npm run
 * build` does.
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, watch } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildShared } from '../build.mjs'
import { buildStandalone } from './build.mjs'

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')

const PORT = Number(process.env.WORKFLOW_STUDIO_PORT ?? 43199)
const DATA_DIR = process.env.WORKFLOW_STUDIO_DATA_DIR ?? join(root, 'standalone', 'data')
const DEBOUNCE_MS = 180

const log = (text) => process.stdout.write(`[dev] ${text}\n`)

/**
 * Does this file change reach the server process?
 *
 * Anything the browser bundle absorbs on its own is `false`; anything the server
 * imports — its own modules, or the `lib/` artifacts generated from `src/host` —
 * is `true`. `src/shared` is imported by both halves, so it restarts: a compiler
 * change must not leave a stale `lib/shared/compiler.js` behind.
 */
function needsRestart(file) {
  const relative = file.slice(root.length + 1).replaceAll('\\', '/')
  if (relative === 'standalone/index.html') return false
  if (relative.startsWith('standalone/') && relative.endsWith('.mjs')) return true
  if (relative.startsWith('src/host/')) return true
  if (relative.startsWith('src/shared/')) return true
  return false
}

/** The files worth reacting to, and the directories to watch to see them. */
function isSource(file) {
  return /\.(ts|tsx|css|mjs|html)$/.test(file)
}

let child = undefined
let restarting = false

/**
 * The child that runs the server.
 *
 * Two things kill it, and both matter:
 *
 * * an IPC `shutdown` — a deliberate restart, answered by `app.close()`, which
 *   stops any run in flight rather than leaving a worker process behind;
 * * stdin reaching end-of-file — the supervisor died without saying goodbye, so
 *   the child must not outlive it and squat on the port. Killing a process does
 *   not kill its children on Windows, and an orphan holding 127.0.0.1:43199 is
 *   worse than no server at all.
 */
const CHILD_BOOTSTRAP = `
import { pathToFileURL } from 'node:url'
const serverUrl = process.env.WFS_DEV_SERVER_URL
const { startStandaloneServer } = await import(serverUrl)
const app = await startStandaloneServer({
  dataDir: process.env.WFS_DEV_DATA_DIR,
  port: Number(process.env.WFS_DEV_PORT),
})
process.stdin.resume()
const gone = () => process.exit(0)
process.stdin.on('end', gone)
process.stdin.on('error', gone)
process.on('message', (message) => {
  if (message === 'shutdown') app.close().then(() => process.exit(0), () => process.exit(0))
})
`

async function start() {
  child = spawn(process.execPath,
    ['--input-type=module', '-e', CHILD_BOOTSTRAP],
    {
      cwd: root,
      stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
      env: {
        ...process.env,
        WFS_DEV_DATA_DIR: DATA_DIR,
        WFS_DEV_PORT: String(PORT),
        WFS_DEV_SERVER_URL: pathToFileURL(join(root, 'standalone', 'server.mjs')).href,
      },
    })
  child.on('exit', (code, signal) => {
    if (restarting) return
    // An exit nobody asked for is the interesting one, so it stays visible.
    log(`服务进程退出（code=${code} signal=${signal}）。已停止，请重新运行 npm run standalone:dev`)
    process.exitCode = code ?? 1
  })
}

async function restart() {
  restarting = true
  const running = child
  child = undefined
  if (running !== undefined && running.exitCode === null) {
    // Ask it to close its runs first, then give it a moment before forcing.
    const exited = new Promise((done) => running.once('exit', done))
    try {
      running.send('shutdown')
    } catch {
      running.kill()
    }
    await Promise.race([exited, new Promise((done) => setTimeout(done, 2_000))])
    if (running.exitCode === null && running.signalCode === null) running.kill()
  }
  restarting = false
  await start()
}

async function rebuild(shouldRestart, changed) {
  try {
    await buildShared()
    await buildStandalone()
    if (shouldRestart) {
      await restart()
      log(`重建并重启完成 → http://127.0.0.1:${PORT}（改了 ${changed}）`)
    } else {
      log(`前端已重建 → 刷新页面即生效，服务未重启（改了 ${changed}）`)
    }
  } catch (error) {
    // A broken file must not end the session: keep serving what still works.
    log(`重建失败：${error?.message ?? error}（服务保持原样）`)
  }
}

/**
 * Coalesce the burst of events one save emits into a single rebuild.
 *
 * One save fires several `change` events, and an editor that writes through a
 * temp file reports the rename too. The burst is answered once, after it settles,
 * and it needs a restart if *any* file in it touched the server.
 */
function debounce(make) {
  let timer
  let restart = false
  let last = ''
  return (file) => {
    last = file
    restart ||= needsRestart(file)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const shouldRestart = restart
      const changed = last
      restart = false
      make(shouldRestart, changed)
    }, DEBOUNCE_MS)
  }
}

const queue = debounce((shouldRestart, changed) => { void rebuild(shouldRestart, changed) })

/**
 * Act only when the bytes actually differ.
 *
 * Windows reports change events for files whose metadata was touched by the
 * indexer or an antivirus scan, and a restart on one of those would kill an
 * agent call the user is waiting on. The map is seeded from the current sources
 * at startup, because an unrecorded file would otherwise look "changed" on its
 * very first real event — which is the one event that matters.
 */
const fingerprints = new Map()

function hashOf(file) {
  try {
    return createHash('sha1').update(readFileSync(file)).digest('hex')
  } catch {
    return undefined
  }
}

function snapshot(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) {
      // `dist/` and `data/` are build output and local state, never sources.
      if (full.replaceAll('\\', '/').includes('/standalone/dist')) continue
      snapshot(full)
    } else if (isSource(full)) {
      fingerprints.set(full, hashOf(full))
    }
  }
}

function contentsChanged(file) {
  const hash = hashOf(file)
  if (hash === undefined) {
    // Deleted, or caught mid-save: either way it is worth a rebuild.
    fingerprints.delete(file)
    return true
  }
  if (fingerprints.get(file) === hash) return false
  fingerprints.set(file, hash)
  return true
}

for (const directory of ['src', 'standalone']) {
  snapshot(join(root, directory))
  watch(join(root, directory), { recursive: true }, (_event, file) => {
    if (file === null) return
    const full = join(root, directory, file)
    if (!isSource(full)) return
    // The build writes into standalone/dist; ignoring it stops a feedback loop.
    if (full.replaceAll('\\', '/').includes('/standalone/dist/')) return
    if (!contentsChanged(full)) return
    queue(full)
  })
}

await buildShared()
await buildStandalone()
await start()
log(`监听 src/ 与 standalone/ 的改动`)
log(`独立版：http://127.0.0.1:${PORT}｜数据目录：${DATA_DIR}`)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    // Ask the child to stop its runs, then leave. If this process is killed
    // outright instead, the child's stdin hits end-of-file and it exits too.
    restarting = true
    try {
      child?.send('shutdown')
    } catch {
      child?.kill()
    }
    setTimeout(() => process.exit(0), 300)
  })
}

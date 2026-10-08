# dsh-workflow-studio

## Standalone browser edition (recommended)

The first standalone stage runs independently of Harness. It reuses the canvas
and compiler, bundles its own React, keeps workflows in its own JSON store, and
executes each run in a disposable Node child process. No Harness profile changes
or plugin installation are needed. The legacy plugin described below should not
be reinstalled as part of this standalone setup.

From this directory, with Node 22+ and dependencies installed:

```sh
npm run standalone:build
npm run standalone:start
```

Open `http://127.0.0.1:43180/`; load the example, save, and run. Alternatively,
run `standalone/start.ps1` in PowerShell to build and start together. Keep that
terminal open; Ctrl+C stops the service.

Workflows are saved in `standalone/data/workflows.json`. Set
`WORKFLOW_STUDIO_DATA_DIR` to choose another directory and
`WORKFLOW_STUDIO_PORT` to choose another port. The server listens only on
127.0.0.1 and rejects foreign origins and requests without its application header.

**Stage-one capabilities:** edit input/code/branch/output/LLM nodes, validate,
save/list/open/delete, import/export version-one JSON documents, and really run
input/code/branch/output. An LLM node runs by delegating to an **outbound
connector** (below); with none configured it says so rather than inventing
output. Inbound MCP, the `http`/`mcp` adapters, streaming and the run ledger are
later stages. Run logs and node colours are shown on completion; this stage does
not stream them.

### Outbound connectors: the workflow is the manager

An `llm` node does not call a model itself. It hands the step to an agent
program — `codex`, `zcode`, a cloud endpoint — chosen per node. The workflow
keeps the DAG, the state and the schedule; the agent does the work.

Configure it by copying the template into the data directory and editing it:

```sh
cp standalone/connectors.example.json standalone/data/connectors.json
```

```json
{
  "defaultConnector": "codex-local",
  "connectors": [
    { "id": "codex-local", "kind": "cli", "label": "Codex（本机）",
      "command": "codex exec", "promptVia": "arg", "timeoutMs": 300000 }
  ]
}
```

`connectors.json` lives in the data directory, which is gitignored — it may hold
endpoints and environment values. Only `id`, `kind` and `label` are ever sent to
the browser.

* Three generic kinds — `cli`, `http`, `mcp` — so a newly installed agent
  program is a config edit, not a code change. Phase A implements `cli`; the
  other two are recognised and reported as pending.
* `command` is split without a shell (`shell: false`), so the prompt is always
  data, never syntax. Quote the program part if its path contains spaces.
* The prompt reaches the agent on stdin by default, or as one argument with
  `"promptVia": "arg"`. Check your CLI's convention; `codex` and `zcode` differ.
* An agent must return `{ "output": …, "summary": … }`. With
  `"outputFormat": "text"` stdout is wrapped into that shape (the first line
  becomes the summary); with `"json"` the CLI must produce it. A response that
  cannot satisfy the contract fails the node instead of passing text along.
* Pick the executor for a node in the property panel, next to the prompt. A node
  with no choice uses `defaultConnector`. The binding is stored on the node as
  `executor`, so it travels with save, export and import — and because it is an
  optional field, the document format stays at version 1.

**Why secrets stay in the server.** The worker child runs your code nodes, so its
environment is a fixed whitelist. When a node asks for an agent step the worker
sends only `{ nodeId, prompt }` over IPC; the parent performs the call and
returns the result. A connector's command line, endpoint and `env` therefore
never enter the worker, and prompts and response bodies are kept out of the run
log — only the connector id, duration and status are recorded. Agent nodes get a
five-minute budget by default, their own concurrency slot, and a delegation-depth
cap of three so an agent that calls back into a workflow cannot recurse.

**Local code execution:** code nodes run with the current user's privileges in
a separate process, not a permissions sandbox. Only run trusted code. A run is
terminated after 30 seconds; at most two runs execute concurrently. Provider and
Harness credentials are not copied from the server's environment to the worker.
Child processes deliberately spawned by user code are outside this timeout guarantee.

**File interchange:** `导出 JSON` exports the current validated graph, including
unsaved edits. `导入 JSON` validates and saves a new copy with a new ID; it never
overwrites an existing ID from the file. Documents use
`{ "format": "dsh-workflow-studio", "version": 1, "workflow": { "name": "...", "graph": { "nodes": [], "edges": [] } } }`.
The HTTP/file limit is 2 MB. A runnable example is in
`standalone/examples/local-workflow.json`. Older plugin storage and formats are
not migrated automatically, and file interchange is not yet automatic Harness interaction.

Validation: `npm run standalone:test`, `npm run typecheck`, and `npm test`.

## Legacy embedded plugin

A visual workflow plugin for DeepSeek Harness: compose a DAG on a canvas, save
it, and run it in one click. The interaction model follows Bisheng's workflow
composer (drag, connect, inspect); no Bisheng code is used.

> The package is named `dsh-workflow-studio` on purpose. `@deepseek-ai/dsh-workflow`
> is the official workflow **engine service** (`ctx.workflowEngine`), a different
> thing entirely.

## What it does

* **Sidebar entry + full-screen panel.** One cell in the `sidebar.panellist` list
  slot (order 200) and a matching cell in the keyed `main` slot under the same id,
  opened with `ctx.layout.selectPanel(id)`.
* **Canvas** built on `@xyflow/react`: add nodes from the palette, drag to
  arrange, connect handles, delete nodes and edges.
* **Five node kinds** — `input`, `llm`, `code`, `branch`, `output`. A branch node
  has two source handles, `true` and `false`.
* **Property panel** for input text, prompt, code, condition, output value, and
  the node label.
* **DAG → JavaScript compiler** with strict validation, so an invalid graph is
  rejected in the UI *and* again on the host before anything is stored.
* **Persistence** in the plugin's own storage domain, `dsh_workflow`.
* **Run** through `ctx.workflowEngine`, with live node colouring driven by the
  engine's phase events.
* **Bilingual** via the client locale service (`zh` / `en`).

## Architecture

```
src/shared/     compiler, sample workflow, wire vocabulary (both halves)
src/host/       zod schemas, storage domain, Typert descriptors, RPC service
src/client/     canvas, palette, inspector, run panel, locales
```

The two halves talk over **Typert** typed RPC. The five endpoints are the
methods `save`, `list`, `load`, `delete`, and `run` in the wire namespace
`workflow`, so the client calls `ctx.remote.workflow.save(...)` and so on.

| Method | Purpose |
|---|---|
| `save` | validate then persist a workflow |
| `list` | summaries, newest first |
| `load` | one record by id |
| `delete` | remove a record |
| `run` | compile, start a run, wait for its result |

`src/host/descriptors.ts` declares the Host contribution with real zod codecs;
`src/client/remote.ts` mounts the matching contribution and binds the same
method names.

### Wire-name rules, and why they matter

The Typert registry validates both `namespace` and `method` against
`/^[A-Za-z0-9_$.-]+$/`:

```js
function validateWireName(subject, value) {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value))
    throw new Error(`typert: invalid ${subject} "${value}" — must contain only RPC endpoint segment characters`)
}
```

A forward slash is therefore illegal in **either** field. Writing
`method: 'workflow/save'` throws inside `ctx.typert.register()`; because that
rejection is unhandled it becomes a **fatal host load failure** — the Harness
process exits, and Desktop recovers by relaunching into **safe mode**, where
third-party bundles are blocked. The slash is legal only in the human-readable
`id` (`dsh-workflow-studio#workflow/save`), which is validated merely as
non-empty.

Three guards now exist so this cannot recur: `assertWireVocabulary()` runs at
module load in `src/shared/wire.ts`, `npm run lint` checks the vocabulary
statically, and `tests/wire.test.mjs` pins the registry's rule.

## Accepted graph shape (v0.1)

One linear chain with **at most one** single-level `branch`. The two arms either
rejoin at a shared node (including the output) or terminate at separate outputs.

Rejected, with a Chinese message shown to the user:

| Rejected | Message contains |
|---|---|
| a cycle | `工作流存在环` |
| fan-out (parallelism) | `扇出` / `不支持并行执行` |
| nested branches | `分支嵌套` |
| a branch missing `true` or `false` | `缺少 ... 出边` |
| a branch edge with no handle | `true / false 分支端口` |
| no input node | `缺少输入节点` |
| no output node | `缺少输出节点` |
| unreachable node | `不连通` |
| interpolation of an unknown node | `不存在的节点` |

`{{node-id}}` interpolation supports hyphens, dots, and word characters, so
`{{n-true}}` works. Node ids are sanitized into JavaScript identifiers, and
reserved words (`in`, `class`, `new`, …) are handled.

## Install

```sh
node build.mjs          # writes lib/index.js and lib/client.js
```

Then install the bundle into the active profile (`plugin_manager`,
`action: install_bundle`, `target`: this directory). The bundle patch
`cordis.patch.yml` does two things:

1. Mounts the workflow engine at the composition root. `@deepseek-ai/dsh-workflow-ptc`
   is a **service, not a bundle** (no `dsh.bundle` field), and profiles expose it
   only inside isolated agent-preset groups, so a root-level consumer needs the
   row inserted *and* `disabled: false`.
2. Inserts the plugin's own Host row.

## Demo workflow

`载入示例` (Load sample) builds the end-to-end acceptance case:

```
input topic → llm writes an outline → branch (length > 500?) → one shared output
```

Both branch arms rejoin the same output node, which is the shape the compiler is
built around.

## Development

```sh
npm run typecheck   # tsc --noEmit
npm run lint        # manifest, patch dialect, and domain-name checks
npm test            # 20 compiler tests, including sandboxed branch execution
npm run check       # all three
```

`npm test` executes the compiled compiler in this process and runs each compiled
script with stubbed `agent`/`phase`/`log` hooks, so both branch arms are really
executed rather than only inspected.

### Sandbox note

esbuild talks to a helper process over pipes. Under the DSH **workspace-write**
sandbox that spawn is denied with `EPERM`, so `node build.mjs` needs either
`danger-full-access` or an approved escalation. Everything else — `typecheck`,
`lint`, and the tests — runs in-process and works inside the stricter sandbox.
`scripts/test.mjs` imports the build rather than spawning it for the same reason.

## Deviations from the task brief

The brief pins `@deepseek-ai/dsh@0.1.7-rc.2`, but the runtime installed here is
**0.2.0-rc.2**. Where the two disagree, the installed runtime wins and the
difference is recorded rather than papered over. The material ones:

* **`phase(label, nodeId)` is not supported.** In this version `phase()` takes
  exactly one argument and the second is silently dropped — there is no node-id
  channel anywhere on the path. The compiler therefore emits `phase('<nodeId>')`
  and the plugin listens on `workflow/phase` to recover the node id for canvas
  colouring. `agent(prompt, { phase: nodeId })` is used as well, since that
  option does accept a free-form string.
* **`WorkflowResult` has a fourth required field**, `agentsStarted`.
* **`meta` accepts only `name`, `description`, `whenToUse`, and `phases`.**
  There is no `cwd`, and unknown keys are a hard `META_INVALID`. The working
  directory reaches the run through the parent agent's session instead, which is
  why `run` creates the parent with `meta: { cwd }`.
* **`parent` must be a live `Agent`**, not an id. It is created with
  `ctx.agents.create({ sessionId })` and disposed in a `finally` block.
* **The engine enforces no overall elapsed-time limit**, so the 15-minute circuit
  breaker is implemented by the plugin with an `AbortController` rather than
  assumed from the engine.
* **A second engine in one context fails loudly**, so the patch does not insert a
  duplicate where a root row already exists — it re-enables the existing one.
* **The brief's `workflow/save`-style method names are illegal.** The Typert
  registry validates `namespace` and `method` separately against
  `/^[A-Za-z0-9_$.-]+$/`, so the slash can only live in the invocation `id`. The
  endpoints are therefore the methods `save`/`list`/`load`/`delete`/`run` in the
  namespace `workflow`. See "Wire-name rules" above for the full failure mode.

Everything the plugin reads or writes lives in its own `dsh_workflow` domain.

## Recovering from a bad activation

An invalid descriptor throws inside `ctx.typert.register()`, and because that
rejection is unhandled the Harness process exits with a fatal load failure.
Desktop then relaunches into **safe mode** (`desktop-safe-mode`), a separate
profile in which third-party bundles are blocked — so the plugin legitimately
disappears from the sidebar and its service is not registered. That state is
recovery behaviour, not a plugin bug in itself.

To get back to a working install:

1. Exit safe mode from the Desktop UI and let it boot the normal profile.
2. Reinstall the bundle from this directory (`plugin_manager`,
   `action: install_bundle`). Reinstalling is required, not optional: the
   profile's generation override still points at the previous content-addressed
   generation, and a plain restart reloads that same broken copy.
3. Restart if the install reports `restart-required`.

`node scripts/verify-descriptors.mjs` (part of `npm run check`) registers this
plugin's real descriptor objects against the real registry extracted from the app
bundle, so an illegal wire name fails locally instead of at startup.

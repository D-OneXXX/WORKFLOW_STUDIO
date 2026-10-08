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

To work on it instead of just using it, run the watcher on
`http://127.0.0.1:43199`:

```sh
npm run standalone:dev
```

It rebuilds on every save. A change to the browser sources rewrites the bundle and
**leaves the server alone** — refresh the page, and a run in flight or an agent
call that takes minutes survives it. A change to `standalone/*.mjs`, `src/host` or
`src/shared` replaces the process, because Node has already evaluated the old
module graph. A touch that changes no bytes does nothing at all: Windows reports
metadata events for files the indexer or an antivirus merely opened, and
restarting on one of those would kill a call you are waiting for. Stop it with
Ctrl+C, or by killing the process — the server is a child that exits when its
supervisor's stdin closes, so it cannot outlive the watcher and squat the port.

Workflows are saved in `standalone/data/workflows.json`. Set
`WORKFLOW_STUDIO_DATA_DIR` to choose another directory and
`WORKFLOW_STUDIO_PORT` to choose another port. The server listens only on
127.0.0.1 and rejects foreign origins and requests without its application header.

**Stage capabilities:** edit input/code/branch/output/LLM nodes, validate,
save/list/open/delete, import/export version-one JSON documents, and really run
input/code/branch/output. An LLM node runs by delegating to an **outbound
connector** (below); with none configured it says so rather than inventing
output. Branch, llm and code nodes can be configured by **describing them in
plain words** (below) instead of writing the configuration. The studio also
speaks **inbound MCP** (below), so an agent program can list and run these
workflows as tools. Streaming status, the persisted run ledger and the `mcp`
outbound adapter are later stages. Run logs and node colours are shown on
completion; this stage does not stream them.

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
  program is a config edit, not a code change. `cli` and `http` are implemented;
  `mcp` (this studio calling *out* to another MCP server) is recognised and
  reported as pending.
* `command` is split without a shell (`shell: false`), so the prompt is always
  data, never syntax. Quote the program part if its path contains spaces.
* The prompt reaches the agent on stdin by default, or as one argument with
  `"promptVia": "arg"`. Check your CLI's convention; `codex` and `zcode` differ.
* An `http` connector POSTs one chat-completion message to its `url`, using
  `model` and any fixed `headers`. **The key is never stored in the file**:
  `apiKeyEnv` names an environment variable in the server process, and a missing
  variable is reported by name before any request is made. A non-2xx response
  says only `返回 HTTP <status>` — the body is not surfaced, because an error
  payload can echo a credential back.
* An agent must return `{ "output": …, "summary": … }`. With
  `"outputFormat": "text"` stdout is wrapped into that shape (the first line
  becomes the summary); with `"json"` the CLI must produce it. A chat completion
  is read from `choices[0].message.content`. A response that cannot satisfy the
  contract fails the node instead of passing text along.
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

### Inbound MCP: an agent can run your workflows

The other direction. `standalone/mcp.mjs` is an MCP server over stdio, so an
agent program (Harness, Codex, any MCP client) can see the saved library and
drive a run as a tool — the studio becomes one step inside a larger agent task,
without the browser being open.

Register it with the client's usual MCP config, pointing at the same data
directory the browser uses (`npm run standalone:mcp` is the same command, for
testing it by hand):

```json
{
  "mcpServers": {
    "workflow-studio": {
      "command": "node",
      "args": ["<repo>/standalone/mcp.mjs"],
      "env": { "WORKFLOW_STUDIO_DATA_DIR": "<repo>/standalone/data" }
    }
  }
}
```

Protocol version `2025-06-18`, three tools:

| Tool | What an agent gets |
|---|---|
| `workflow.list` | id, name, description, node count, `updatedAt`, newest first |
| `workflow.run` | run a saved workflow by `id` (or an inline `graph`), optionally overriding the input node's text with `input`; `wait: false` returns a `runId` at once |
| `workflow.status` | that run's state — `running` / `completed` / `error` / `cancelled` — plus its result and the engine run id behind it |

`workflow.run` re-reads `workflows.json` on each request, so a workflow saved in
the browser a moment ago is immediately available to the agent.

A workflow that a *node* starts by calling back into MCP is one generation
deeper: the parent stamps `WORKFLOW_STUDIO_DEPTH` into the agent's environment,
this server reads it, and `workflow.run` is refused once the cap of three is
reached — while `workflow.list` keeps working, so an over-deep agent can still
inspect instead of being cut off entirely. That closes the loop the outbound
side opened: without the check, `llm → agent → workflow.run → llm → …` recurses.

Everything else the protocol needs is answered plainly: `initialize`, `ping`,
`tools/list`. A notification gets no reply, stdout carries one JSON-RPC frame
per line and nothing else, and all diagnostics go to stderr. A workflow that
cannot be found or a run that fails is a **tool result with `isError`**, not a
protocol error, so the agent can read the reason and react; only genuine
protocol misuse (`-32601`, `-32602`, `-32700`) is a JSON-RPC error.

Run statuses live in memory for the life of the session, capped at the last 200
finished runs. A persisted run ledger, streamed progress, and a comparison view
are the next stage.

### Plain-language node configuration

A branch, llm or code node can be configured by describing it in one sentence
instead of writing the configuration. This is **translate at edit time only**:
the model is called when the button is pressed, and the formal configuration it
proposes is what a run executes. A run calls no model to interpret your words, so
it costs nothing extra and behaves the same every time.

Every applicable node has two modes in the property panel:

* **大白话** — write the sentence, press `生成配置`, read the preview, press
  `确认使用`. Nothing is stored until you confirm, and the preview is editable
  because the usual mistake is one number or one clause, not the whole idea.
* **专家** — the fields as they have always been: condition type and value,
  prompt with `{{node-id}}`, code editor. Switching back shows the formal
  configuration either way, so translating never hides what a node actually does.

The node then carries both: `description` (your words, kept so they can be
translated again) and the formal field, which is the only thing the compiler
reads. `descriptionApplied` remembers which wording produced the current
configuration, so the panel can say 配置已过期 when you edit the sentence without
regenerating, or 已手动修改 when you edit the configuration itself.

The request goes to `POST /api/translate`. The browser sends the words and the
graph; it never builds the prompt, so the connector's command line, endpoint and
key stay in the server process, as with outbound agent steps.

Two things make a translation correct, and both are enforced rather than
requested:

* **The node list travels with the request**, marked by whether each node is
  upstream. Without it "把主题扩展成大纲" cannot be mapped to `{{n1}}` — and a
  reference to a node that has not run yet has no value to read.
* **The answer is re-checked against the graph.** A condition naming a node that
  is not the branch's upstream, a prompt interpolating a non-upstream node, a
  code body without a `return` or reaching for `fetch`/`process`/`require`/`fs`,
  is refused with a readable reason instead of being offered for confirmation.

Fallbacks, all of which keep the expert mode working:

| Situation | What you see |
|---|---|
| Beyond the four operators ("语气是否礼貌") | `untranslatable` plus the model's reason and how to say it instead |
| Two nodes could be meant | the candidates listed; pick one, and the retry carries your choice |
| No connector configured | plain mode greyed out with a pointer to `connectors.json`; expert mode unaffected |
| Call fails or times out | the error shown, your sentence left untouched |
| You don't trust the answer | it was only ever a proposal — edit it, or write it yourself |

A description is quoted inside a closed marker block whose delimiters are
stripped from the text, so a sentence that says "忽略上面的要求" is still just
something to translate.

For the human check the spec asks for — five typical sentences per kind, judged
by a person — these cover the shapes the three kinds support:

```text
分支    如果大纲的字数超过500
分支    输入里包含「紧急」就走这边
分支    清洗后的结果不足 20 个字
分支    主题正好是「无」
分支    大纲长度不超过 800

大模型  把主题扩展成一份300字左右的中文大纲，分点列出
大模型  用一句话说清楚输入讲的是什么
大模型  把大纲改写成面向小白的版本
大模型  判断输入是否需要补充资料，只回答是或否
大模型  把主题里的地名替换成对应省份

代码    把输入的每行前面加上序号
代码    去掉输入首尾的空格和换行
代码    把输入转成全大写
代码    统计输入有多少个字符，返回数字的文本
代码    把输入里所有的逗号换成中文逗号
```

**Local code execution:** code nodes run with the current user's privileges in
a separate process, not a permissions sandbox. Only run trusted code. A run is
terminated after 30 seconds — plus each `llm` node's own agent allowance, so a
graph that delegates to an agent is not cut off at the base limit — and at most
two runs execute concurrently (one, when a run uses agents). Provider and
Harness credentials are not copied from the server's environment to the worker.
Child processes deliberately spawned by user code are outside this timeout guarantee.

**File interchange:** `导出 JSON` exports the current validated graph, including
unsaved edits. `导入 JSON` validates and saves a new copy with a new ID; it never
overwrites an existing ID from the file. Documents use
`{ "format": "dsh-workflow-studio", "version": 1, "workflow": { "name": "...", "graph": { "nodes": [], "edges": [] } } }`.
The HTTP/file limit is 2 MB. A runnable example is in
`standalone/examples/local-workflow.json`. Older plugin storage and formats are
not migrated automatically, and file interchange is not yet automatic Harness interaction.

Validation: `npm run check` (typecheck, lint, the full suite, descriptor and
binding verification) and `npm run standalone:test`.

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
npm run lint        # manifest, patch dialect, wire vocabulary, domain-name checks
npm test            # build, then every suite in tests/
npm run check       # typecheck + lint + test + descriptor and binding verification
```

`npm test` runs each `tests/*.test.mjs` inside one process (the DSH
workspace-write sandbox denies the per-file child spawn `node --test` would
need). It covers the compiler and both branch arms with stubbed
`agent`/`phase`/`log` hooks, the document/session codec, the wire vocabulary, the
connector registry against fake CLI programs, the `http` adapter against a local
stub endpoint, and the MCP server spawned as a real child process and driven over
its actual stdio.

### Sandbox note

esbuild talks to a helper process over pipes. Under the DSH **workspace-write**
sandbox that spawn is denied with `EPERM`, so `node build.mjs` needs either
`danger-full-access` or an approved escalation; `scripts/test.mjs` imports the
build rather than spawning it for the same reason. `node --test` was rejected
for the same `EPERM` on its per-file child spawn, which is why the whole suite
is imported into one process.

Spawning a *real* program still works inside the stricter sandbox, and the suite
relies on that: the MCP server, the fake CLI connectors and the execution worker
are each started as child processes by their tests.

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

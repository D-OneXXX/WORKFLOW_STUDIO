# Changelog

Release history for `dsh-workflow-studio`. Versions follow
[semantic versioning](https://semver.org/) and are tagged as annotated Git tags
on `main`.

This project carries **three unrelated version numbers**. They must not be
bumped together. See [Version identity](#version-identity) below.

## v0.6.0 — 2026-10-09

Plain-language node configuration: a branch, llm or code node can be set up by
describing it in a sentence. The model is called **while configuring**, never
during a run, so runs cost nothing extra and behave deterministically from the
stored formal configuration.

### How it works

* `standalone/translator.mjs` builds the request, reads the answer, and decides
  whether the answer may be shown at all. The server calls the workflow's default
  connector; the browser sends words and the graph, never a prompt it assembled,
  so keys keep staying inside the server process.
* The property panel gains two modes for those three kinds. **大白话** describes,
  previews and confirms; **专家** is the old form, unchanged. Nothing is written
  until the user presses 确认使用, and the preview is editable — the common defect
  is one number, not the whole idea.
* The node keeps both copies: `description` (the words, so they can be translated
  again) and the formal field, which remains the only thing the compiler reads.
  `descriptionApplied` records which wording produced the current field, which is
  how 配置已过期 and 已手动修改 survive closing and reopening the document.
* `POST /api/translate`, on the standalone HTTP surface rather than Typert:
  `scripts/lint.mjs` pins the wire vocabulary at five methods. The plugin edition
  has no connector registry, so it keeps expert fields only.
* Both fields are optional, so the interchange format stays at `version: 1` and
  older documents keep loading.

### What the model is not allowed to get away with

The answer is re-checked against the real graph before it is ever offered:

* the node list is sent marked by upstream status, and a condition or `{{id}}`
  reference pointing at anything that is not upstream is refused — a branch has
  no field for *which* node to test, so the reference stays a translation-time
  detail rather than a new configuration shape;
* a length threshold that is not a number, a code body with no `return`, and a
  code body naming `fetch`/`process`/`require`/`fs`/`eval`/`new Function` are
  refused with the reason;
* an answer that is not the agreed JSON fails readably instead of half-filling
  the node;
* the user's sentence is embedded inside a closed marker block whose delimiters
  are stripped from the text, so "忽略上面的要求" remains data to translate.

Fallbacks keep the helper from becoming a gate: `untranslatable` carries the
reason, ambiguity lists the candidate nodes and asks the user to pick rather than
guessing (the choice is sent back as a settled mapping on the retry), and with no
connector configured plain mode is greyed out while expert mode works as before.
A failed call shows its error and leaves the typed sentence untouched.

### Verification

120 automated tests. `tests/translator.test.mjs` (17) covers the prompt, the
reply shapes and every refusal above. `tests/translate-api.test.mjs` (14) drives
the real HTTP server against a fake translator CLI, including the injection
attempt and the origin guards, and `tests/standalone.test.mjs` pins that both
copies survive a save, a reopen and a `version: 1` export/import while the run
still reads only the formal field. The panel was driven in the browser for all
three kinds: generate, edit the preview, confirm, candidate picking,
`untranslatable`, a rejected oversized request leaving the text intact, and the
no-connector greyed state; the saved record and its export were read back with
both copies present.

Not yet done: the human pass over the 15 typical sentences now listed in the
README. No model quota was spent on this release — every check above ran against
fake CLIs, and the translation quality of a real connector is unverified until
those sentences are judged.

## v0.5.0 — 2026-10-08

Phase B of the manager-mode plan: the studio now talks to agents in **both**
directions. It can delegate a step out, and an agent can start a workflow as a
tool.

### Inbound MCP server

`standalone/mcp.mjs` — an MCP server (protocol `2025-06-18`) over stdio, started
with `npm run standalone:mcp` or registered in any MCP client. It reads the same
data directory as the browser, so the library an agent sees is the library the
user edits.

* Three tools: `workflow.list`, `workflow.run` (by `id`, or an inline `graph`,
  with `input` overriding the input node's text and `wait: false` returning a
  `runId` immediately), and `workflow.status`.
* A workflow that cannot be found, or a run that ends in error, is a **tool
  result with `isError`** — a message an agent can read and act on. Only genuine
  protocol misuse gets a JSON-RPC error code (`-32601`, `-32602`, `-32700`).
* **The delegation cap is closed from this side.** Phase A stamped
  `WORKFLOW_STUDIO_DEPTH` into an agent's environment without anything reading
  it. This server reads it and refuses `workflow.run` once three generations are
  reached, so `llm → agent → workflow.run → llm → …` cannot recurse;
  `workflow.list` still answers, so an over-deep agent can inspect rather than
  being cut off completely.
* stdout carries one JSON-RPC frame per line and nothing else — every
  diagnostic goes to stderr, because `JSON.stringify` escapes newlines inside
  string values and a workflow name must not be able to split a frame.
* The library is re-read per request rather than snapshotted at startup. An MCP
  session outlives browser edits, and a snapshot would hide a workflow saved
  minutes ago or keep offering one already deleted.
* Run statuses live in memory, capped at the last 200 finished runs, and record
  the engine run id behind the MCP-facing one. The persisted ledger, streaming
  progress and the comparison view are the next stage.
* The handshake version is read from `package.json`, so a release bump cannot
  leave an agent being told a version that was never shipped.

### The `http` connector adapter

An `llm` node can now delegate to an HTTP endpoint as well as a CLI.

* One chat-completion message to `url` with `model` and fixed `headers`; the
  reply is read from `choices[0].message.content`, and a bare
  `{ output, summary }` or plain text is accepted too.
* **The key is never in the file.** `apiKeyEnv` names an environment variable in
  the server process; a missing variable is reported by name before any request
  is made. `connectors.json` sits on disk next to workflows and must stay
  copyable.
* A non-2xx response reports only `返回 HTTP <status>`. The body is not
  surfaced, because an error payload can echo a credential back — a test proves
  a deliberately leaked key never reaches the caller.
* The callee is stamped one generation deeper via `x-workflow-depth`, and each
  request runs under its own `AbortController` budget.
* The `mcp` kind is still recognised-and-pending; calling *out* to another MCP
  server is not part of this release.

### Verification

87 tests, all passing. `tests/mcp.test.mjs` (13) spawns the server as a real
child process and drives its actual stdio, because the framing is part of what
is being tested; `tests/http-connector.test.mjs` (8) runs against a local stub
endpoint. No paid model calls were used: connectors are exercised by fake CLI
fixtures and a stub server.

## v0.4.1 — 2026-10-08

Fixed `{{node-id}}` interpolation in an `llm` prompt. It never worked.

The compiler ran the whole interpolated template through `JSON.stringify`, so
the substitution produced the sanitized **variable name** as literal text:

```js
agent_n = await agent("say input_n", { phase: "agent" });   // was meant to be "say hello"
```

Code nodes were never affected because their body is emitted as raw JavaScript,
where the same substitution lands on a real variable reference.

A prompt is now compiled to a concatenation of JSON-encoded literals and variable
references, so an upstream value is read at run time and cannot be mistaken for
code even when it contains quotes or braces. A prompt with no reference still
emits a plain literal. Because an agent node returns the `{ output, summary }`
contract, naming one in a prompt now contributes its `output` rather than
`[object Object]`, and a null upstream contributes empty text rather than
`"null"`.

This predates v0.4.0 and was untouched by it, but v0.4.0 made it matter: an
agent was being handed an identifier instead of the data it was supposed to work
on. Found while verifying that path.

## v0.4.0 — 2026-10-08

Phase A of the manager-mode plan: **outbound connectors**. An `llm` node now
delegates its step to a real agent program instead of reporting that no model
connector exists.

* `standalone/connectors.mjs` — a registry read from `connectors.json` in the
  data directory. Three generic kinds (`cli`, `http`, `mcp`) so a new agent
  program is a config edit, not a code change. `cli` is implemented here;
  `http`/`mcp` are recognised and reported as phase B rather than missing.
* The CLI adapter spawns with `shell: false` and a whitelisted environment, so a
  prompt can never be interpreted as shell syntax and cannot inherit parent
  credentials. Command splitting is quote-aware for paths containing spaces.
* Result contract `{ output, summary }`, validated at the boundary. A response
  that cannot satisfy it fails the node instead of forwarding loose text.
* **Secrets never enter the worker.** The worker sends only
  `{ nodeId, prompt }` over IPC and receives only a result; the parent performs
  the call. Command line, endpoint and connector `env` stay in the server
  process, which matters because the worker also executes untrusted code nodes.
  Prompts and response bodies are excluded from the run log, and a failing
  agent's stderr is redacted before it is shown.
* Agent nodes get a five-minute default budget. The run's total budget is now
  `30s + Σ(agent node budgets)` rather than a flat 30 seconds, and agent runs
  hold their own concurrency slot (2 code runs, plus 1 agent run).
* Delegation depth is capped at three and passed to agents as
  `WORKFLOW_STUDIO_DEPTH`, the hook an inbound call (phase B) will check.
* `node.executor` binds a node to a connector, chosen from a new dropdown in the
  property panel. It is an optional node field, so it survives save, export and
  import and the interchange format stays at version 1.
* The connector list reaches the browser over `POST /api/connectors`, not the
  Typert surface: `scripts/lint.mjs` pins the wire vocabulary at exactly five
  methods, and an illegal name there is a fatal host load failure.
* Fixed a latent quota leak: a run released its concurrency slot only when the
  child reported `exit`, which is asynchronous, so two agent runs back to back
  could be refused by a run that had already finished.
* Tests: `tests/connectors.test.mjs` (21 cases) drives the whole outbound path
  against `tests/fixtures/agent-fake.mjs`, including contract violation,
  timeout kill, stderr redaction, depth cap, slot separation, and a code node
  proving the worker cannot see connector secrets. No model quota is used.

## v0.3.0 — 2026-10-08


Visual language merged from the `workflow-studio` v0.1 reference build.
Presentation only: no behaviour, protocol, storage or document-format change.

* `src/client/styles.css` gained a `--wfs-*` token layer that resolves to the
  host's `--dsw-alias-*` theme when one exists and falls back to the reference's
  light neutral ramp otherwise. Inside Harness the panel still follows the host
  theme; standalone gets the reference look directly.
* Node cards are now bordered in their kind colour (input green `#16a34a`,
  LLM violet `#7c3aed`, code amber `#d97706`, branch blue `#2563eb`, output teal
  `#0d9488`) and carry a filled uppercase kind badge. The palette shows a
  matching colour dot.
* The running node pulses a blue ring; completed and failed nodes ring green and
  red. Honours `prefers-reduced-motion`.
* Primary action is indigo `#4f46e5`; the run action is a distinct green so it
  never reads as save.
* `standalone/index.html` publishes the light ramp in place of the previous
  hardcoded dark one, and React Flow's controls and minimap are now themed from
  the panel's tokens instead of page-level hex overrides.
* Fixed a long-standing stray horizontal scrollbar: React Flow drew a 200px
  minimap SVG inside a 120px box with no `overflow: hidden`, and `overflow-y:
  auto` on the side columns promotes `overflow-x` from `visible` to `auto`.
* Styling hooks are two `data-kind` attributes (`canvas.tsx`, `sidebar.tsx`) and
  one button variant (`app.tsx`), so future recolouring needs no TSX change.

## v0.2.0 — 2026-10-06

Standalone stage one: the canvas and compiler run without Harness.

* Own bundle (`standalone/build.mjs`), HTTP server bound to `127.0.0.1:43180`,
  JSON store in `standalone/data/`, and execution in a disposable child process
  with a 30-second timeout and a two-run concurrency cap.
* Version-1 JSON document interchange with import and export.
* LLM nodes deliberately report an unconfigured connector rather than simulating
  output.
* Requests are rejected on foreign origin, foreign host header, or a missing
  application header.

Verified by `docs/standalone-verification.md`.

## v0.1.0 — 2026-10-06 (untagged)

The legacy embedded Harness plugin: sidebar entry and full-screen panel, five
node kinds, DAG-to-JavaScript compiler with strict validation, persistence in
the `dsh_workflow` storage domain, Typert RPC over the `workflow` namespace
(`save`/`list`/`load`/`delete`/`run`), and bilingual UI.

**This milestone has no tag.** The repository did not exist when it was built,
and by the time version control was introduced the standalone stage had already
modified several of its files (`src/client/app.tsx`, `src/client/styles.css`,
`README.md`). Their intermediate content was not recoverable, so inventing a
commit for it would have recorded something that never existed. The baseline
commit is therefore tagged `v0.2.0`, and this entry preserves the chronology.

## Version identity

| Number | Where | Meaning | Consequence of bumping |
|---|---|---|---|
| `0.6.0` | `package.json`, mirrored in `package-lock.json` (root and `packages[""]`) | Release version. Read at runtime by one place: `standalone/mcp.mjs` reports it in the MCP handshake, deliberately by parsing `package.json` rather than repeating the literal. | Safe. `scripts/lint.mjs` asserts the package name, `type`, `private`, the bundle patch dialect, `exports` and the wire vocabulary — never the version. Keep the two lockfile fields in lockstep; `tests/mcp.test.mjs` asserts the handshake agrees with `package.json`. |
| `"version": 1` | Exported documents: `{ "format": "dsh-workflow-studio", "version": 1 }` | **Document schema revision.** Validated by `z.literal(1)` in `standalone/store.mjs`, reached from `/api/import` and `/api/export`. | Rejects every existing export, including `standalone/examples/local-workflow.json`. `tests/standalone.test.mjs` pins `version: 2` as rejected, so a bump fails that test by design. Requires a migration. |
| `version: 1` | Storage domain in `src/host/service.ts` | **Plugin storage compatibility** for the `dsh_workflow` domain. | Bumping without populating `compatibleVersions` makes already-stored records unreadable. |

The built artifacts in `lib/` and `standalone/dist/` embed the two schema
numbers but never the release version, and they are not committed — regenerate
with `npm run build` and `npm run standalone:build`.

## Known issues

### The `输出值` field on an output node does nothing

Pre-existing, and deliberately not changed in v0.4.1.

`outputValue` is editable in the property panel, stored in the schema, and shown
as the node's preview on the canvas — but `compile()` never reads it. An output
node passes its upstream value straight through, so whatever is typed into
`输出值` has no effect on a run.

Fixing it is a behaviour decision rather than a bug fix: the output node's
pass-through is what makes a branch rejoin work today, so making the field live
would change what existing saved workflows return. It needs its own call on
whether the field should template the value, replace it, or leave the panel.

(The other entry here — `{{node-id}}` not interpolating in an `llm` prompt — was
fixed in v0.4.1.)

### Deferred to the next stage

Not gaps in the design, but the parts of the plan the release ordering puts
after inbound MCP: streamed run progress and node colours during a run (the
in-memory run registry answers polling today), the persisted run ledger and
comparison view, calling *out* to another MCP server (`kind: "mcp"` is
recognised and reported as pending), and the REST `/api/v1/*` surface with its
OpenAPI description.

## Tagging policy

* Annotated tags named `vMAJOR.MINOR.PATCH`, one per release, on `main`.
* `major` — breaking change to the RPC contract, the accepted graph shape, or
  either schema revision.
* `minor` — new capability, or a change to the product's visual identity.
* `patch` — fixes with no new capability.
* A release commit bumps `package.json` and both `package-lock.json` fields
  together, and adds an entry here.
* Before pushing: `npm run check` and `npm run standalone:test` must pass, and
  the working tree must contain no build output, dependency caches or local
  workflow data (`.gitignore` covers `node_modules/`, `.npm-cache/`, `lib/`,
  `standalone/dist/` and `standalone/data/`).

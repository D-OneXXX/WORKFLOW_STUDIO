# Changelog

Release history for `dsh-workflow-studio`. Versions follow
[semantic versioning](https://semver.org/) and are tagged as annotated Git tags
on `main`.

This project carries **three unrelated version numbers**. They must not be
bumped together. See [Version identity](#version-identity) below.

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
| `0.3.0` | `package.json`, mirrored in `package-lock.json` (root and `packages[""]`) | Release version. Not read at runtime anywhere. | Safe. `scripts/lint.mjs` asserts the package name, `type`, `private`, the bundle patch dialect, `exports` and the wire vocabulary — never the version. Keep the two lockfile fields in lockstep. |
| `"version": 1` | Exported documents: `{ "format": "dsh-workflow-studio", "version": 1 }` | **Document schema revision.** Validated by `z.literal(1)` in `standalone/store.mjs`, reached from `/api/import` and `/api/export`. | Rejects every existing export, including `standalone/examples/local-workflow.json`. `tests/standalone.test.mjs` pins `version: 2` as rejected, so a bump fails that test by design. Requires a migration. |
| `version: 1` | Storage domain in `src/host/service.ts` | **Plugin storage compatibility** for the `dsh_workflow` domain. | Bumping without populating `compatibleVersions` makes already-stored records unreadable. |

The built artifacts in `lib/` and `standalone/dist/` embed the two schema
numbers but never the release version, and they are not committed — regenerate
with `npm run build` and `npm run standalone:build`.

## Known issues

### `{{node-id}}` does not interpolate in an LLM prompt

Pre-existing, and untouched by v0.4.0. The compiler emits an `llm` node's prompt
as a JSON string literal, so `{{input}}` reaches the agent as the sanitized
**variable name** (`input_n`) rather than the upstream value:

```js
agent_n = await agent("say input_n", { phase: "agent" });   // not "say hello"
```

Code nodes are unaffected — their body is emitted as raw JavaScript, so the same
substitution produces a real variable reference. `README.md` and the palette
description both advertise interpolation for LLM nodes, so this is a genuine gap,
and it weakens the outbound path added in v0.4.0: an agent receives a prompt
containing an identifier instead of the data it was meant to work on.

Tracked by a `todo` test, `an llm prompt interpolates the upstream value`, in
`tests/connectors.test.mjs`. It reports honestly today and becomes an ordinary
failing/passing test the moment the compiler is fixed. The fix is to build the
prompt as a concatenation of string literals and variable references instead of
one `JSON.stringify` of the interpolated text.

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

# Standalone Workflow Implementation Plan

**Goal:** Deliver the approved first-stage standalone browser editor, local persistence, JSON interchange and separate-process execution.

**Architecture:** Reuse WorkflowPanel through a local HTTP WorkflowRpc adapter and a local locale context. Compile validated graphs on the server, execute in a disposable Node child process, and store records outside Harness.

**Tech Stack:** Existing React 18, React Flow, esbuild, Zod and Node built-ins. Execute inline in this session; the workspace has no Git repository.

### Task 1: Regression coverage
- [x] Add `tests/standalone.test.mjs`: persistence/reopen, interchange rejection, subprocess execution/timeout, HTTP same-origin restriction.
- [x] Run `node tests/standalone.test.mjs` and confirm missing standalone implementation fails.

### Task 2: Local backend
- [x] Create `standalone/store.mjs` with schema validation, UUID identities, serialized atomic JSON writes and versioned import/export.
- [x] Create `standalone/runner.mjs` and `worker.mjs` with per-run process, deadline, bounded concurrency/progress and explicit missing-LLM errors.
- [x] Create `standalone/server.mjs`: loopback-only static server, POST JSON endpoints, bounded body, origin and custom-header checks, graceful worker disposal.
- [x] Run backend regression tests; preserve all existing compiler tests.

### Task 3: Browser entry
- [x] Create `src/standalone/index.tsx` with locally bundled React, local locale and HTTP adapter.
- [x] Add optional import/export controls to `WorkflowPanel`, draft replacement to `useStudio`, and a local code-only example.
- [x] Create `standalone/build.mjs` and `standalone/index.html`; expose `npm run standalone:build`, `npm run standalone:start`, `npm run standalone:test`.
- [x] Run typecheck and build; inspect and exercise real browser UI.

### Task 4: Delivery
- [x] Document startup, data directory, interchange format, code execution privileges and first-stage LLM limitation in README.
- [x] Review implementation, resolve material findings, run regressions and report verified scope.


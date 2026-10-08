# Changelog

Release history for `dsh-workflow-studio`. Versions follow
[semantic versioning](https://semver.org/) and are tagged as annotated Git tags
on `main`.

This project carries **three unrelated version numbers**. They must not be
bumped together. See [Version identity](#version-identity) below.

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

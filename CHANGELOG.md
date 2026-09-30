# Changelog

Notable changes per release, newest first. The DSH peer range is this package's
compatibility contract: a `0.1.x` release does not install on a `0.2.x` runtime,
and the runtime rejects it before pnpm runs.

## [0.2.6] — 2026-10-01

### Added

- **Just-in-time notes in tool results.** `task_add` now names the fields a title-only entry is missing, and `task_update` on a task that just became `done` names the specific gaps in the finished record: a `nextStep` still set, steps not marked `done`, an empty `description`. They are derived from the record they just wrote — they restate no rule and repeat no guidance — so they say nothing while the record is right and cost nothing until something is wrong, and they land at the moment it can still be fixed. A tool result is appended to the conversation, so unlike a section it never touches the cached prompt prefix.

### Changed

- The completion form moved into the always-on layer. `task_update`'s description now says to clear `nextStep`, leave `steps` all `done`, and write the outcome into `description` — because that rule was reachable only by loading the skill, and a model that never loads the skill is exactly who leaves the record half-finished. (`host-smoke` asserts all three clauses, so a rewording cannot silently drop them.)

## [0.2.5] — 2026-10-01

### Changed

- **The skip boundary is now a shape test, not a length test.** Both the always-on prompt section and the `task_add` description said to skip "trivial single-step requests" / "one-shot answers", and a repository analysis walks straight through that: "analyze X" is one exchange producing one deliverable, so skipping it was a *defensible* reading of the rule. That is how a user's "给你一个任务：分析 `<repo>`" produced no entry — the rule, not the model, was wrong.

  The boundary now names the shapes that count — analyze / investigate / compare / implement / review, and anything the user calls a task — and keeps exactly one exemption: a reply you can give without looking anything up. It also states that a late entry beats no entry, because "before you start" is the moment a model is least likely to pause.

  The bundled skill states the same boundary and records the case that motivated it, so the three surfaces that carry the obligation (section, tool description, skill) agree.

## [0.2.4] — 2026-09-30

### Fixed

- **A reload that collided with the previous instance could still take the app down.** 0.2.3 made the storage-domain open survive `already-open`, but the same window produces other collisions of the same kind: `WebServer.register` throws on a duplicate `(kind, path)` — the host reports it as `webserver: duplicate prefix route "/task-ui"` — and `Tools.register` fails on a duplicate name within one layer. The crash log says what a synchronous throw out of `apply()` means: `dsh: fatal load failure`, and the application exits.

  Every scope-global registration the plugin makes — the two HTTP routes, the prompt section, and all six tools — is now acquired through one tolerant path. It retries that class of failure (the storage facility's `already-open`, or the web server's duplicate-route error) with a short backoff, and each disposer is owned by the plugin's own `ctx.effect`, which is what actually releases the name. When a resource never frees, the plugin logs it and stays loaded but degraded: a panel without its HTTP API is a far better outcome than an application that will not start.

- Live SSE streams are ended when the plugin is disposed, so a browser's `EventSource` is not left waiting on a channel that nothing will ever write to.

### Added

- `test/host-smoke.mjs` drives the collision path directly: with two injected duplicate-route throws, both routes must still be acquired, and disposing the plugin must free the prefix route.

## [0.2.3] — 2026-09-30

### Fixed

- **Toggling the plugin off could crash the whole application.** `apply()` opened the `task_ui` storage domain and never handled a rejection, so a `DomainError` carrying `already-open` escaped as an unhandled promise rejection — which the host treats as fatal, taking the app down mid-reload. `already-open` is documented as *transient* ("the name is open or still closing"), and this path produces it by construction: a host reloads plugins without awaiting the previous instance's disposal, so the next `apply()` runs while the old domain is still tearing down.

  Both halves of the fix are needed. The handle is now closed from the plugin's own `ctx.effect` disposer — `DomainFacility.open` documents that the caller owns the handle, and relying on the facility's asynchronous unmount fallback is what left the name reserved for the next `apply()` to collide with. The open itself retries that one code with a bounded backoff, because a transient failure deserves a retry rather than a hard failure. Any rejection is also observed, so nothing can reach the host as an unhandled rejection.

### Added

- `test/bundle-css-check.mjs` — verifies the *built* client bundle is internally consistent: every class in its exported map has a rule in the CSS text that bundle injects. The source-level class check cannot see a build that drops or renames a rule.

## [0.2.2] — 2026-09-30

### Changed

- **`skills/task-ui/SKILL.md`** — the completion form now keeps the step flow and
  marks it `done`, instead of sending `steps: []`. Clearing it discarded the one
  thing a later reader most wants — the sequence of what was actually done — and
  made the panel's detail degrade to a single derived node; only `nextStep` is
  cleared on completion. This reaches **fresh installs only**: the Host seeds the
  skill into `<dshHome>/skills/` once and never overwrites it, so an existing
  deployment keeps whatever it already has.
- **README** — the absence of a session/provenance field is now documented as a
  deliberate design decision (tasks are session-independent, so a handoff needs
  current state and the next action, not the origin) rather than as a gap. The
  blocked-reason item stays, on its own.

## [0.2.1] — 2026-09-30

### Added

- **`task_get(id)`** — reads one task in full: description, progress, the whole
  step flow, next step, dependencies, linked job and timestamps, ordered the way
  a session picking up someone else's work needs it. The durable record carried
  far more than `task_list` printed, and a later session had no way to reach it.
- **`task_list` triage clause** — each line gains `— next: ...`, so filtering
  shows what every task does next while the detail stays in `task_get`.
- **`steps` and `nextStep`** on the record, with the flow's states (`done` /
  `current` / `next` / `todo`) validated at the zod boundary on write.
- **Step flow in the detail card** — progress is drawn as a vertical flow rather
  than a bar: finished and pending steps share the plain frame, `current` gets a
  solid brand frame with a faint tint, `next` a dashed one. A flow the owner
  never wrote falls back to `progress` + `nextStep`, and says so on screen.
- **Unprompted use** — a registered system-prompt section plus rewritten tool
  descriptions. The descriptions carry the when-and-how (the shape DSH uses for
  its own `todo_write`); the section is the always-on nudge, covering record /
  keep current / read back / skip trivial, and renders a shorter variant for
  subagents, which are told only to keep their own task's record true.
- **Expired job links** — a `running` task whose job predates the current process
  is flagged in `task_list` (`[expired]`), in `task_get` (a `warning:` line
  before the actionable state) and in the panel (warn-coloured job line). The job
  registry is in-process, so after a restart those links cannot be alive; the
  record is annotated rather than rewritten, because the plugin cannot know
  whether the work finished, was abandoned, or went unrecorded.
- **Panel motion** — new tasks rise in while the bottom-anchored panel slides up
  by the height it gained; a deleted card holds its slot through its exit
  animation.
- **Resizable panel** — drag the left edge (or focus it and use ←/→) for
  260–760px, remembered in `localStorage`.

### Changed

- Tool descriptions now state each tool's purpose, the moment to act, and its
  boundary, and the bundled skill keeps the detailed workflow.
- `config.promptSection` (default `true`) drops just the prompt section, for a
  deployment that would rather rely on the tool descriptions alone.

### Fixed

- Deleting a task made the whole list flash and the panel run a
  shrink/grow/shrink cycle: the removed row is re-adopted as a ghost inside a
  *layout* effect, so it never leaves the DOM for a painted frame.
- The panel could vanish entirely — a `ReferenceError` in the motion effect's
  dependency array. DSH isolates each slot entry, so a component that throws
  renders nothing while the rest of the UI stays healthy.

### Build

- `npm test`: `tsc --noEmit` against the published `0.2.0-rc.2` type packages
  (dev-only, pinned exactly, never shipped) plus host-smoke, client-smoke,
  render and CSS-class checks. The typecheck found a real latent bug on its
  first run; tsdown alone never type-checks.

## [0.2.0] — 2026-09-30

### Added

- Support for `0.2.x` DSH runtimes alongside `0.1.x`; peer ranges widened to
  `^0.1.5-rc.2 || ^0.2.0-rc.2`.

### Changed

- Job-status sync is version-adaptive: `jobs.events.subscribe({ owners: 'all' },
  …)` on 0.2, `jobs.onJobsChanged` on 0.1. A runtime with neither logs a line and
  disables only the bridge, keeping the tools, the panel and the HTTP API.

### Fixed

- `installation rejected: Plugin dsh-global-task-list@0.1.5 is incompatible with
  dsh 0.2.0-rc.2` — caused by peer ranges that excluded the running runtime.
- Agent-origin detection read `session.header.origin` instead of the always-
  undefined `header.meta?.origin`, which made every agent look like a master.

## [0.1.5] — 2026-09-11

### Fixed

- Ported the client bundle to the `0.1.5` client module table (`defineStore`),
  which earlier hosts do not expose; before this the panel failed to load with
  `Failed to load plugins`.

## [0.1.4] — 2026-08-22

### Added

- The bundled `task-ui` skill is seeded into the user skill root on first
  activation (and never overwritten afterwards).

### Fixed

- The panel refreshes on task changes from any session.

## [0.1.3] — 2026-08-22

### Changed

- Documented the exact `allowBuilds` key a pnpm GitHub install requires.

## [0.1.2] — 2026-08-22

### Added

- Host half migrated to TypeScript (`src/index.ts`) with its own build.
- The panel hides off the conversation view, and its header stays visible while
  the list scrolls.

### Fixed

- Session-scoped inject signature (`sessionId, actions`) — the panel previously
  showed 0 tasks.

## [0.1.1] — 2026-08-14

Initial release: a cross-session global task library, a floating panel with
status/delete/split controls, subagent job-status sync, and the generative-UI
`surface` renderer.

[0.2.6]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.2.5...v0.2.6
[0.2.5]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.2.4...v0.2.5
[0.2.4]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.2.3...v0.2.4
[0.2.3]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/sgzxs/dsh-global-task-list/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/sgzxs/dsh-global-task-list/releases/tag/v0.1.1

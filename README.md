# dsh-global-task-list

A global task library for the DeepSeek Harness: six model-facing tools, a persistent browser panel, subagent job status synchronization, and a generative-UI surface renderer. Tasks persist across sessions in a `storageDomain` unit and survive restarts.

> 全局任务列表插件：为 DeepSeek Harness 提供一个跨会话持久化的任务库，附右下角常驻面板（轨迹等非对话界面自动隐藏）。主 agent 用 `task_add` 创建任务（带描述与进度），spawn 子 agent 后关联 `jobId` 自动同步终态；面板支持手动改状态、删除、拆分，并实时（SSE）刷新。任务可携带 `surface` 结构化文档渲染生成式 UI（进度条、时间线、表格、DAG 等）。

## What it does

- **Global task library** — `task_add` / `task_list` / `task_get` / `task_update` / `task_delete` model tools over a cross-session `storageDomain` unit (`task_ui`). Tasks carry a title, status (`pending` / `running` / `done` / `blocked` / `failed`), description, `nextStep`, an ordered `steps` flow, `parentId`, `dependsOn`, an optional `progress` (`{ text, percent? }`), and an optional `surface` document.
- **Persistent panel** — a bottom-right floating panel (mounted in the session-scoped `conversation.input.dock` slot) subscribes to a Server-Sent Events channel (`/task-ui/events`) and refreshes on every task change, letting the user change status, delete (with confirmation), and trigger a generative split loop. Clicking a card expands a **secondary card** under it with the description, the step flow, dependencies, and timestamps. Styled with `--dsw-*` theme tokens and localized zh/en. It disappears on non-conversation views (e.g. trajectory).
- **Step flow** — the detail card describes progress as a vertical flow rather than a bar: finished and pending steps share the plain frame, while the two that matter are drawn differently — `current` in a solid brand frame with a faint tint, `next` in a dashed one. Steps come from the owner's `steps` (`done` / `current` / `next` / `todo`); when it wrote none the panel derives a node from `progress`, and a list naming no `next` inherits `nextStep` as one. A step's state is drawn, so it is also announced to screen readers as text.
- **Panel motion** — a new task rises in while the bottom-anchored panel slides up by the height it gained, which is what lifts the cards above it; a deleted card holds its slot through its exit animation and the panel retracts afterwards. Expansion is CSS-only (`grid-template-rows: 0fr → 1fr`). All of it is skipped under `prefers-reduced-motion`. A removed card is re-adopted as a ghost row inside a *layout* effect, so it never leaves the DOM for a painted frame — that gap was what made the whole list flash and the panel run a shrink/grow/shrink cycle on delete.
- **Resizable** — drag the panel's left edge (or focus it and use ←/→) to set its width between 260px and 760px; the width is remembered in `localStorage`. The gesture follows ui-layout's own `DragHandle`: pointer capture for the whole drag, one throttled update per animation frame, and the width computed from the drag origin rather than accumulated per move.
- **Subagent job sync** — a task linked to a background job via `task_update(id, { jobId })` auto-advances its terminal status through the `JOB_STATUS_MAP` (`completed`→`done`, `failed`→`failed`, `killed`→`blocked`). Tasks are created explicitly by the master agent, never auto-registered from arbitrary background jobs.
- **Generative UI surface** — a task's `surface` field renders a whitelisted, recursive component tree: `section`, `metric`, `statusBadge`, `progress`, `table`, `list`, `timeline`, `dag`, `disclosure`.

## Install

Installing from **npm** is the recommended path — the package ships prebuilt `lib/`, so no build step runs at install time. The GitHub alternative pulls source and builds on install (see below).

```sh
# npm (recommended, prebuilt — no build step at install)
dsh plugin --profile web add dsh-global-task-list

# GitHub (alternative: source + prepare build)
dsh plugin --profile web add github:sgzxs/dsh-global-task-list#v0.2.0
```

The package declares `dsh.bundle`, so `dsh` adds it to the profile's `bundles` automatically. Requires a DSH installation with `@deepseek-ai/dsh-base` and the client surface (`dsh-web-app`) present.

Pin at least `0.2.0` for a `0.2.x` DSH runtime (the desktop app is `0.2.0-rc.2`): earlier releases declare `0.1.x`-only DSH peer ranges, and the runtime rejects them before pnpm runs, with `installation rejected: Plugin dsh-global-task-list@0.1.5 is incompatible with dsh 0.2.0-rc.2`. The desktop app additionally manages its profile itself — see [Installing on the desktop app](#installing-on-the-desktop-app).

### GitHub install: allowBuilds

Installing from GitHub pulls source, so pnpm must run the package's `prepare` script to build `lib/`. pnpm blocks that by default for git-hosted packages, and its `allowBuilds` key matches the **exact commit** (a package-name-only entry does not match — see [pnpm#12367](https://github.com/pnpm/pnpm/issues/12367)). The first `add` therefore fails with an `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` message that prints the exact key to allow. Copy that exact key into the profile's `pnpm-workspace.yaml`, then re-run:

```yaml
allowBuilds:
  dsh-global-task-list@git+https://github.com/sgzxs/dsh-global-task-list.git#<commit>: true
```

Pin a tag (e.g. `#v0.2.0`) in the install command so the commit hash — and therefore the `allowBuilds` key — stays stable.

## Requirements

- DeepSeek Harness (`@deepseek-ai/dsh`) at `0.1.2-alpha.2` or later: the client bundle imports `defineStore` from `@deepseek-ai/dsh-client-store`, a browser module-table entry that does not exist on earlier hosts (there the panel fails to load with `Failed to load plugins`). Verified against `0.1.5-rc.2` (CLI/web profiles) and `0.2.0-rc.2` (the DeepSeek Harness desktop app).
- The Host half resolves `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-storage-domain`, and `zod` from the profile's node_modules.
- The client bundle is prebuilt (`lib/client.js`) and ships with the package; no build step runs at install time.

## DSH version compatibility

The Host half is written against two DSH generations because the `jobs` service changed shape in 0.2:

| Surface | 0.1.x | 0.2.x | This plugin |
|---|---|---|---|
| Job change feed | `ctx.jobs.onJobsChanged(listener)` (listener receives the owner Agent) | `ctx.jobs.events.subscribe({ owners: 'all' }, listener)` (each commit carries the job snapshot) | feature-detects `jobs.events.subscribe` first, falls back to `onJobsChanged`, and disables the bridge with a log line if neither exists |
| `ctx.jobs.list(caller)` | `caller` is the owner **Agent** | `caller` is the owner's **session id** | only used on the 0.1.x path, which is the path that needs it |

Everything else the plugin touches is unchanged between the two: `defineTool` / `tools.register`, `createUserMessage`, `defineDomain` / `domainTable` / `storageDomain.open`, `webServer.register({ kind, path, handler })`, `agents.list()` / `agent.followup` / `session.header.origin`, and the `domain/changed` event. The client half needs no version split at all — the browser platform module table (`react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`, `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives`, `dsh-client-ui-dockkit`) and the `conversation.input.dock` slot contract are identical in both.

`peerDependencies` therefore admit both lines (`^0.1.5-rc.2 || ^0.2.0-rc.2`). DSH enforces every `@deepseek-ai/dsh*` peer range against the running runtime at install time and again at profile composition, so a range that excludes the running version blocks the plugin instead of degrading.

### Installing on the desktop app

The desktop app owns its profile: `dsh --profile desktop` is refused outside the Electron application, and `dsh plugin --profile desktop <args>` expects the app to be fully quit first. Either install through the app's own Plugins page, or place the package and declare it by hand:

```jsonc
// $DSH_HOME/profiles/desktop/package.json
{
  "dependencies": { "dsh-global-task-list": "link:../../plugins/dsh-global-task-list" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-global-task-list"] } }
}
```

Profiles reload their configuration by default (`dsh-hmr`), so a running desktop app mounts the plugin on its next recompose — no restart required.

## Build (development)

```sh
npm install
npm run build:host    # tsdown bundles src/index.ts → lib/index.js
npm run build:client  # tsdown bundles src/client → lib/client.js
npm run typecheck     # tsc --noEmit, against the real DSH 0.2.0-rc.2 types
npm test              # builds, then typecheck + smoke + render + CSS-classes
npm run sync web      # copy the build into a profile's node_modules (dev helper)
```

Both halves are TypeScript: the Host half (`src/index.ts`) compiles to plain ESM, and the client half (TSX) compiles with CSS Modules (lightningcss) into a `__ModuleLoader__` closure-factory bundle.

### Why the test suite exists

The build only transpiles — tsdown runs with `dts: false` and never type-checks — so nothing in the build path catches a wrong identifier. `npm test` closes that with six layers, each of which caught something the others missed:

| Layer | Catches |
|---|---|
| `tsc --noEmit` | undefined identifiers, wrong argument types, stale locale keys (the dictionaries are the key-set source of truth) |
| `test/host-smoke.mjs` | what the Host half actually contributes: the six tools, their converted JSON Schema (including the object-typed `steps` items), both HTTP routes, the job-bridge subscription, and the system-prompt section. It also drives the storage lifecycle: a transient `already-open` is retried, and disposing the plugin closes the handle it owns. |
| `test/client-smoke.mjs` | module-eval and `apply()` throws — what a browser reports as "Failed to load plugins" |
| `test/render-check.mjs` | render-path throws across every task state. DSH isolates each slot entry, so a component that throws renders *nothing*: the panel disappears while the rest of the UI stays healthy. The harness runs the real component through a minimal hook runtime and renders child components too. |
| `test/class-check.mjs` | a `css.foo` with no `.foo` rule (and the reverse) — the class map is a plain object, so neither side is typed |
| `test/bundle-css-check.mjs` | the same split in the *built* artifact: every class in the bundle's exported map must have a rule in the CSS text that bundle injects. Source and build can disagree. |

The typecheck needs the DSH packages as `devDependencies`; they are pinned exactly to the runtime line the plugin targets, and they never ship (`files` lists only `lib/` and the patch).

## Model Experience

### Request context and condition

The package contributes six model-facing tools to the agent's tool catalog.

#### What the model sees

- `taskui_probe` — reports the plugin's host-alive status and current task count.
- `task_list` — one triage line per task: `- [status] title (id[, job=...]) — next: ...`.
- `task_get(id)` — the full record of one task, ordered the way a session picking up someone else's work needs it: status and title, `progress` (with percent), `next`, the whole `steps` flow with its states, dependencies, parent, job, description, and timestamps.
- `task_add(title, description?, nextStep?, steps?, parentId?, dependsOn?, surface?, progress?)` — creates a task (initial `pending`).
- `task_update(id, title?/status?/description?/nextStep?/steps?/parentId?/dependsOn?/surface?/progress?/jobId?)` — patches one task; `progress` is `{ text, percent? }`, `nextStep` is the one-line "what happens next", `steps` is the ordered `[{ text, state }]` flow the detail card draws, `surface` accepts a structured generative-UI document, and `jobId` links the task to a background job for terminal-status sync.
- `task_delete(id)` — deletes one task.

The list is deliberately short and the detail lives in `task_get`, so the model's read path is "filter with `task_list`, then read the one task you are about to work on". The durable record carries far more than any single line could, and a later session has no other way to reach it.

`nextStep` and `steps` postdate the original record schema. Both are optional and defaulted, and the domain's backend descriptor is derived from the domain name, version, and table names rather than the zod schemas — so adding a column needs no version bump, and records written before it existed still load. `steps` items are validated by the durable zod boundary on write, so the tool parameter declares them as loose objects (`additionalProperties: true`) instead of duplicating that enum in JSON Schema.

The `surface` document is a recursive, whitelisted component tree (`section` / `metric` / `statusBadge` / `progress` / `table` / `list` / `timeline` / `dag` / `disclosure`) rendered by the browser panel. Unknown kinds are ignored by the renderer; the Host stores the document as opaque JSON.

#### How the agent is made to use it

A skill is **model-invoked**: the catalog the model sees carries only each skill's name and description, so `task-ui` loads exactly when the model decides that description matches — which is not when ordinary work starts. That is the wrong lever for behaviour that must happen unprompted, so the plugin uses the two levers that are always present instead:

1. **Tool descriptions** — the schemas sit in the system prompt's tool catalog on every request. Each one states its purpose, the moment to act, and its boundary (the same shape the harness uses for its own `todo_write`, which is proactive for exactly this reason). `task_add` says to record multi-step work *before starting it and always before delegating*, and to skip one-shot requests; `task_update` says to keep the entry moving and to link a delegated job.
2. **One system-prompt section** (`task-ui:library`, at the subagent tool's own order) — one sentence in the harness's own register, so a model that never reaches for a tool still knows the library exists. It covers the whole obligation, not just the write half: record before starting, keep current while working, **read the record back before continuing anything an earlier session started**, and skip one-shot work. It renders **two variants**: the session that owns the work gets all four clauses, while a subagent (read from `AssembleContext.agent.session.header.origin`) is told only to keep *its* task's record true — it does not plan, delegate, or create parallel entries its spawner cannot see. It renders empty in any scope where `task_add` is not callable, and `config.promptSection: false` drops it for a deployment that prefers to rely on the descriptions alone.

Sections are merged **by name**, so this one — a unique name no DSH package or preset uses — is never shadowed by, and never shadows, the deployment's persona: all of them simply render in `order` sequence (`deployment:persona-prefix` at 0, this at the subagent tool's order, `deployment:persona-suffix` at 10200).

The bundled skill remains the place for the *detailed* workflow (the subagent supervision loop, the flow-authoring rules, the cross-session handoff read order); these two levers are what make the library get used without anyone asking for it.

#### Token effect

Six tool schemas plus their descriptions are injected into the system-prompt tool catalog, and — unless `config.promptSection` is false — one fixed sentence into the system prompt. Fixed cost; no per-task or data-dependent prompt growth.

#### KV Cache effect

Independent of the agent's request-context assembly. The tool schemas and the prompt section are static, so the prompt prefix is stable across requests; task-list content does not enter the prompt. A plugin version change (or toggling `promptSection`) replaces the section, or the tool schemas, and invalidates reuse.

## Design notes

**Tasks are session-independent by design.** The record deliberately does not name the session that created it or last touched it, and no field ties an entry to a conversation. The library exists so that work hands off seamlessly: any session — a later one, a different preset, a subagent — picks an entry up and continues, and what it needs is *what is true now* and *what to do next*, both of which the record carries (`progress`, `steps`, `nextStep`). Recording an origin would make every entry an artifact of the conversation that produced it, which is the opposite of the point; it would also invite a later session to defer to an owner that no longer exists. This is why `task_get` leads with state rather than history, and why nothing has to be rewritten when a task outlives the session it started in.

## Known Limitations and Deferred Work

- **No graph layout** — the `dag` surface renders nodes as chips plus an edges list, not a positioned graph.
- **Surface is opaque** — the Host stores `surface` as unvalidated JSON (`z.record`); malformed kinds fall back to "ignored" in the renderer rather than a load-time error.
- **`sync-profile.mjs` is a local dev helper** — it copies the built package into `$DSH_HOME/profiles/<profile>/node_modules` (profile defaults to `web`) and warns when that profile's `dsh.profile.bundles` does not list the plugin. It is not published (excluded via `files`); use `dsh plugin add` for installation.
- **Job-status sync degrades, never blocks** — a runtime exposing neither `jobs.events.subscribe` nor `jobs.onJobsChanged` keeps the tools, the panel, and the HTTP API, and logs `jobs service exposes no change feed; job status sync disabled`.
- **The prompt section cannot force the behaviour** — descriptions and one sentence raise the odds that the model records its work; nothing in the harness compels it. A deployment that needs a guarantee should say so in its own persona or preset instructions, which outrank a plugin's contribution.
- **Skill updates need a manual refresh** — the Host half seeds `skills/task-ui/SKILL.md` into `<dshHome>/skills/task-ui/` only when that file is absent, so it never clobbers a user's edits; a plugin upgrade therefore does not update an already-seeded copy.
- **Blocked reasons have no field of their own** — `dependsOn` covers task-to-task blocking; a reason that is not another task ("waiting on an external service") has only `nextStep` to live in.
- **A `running` task linked to a job is flagged, not corrected** — the job registry is in-process, so a `jobId` written before the running Host started cannot refer to anything alive. Both read paths say so: `task_list` appends `[expired]`, `task_get` leads with a `warning:` line, and the panel colours the job line with `--dsw-alias-state-warn-primary`. The record is *annotated* rather than rewritten, because the plugin cannot know whether the work finished, was abandoned, or is simply unrecorded. The signal is the task's own `updatedAt` compared against Host start (`jobs` exposes no call that enumerates every owner's jobs), so a write after boot clears the flag — a false negative if a session sets `running` by hand on a task that still carries an old `jobId`.

- **The client bundle is not byte-reproducible** — `npm run build:client` emits the CSS-module class map in a different key order on every run, so the bundle hash changes even with identical sources. The key→hash pairs themselves are stable and nothing at runtime observes the order; the only casualty is comparing a local build against a published tarball by hash, which is why `lib/client.js` never matches its published copy byte for byte.

## Acknowledgements

Inspired by [HomeRail](https://github.com/xiaotianfotos/homerail) — its generative-UI (A2UI) idea of "the agent emits a bounded, whitelisted component tree that a host renders into a glanceable view" shaped this plugin's `surface` document and component catalog (`section` / `metric` / `statusBadge` / `progress` / `table` / `list` / `timeline` / `dag` / `disclosure`), as well as the principle of preferring built-in rendering over dumping raw logs.

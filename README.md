# dsh-global-task-list

A global task library for the DeepSeek Harness: five model-facing CRUD tools, a persistent browser panel, subagent job status synchronization, and a generative-UI surface renderer. Tasks persist across sessions in a `storageDomain` unit and survive restarts.

English | 中文

## What it does

- **Global task library** — `task_add` / `task_list` / `task_update` / `task_delete` model tools over a cross-session `storageDomain` unit (`task_ui`). Tasks carry a title, status (`pending` / `running` / `done` / `blocked` / `failed`), description, `parentId`, `dependsOn`, an optional `progress` (`{ text, percent? }`), and an optional `surface` document.
- **Persistent panel** — a bottom-right `shell.overlay` panel subscribes to a Server-Sent Events channel (`/task-ui/events`) and refreshes on every task change, letting the user change status, delete (with confirmation), and trigger a generative split loop. Styled with `--dsw-*` theme tokens and localized zh/en.
- **Subagent job sync** — a task linked to a background job via `task_update(id, { jobId })` auto-advances its terminal status through the `JOB_STATUS_MAP` (`completed`→`done`, `failed`→`failed`, `killed`→`blocked`). Tasks are created explicitly by the master agent, never auto-registered from arbitrary background jobs.
- **Generative UI surface** — a task's `surface` field renders a whitelisted, recursive component tree: `section`, `metric`, `statusBadge`, `progress`, `table`, `list`, `timeline`, `dag`, `disclosure`.

## Install

```sh
dsh plugin --profile web add dsh-global-task-list
```

The package declares `dsh.bundle`, so `dsh` adds it to the profile's `bundles` automatically. Requires a DSH installation with `@deepseek-ai/dsh-base` and the client surface (`dsh-web-app`) present.

## Requirements

- DeepSeek Harness (`@deepseek-ai/dsh`), version compatible with `0.1.0-rc.6`.
- The Host half resolves `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-storage-domain`, and `zod` from the profile's node_modules.
- The client bundle is prebuilt (`lib/client.js`) and ships with the package; no build step runs at install time.

## Build (development)

```sh
npm install
npm run build:client   # tsdown bundles src/client → lib/client.js
```

The client half is TypeScript + TSX compiled with CSS Modules (lightningcss) into a `__ModuleLoader__` closure-factory bundle.

## Model Experience

### Request context and condition

The package contributes five model-facing tools to the agent's tool catalog.

#### What the model sees

- `taskui_probe` — reports the plugin's host-alive status and current task count.
- `task_list` — lists every task as `- [status] title (id, job=...)`.
- `task_add(title, description?, parentId?, dependsOn?, surface?, progress?)` — creates a task (initial `pending`).
- `task_update(id, title?/status?/description?/parentId?/dependsOn?/surface?/progress?/jobId?)` — patches one task; `progress` is `{ text, percent? }`, `surface` accepts a structured generative-UI document, and `jobId` links the task to a background job for terminal-status sync.
- `task_delete(id)` — deletes one task.

The `surface` document is a recursive, whitelisted component tree (`section` / `metric` / `statusBadge` / `progress` / `table` / `list` / `timeline` / `dag` / `disclosure`) rendered by the browser panel. Unknown kinds are ignored by the renderer; the Host stores the document as opaque JSON.

#### Token effect

Five tool schemas plus their descriptions are injected into the system-prompt tool catalog. Fixed cost; no per-task or data-dependent prompt growth.

#### KV Cache effect

Independent of the agent's request-context assembly. The tool schemas are static, so the prompt prefix is stable across requests; task-list content does not enter the prompt. A plugin version change replaces the tool schemas and invalidates reuse.

## Known Limitations and Deferred Work

- **No graph layout** — the `dag` surface renders nodes as chips plus an edges list, not a positioned graph.
- **Surface is opaque** — the Host stores `surface` as unvalidated JSON (`z.record`); malformed kinds fall back to "ignored" in the renderer rather than a load-time error.
- **Hardcoded tunables** — the `JOB_STATUS_MAP` is a module constant, not a `Config` field; deployments that want different job→status mappings must edit source.
- **`sync-profile.mjs` is a local dev helper** — it is not published (excluded via `files`); use `dsh plugin add` for installation.

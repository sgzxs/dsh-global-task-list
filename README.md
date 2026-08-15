# dsh-global-task-list

A global task library for the DeepSeek Harness: five model-facing CRUD tools, a persistent browser panel, subagent job status synchronization, and a generative-UI surface renderer. Tasks persist across sessions in a `storageDomain` unit and survive restarts.

> 全局任务列表插件：为 DeepSeek Harness 提供一个跨会话持久化的任务库，附右下角常驻面板（轨迹等非对话界面自动隐藏）。主 agent 用 `task_add` 创建任务（带描述与进度），spawn 子 agent 后关联 `jobId` 自动同步终态；面板支持手动改状态、删除、拆分，并实时（SSE）刷新。任务可携带 `surface` 结构化文档渲染生成式 UI（进度条、时间线、表格、DAG 等）。

## What it does

- **Global task library** — `task_add` / `task_list` / `task_update` / `task_delete` model tools over a cross-session `storageDomain` unit (`task_ui`). Tasks carry a title, status (`pending` / `running` / `done` / `blocked` / `failed`), description, `parentId`, `dependsOn`, an optional `progress` (`{ text, percent? }`), and an optional `surface` document.
- **Persistent panel** — a bottom-right floating panel (mounted in the session-scoped `conversation.input.dock` slot) subscribes to a Server-Sent Events channel (`/task-ui/events`) and refreshes on every task change, letting the user change status, delete (with confirmation), and trigger a generative split loop. Styled with `--dsw-*` theme tokens and localized zh/en. It disappears on non-conversation views (e.g. trajectory).
- **Subagent job sync** — a task linked to a background job via `task_update(id, { jobId })` auto-advances its terminal status through the `JOB_STATUS_MAP` (`completed`→`done`, `failed`→`failed`, `killed`→`blocked`). Tasks are created explicitly by the master agent, never auto-registered from arbitrary background jobs.
- **Generative UI surface** — a task's `surface` field renders a whitelisted, recursive component tree: `section`, `metric`, `statusBadge`, `progress`, `table`, `list`, `timeline`, `dag`, `disclosure`.

## Install

```sh
# npm (prebuilt)
dsh plugin --profile web add dsh-global-task-list

# or GitHub (source + prepare build)
dsh plugin --profile web add github:sgzxs/dsh-global-task-list#v0.1.1
```

The package declares `dsh.bundle`, so `dsh` adds it to the profile's `bundles` automatically. Requires a DSH installation with `@deepseek-ai/dsh-base` and the client surface (`dsh-web-app`) present.

### GitHub install: allowBuilds

Installing from GitHub pulls source, so pnpm must run the package's `prepare` script to build `lib/`. pnpm blocks that by default for git-hosted packages, and its `allowBuilds` key matches the **exact commit** (a package-name-only entry does not match — see [pnpm#12367](https://github.com/pnpm/pnpm/issues/12367)). The first `add` therefore fails with an `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` message that prints the exact key to allow. Copy that exact key into the profile's `pnpm-workspace.yaml`, then re-run:

```yaml
allowBuilds:
  dsh-global-task-list@git+https://github.com/sgzxs/dsh-global-task-list.git#<commit>: true
```

Pin a tag (e.g. `#v0.1.1`) in the install command so the commit hash — and therefore the `allowBuilds` key — stays stable.

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

## Acknowledgements

Inspired by [HomeRail](https://github.com/xiaotianfotos/homerail) — its generative-UI (A2UI) idea of "the agent emits a bounded, whitelisted component tree that a host renders into a glanceable view" shaped this plugin's `surface` document and component catalog (`section` / `metric` / `statusBadge` / `progress` / `table` / `list` / `timeline` / `dag` / `disclosure`), as well as the principle of preferring built-in rendering over dumping raw logs.

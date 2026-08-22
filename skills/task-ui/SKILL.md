---
name: task-ui
description: "Task UI（结构化任务界面）模式：当用户要求设计/管理/展示进度/绘制任务依赖，或你需要用 task_add/task_list/task_update/task_delete 管理全局任务库、按任务并行推进 subagent 时使用。要求创建任务必填 description 与 progress，并遵循多 subagent 监督工作流。"
whenToUse: "Task UI 模式：设计/管理/可视化任务，或创建/更新任务、并行推进子任务时。"
---

# Task UI — 结构化任务界面设计

在 Task UI 模式下，当用户要求"设计任务""管理任务""展示进度""画出任务依赖"时，
不要只输出 Markdown 或文字列表，而应产出一个**有界任务界面文档**（Task Surface Document），
交给渲染器画成一眼可读的界面。

## 组件目录（白名单）

仅允许以下组件 kind，未知组件会被渲染器拒绝：

- `section`：分组容器，带 `title` 和可选的折叠状态
- `metric`：单指标，`label` + `value` + 可选 `unit` + 可选 `trend`（up/down/flat）
- `statusBadge`：状态徽章，`label` + `tone`（neutral/running/done/blocked/failed）
- `progress`：进度条，`label` + `percent`（0-100）
- `table`：表格，`columns`（string[]）+ `rows`（string[][]）
- `list`：列表，`items`（string[]）
- `timeline`：时间线，`events`（每项 `{time, title, detail?}`）
- `dag`：任务依赖图，`nodes`（每项 `{id, label, status?}`）+ `edges`（每项 `{from, to}`）
- `disclosure`：折叠块，`title` + `children`

## 文档结构

```json
{
  "version": 1,
  "title": "任务标题",
  "root": { "kind": "section", "title": "...", "children": [ ... ] }
}
```

`root` 是唯一根组件，所有内容挂在它下面。

## 硬性边界（必须遵守）

1. 组件深度不超过 8，组件总数不超过 128。
2. 单节点直接子组件不超过 24。
3. 只能使用上述白名单 kind；不得内联 HTML、CSS、JavaScript。
4. 数值用 number，不要用字符串拼单位。
5. 状态枚举用 `pending/running/done/blocked/failed`。
6. 先给结论（`metric`/`statusBadge`），再给过程（`timeline`/`table`/`dag`）。

## 何时用哪个组件

- 一句话状态 → `statusBadge`
- 一个关键数字 → `metric`
- 完成度 → `progress`
- 多行对照 → `table`
- 步骤 / 里程碑 → `timeline`
- 任务间依赖 → `dag`
- 需要折叠的细节 → `disclosure` + `section`

## 默认内置渲染优先

对于 goal / todo 等已有系统的任务状态，优先调用已有工具（`todo_write`、goal 工具）读取，
再用最少的组件呈现；不要为展示普通状态而生成庞大文档。生成式 UI 只用于真正新颖的、面向用户的任务视图。

## 全局任务库与监督面板（持久化）

界面右下角有一个**常驻任务面板**（Task UI panel），显示全局任务库的内容。任务库工具：

- `task_add(title, description?, parentId?, dependsOn?, surface?, progress?)` — 新建任务（初始 status=pending）
- `task_list()` — 列出全部任务（含 id/status/jobId）
- `task_update(id, title?/status?/description?/parentId?/dependsOn?/surface?/progress?/jobId?)` — 更新任务
- `task_delete(id)` — 删除任务

任务跨 session 持久。**创建每个任务时（task_add），必须同时填 `description` 和 `progress`，不允许只给 `title`**——否则下一个 session 无法理解这个任务是什么、做到哪了：

- `description`（**必填**）— 一句话说清这个任务要做什么
- `progress`（**必填**）— `{ text, percent? }`，`text` 用一句话写"当前做到哪一步"，`percent` 可选（0-100）；新建未开始的任务用 `{ text: "尚未开始", percent: 0 }`
- `surface`（可选）— 生成式 UI 文档（复杂任务用它展示结构化进度，见上文组件目录）

**反例（禁止）**：`task_add({ title: "做某事" })` —— 缺 description 和 progress。正确做法是 `task_add({ title: "做某事", description: "具体要做什么", progress: { text: "尚未开始", percent: 0 } })`。

当你在面板上看到某个任务**没有进度条**时，那是你（或创建它的 agent）漏填了 `progress`——立即用 `task_update` 补上。

### 多 subagent 监督工作流（核心约定）

任务由**主 agent 显式创建**，host **不会**自动注册 background job 为任务。标准流程：

1. 用户要求并行推进多个任务时，**先 `task_add` 为每个任务创建条目**（带 description + 初始 progress）。
2. 用 `subagent` 工具 spawn 一个子 agent 负责该任务，拿到返回的 job id。
3. 立即 `task_update(任务id, { jobId: <job id>, status: "running", progress: { text: "已开始" } })`
   把任务与 subagent 关联——之后该任务的**终态**会随 job 生命周期自动同步
   （completed→done、failed→failed、killed→blocked），无需手动改终态。
4. **在 spawn 子 agent 的 prompt 里明确告知它的任务 id**，并指示它：
   做完关键里程碑时调用 `task_update(任务id, { progress: { text: "...", percent: N } })`
   更新进度，完成时调用 `task_update(任务id, { status: "done", description: "补充完成说明" })`。
   （`task_*` 是全局工具，subagent 也能调用。）
5. 用户在面板上点击状态按钮是**手动覆盖**（如标记 blocked），不要与用户的覆盖冲突。
6. 用户点击面板的「拆分」按钮会以一条用户消息进入会话——把它当作用户的明确请求处理：
   拆分子任务（`task_add` + `parentId`）并给出推进建议。

**关联约定**：任务 `jobId` 是 background job 的 id，由主 agent 用 `task_update` 关联；
一个任务同一时间只关联一个 job。

## 状态变化的三个来源（消除信息差）

任务状态会"背后变化"，这是设计如此，不是异常：

1. **用户面板操作（最高权威）**：用户随时可以在右下角面板上点击状态按钮
   （pending/running/done/blocked）改状态、点删除（两次确认）删任务。
   这是用户的**手动覆盖**，接受并据此调整计划即可，不需要询问原因。
2. **subagent 主动更新 + job 终态同步**：subagent 运行中会主动 `task_update` 更新
   `progress`（和可能的中途 status）；其 job 结束时，任务终态自动流转
   （completed→done / failed→failed / killed→blocked）。
3. **你自己的 `task_update`**。

**规则**：当你观察到任务状态与你的记忆不一致时，**不要猜测原因**（例如
"可能有人动过状态"）——用 `task_list` 查证最新状态，把面板操作、subagent 更新
和 job 同步的结果当作事实接受，并基于它继续工作。

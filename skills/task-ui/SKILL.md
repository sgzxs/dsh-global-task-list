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

- `task_add(title, description?, nextStep?, steps?, parentId?, dependsOn?, surface?, progress?)` — 新建任务（初始 status=pending）
- `task_list()` — 列出全部任务（每条一行：状态、标题、id、job、下一步）
- `task_get(id)` — **读一个任务的完整记录**：描述、进度、完整流程、下一步、依赖、job、时间戳
- `task_update(id, title?/status?/description?/nextStep?/steps?/parentId?/dependsOn?/surface?/progress?/jobId?)` — 更新任务
- `task_delete(id)` — 删除任务

任务跨 session 持久。**创建每个任务时（task_add），必须同时填 `description`、`progress` 和 `steps`，不允许只给 `title`**——否则下一个 session 无法理解这个任务是什么、做到哪了、接下来做什么：

- `description`（**必填**）— 一句话说清这个任务要做什么
- `progress`（**必填**）— `{ text, percent? }`，`text` 用一句话写"当前做到哪一步"，`percent` 可选（0-100）；新建未开始的任务用 `{ text: "尚未开始", percent: 0 }`
- `steps`（**必填**）— 面板详情里**流程图**的数据：`[{ text, state }]` 有序数组，
  `state` 取 `done` / `current` / `next` / `todo`。面板用不同标框区分：
  `done`（已完成）与 `todo`（待办）用**常规标框**，`current`（当前进度）用**品牌色实线标框**，
  `next`（下一步）用**虚线标框**——一眼看出"做到哪、正在做什么、接着做什么"。
  **至少给 2 步**（一个 `current` + 一个 `next`）；确实只有一步的任务才可以只给 1 步。
- `nextStep`（**必填**）— 一句话写"下一步要做什么"，与 `steps` 里的 `next` 节点一致
- `surface`（可选）— 生成式 UI 文档（复杂任务用它展示结构化进度，见上文组件目录）

**反例（禁止）**：`task_add({ title: "做某事" })` —— 缺 description、progress 和 steps。
正确做法是 `task_add({ title: "做某事", description: "具体要做什么", nextStep: "第一步做什么", progress: { text: "尚未开始", percent: 0 }, steps: [{ text: "第一步做什么", state: "current" }, { text: "第二步做什么", state: "next" }] })`。

**为什么 `steps` 是必填**：面板无法凭空编造历史——它只能画任务里真实存在的东西。
只填 `progress` 时，详情卡片会退化成一个孤零零的"当前"节点，并在下面标注
"未提供流程，仅显示当前进度"。看到这行提示就说明是你漏填了 `steps`，**立即用 `task_update` 补上**。

**流程图怎么写**：把任务拆成 3-6 步，做完的标 `done`，正在做的标 `current`，紧接着的标 `next`，
其余标 `todo`。每推进一步就更新：刚做完的 `current` 改成 `done`，原来的 `next` 改成 `current`，
再补一个新的 `next`。

```json
"steps": [
  { "text": "读取 schema 并确认字段", "state": "done" },
  { "text": "写入 storage 并验证", "state": "done" },
  { "text": "对照算子支持表评估兼容性", "state": "current" },
  { "text": "输出量化部署方案", "state": "next" },
  { "text": "烧录到设备验证", "state": "todo" }
]
```

`steps` 为空时，面板会退化成用 `progress` + `nextStep` 拼出的流程；若 `steps` 里没有
任何 `next`，面板会把 `nextStep` 追加成下一步。这两种情况都只是兜底，不要依赖。

当你在面板上看到某个任务**没有进度条**时，那是你（或创建它的 agent）漏填了 `progress`——立即用 `task_update` 补上。

### 接手已有任务（跨 session 交接）

任务库是**跨 session 共享**的，所以你很可能会接手别的 session（或更早的你自己）留下的任务。
这时**不要凭猜测继续**，按这个顺序读：

1. `task_list()` —— 一行一个任务，带状态和 `next`，先做筛选；
2. `task_get(id)` —— 对你**真正要动手**的那个任务读全量记录。里面按重要性排列：
   - `description`：这个任务要做什么（含之前的发现，例如文件的真实格式、踩过的坑）
   - `progress`：当前做到哪一步（带 percent）
   - `steps`：完整流程，`[done]/[current]/[next]/[todo]` 标出已完成、正在做、接着做、还没做
   - `next`：下一步具体做什么
   - `depends on` / `parent`：依赖关系
   - `job`：关联的后台任务 id。**如果这里写着 `[expired]` / `warning: ... no longer exists`**，
     说明这个 job 是上一次运行留下的、现在已经不存在了，**`running` 状态不可信**——先自己确认
     实际情况（看 `updated` 时间、看产物），再决定是继续、改成 done 还是重开。
   - `created` / `updated`：**判断记录新鲜度的关键**——`updated` 很久没动却是 running，就要怀疑是否真的还在跑
3. 按记录的 `next` 继续；**推进过程中随时 `task_update`**（progress / steps / nextStep）。
   如果你发现记录与实际不符（例如记录说在用 TFL3 解析，但文件其实已经换版本了），
   **先把记录改对，再继续**——否则下一个接手的人会被你的旧记录误导。

这套顺序的意义在于：任务库的存储字段很全，但 `task_list` 是刻意保持短的一行；
**完整信息只能通过 `task_get` 拿到**，所以「列表筛选 → 单个读全量」是标准读法。

### 多 subagent 监督工作流（核心约定）

任务由**主 agent 显式创建**，host **不会**自动注册 background job 为任务。标准流程：

1. 用户要求并行推进多个任务时，**先 `task_add` 为每个任务创建条目**（带 description + 初始 progress）。
2. 用 `subagent` 工具 spawn 一个子 agent 负责该任务，拿到返回的 job id。
3. 立即 `task_update(任务id, { jobId: <job id>, status: "running", progress: { text: "已开始" } })`
   把任务与 subagent 关联——之后该任务的**终态**会随 job 生命周期自动同步
   （completed→done、failed→failed、killed→blocked），无需手动改终态。
4. **在 spawn 子 agent 的 prompt 里明确告知它的任务 id**，并指示它：
   做完关键里程碑时调用 `task_update(任务id, { progress: { text: "...", percent: N }, nextStep: "下一步...", steps: [...] })`
   更新进度、下一步与流程图，完成时调用
   `task_update(任务id, { status: "done", description: "补充完成说明", nextStep: "", steps: [把已有步骤全部标成 done] })`。
   （`task_*` 是全局工具，subagent 也能调用。）

   **收尾时必须清空 `nextStep`**——任务已经结束，"下一步"再留着任何内容都会误导下一个接手的人。
   而 `steps` **要保留、只把最后的状态改成 `done`**，不要清空：完成的步骤序列就是"这件事到底做了什么"的记录，
   正是后来者最需要的信息。清空它，面板详情会退化成孤零零一个节点。

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

# pi-work API / 模块契约（v0.1，测试据此编写）

实现方必须满足本契约；如需改动，先改本文件再改测试。

## 1. 启动与环境变量
`node server.mjs`，环境变量：
| 变量 | 说明 | 测试取值 |
|---|---|---|
| `PORT` | 监听端口 | 随机 |
| `PI_WORK_DATA_DIR` | SQLite/检查点目录 | 临时目录 |
| `PI_WORK_LLM` | `openai` \| `faux` | `faux` |
| `PI_WORK_FAUX_SCRIPT` | faux 模型脚本 JSON 路径（见 §6） | fixtures/*.json |
| `PI_WORK_RETRY_BASE_MS` / `PI_WORK_RETRY_MAX` | 续跑退避 | 50 / 5 |
| `PI_WORK_STALL_MS` | 卡住判定 | 2000 |
| `PI_WORK_TOKEN` | 可选 Bearer 鉴权；设置后所有 /api 需 `Authorization: Bearer` | 不设 |
启动完成后 stdout 打印一行 `PI_WORK_READY http://127.0.0.1:<port>`。`GET /api/health` → `{ok:true}`。

## 2. 纯函数模块（单元测试直接 import，均为 ESM，路径相对仓库根）
- `src/core/paths.mjs`
  - `truncatePath(p, max=40)`：长度 ≤max 原样返回；否则保留首段与文件名，中间用 `…`，如 `src/…/foo.ts`；若仍超长，对文件名前部截断 `…ame.ts`；结果长度 ≤ max；统一用 `/` 分隔（Windows `\` 转 `/`）。
  - `resolveInWorkspace(root, rel)` → `Promise<string>` 绝对真实路径；越界（`..`、绝对路径到外部、符号链接指向外部、NUL 字节）抛 `Error` 且 `err.code === 'E_SANDBOX'`。允许尚不存在的文件（检查其已存在的最近父目录 realpath）。
- `src/core/diff.mjs`
  - `diffStats(oldText, newText)` → `{added, removed}`（按行；`null`/`''` 视为空文件；末尾换行差异不计为改动行）。
  - `unifiedDiff(path, oldText, newText)` → 标准 unified diff 字符串（含 `--- a/path`、`+++ b/path`、`@@`）。
- `src/core/retry.mjs`
  - `createRetryPolicy({maxAttempts, baseMs, maxMs, factor=2})` → `{ shouldRetry(err, attempt), delayMs(attempt) }`。
  - 可重试：`err.code` ∈ `ETIMEDOUT, ECONNRESET, E_STREAM_CUT, E_EMPTY_OUTPUT` 或 `err.status` 为 429/5xx；不可重试：400/401/403、`E_SANDBOX`、`E_ABORTED`。`attempt` 从 1 起，`attempt >= maxAttempts` 一律 false。
  - `delayMs(n) = min(maxMs, baseMs * factor^(n-1))`，无抖动（便于测试）。
  - `decideAutoContinue({lastProgressAt, now, stallMs, status, autoContinues, maxAutoContinues})` → `'continue' | 'wait' | 'give_up'`：仅 `status==='running'` 且超时才 continue；次数用尽 give_up；其余 wait。
- `src/core/sse.mjs`
  - `formatSSE({id, event, data})` → `id: <id>\nevent: <event>\ndata: <JSON 单行>\n\n`；data 为对象时 JSON.stringify；多行字符串按行拆成多个 `data:`；缺 id 则省略该行。
  - `parseSSE(text)` → 事件数组 `{id, event, data}`（data 为解析后的 JSON，若可解析）。往返一致。
- `src/core/config.mjs`
  - `validateRole(obj)` / `validatePipeline(obj, roles)` → `{ok:true, value}` 或 `{ok:false, errors:[string]}`。
  - Role：`{id:/^[a-z][a-z0-9-]{0,31}$/, name, systemPrompt:string 非空, tools: 子集 of ['read','write','edit','ls','grep','bash'], model?: string}`；tools 缺省 `['read','ls','grep']`。
  - Pipeline：`{id, name, steps:[{role:<已存在 role id>, input?:'previous'|'user'}]}`，steps 非空，最多 20 步。
- `src/core/orchestrator.mjs`
  - `createOrchestrator({llm, store, tools})`：`start(conversationId, opts)`、`pause(id)`、`resume(id)`、`stop(id)`、`status(id)`；多个会话并行运行，彼此消息/工具事件/工作区不串。单测用 `src/llm/faux.mjs` 的 `createFauxLLM(script)` 与 `src/store/memory.mjs` 的 `createMemoryStore()`。

## 3. REST（JSON，前缀 /api）
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /workspaces` | `{name, path}` | `201 {id,name,path}`；path 不存在 → 400 |
| `GET /workspaces` | | `[{id,name,path}]` |
| `POST /workspaces/:wid/conversations` | `{title?, roleId?, pipelineId?}` | `201 {id, workspaceId, title, status:'idle'}` |
| `GET /workspaces/:wid/conversations?q=` | | 列表，按更新时间倒序 |
| `GET /conversations/:cid` | | `{id,title,status,autoContinues,lastCheckpointAt,currentStep,messages:[...]}` |
| `POST /conversations/:cid/messages` | `{text}` | `202 {runId}`，开始运行 |
| `POST /conversations/:cid/pause` · `/resume` · `/stop` | | `200 {status}` |
| `GET /conversations/:cid/changes` | | `[{path, added, removed, toolCallId}]`（按文件聚合） |
| `GET /workspaces/:wid/files?path=` | | `{path, content}`；越界 → 403 `{error:'E_SANDBOX'}` |
| `PUT /workspaces/:wid/files` | `{path, content}` | `200 {path, added, removed}` |
| `GET /conversations/:cid/diff?path=` | | `{path, before, after, unified, added, removed}` |
| `GET /roles` · `POST /roles` | Role | 校验失败 400 `{errors}` |
| `GET /pipelines` · `POST /pipelines` | Pipeline | 同上 |
status 取值：`idle | running | waiting | paused | recovering | failed | done | stopped`。

消息 `messages[]`：`{id, role:'user'|'assistant'|'tool', text?, tool?:{id,name,path?,added?,removed?,status,input,output}}`。

## 4. SSE：`GET /api/conversations/:cid/events`
支持 `Last-Event-ID` 断线续传（id 为会话内单调递增整数）。事件：
`status {status}` · `message.delta {messageId, text}` · `message.done {messageId}` · `tool.start {tool}` · `tool.end {tool}` · `checkpoint {at, step}` · `retry {attempt, delayMs, reason}` · `error {code, message}`。

## 5. 持久性/恢复语义
- 每个工具调用完成后写检查点；工具调用有稳定 `toolCallId`，恢复时已完成的调用**不得重放**（写文件幂等：同 toolCallId 不重复执行）。
- 进程重启：status 为 running/recovering 的会话自动恢复，先置 `recovering`，完成后 `done`。

## 6. faux 模型脚本
JSON：`{"turns":[ {"text":"..."} | {"tool":"write","args":{...}} | {"cut":true} | {"delayMs":N} ]}`，依次产出。`{"cut":true}` 第一次执行时抛 `E_STREAM_CUT`，重试时跳过。可选 `"perConversation": true` 时每个会话独立游标。

## 7. data-testid 约定（E2E）
| testid | 元素 |
|---|---|
| `workspace-new` / `workspace-name-input` / `workspace-path-input` / `workspace-create-submit` | 新建工作区 |
| `workspace-item` (+ `data-id`) | 左栏工作区项 |
| `conversation-new` / `conversation-item` (+`data-id`,`data-status`) | 会话项 |
| `status-dot` (+`data-status`) | 会话状态点 |
| `chat-input` / `chat-send` | 输入与发送 |
| `message` (+`data-role`) / `message-body` | 消息与渲染体（Markdown → HTML） |
| `tool-row` (+`data-tool`,`data-path`) / `tool-row-path` / `tool-row-added` / `tool-row-removed` / `tool-row-detail` | 工具行（点击展开 detail） |
| `status-bar` / `status-text` / `autocontinue-count` / `btn-pause` / `btn-resume` / `btn-stop` | 状态条 |
| `right-panel` / `diff-view` / `file-view` / `md-editor` / `md-editor-save` / `changed-file` (+`data-path`) | 右栏 |
| `file-open-editor` | 右栏中打开当前文件（.md→`md-editor`，其他→`file-view`） |
| `agent-status-item` (+`data-id`,`data-status`) | 左栏「Agent 状态」区，列出所有工作区中非 idle 的会话 |

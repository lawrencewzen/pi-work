# pi-work API / 模块契约（v0.1，测试据此编写）

实现方必须满足本契约；如需改动，先改本文件再改测试。

## 1. 启动与环境变量
`node server.mjs`，环境变量：
| 变量 | 说明 | 测试取值 |
|---|---|---|
| `PORT` | 监听端口 | 随机 |
| `PI_WORK_DATA_DIR` | SQLite/检查点目录 | 临时目录 |
| `PI_WORK_LLM` | `openai` \| `faux`。`faux` 只在显式要求时使用 | 测试设 `faux` |
| `PI_WORK_FAUX_SCRIPT` | faux 模型脚本 JSON 路径（见 §6）。设置后即视为要求演示模型 | fixtures/*.json |
| `LLM_API` | `faux` 时使用演示模型；其他值不单独打开演示模型 | 测试可设 `faux` |
| `PI_WORK_RETRY_BASE_MS` / `PI_WORK_RETRY_MAX` | 续跑退避 | 50 / 5 |
| `PI_WORK_STALL_MS` | 卡住判定 | 2000 |
| `PI_WORK_MAX_TOOL_CALLS` | 每个流水线步骤（没有流水线时就是这一轮）最多执行多少次工具，默认 15。达到后写入可见说明并结束该步，运行状态为 `done`，不继续空转 | 不设 |
| `PI_WORK_TOOL_LOOP` | 同一工具、同一组参数连续执行多少次后注入「停止调用工具」说明，默认 3。注入后若仍立刻重复，结束该步 | 不设 |
| `PI_WORK_TOOL_NUDGE` | 本步已执行这么多次工具、且还没有助手文字时，注入「请根据已有结果直接回答」，默认 8。只提醒一次，不立刻结束 | 不设 |
| `PI_WORK_EXPLORE_REPEAT` | 对同一文件 `read`、或对同一路径 `ls` / `grep`（以及 bash 里列出、搜索、读同一路径），忽略其余参数，执行超过这么多次就注入「不要再重复查看」，默认 2。再重复则结束该步 | 不设 |
| `PI_WORK_TOKEN` | 可选 Bearer 鉴权；设置后所有 /api 需 `Authorization: Bearer` | 不设 |
启动完成后 stdout 打印一行 `PI_WORK_READY http://127.0.0.1:<port>`。`GET /api/health` → `{ok:true}`。

未设置 `PI_WORK_LLM=faux`、`LLM_API=faux`、`PI_WORK_FAUX_SCRIPT` 时，没有已登录的 Grok 来源，也没有可用的 API 来源，就**不能**回落到 faux。此时发消息的运行以 `failed` 结束，不写助手回复。SSE `error` 与 `GET /conversations/:cid` 的 `llmError` 为 `{code:'E_NO_MODEL', message:'err_no_model'}`。`GET /api/settings` 增加 `runtime`：`faux` | `openai` | `none`。`runtime==='faux'` 时界面显示「演示模型」。模型来源与按角色绑定见 §8。

## 2. 纯函数模块（单元测试直接 import，均为 ESM，路径相对仓库根）
- `src/core/paths.mjs`
  - `truncatePath(p, max=40)`：长度 ≤max 原样返回；否则保留首段与文件名，中间用 `…`，如 `src/…/foo.ts`；若仍超长，对文件名前部截断 `…ame.ts`；结果长度 ≤ max；统一用 `/` 分隔（Windows `\` 转 `/`）。
  - `resolveInWorkspace(root, rel)` → `Promise<string>` 绝对真实路径；越界（`..`、绝对路径到外部、符号链接指向外部、NUL 字节）抛 `Error` 且 `err.code === 'E_SANDBOX'`。允许尚不存在的文件（检查其已存在的最近父目录 realpath）。
- `src/core/diff.mjs`
  - `diffStats(oldText, newText)` → `{added, removed}`（按行；`null`/`''` 视为空文件；末尾换行差异不计为改动行）。
  - `unifiedDiff(path, oldText, newText)` → 标准 unified diff 字符串（含 `--- a/path`、`+++ b/path`、`@@`）。
- `src/core/retry.mjs`
  - `createRetryPolicy({maxAttempts, baseMs, maxMs, factor=2})` → `{ shouldRetry(err, attempt), delayMs(attempt) }`。
  - 可重试：`err.code` ∈ `ETIMEDOUT, ECONNRESET, E_STREAM_CUT, E_EMPTY_OUTPUT` 或 `err.status` 为 429/5xx；不可重试：400/401/403、`E_SANDBOX`、`E_ABORTED`、`E_NO_MODEL`。`attempt` 从 1 起，`attempt >= maxAttempts` 一律 false。
  - `delayMs(n) = min(maxMs, baseMs * factor^(n-1))`，无抖动（便于测试）。
  - `decideAutoContinue({lastProgressAt, now, stallMs, status, autoContinues, maxAutoContinues})` → `'continue' | 'wait' | 'give_up'`：仅 `status==='running'` 且超时才 continue；次数用尽 give_up；其余 wait。
- `src/core/sse.mjs`
  - `formatSSE({id, event, data})` → `id: <id>\nevent: <event>\ndata: <JSON 单行>\n\n`；data 为对象时 JSON.stringify；多行字符串按行拆成多个 `data:`；缺 id 则省略该行。
  - `parseSSE(text)` → 事件数组 `{id, event, data}`（data 为解析后的 JSON，若可解析）。往返一致。
- `src/core/config.mjs`
  - `validateRole(obj)` / `validatePipeline(obj, roles)` → `{ok:true, value}` 或 `{ok:false, errors:[string]}`。
  - Role：`{id:/^[a-z][a-z0-9-]{0,31}$/, name, systemPrompt:string 非空, tools: 子集 of ['read','write','edit','ls','grep','bash'], model?: string}`；tools 缺省 `['read','ls','grep']`。空字符串 `model` 视为未设置。
  - Pipeline：`{id:/^[a-z][a-z0-9-]{0,31}$/, name, steps:[{role:<已存在 role id>, input?:'previous'|'user'}]}`，steps 非空，最多 20 步。
- `src/core/orchestrator.mjs`
  - `createOrchestrator({llm, store, tools})`：`start(conversationId, opts)`、`pause(id)`、`resume(id)`、`stop(id)`、`status(id)`；多个会话并行运行，彼此消息/工具事件/工作区不串。单测用 `src/llm/faux.mjs` 的 `createFauxLLM(script)` 与 `src/store/memory.mjs` 的 `createMemoryStore()`。

## 3. REST（JSON，前缀 /api）
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /workspaces` | `{name, path}` | `201 {id,name,path}`；path 不存在 → 400 |
| `GET /workspaces` | | `[{id,name,path}]` |
| `POST /workspaces/:wid/conversations` | `{title?, roleId?, pipelineId?}` | `201 {id, workspaceId, title, status:'idle'}` |
| `GET /workspaces/:wid/conversations?q=` | | 列表，按更新时间倒序 |
| `GET /conversations/:cid` | | `{id,title,status,autoContinues,lastCheckpointAt,currentStep,roleId,pipelineId,pipelineStep,messages:[...],usage,contextWindow,contextLabel}`。`usage` 是最近一次模型调用上报的 token 计数（没有则为 `null`，不估算）。`contextWindow` 优先用 usage 里的窗口，否则为 `LLM_CONTEXT_WINDOW`（默认 128000）。`contextLabel` 为 `1.2k / 128k` 或 `—` |
| `POST /conversations/:cid/messages` | `{text}` | `202 {runId}`，开始运行 |
| `PATCH /conversations/:cid` | `{roleId?, pipelineId?}` | `200 {id, roleId, pipelineId, pipelineStep, status, agents}`。`agents` 是切换后的侧栏角色列表，客户端应立刻用它刷新，不必整页刷新。空 `roleId` 表示默认 Agent，并清除流水线。`running` / `recovering` / `paused` 时 409 `{error:'err_role_busy'}`。未知角色或流水线 400 |
| `POST /conversations/:cid/pause` · `/resume` · `/stop` | | `200 {status}` |
| `GET /conversations/:cid/changes` | | `[{path, added, removed, toolCallId}]`（按文件聚合）。`added` / `removed` 用基线对比工作区里该文件的当前内容 |
| `GET /workspaces/:wid/files?path=` | | `{path, content}`；越界 → 403 `{error:'E_SANDBOX'}` |
| `PUT /workspaces/:wid/files` | `{path, content}` | `200 {path, added, removed}` |
| `GET /conversations/:cid/diff?path=` | | `{path, before, after, unified, added, removed}`。`before` 是该文件第一次变更前的基线；`after` 与 `unified` 对的是工作区磁盘上的当前内容，所以右侧手动保存的改动也会出现。文件已删除时 `after` 为空。磁盘读不出来时才退回存储的快照 |
| `GET /roles` · `POST /roles` | Role | 校验失败 400 `{errors}`；id 已存在 409 `{error:'exists'}`。`GET` 对 `planner`、`coder`、`tester`、`auditor` 额外带 `builtin:true`、`defaultPrompt`（`roles/<id>.json` 里的出厂提示词）和 `defaultTools`。库里的 `systemPrompt` 可以和出厂提示词不同。启动时若这四个内置角色的提示词仍是上一版英文出厂稿、且用户没有改过，会换成当前 `roles/<id>.json`；改过的提示词保持不动 |
| `PUT /roles/:id` | Role | 更新已有角色。不存在 404 `{error:'not_found'}`；路径与 body.id 不一致 400 `{errors:['id mismatch']}` |
| `DELETE /roles/:id` | | 200 `{ok:true,id}`。`default` 不可删，409 `{error:'protected'}`。被流水线引用 409 `{error:'role_in_use',pipelines:[id]}`。被对话 `roleId` 引用 409 `{error:'role_in_conversations',conversations:n}`。成功删除会写入 catalog tombstone，下次启动不会从 `roles/*.json` 再种回该 id |
| `GET /pipelines` · `POST /pipelines` | Pipeline | 校验失败 400 `{errors}`；id 已存在 409 `{error:'exists'}` |
| `PUT /pipelines/:id` | Pipeline | 同角色更新。步骤里的 role 必须已存在 |
| `DELETE /pipelines/:id` | | 200 `{ok:true,id}`。被对话 `pipelineId` 引用 409 `{error:'pipeline_in_use',conversations:n}`。成功删除写入 tombstone，下次启动不会从 `pipelines/*.json` 或 `examples/pipelines/*.json` 再种回该 id |
status 取值：`idle | running | waiting | paused | recovering | failed | done | stopped`。

消息 `messages[]`：`{id, role:'user'|'assistant'|'tool', text?, tool?:{id,name,path?,added?,removed?,status,input,output}}`。

## 4. SSE：`GET /api/conversations/:cid/events`
支持 `Last-Event-ID` 断线续传（id 为会话内单调递增整数）。事件：
`status {status}` · `message.delta {messageId, text}` · `message.done {messageId}` · `tool.start {tool}` · `tool.end {tool}` · `checkpoint {at, step}` · `retry {attempt, delayMs, reason}` · `error {code, message}` · `usage {usage, contextWindow, contextLabel}`。`usage` 仅在模型响应带了 token 计数时发送；最新一次调用覆盖上一次，不把多轮相加。

## 5. 持久性/恢复语义
- 每个工具调用完成后写检查点；工具调用有稳定 `toolCallId`，恢复时已完成的调用**不得重放**（写文件幂等：同 toolCallId 不重复执行）。
- 进程重启：status 为 running/recovering 的会话自动恢复，先置 `recovering`，完成后 `done`。
- 工具结果会随下一轮请求发回模型。输出为空时用 `(no output)`，避免模型以为调用没有发生。同一工具、同一组参数连续达到 `PI_WORK_TOOL_LOOP` 后注入一条可见的「停止调用工具」说明并再请求一次；若仍立刻重复，或本步工具次数达到 `PI_WORK_MAX_TOOL_CALLS`，写入可见说明并结束该步（流水线进入下一步）。对同一路径的查看（`read` 同一文件，`ls` / `grep` 同一路径，bash 的 `ls` / `grep` / `cat` 等打到同一路径，参数可以不同）达到 `PI_WORK_EXPLORE_REPEAT` 后注入「不要再重复查看」；再重复则结束该步。本步工具已有 `PI_WORK_TOOL_NUDGE` 次且还没有助手文字时，注入一次「请根据已有结果直接回答」，模型仍可继续，直到上限或重复查看把该步结束。这些结束都让整条运行走到 `done`。
- 写文件已经成功之后，模型连接被掐断（响应体 `terminated`、`E_STREAM_CUT`、`E_EMPTY_OUTPUT`）会先重试；重试仍失败则结束该步并说明「已按完成的工具结果结束本步」，状态是 `done`，不是 `failed` / `E_LLM`。没有成功工具调用时，这类错误仍然 `failed`。`E_NO_MODEL` 不重试，也不改成完成。

## 6. faux 模型脚本
JSON：`{"turns":[ {"text":"..."} | {"tool":"write","args":{...}} | {"cut":true} | {"delayMs":N} ]}`，依次产出。`{"cut":true}` 第一次执行时抛 `E_STREAM_CUT`，重试时跳过。可选 `"perConversation": true` 时每个会话独立游标。回合上的 `usage` 仅在带有数字 token 字段时进入会话用量（例如 `{"text":"ok","usage":{"total_tokens":16400}}`）；没有 `usage` 时作曲栏保持 `—`。

## 7. data-testid 约定（E2E）
| testid | 元素 |
|---|---|
| `workspace-new` / `workspace-name-input` / `workspace-path-input` / `workspace-create-submit` | 新建工作区 |
| `workspace-item` (+ `data-id`) | 左栏工作区项 |
| `conversation-new` / `conversation-item` (+`data-id`,`data-status`) | 会话项 |
| `status-dot` (+`data-status`) | 会话状态点 |
| `chat-input` / `chat-send` | 输入与发送 |
| `composer-context` | 作曲栏上下文用量（`—` 或 `1.2k / 128k`） |
| `composer-agent` / `composer-agent-menu` | 作曲栏当前模型；点击列出角色并可切换 |
| `message` (+`data-role`) / `message-body` | 消息与渲染体（Markdown → HTML） |
| `tool-row` (+`data-tool`,`data-path`) / `tool-row-path` / `tool-row-added` / `tool-row-removed` / `tool-row-detail` | 工具行（点击展开 detail） |
| `status-bar` / `status-text` / `autocontinue-count` / `btn-pause` / `btn-resume` / `btn-stop` | 状态条 |
| `right-panel` / `diff-view` / `file-view` / `md-editor` / `md-editor-save` / `changed-file` (+`data-path`) | 右栏 |
| `file-open-editor` | 右栏中打开当前文件（.md→`md-editor`，其他→`file-view`） |
| `agent-status-item` (+`data-id`,`data-status`) | 左栏「Agent 状态」区，列出所有工作区中非 idle 的会话 |

## 8. 模型来源（settings version 2）

`GET /api/settings` 的设置主体：

```json
{
  "version": 2,
  "sources": [],
  "models": { "default": { "sourceId": "a1b2c3d4", "model": "gpt-4o" } },
  "language": "zh",
  "theme": "white",
  "appearance": "light",
  "plugins": {},
  "skills": {},
  "vendors": [{ "id": "openai", "name": "OpenAI", "baseUrl": "https://api.openai.com/v1", "needsKey": true }],
  "grok": { "signedIn": false },
  "runtime": "none"
}
```

顶层不再返回 `provider`、`baseUrl`、`apiKey`、`hasApiKey`。密钥只出现在某条 `sources[]` 里，而且是掩码 `••••` 加原密钥最后 4 位，另有 `hasApiKey`。响应体不得含明文密钥。

`models` 的值是 `{ sourceId, model }`。`PUT /api/settings` 只接受这一种；字符串会被 400。`null` 表示去掉该角色的绑定。`PUT` 忽略 `provider`、`baseUrl`、`apiKey`、`hasApiKey`、`sources`、`version`，这些都不能从这条接口写回去。

旧的单行 `{ provider, baseUrl, apiKey, models:{ role: "模型名" } }` 在第一次读到时迁移到 version 2，并且只迁移一次（已经是 version 2 的记录按原样保留来源，读出时仍会去掉顶层那三个旧字段）：

- 有非空 `apiKey`，或 `provider` 是 `ollama` 且有 `baseUrl`，或 `baseUrl` 非空且不等于该 provider 的预设地址，才建一条 API 来源。
- 默认的 `{ provider:'openai', baseUrl:'', apiKey:'' }`、只选了预设厂商但没填地址和密钥、以及 `baseUrl` 恰好等于预设地址且没有密钥，都不建来源。
- 建不出 API 来源、也没有已登录的 Grok 时，旧的字符串 `models` 丢掉。
- 已登录 Grok 时，字符串模型挂到 Grok 来源；否则挂到新建的那条 API 来源。
- 迁移后顶层 `apiKey`、`baseUrl` 清空，`provider` 回到 `openai`，库里的 JSON 不再保留这三个字段。

来源对象：`{ id, kind:'api'|'grok', vendor, name, baseUrl, apiKey, hasApiKey, models:string[], lastTest?:{ ok, at, error?, code?, status? } }`。Grok 的 id 固定为 `grok`，并带 `session:{ signedIn, email, expiresAt }`。`lastTest.error` 与探测失败文本都要去掉密钥（`sk-***`、以及原文里的完整 key）。`lastTest.code` 与下面探测响应的 `code` 相同；`lastTest.status` 只在 HTTP 响应失败时出现。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/sources` | 无单独列表接口 | 来源在 `GET /api/settings` 的 `sources` |
| `POST /api/sources` | `{ vendor, name?, baseUrl?, apiKey?, models? }` | `201` 公开来源。`vendor` 必须是预设 id |
| `PUT /api/sources/:id` | 局部更新 `name` / `vendor` / `baseUrl` / `apiKey` / `models` | `200` 公开来源。掩码或空的 `apiKey` 表示不改密钥 |
| `DELETE /api/sources/:id` | | `200 {ok:true,id}`。引用该来源的角色绑定被去掉。删除 Grok 来源会退出登录 |
| `POST /api/sources/test` | `{ vendor, baseUrl?, apiKey? }` 或 `{ sourceId, vendor?, baseUrl?, apiKey? }` | `200 { ok, models?, error?, code?, status? }` |

错误码：

| 状态 | `error` | 何时 |
|---|---|---|
| 400 | `unknown vendor` | `vendor` 不在预设里 |
| 400 | `invalid models` | `models` 不是字符串数组 |
| 400 | `base url required` | 没有可用的 base URL |
| 400 | `api key required` | 该厂商需要密钥，但没有新密钥。改 `baseUrl` 时，新地址的 origin（协议 + 主机 + 端口）和旧地址不同，且这次没有带新密钥，也是这个错误：旧密钥先被丢掉。只改路径、origin 不变，旧密钥保留。Ollama 不需要密钥，换 origin 会清空旧密钥并成功 |
| 400 | `invalid model binding` | `models` 不是对象，或某个值不是 `{ sourceId, model }` / `null` |
| 400 | `invalid role id` | 角色 id 不合法 |
| 400 | `unknown source` | `sourceId` 不存在 |
| 400 | `model not in source` | `model` 不在该来源的 `models` 列表里 |
| 404 | `not found` | 来源 id 不存在 |
| 409 | `exists` | 新建时 id 冲突 |

`POST /api/sources/test` 失败时仍是 `200 { ok:false, error }`。`error` 是去掉密钥后的原文，不改写成界面语言。另外带机器可读的 `code`：

| `code` | 何时 | `status` |
|---|---|---|
| `network` | 连不上（`fetch failed`、`ECONNREFUSED` 等） | 无 |
| `timeout` | 超时 | 无 |
| `bad_json` | 响应体不是 JSON | 无 |
| `auth` | HTTP 401 或 403 | 有 |
| `not_found` | HTTP 404 | 有 |
| `http` | 其他 HTTP 状态 | 有 |

认不出的抛错只有 `error`，没有 `code`。成功响应不带 `code` / `status`。

`POST /api/sources/test` 带 `sourceId` 时，把请求里的 `vendor` / `baseUrl` / `apiKey` 叠到已保存的来源上再探测，不写回这条来源。origin 变了又没带新密钥，同样 400 `api key required`，不探测。只有请求里完全没有这些覆盖字段时，才把结果写入该来源的 `lastTest`（含 `code` / `status`）。

发消息时按角色选来源：该角色的 `{ sourceId, model }`，没有再用 `default`，再没有就用第一个可用的来源上的第一个模型。角色模板上的 `model` 字符串若出现在某个可用的来源列表里，就改走那个来源；否则沿用上面选中的来源，但模型名改成模板里的字符串。目标是 Grok 但拿不到 access token，并且没有别的可用目标时，本轮以 `E_NO_MODEL` / `err_no_model` 失败，而不是拿空的 base URL 去请求。

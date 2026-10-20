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
| `PI_WORK_TOKEN` | 可选登录。不设时 `/api` 与 SSE 不鉴权，不读不写 `auth.token`，`GET /login` 一律 302 `/`，启动不打印 `PI_WORK_LOGIN` / `PI_WORK_TOKEN`。设置后所有 `/api` 需 `Authorization: Bearer` 或 cookie `pi_work_token`；SSE 可用一次性 `?ticket=`；`GET /login?token=` 校验后种 cookie 并 302 `/`，否则 401 | 不设 |
| `PI_WORK_ALLOWED_HOSTS` | 逗号分隔的额外 Host。不设 `PI_WORK_TOKEN` 且本变量非空时，启动打印一行警告：服务对这些主机开放且没有鉴权 | 不设 |
| `PI_WORK_KERNEL` | 已废弃，启动不再读取。运行时始终是 Pi Durable Harness | 不设 |
| `PI_WORK_MAX_SUBAGENTS` | 子 Agent 并发上限。正整数时按它限制；缺省或非法值默认不限。数的是花名册里未停止、未结束的子 Agent（含已经空闲的后台子 Agent）。被停止后释放名额 | 不设 |
| `PI_WORK_GIT_BIN` | git 可执行文件。缺省 `git`。Windows 上可设为 `git.exe` 的完整路径 | 不设 |
| `PI_WORK_GIT_HTTP_HOSTS` | 允许用 `http://` 克隆的主机名，逗号分隔，大小写不敏感，不含端口。其它 `http://` 拒绝 | 不设 |
| `PI_WORK_GIT_CA_FILE` | 设置后克隆命令增加 `-c http.sslCAInfo=<路径>`，用于自签或内网 CA | 不设 |
启动完成后 stdout 打印一行 `PI_WORK_READY http://127.0.0.1:<port>`。未设置 `PI_WORK_TOKEN` 时不再打印 `PI_WORK_LOGIN` 或 `PI_WORK_TOKEN`。`GET /api/health` → `{ok:true}`。服务只监听 `127.0.0.1`。`Host` 不在白名单为 400；写请求带非同源 `Origin` 为 403；写请求的 `Content-Type` 不是 `application/json` 为 415。这三项与是否设置 `PI_WORK_TOKEN` 无关。

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
  - Role：`{id:/^[a-z][a-z0-9-]{0,31}$/, name, systemPrompt:string 非空, tools: 子集 of ['read','write','edit','ls','grep','bash'], description?: string, skills?: string[], pluginTools?: boolean}`。tools 缺省 `['read','ls','grep']`。`description` 最长 500，缺省空字符串。`skills` 缺省表示继承全部全局已启用的 Skill；`[]` 表示不用；非空数组只使用其中且全局已启用的那些。`pluginTools` 缺省或 `true` 表示这个角色可以使用已启用的插件工具；`false` 表示不并入、也不能调用。请求里的 `model` 和 `builtin` 一律忽略，不报错。
  - Pipeline：`{id:/^[a-z][a-z0-9-]{0,31}$/, name, steps:[{role:<已存在 role id>, input?:'previous'|'user'}]}`，steps 非空，最多 20 步。
- `src/core/explore.mjs`
  - `toolSignature` / `normalizeExplorePath` / `exploreTarget` / `explorePathOf`：工具循环和重复查看用的纯函数。对话运行走 `src/kernel/` 的 HTTP 门面和 Harness，不再有 `createOrchestrator`。
- `src/core/git-import.mjs`
  - `validateGitUrl(url, { httpHosts?, env? })`：允许 `https:`、`ssh:`、`git@host:path`。`http:` 仅当主机名（不含端口，大小写不敏感）在允许列表中。列表优先用 `httpHosts`，否则用 `env.PI_WORK_GIT_HTTP_HOSTS`（传了 `env` 时），再否则读进程环境。逗号分隔。`file:`、`git:`、`ftp:` 等拒绝。主机或路径段以 `-` 开头则拒绝。
  - `stripGitUrlCredentials(url)`：去掉 `scheme://user:pass@` 中的 `user:pass`。
  - `prepareGitClone({ url, branch, dest, env })` → `{ bin, args, env }`。`bin` 为 `PI_WORK_GIT_BIN`，缺省 `git`。`args` 含 `-c protocol.file.allow=never`、`-c protocol.ext.allow=never`、`clone --depth 1` 和 `--`；有分支时加 `--branch`。`PI_WORK_GIT_CA_FILE` 非空时加 `-c http.sslCAInfo=<路径>`。地址含 `user:pass@` 时，在 `clone` 前加 `-c credential.helper=`（空值，只清空这一次克隆的凭证助手）；地址不含凭证时不加，本机助手仍生效。子进程环境从传入的 env 拷贝，去掉 `GIT_CONFIG_NOSYSTEM`、`GIT_ASKPASS`、`SSH_ASKPASS`（及对应的 REQUIRE）；设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`；不主动设置 `GIT_SSH_COMMAND`。`LANG` 与 `LC_ALL` 为 `C.UTF-8`，`LANGUAGE` 为 `C`。
  - `classifyCloneFailure(err)` → `{ code, detail? }`。`code` 为 `git_not_found` | `auth_failed` | `cert_failed` | `repo_not_found` | `branch_not_found` | `network` | `timeout` | `unknown`。仅 `unknown` 带 `detail`：脱敏后的 stderr 末几行（URL 里的 `user:pass@` 已去掉）。
  - `cloneGitRepo({ url, branch, dest, env })`：校验后按 `prepareGitClone` 调用 `execFile`（不经 shell）。地址带 `user:pass@` 时，克隆参数包含 `-c credential.helper=`，成功后执行 `git remote set-url origin <去掉凭证的地址>`，并确认 `.git/config` 不含该凭证。失败抛 `Error`，`message` 为 `git clone failed`，`gitCode` 为上面的 code，`status` 为 400。非法地址的 `message` 为 `invalid gitUrl`，非法分支为 `invalid branch`，这两类没有 `gitCode`。

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
| `GET /roles` · `POST /roles` | Role | 校验失败 400 `{errors}`；id 已存在 409 `{error:'exists'}`。`POST` 可以不带 `id`：服务端用名称生成唯一 id（ASCII 小写、数字、横线；纯中文等无法生成合法 id 时用 `agent-` 加 6 位随机）。与已有角色或 tombstone 冲突时在后面加 `-2`、`-3`……。调用方仍然可以显式传合法 `id`。响应带生成的 `id`。`GET` 对预设 `default`、`planner`、`coder`、`tester`、`auditor` 带 `builtin:true`、`defaultPrompt`（`roles/<id>.json` 的出厂提示词）和 `defaultTools`。每个角色都带只读 `effectiveModel:{sourceId, model, follow}`。`follow:true` 表示这个角色没有自己的 `settings.models` 绑定，实际用的是默认角色的绑定，或再退到第一个可用来源的第一个模型；没有可用模型时 `sourceId` 和 `model` 为 `null`。响应不含 `model`。库里的 `systemPrompt` 可以和出厂提示词不同。启动时，预设提示词若仍是已知的旧出厂稿且用户没改过，会换成当前模板；改过的保持不动。预设的 `tools` 若仍等于旧模板值则升到新模板（审计从 `read,write,ls,grep` 改为只读 `read,ls,grep`），改过的保留。`description` 为空时补上模板里的说明 |
| `PUT /roles/:id` | Role | 更新已有角色，按整份角色替换（没传的 `skills` / `pluginTools` 回到缺省）。不存在 404 `{error:'not_found'}`；路径与 body.id 不一致 400 `{errors:['id mismatch']}`。`model` 被忽略 |
| `POST /roles/:id/reset` | | 把预设的名称、提示词、工具、`description`、`skills`、`pluginTools` 恢复成 `roles/<id>.json`。不改 `settings.models` 里的绑定。不是预设 400 `{error:'not_builtin'}`；角色不存在 404 `{error:'not_found'}` |
| `DELETE /roles/:id` | | 200 `{ok:true,id}`。五个预设不可删。被流水线引用时仍是 409 `{error:'role_in_use',pipelines:[id]}`；被对话 `roleId` 引用时 409 `{error:'role_in_conversations',conversations:n}`。没有这些引用时，预设返回 409 `{error:'protected'}`。成功删除会写入 catalog tombstone，下次启动不会从 `roles/*.json` 再种回该 id，并删掉 `settings.models` 里这个角色的绑定 |
| `GET /pipelines` · `POST /pipelines` | Pipeline | 校验失败 400 `{errors}`；id 已存在 409 `{error:'exists'}` |
| `PUT /pipelines/:id` | Pipeline | 同角色更新。步骤里的 role 必须已存在 |
| `DELETE /pipelines/:id` | | 200 `{ok:true,id}`。被对话 `pipelineId` 引用 409 `{error:'pipeline_in_use',conversations:n}`。成功删除写入 tombstone，下次启动不会从 `pipelines/*.json` 或 `examples/pipelines/*.json` 再种回该 id |
status 取值：`idle | running | waiting | paused | recovering | failed | done | stopped | archived`（见下）。

### Git 导入

`POST /workspaces` 请求 `{name, gitUrl, branch?}` 时把仓库克隆到数据目录，并创建 `source:'git'` 的工作区。成功 `201`，响应里的 `gitUrl` 已去掉 `user:pass@`。非法地址 `400 {error:'invalid gitUrl'}`；非法分支 `400 {error:'invalid branch'}`。克隆失败 `400 {error:'git clone failed', code}`，`code` 为 `git_not_found` | `auth_failed` | `cert_failed` | `repo_not_found` | `branch_not_found` | `network` | `timeout` | `unknown`。只有 `unknown` 另外带 `detail`（脱敏后的 stderr 末几行）。`http://` 的主机不在 `PI_WORK_GIT_HTTP_HOSTS` 里时，与非法地址相同。

消息 `messages[]`：`{id, role:'user'|'assistant'|'tool', text?, tool?:{id,name,path?,added?,removed?,status,input,output}}`。

### 旧对话只读归档

应用库里没有 harness id 的对话是切换前留下的。

- `GET /conversations/:cid` 与 `GET /workspaces/:wid/conversations` 的该项为 `status:'archived'`，并带 `archived:true`。消息仍来自 `messages` / `tool_calls`；`changes` 与 `diff` 路径不变。
- `POST /conversations/:cid/messages`、`PATCH /conversations/:cid`、`POST .../pause`、`/resume`、`/stop` 返回 `409 {error:'err_archived', status:'archived'}`。进程启动不恢复这些对话。
- `POST /conversations/:cid/from-history`，请求 `{title?}`，响应 `201 {id, workspaceId, title, status:'idle', sourceConversationId}`。在同一工作区新建一条内核对话，角色沿用旧对话；不复制流水线，也不把旧消息或工具调用写进新对话正文。用户和助手的可见文本（去掉首尾空白；工具行不包含）作为开场上下文交给模型。对新内核对话调用该接口返回 `409 {error:'err_not_archived'}`。未知对话是 `404`。不导入、不改写旧正文。

## 4. SSE：`GET /api/conversations/:cid/events`
支持 `Last-Event-ID` 断线续传（id 为会话内单调递增整数）。事件：
`status {status}` · `message.delta {messageId, text, replace?}` · `message.done {messageId, text?, role?, liveId?}` · `tool.start {tool}` · `tool.end {tool}` · `checkpoint {at, step}` · `retry {attempt, delayMs, reason}` · `error {code, message}` · `usage {usage, contextWindow, contextLabel}`。`usage` 仅在模型响应带了 token 计数时发送；最新一次调用覆盖上一次，不把多轮相加。

`message.delta` 的 `text` 在没有 `replace` 时是增量片段，接收方直接拼到当前气泡后面，不能因为这段文字以前出现过就丢掉。同一次生成的增量共用一个 `messageId`（`live-1`、`live-2`……；更早的事件也可能仍是 `live`）。它不是 transcript 里的正式 id。`replace: true` 表示 `text` 是到目前为止的完整 partial，用来替换气泡正文（断线后补发），不是再拼一段。同一时刻最多一个流式气泡。

`message.done` 的 `messageId` 是 transcript 条目 id。这次生成如果发过 delta，`liveId` 与那些 delta 的 `messageId` 相同；接收方用它结束流式气泡，并换成这条正式消息。done 之后不再保留临时气泡，刷新页面也不会把它留在末尾。用户消息带 `role:'user'`，不关闭助手的流式气泡。

## 5. 持久性/恢复语义
- 每个工具调用完成后写检查点；工具调用有稳定 `toolCallId`，恢复时已完成的调用**不得重放**（写文件幂等：同 toolCallId 不重复执行）。
- 进程重启：有 harness id、status 为 running/recovering 的会话由 Harness `resume()` 接着跑，先可表现为 `recovering`，完成后 `done`。没有 harness id 的旧对话不参与恢复，读取时状态为 `archived`。`write` / `edit` / `bash` 中断后不重放。
- 工具结果会随下一轮请求发回模型。输出为空时用 `(no output)`，避免模型以为调用没有发生。同一工具、同一组参数连续达到 `PI_WORK_TOOL_LOOP` 后注入一条可见的「停止调用工具」说明并再请求一次；若仍立刻重复，或本步工具次数达到 `PI_WORK_MAX_TOOL_CALLS`，写入可见说明并结束该步（流水线进入下一步）。对同一路径的查看（`read` 同一文件，`ls` / `grep` 同一路径，bash 的 `ls` / `grep` / `cat` 等打到同一路径，参数可以不同）达到 `PI_WORK_EXPLORE_REPEAT` 后注入「不要再重复查看」；再重复则结束该步。本步工具已有 `PI_WORK_TOOL_NUDGE` 次且还没有助手文字时，注入一次「请根据已有结果直接回答」，模型仍可继续，直到上限或重复查看把该步结束。同一条助手消息里多个并行调用一起被拦住时，模型仍会收到每一次被拦的说明；界面和 `GET` messages 只显示其中第一条相同文本的纠正。记录里已经存在的重复纠正也同样只显示一条。这些结束都让整条运行走到 `done`。
- 写文件已经成功之后，模型连接被掐断（响应体 `terminated`、`E_STREAM_CUT`、`E_EMPTY_OUTPUT`）会先重试；重试仍失败则结束该步并说明「已按完成的工具结果结束本步」，状态是 `done`，不是 `failed` / `E_LLM`。没有成功工具调用时，这类错误仍然 `failed`。`E_NO_MODEL` 不重试，也不改成完成。

## 6. faux 模型脚本
JSON：`{"turns":[ {"text":"..."} | {"tool":"write","args":{...}} | {"tools":[{"tool":"read","args":{...}}]} | {"cut":true} | {"delayMs":N} ]}`，依次产出。`tools` 把多个调用放在同一条助手消息里。`{"cut":true}` 第一次执行时抛 `E_STREAM_CUT`，重试时跳过。可选 `"perConversation": true` 时每个会话独立游标。回合上的 `usage` 仅在带有数字 token 字段时进入会话用量（例如 `{"text":"ok","usage":{"total_tokens":16400}}`）；没有 `usage` 时作曲栏保持 `—`。

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

来源对象：`{ id, kind:'api'|'grok', vendor, name, baseUrl, apiKey, hasApiKey, models:string[], catalog?:string[], lastTest?:{ ok, at, error?, code?, status? } }`。`models` 是已启用、会出现在角色下拉里的名字。`catalog` 只在来源行探测成功后出现，是这次拉到的完整列表；编辑抽屉用它把还没启用的新模型显示成未勾选。Grok 的 id 固定为 `grok`，并带 `session:{ signedIn, email, expiresAt }`。`lastTest.error` 与探测失败文本都要去掉密钥（`sk-***`、以及原文里的完整 key）。`lastTest.code` 与下面探测响应的 `code` 相同；`lastTest.status` 只在 HTTP 响应失败时出现。

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

`POST /api/sources/test` 带 `sourceId` 时，把请求里的 `vendor` / `baseUrl` / `apiKey` 叠到已保存的来源上再探测，不写回这条来源。origin 变了又没带新密钥，同样 400 `api key required`，不探测。只有请求里完全没有这些覆盖字段时，才把结果写入该来源的 `lastTest`（含 `code` / `status`）。这次如果成功，还按下面的规则改 `models`，并把拉到的完整列表写入 `catalog`：刷新不删除已经启用的模型。当前没有启用任何模型时，`models` 变成拉到的全部；已经有启用模型时 `models` 保持不变，新出现的名字只进 `catalog`、不自动启用。失败不改 `models` 和 `catalog`。

发消息时按角色选来源：该角色的 `{ sourceId, model }`，没有再用 `default`，再没有就用第一个可用的来源上的第一个模型。角色记录上不再有 `model`。启动时若库里的角色还留着旧的 `model` 字符串：这个角色还没有绑定时，在某个可用来源的模型列表里能找到同名模型，就写成 `settings.models[roleId]`；找不到就丢掉，并在服务器日志记一行 `PI_WORK_ROLE_MODEL dropped <roleId> model "<name>"`（不含密钥、不含 base URL）。无论找不找得到，这行 `model` 都会从角色记录里删掉。已有绑定不被覆盖。目标是 Grok 但拿不到 access token，并且没有别的可用目标时，本轮以 `E_NO_MODEL` / `err_no_model` 失败，而不是拿空的 base URL 去请求。

## 9. Skills 与按角色生效

`GET /api/skills` 返回全部 Skill：`{id, name, description, version, source, enabled, deletable}`。Agent 页的复选列表用其中 `enabled === true` 的 `id`、`name`、`description`（`description` 是一句说明）。全局开关仍是 `settings.skills[id] === false` 表示关闭，缺省为开启。

运行时：当前角色的 `skills` 缺省时，系统提示词带上全部全局已启用的 Skill；是数组时只带这些 id 里全局仍启用的；`[]` 不带 Skill。主 Agent（`default`）也看它自己的 `skills`。`pluginTools === false` 的角色，工具列表里没有插件工具，模型若仍调用，结果是 `E_UNKNOWN_TOOL`。缺省与现在一样，已启用的插件工具会并进该角色的工具列表。

## 10. 子 Agent

主 Agent 始终可以派子 Agent。未知对话的 `GET /api/conversations/:cid/agents/:aid/messages` 是 `404 {error:'conversation not found'}`。

主 Agent 多两个工具：`delegate`（前台，参数 `{agent, task}`，`agent` 是角色 id）和 `subagent`（后台，`action` 为 `spawn` / `send` / `wait` / `stop` / `list`）。可用角色的 id、名称和 `description` 写在主 Agent 的 `subagents` 系统提示 section。子 Agent 按该角色的模型绑定、工具白名单、Skills 和插件工具各自 `configure`，不能再派子 Agent。

`GET /api/conversations/:cid` 的 `agents` 在原有角色 / 流水线芯片之后追加真实子 Agent 实例：`{id, roleId, name, status, step, totalSteps, toolCalls, lastText, mode}`。`id` 形如 `<cid>:sub:<子对话 id>`。`status` 取 `waiting | running | done | stopped`。`mode` 取 `foreground | background`：前台 `delegate` 是 `foreground`，后台 `subagent` spawn 是 `background`。角色芯片和流水线芯片没有 `mode`。没有子 Agent 时，`agents` 与原来相同。

父对话 SSE 不混入子对话的 `message.delta` / `tool.*`。子 Agent 状态变化时，父对话收到 `agent` 事件，字段与芯片相同，包含 `mode`。角色和流水线的 `agent` 事件仍然不带 `mode`。

| 方法 路径 | 响应 |
|---|---|
| `GET /api/conversations/:cid/agents/:aid/messages` | `200 {id, roleId, name, status, mode, messages}`。`mode` 与芯片相同。`messages` 与父对话消息同形。对话不存在 `404 {error:'conversation not found'}`；`aid` 不是这个对话的子 Agent `404 {error:'agent not found'}` |
| `POST /api/conversations/:cid/stop` | `200 {status:'stopped'}`。停掉这条对话里的全部工作，包括后台子 Agent |

暂停仍不是本接口的停止语义。

## 11. Git 连接与从 GitLab 导入

连接存在 `settings.gitConnections`，不从 `GET /api/settings` 或 `PUT /api/settings` 读写。`PUT /api/settings` 里的 `gitConnections` 被忽略。输出一律掩码 `token`（与模型来源相同，`••••` 加末四位），并带 `hasToken`。编辑时掩码或空令牌表示不修改。

一条连接：`{id, name, kind, baseUrl, token, hasToken, allowHttp, caFile, lastTest}`。`kind` 为 `gitlab-self` | `gitlab-com` | `other`。`gitlab-com` 的 `baseUrl` 固定 `https://gitlab.com`。`allowHttp` 只对 `gitlab-self` 能为 `true`。`lastTest` 为 `{ok, username, error, at}` 或 `null`；`error` 是原因码，不是原文。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/git/connections` | | `200` 连接数组，令牌已掩码 |
| `POST /api/git/connections` | `{name, kind, baseUrl, token, allowHttp?, caFile?}` | `201` 新建的公开连接。校验失败 `400 {error:'invalid connection', errors}` |
| `PATCH /api/git/connections/:id` | 同字段，均可省略 | `200` 公开连接。不存在 `404 {error:'not_found'}`。掩码或空 `token` 保留原令牌 |
| `DELETE /api/git/connections/:id` | | `200 {ok:true,id}`。不存在 `404` |
| `POST /api/git/connections/:id/test` | | `200 {ok:true, username, connection}` 或 `200 {ok:false, code, connection}`。会写入 `lastTest` |
| `POST /api/git/connections/test` | 未保存的表单，可带 `id` | `200 {ok, username?, code?}`。不写库。带 `id` 且令牌是掩码或空时，用已保存的令牌测 |
| `GET /api/git/connections/:id/projects?search=` | | `200 {projects:[{id, path, description, defaultBranch, lastActivityAt, httpUrl}]}`。`kind:other` 为 `400 {code:'not_gitlab'}` |
| `GET /api/git/connections/:id/projects/:pid/branches` | | `200 {branches:[{name, default}], defaultBranch}` |

GitLab 请求只用 Node 内置 `http`/`https`，请求头 `PRIVATE-TOKEN`。设了 `caFile` 时，该文件作为 HTTPS 的 CA。`http://` 且未勾选允许 http 时不发请求，原因码 `http_not_allowed`。上游失败映射为 `auth_failed`（401/403）、`cert_failed`、`repo_not_found`、`branch_not_found`、`network`、`timeout`、`unknown`。响应和 `lastTest.error` 不含令牌。

`POST /api/workspaces` 除 `{name, path}` 和 `{name, gitUrl, branch?}` 外，接受 `{name, connectionId, projectId, branch?}`。`projectId` 向该连接的 GitLab 取 `http_url_to_repo`，去掉用户信息后，用连接的 origin 克隆。只填 `gitUrl` 时，若主机属于某条连接，用那条连接的令牌；否则仍走本机 git。用连接令牌克隆时，令牌放在子进程环境 `GIT_CONFIG_VALUE_*` 的 `http.extraHeader`（`Authorization: Bearer <token>`，GitLab 把个人访问令牌当作 Bearer），同时把 `credential.helper` 置空，避免系统凭证助手。令牌不出现在命令行参数、仓库地址、`.git/config`、workspace 记录或错误信息里。连接的 `allowHttp` / `caFile` 对这次克隆同样生效。失败 `400 {error, code, via:'connection'}`，`code` 同上；未知失败可带已打码的 `detail`。`http://` 未被允许时 `code` 为 `http_not_allowed`。

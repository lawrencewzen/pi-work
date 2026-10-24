# Weft API / 模块契约（v0.1，测试据此编写）

实现方必须满足本契约；如需改动，先改本文件再改测试。

## 1. 启动与环境变量
`node server.mjs`，环境变量：
| 变量 | 说明 | 测试取值 |
|---|---|---|
| `PORT` | 监听端口 | 随机 |
| `WEFT_DATA_DIR` | SQLite/检查点目录 | 临时目录 |
| `WEFT_LLM` | `openai` \| `faux`。`faux` 只在显式要求时使用 | 测试设 `faux` |
| `WEFT_FAUX_SCRIPT` | faux 模型脚本 JSON 路径（见 §6）。设置后即视为要求演示模型 | fixtures/*.json |
| `LLM_API` | `faux` 时使用演示模型；其他值不单独打开演示模型 | 测试可设 `faux` |
| `WEFT_RETRY_BASE_MS` / `WEFT_RETRY_MAX` | 交给 Harness `retry`。`WEFT_RETRY_MAX` 含第一次尝试，默认 5，`maxRetries` 为该值减 1。`baseDelayMs` 默认 200 | 50 / 5 |
| `WEFT_STREAM_TIMEOUT_MS` | 交给 Harness `stream.timeoutMs`。超时后按 retry 重试。默认 120000 | 不设 |
| `WEFT_MAX_OUTPUT_TOKENS` | 显式设置且为正整数时，覆盖 pi-ai 目录里该模型的 `maxTokens`。未设或非正整数时：目录有则用目录值，否则 32768。最终不超过该模型的上下文窗口 | 不设 |
| `WEFT_TOKEN` | 可选登录。不设时 `/api` 与 SSE 不鉴权，不读不写 `auth.token`，`GET /login` 一律 302 `/`，启动不打印 `WEFT_LOGIN` / `WEFT_TOKEN`。设置后所有 `/api` 需 `Authorization: Bearer` 或 cookie `weft_token`；SSE 可用一次性 `?ticket=`；`GET /login?token=` 校验后种 cookie 并 302 `/`，否则 401 | 不设 |
| `WEFT_ALLOWED_HOSTS` | 逗号分隔的额外 Host。不设 `WEFT_TOKEN` 且本变量非空时，启动打印一行警告：服务对这些主机开放且没有鉴权 | 不设 |
| `WEFT_KERNEL` | 已废弃，启动不再读取。运行时始终是 Pi Durable Harness | 不设 |
| `WEFT_GIT_BIN` | git 可执行文件。缺省 `git`。Windows 上可设为 `git.exe` 的完整路径 | 不设 |
| `WEFT_GIT_HTTP_HOSTS` | 允许用 `http://` 克隆的主机名，逗号分隔，大小写不敏感，不含端口。其它 `http://` 拒绝 | 不设 |
| `WEFT_GIT_CA_FILE` | 设置后克隆命令增加 `-c http.sslCAInfo=<路径>`，用于自签或内网 CA | 不设 |
启动完成后 stdout 打印一行 `WEFT_READY http://127.0.0.1:<port>`。未设置 `WEFT_TOKEN` 时不再打印 `WEFT_LOGIN` 或 `WEFT_TOKEN`。`GET /api/health` → `{ok:true}`。服务只监听 `127.0.0.1`。`Host` 不在白名单为 400；写请求带非同源 `Origin` 为 403；写请求的 `Content-Type` 不是 `application/json` 为 415。这三项与是否设置 `WEFT_TOKEN` 无关。

未设置 `WEFT_LLM=faux`、`LLM_API=faux`、`WEFT_FAUX_SCRIPT` 时，没有已登录的 Grok 来源，也没有可用的 API 来源，就**不能**回落到 faux。此时发消息的运行以 `failed` 结束，不写助手回复。SSE `error` 与 `GET /conversations/:cid` 的 `llmError` 为 `{code:'E_NO_MODEL', message:'err_no_model'}`。`GET /api/settings` 增加 `runtime`：`faux` | `openai` | `none`。`runtime==='faux'` 时界面显示「演示模型」。模型来源与默认绑定见 §8。

## 2. 纯函数模块（单元测试直接 import，均为 ESM，路径相对仓库根）
- `src/core/paths.mjs`
  - `truncatePath(p, max=40)`：长度 ≤max 原样返回；否则保留首段与文件名，中间用 `…`，如 `src/…/foo.ts`；若仍超长，对文件名前部截断 `…ame.ts`；结果长度 ≤ max；统一用 `/` 分隔（Windows `\` 转 `/`）。
  - `resolveInWorkspace(root, rel)` → `Promise<string>` 绝对真实路径；越界（`..`、绝对路径到外部、符号链接指向外部、NUL 字节）抛 `Error` 且 `err.code === 'E_SANDBOX'`。允许尚不存在的文件（检查其已存在的最近父目录 realpath）。
- `src/core/diff.mjs`
  - `diffStats(oldText, newText)` → `{added, removed}`（按行；`null`/`''` 视为空文件；末尾换行差异不计为改动行）。
  - `unifiedDiff(path, oldText, newText)` → 标准 unified diff 字符串（含 `--- a/path`、`+++ b/path`、`@@`）。
- `src/core/sse.mjs`
  - `formatSSE({id, event, data})` → `id: <id>\nevent: <event>\ndata: <JSON 单行>\n\n`；data 为对象时 JSON.stringify；多行字符串按行拆成多个 `data:`；缺 id 则省略该行。
  - `parseSSE(text)` → 事件数组 `{id, event, data}`（data 为解析后的 JSON，若可解析）。往返一致。
- `src/core/config.mjs`
  - `TOOLS`：内置工作区工具名 `['read','write','edit','ls','grep','bash']`。主 Agent 始终带上这份清单，再加上设置里启用的插件工具和 `delegate` / `subagent`。
- `src/core/git-import.mjs`
  - `validateGitUrl(url, { httpHosts?, env? })`：允许 `https:`、`ssh:`、`git@host:path`。`http:` 仅当主机名（不含端口，大小写不敏感）在允许列表中。列表优先用 `httpHosts`，否则用 `env.WEFT_GIT_HTTP_HOSTS`（传了 `env` 时），再否则读进程环境。逗号分隔。`file:`、`git:`、`ftp:` 等拒绝。主机或路径段以 `-` 开头则拒绝。
  - `stripGitUrlCredentials(url)`：去掉 `scheme://user:pass@` 中的 `user:pass`。
  - `prepareGitClone({ url, branch, dest, env })` → `{ bin, args, env }`。`bin` 为 `WEFT_GIT_BIN`，缺省 `git`。`args` 含 `-c protocol.file.allow=never`、`-c protocol.ext.allow=never`、`clone --depth 1` 和 `--`；有分支时加 `--branch`。`WEFT_GIT_CA_FILE` 非空时加 `-c http.sslCAInfo=<路径>`。地址含 `user:pass@` 时，在 `clone` 前加 `-c credential.helper=`（空值，只清空这一次克隆的凭证助手）；地址不含凭证时不加，本机助手仍生效。子进程环境从传入的 env 拷贝，去掉 `GIT_CONFIG_NOSYSTEM`、`GIT_ASKPASS`、`SSH_ASKPASS`（及对应的 REQUIRE）；设置 `GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never`；不主动设置 `GIT_SSH_COMMAND`。`LANG` 与 `LC_ALL` 为 `C.UTF-8`，`LANGUAGE` 为 `C`。
  - `classifyCloneFailure(err)` → `{ code, detail? }`。`code` 为 `git_not_found` | `auth_failed` | `cert_failed` | `repo_not_found` | `branch_not_found` | `network` | `timeout` | `unknown`。仅 `unknown` 带 `detail`：脱敏后的 stderr 末几行（URL 里的 `user:pass@` 已去掉）。
  - `cloneGitRepo({ url, branch, dest, env })`：校验后按 `prepareGitClone` 调用 `execFile`（不经 shell）。地址带 `user:pass@` 时，克隆参数包含 `-c credential.helper=`，成功后执行 `git remote set-url origin <去掉凭证的地址>`，并确认 `.git/config` 不含该凭证。失败抛 `Error`，`message` 为 `git clone failed`，`gitCode` 为上面的 code，`status` 为 400。非法地址的 `message` 为 `invalid gitUrl`，非法分支为 `invalid branch`，这两类没有 `gitCode`。

## 3. REST（JSON，前缀 /api）
| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /workspaces` | `{name, path}` | `201 {id,name,path}`；path 不存在 → 400 |
| `GET /workspaces` | | `[{id,name,path}]` |
| `POST /workspaces/:wid/conversations` | `{title?, modelSourceId?, modelId?}` | `201 {id, workspaceId, title, status:'idle', modelSourceId, modelId}`。`modelSourceId`/`modelId` 成对可选；都缺或都为 `null` 表示跟随 `settings.models.default`。来源不存在、或该来源模型列表里没有这个模型 → 400 `{errors}`。若仍带 `pipelineId` 或其它未知字段则忽略、不报错 |
| `GET /workspaces/:wid/conversations?q=` | | 列表，按更新时间倒序 |
| `GET /conversations/:cid` | | `{id,title,status,modelSourceId,modelId,messages:[...],usage,contextWindow,contextLabel}`。不返回 `roleId`。`usage` 是最近一次模型调用上报的 token 计数（没有则为 `null`，不估算）。`contextWindow` 为该对话实际模型（与 `modelFor` 相同的源 + 模型名）的窗口：用户在来源 `contextWindows` 里的设置 > pi-ai 模型目录里该模型的 `contextWindow` > `LLM_CONTEXT_WINDOW` > 128000。用户设置优先于 usage 里报的窗口。对话没有可用模型时仍是 usage 窗口或环境默认值。`contextLabel` 为 `1.2k / 128k` 或 `—`。失败时带 `llmError`。不返回 `pipelineId` / `pipelineStep` |
| `POST /conversations/:cid/messages` | `{text}` | `202 {runId, status:'running'}`。对话忙时用 `whenBusy:'steer'` 插入当前运行，不返回 409 |
| `PATCH /conversations/:cid` | `{modelSourceId?, modelId?}` | `200 {id, modelSourceId, modelId, status, agents}`。不返回 `roleId`。`modelSourceId`/`modelId` 为 `null` 表示跟随 `settings.models.default`。来源不存在或模型不在该来源列表里 → 400 `{errors}`。若仍带 `pipelineId` 或其它未知字段则忽略、不报错。运行中也可改模型，下一轮生效 |
| `POST /conversations/:cid/stop` | | `200 {status:'stopped'}`。中止当前运行，并停掉后台子 Agent |
| `GET /conversations/:cid/changes` | | `[{path, added, removed, toolCallId}]`（按文件聚合）。基线是该路径第一次 `write`/`edit` 的 `before`，对比工作区里该文件的当前内容。单份 before/after 或当前文件超过 1 MB 时该项带 `error:'文件过大'` |
| `GET /workspaces/:wid/files?path=` | | `{path, content}`；越界 → 403 `{error:'E_SANDBOX'}` |
| `PUT /workspaces/:wid/files` | `{path, content}` | `200 {path, added, removed}` |
| `GET /conversations/:cid/diff?path=` | | `{path, before, after, unified, added, removed}`。`before` 是该文件第一次变更前的基线；`after` 与 `unified` 对的是工作区磁盘上的当前内容。文件已删除时 `after` 为空。没有这条路径 404 `{error:'no diff'}`。基线或当前文件超过 1 MB 时 `200 {path, error:'文件过大'}` |
| `GET /roles` · `POST /roles` · `PUT /roles/:id` · `DELETE /roles/:id` · `POST /roles/:id/reset` | | 404 `{error:'not found'}`。角色系统已删除 |
| `GET /pipelines` · `POST /pipelines` · `PUT /pipelines/:id` · `DELETE /pipelines/:id` | | 404 `{error:'not found'}`。流水线已删除 |
status 取值：`idle | running | waiting | failed | done | stopped`。应用库只存最近一次 `submit` 的 `last_submission_id`。状态是 `harness.submission(id).status()`：`queued` / `placed` 为运行中，`done` 为完成，`unanswered` 且 `reason` 为 `aborted` 为已停止，其它 `unanswered` 为失败（`llmError` 来自这条记录的 `reason` / `detail`）。还没有这个指针的对话是空闲。指针指向的提交在 Harness 里找不到时，状态是 `failed`，`llmError` 为 `{code:'E_SUBMISSION_MISSING', message:'找不到这次运行的记录'}`，HTTP 仍是 200。没有 harness id 的旧行不出现在列表里。

### Git 导入

`POST /workspaces` 请求 `{name, gitUrl, branch?}` 时把仓库克隆到数据目录，并创建 `source:'git'` 的工作区。成功 `201`，响应里的 `gitUrl` 已去掉 `user:pass@`。非法地址 `400 {error:'invalid gitUrl'}`；非法分支 `400 {error:'invalid branch'}`。克隆失败 `400 {error:'git clone failed', code}`，`code` 为 `git_not_found` | `auth_failed` | `cert_failed` | `repo_not_found` | `branch_not_found` | `network` | `timeout` | `unknown`。只有 `unknown` 另外带 `detail`（脱敏后的 stderr 末几行）。`http://` 的主机不在 `WEFT_GIT_HTTP_HOSTS` 里时，与非法地址相同。

消息 `messages[]`：`{id, role:'user'|'assistant'|'tool'|'note', text?, model?, stopReason?, kind?, tool?:{id,name,path?,added?,removed?,status,input,output}}`。助手消息在 transcript 里有模型名时带 `model`（这条回复实际调用的模型 id）；没有则不加该字段。用户、工具和 `note` 消息不加 `model`。助手消息有 `stopReason` 时带上（如 `stop`、`length`）。以 `[auto-continue]` 开头的用户消息带 `kind:'auto-continue'`，界面不画成用户气泡。`role:'note'` 是给某个子 Agent 插话后写在主对话记录里的通知，不是用户气泡。

### 旧对话

应用库里没有 harness id 的对话不出现在 `GET /workspaces/:wid/conversations`。升级前、在新版本启动并删表之前，用 `node scripts/export-legacy-conversations.mjs <dataDir> <outDir>` 把这些对话（`conversations` + `messages`）各导出成一个 Markdown 文件。脚本只读，不改数据库。

## 4. SSE：`GET /api/conversations/:cid/events`
不落库，不使用 `Last-Event-ID`。连接后先推一条当前 `status`，之后只推这次连接上新发生的事件。前端在连接或重连时重新 `GET /conversations/:cid`。事件：
`status {status}` · `message.delta {messageId, text}` · `message.done {messageId, text?, role?, liveId?, model?, stopReason?, kind?}` · `tool.start {tool}` · `tool.end {tool}` · `retry {attempt, delayMs, reason}` · `error {code, message}` · `usage {usage, contextWindow, contextLabel}` · `agent`。`usage` 仅在模型响应带了 token 计数时发送；最新一次调用覆盖上一次，不把多轮相加。助手 `message.done` 在条目里有模型名时带 `model`，有 `stopReason` 时带 `stopReason`；流式增量拿不到时，结束后 `GET` 刷新会补上。自动续写用户消息带 `kind:'auto-continue'`。

`message.delta` 的 `text` 是增量片段，接收方直接拼到当前气泡后面，不能因为这段文字以前出现过就丢掉。同一次生成的增量共用一个 `messageId`（`live-1`、`live-2`……；更早的事件也可能仍是 `live`）。它不是 transcript 里的正式 id。同一时刻最多一个流式气泡。断线后重新 GET 对话，不靠补发 partial。

`message.done` 的 `messageId` 是 transcript 条目 id。这次生成如果发过 delta，`liveId` 与那些 delta 的 `messageId` 相同；接收方用它结束流式气泡，并换成这条正式消息。done 之后不再保留临时气泡，刷新页面也不会把它留在末尾。用户消息带 `role:'user'`，不关闭助手的流式气泡。

## 5. 持久性/恢复语义
- 工具调用有稳定 `toolCallId`。恢复时已完成的调用**不得重放**（写文件幂等：同 toolCallId 不重复执行）。
- 进程重启：有 harness id 且未结束的会话由 Harness `resume()` 接着跑，状态是 `running`，完成后 `done`。没有 harness id 的旧对话不参与恢复，也不出现在列表里。`write` / `edit` / `bash` 中断后不重放。
- 卡住只靠 `stream.timeoutMs`；可重试的模型错误由 Harness `retry` 处理。不自动提交下一句用户输入。助手 `stopReason` 为 `length` 时，内核用 GenerationTask `onYield` 在同一 run 里追加一条以 `[auto-continue]` 开头的用户消息继续生成，同一条真实用户消息之后最多连续 8 次。
- 工具结果会随下一轮请求发回模型。输出为空时用 `(no output)`，避免模型以为调用没有发生。
- `E_NO_MODEL` 不重试。流超时按 retry 重试，次数用尽后 `failed`。

## 6. faux 模型脚本
JSON：`{"turns":[ {"text":"..."} | {"text":"...","stopReason":"length"} | {"tool":"write","args":{...}} | {"text":"...","tool":"write","args":{...}} | {"tools":[{"tool":"read","args":{...}}]} | {"cut":true} | {"end":true} | {"delayMs":N} ]}`。一个对象是一次模型调用。文字和紧跟的工具调用放在同一个对象里，合成一条助手消息，Harness 自己跑完工具回合。只有文字、没有工具调用时这一轮结束，剩下的对象留给下一条用户消息。文字回合可带 `stopReason`（如 `length`），交给 Harness；`length` 会触发内核 `onYield` 自动续写。`{"cut":true}` 变成可重试的 `terminated` 错误。`{"end":true}` 是空助手消息，占住一轮，让脚本的下一拍留给下一次模型调用。回合上的 `usage` 仅在带有数字 token 字段时进入会话用量（例如 `{"text":"ok","usage":{"total_tokens":16400}}`）；没有 `usage` 时作曲栏保持 `—`。

## 7. data-testid 约定（E2E）
| testid | 元素 |
|---|---|
| `workspace-new` / `workspace-name-input` / `workspace-path-input` / `workspace-create-submit` | 新建工作区 |
| `workspace-item` (+ `data-id`) | 左栏工作区项 |
| `conversation-new` / `conversation-item` (+`data-id`,`data-status`) | 会话项 |
| `status-dot` (+`data-status`) | 会话状态点 |
| `chat-input` / `chat-send` | 输入与发送 |
| `composer-context` | 作曲栏上下文用量展示（`已用 x% · 剩 y% · 128k`），不可点 |
| `composer-context-limit` | 作曲栏上下文上限按钮（如 `128k`），点击打开档位菜单 |
| `composer-agent` / `composer-agent-menu` | 作曲栏当前模型；点击按来源列出模型，可选「默认」跟随设置绑定 |
| `message` (+`data-role`) / `message-body` / `message-sender` / `message-chip` | 消息、渲染体（Markdown → HTML）、发送者小字、该回复实际用的模型标签 |
| `auto-continue-note` | 自动续写提示行，不是用户气泡 |
| `output-truncated` / `continue-truncated` | 仍以 `length` 结束时的截断提示和「继续」按钮 |
| `tool-row` (+`data-tool`,`data-path`) / `tool-row-path` / `tool-row-added` / `tool-row-removed` / `tool-row-detail` | 工具行（点击展开输出；write/edit 打开右栏 diff） |
| `tool-group-elapsed` | 运行中且组在线程末尾时，摘要行右侧的用时 |
| `assistant-pending` / `assistant-pending-status` / `assistant-pending-elapsed` | 这一轮还没有工具调用时的思考占位 |
| `status-bar` / `status-text` / `btn-stop` | 状态条。运行中输入框保持可用 |
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

`models` 的值是 `{ sourceId, model }`。`PUT /api/settings` 只接受这一种；字符串会被 400。只保留 `default` 一项，其它键读到时忽略、保存时不写。`null` 表示去掉默认绑定。`PUT` 忽略 `provider`、`baseUrl`、`apiKey`、`hasApiKey`、`sources`、`version`，这些都不能从这条接口写回去。

旧的单行 `{ provider, baseUrl, apiKey, models:{ default: "模型名" } }` 在第一次读到时迁移到 version 2，并且只迁移一次（已经是 version 2 的记录按原样保留来源，读出时仍会去掉顶层那三个旧字段）。只有 `default` 字符串会写成绑定，其它键丢掉：

- 有非空 `apiKey`，或 `provider` 是 `ollama` 且有 `baseUrl`，或 `baseUrl` 非空且不等于该 provider 的预设地址，才建一条 API 来源。
- 默认的 `{ provider:'openai', baseUrl:'', apiKey:'' }`、只选了预设厂商但没填地址和密钥、以及 `baseUrl` 恰好等于预设地址且没有密钥，都不建来源。
- 建不出 API 来源、也没有已登录的 Grok 时，旧的字符串 `models` 丢掉。
- 已登录 Grok 时，字符串模型挂到 Grok 来源；否则挂到新建的那条 API 来源。
- 迁移后顶层 `apiKey`、`baseUrl` 清空，`provider` 回到 `openai`，库里的 JSON 不再保留这三个字段。

来源对象：`{ id, kind:'api'|'grok', vendor, name, baseUrl, apiKey, hasApiKey, models:string[], catalog?:string[], lastTest?:{ ok, at, error?, code?, status? }, contextWindows?:{ [模型名]: number }, defaultContextWindow: number, defaultContextWindows:{ [模型名]: number } }`。`models` 是已启用、会出现在模型下拉里的名字。`catalog` 只在来源行探测成功后出现，是这次拉到的完整列表；编辑抽屉用它把还没启用的新模型显示成未勾选。`contextWindows` 只含用户改过的模型上限（正整数 token 数）；没有改过则省略。`defaultContextWindow` 等于 `contextWindowFromEnv()`（`LLM_CONTEXT_WINDOW`，默认 128000），仍是整源回落。`defaultContextWindows` 给每个已启用模型一个默认上下文：pi-ai 目录里该模型的 `contextWindow`，查不到则用 `defaultContextWindow`。匹配规则：模型 id 相同且源 `baseUrl` 主机名相同；否则 id 相同且全目录唯一。前端输入框和「恢复默认」先看 `defaultContextWindows[模型]`。Grok 的 id 固定为 `grok`，并带 `session:{ signedIn, email, expiresAt }`。`lastTest.error` 与探测失败文本都要去掉密钥（`sk-***`、以及原文里的完整 key）。`lastTest.code` 与下面探测响应的 `code` 相同；`lastTest.status` 只在 HTTP 响应失败时出现。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/sources` | 无单独列表接口 | 来源在 `GET /api/settings` 的 `sources` |
| `POST /api/sources` | `{ vendor, name?, baseUrl?, apiKey?, models? }` | `201` 公开来源。`vendor` 必须是预设 id |
| `PUT /api/sources/:id` | 局部更新 `name` / `vendor` / `baseUrl` / `apiKey` / `models` / `contextWindows` | `200` 公开来源。掩码或空的 `apiKey` 表示不改密钥。`contextWindows` 与已有值合并；某模型值为 `null` 表示删除该项（恢复默认）。Grok 来源也支持 |
| `DELETE /api/sources/:id` | | `200 {ok:true,id}`。引用该来源的默认绑定被去掉。删除 Grok 来源会退出登录 |
| `POST /api/sources/test` | `{ vendor, baseUrl?, apiKey? }` 或 `{ sourceId, vendor?, baseUrl?, apiKey? }` | `200 { ok, models?, error?, code?, status? }` |

错误码：

| 状态 | `error` | 何时 |
|---|---|---|
| 400 | `unknown vendor` | `vendor` 不在预设里 |
| 400 | `invalid models` | `models` 不是字符串数组 |
| 400 | `invalid context window` | `contextWindows` 不是对象，或某个值不是 `null` 且不是 1000–10000000 的整数 |
| 400 | `base url required` | 没有可用的 base URL |
| 400 | `api key required` | 该厂商需要密钥，但没有新密钥。改 `baseUrl` 时，新地址的 origin（协议 + 主机 + 端口）和旧地址不同，且这次没有带新密钥，也是这个错误：旧密钥先被丢掉。只改路径、origin 不变，旧密钥保留。Ollama 不需要密钥，换 origin 会清空旧密钥并成功 |
| 400 | `invalid model binding` | `models` 不是对象，或 `default` 的值不是 `{ sourceId, model }` / `null` |
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

发消息时按这条链选来源：对话自己的 `{ modelSourceId, modelId }`，没有再用 `settings.models.default`，再没有就用第一个可用的来源上的第一个模型。目标是 Grok 但拿不到 access token，并且没有别的可用目标时，本轮以 `E_NO_MODEL` / `err_no_model` 失败，而不是拿空的 base URL 去请求。

## 9. Skills

`GET /api/skills` 返回全部 Skill：`{id, name, description, version, source, enabled, deletable}`。全局开关仍是 `settings.skills[id] === false` 表示关闭，缺省为开启。

运行时：主 Agent 的系统提示词 `instructions` 为空字符串。技能 section 只列设置里启用的 Skill 清单：第一行固定为 `Skills you can load with the skill tool when a request matches:`，之后每个启用技能一行 `- <id>: <description>`（description 压成一行、截到 160 字）。没有启用技能时不渲染该 section。正文不进系统提示词；主 Agent 判断用得上时调用 `skill({ name })`（`replay: 'safe'`），按 id（其次按 name）返回该技能完整正文。找不到或未启用时 `isError`，文案 `unknown skill <name>，可用：…`。关掉一个技能后，它从清单消失，工具也读不到。工具列表是全部内置工作区工具、已启用的插件工具、`skill`，以及 `delegate` / `subagent`。模型若调用未启用的插件工具，结果是 `E_UNKNOWN_TOOL`。子 Agent 没有技能清单，也没有 `skill` 工具。

## 10. 子 Agent

主 Agent 始终可以派子 Agent。未知对话的 `GET /api/conversations/:cid/agents/:aid/messages` 是 `404 {error:'conversation not found'}`。

主 Agent 多三个工具：`skill`（按需加载技能正文，参数 `{name}`）、`delegate`（前台，参数只有 `{task}`）和 `subagent`（后台，`action` 为 `spawn` / `send` / `wait` / `stop` / `list`；spawn 参数 `{name, message}`）。写法照 Pi Durable README「Abort and Subagents」与示例 22（前台）/ 23（后台）：前台子对话由工具任务拥有，重启时 `scanConversations({ ownerTaskId })` 复用，`requestId` 为 `subagent:<taskId>`；后台子对话由 background 锚点任务拥有，答案由 reporter 以 follow-up 送回主对话。没有自写花名册、并发上限或暂停同步。两个派活工具的 `description` 都说明子 Agent 看不到本对话和主 Agent 的提示词，需要的内容全部写进 `task` / `message`。子 Agent 是自包含派活：`instructions` 为空字符串，不带角色文字、不带 Skills 清单，工具是主 Agent 的工作区工具和插件工具（没有 `delegate` / `subagent` / `skill`），模型与 `cwd` 沿用父对话。不能再派子 Agent。前台 `name` 取 `task` 第一行（压成一行，最多 30 字）；后台用 spawn 的 `name`。单独中止一个前台子对话时，调用方收到 `[subagent <name> was stopped by the user]`（不是错误），本轮继续；中止主 Agent 仍会停掉这一轮。

`GET /api/conversations/:cid` 的 `agents` 第一项是主 Agent：`{id, name:'Agent', status, step, totalSteps, toolCalls, lastText}`，不带 `roleId` / `mode`。其后追加真实子 Agent 实例：`{id, name, status, step, totalSteps, toolCalls, lastText, mode}`，以及拿得到才返回的 `brief`、`startedAt`、`lastActivityAt`、`endedAt`、`currentAction`。不返回 `roleId`。名单从 Harness 读：工具调用的 `details.conversationId`、所有权索引、后台名称文档、子对话 `viewState`。`id` 形如 `<cid>:sub:<子对话 id>`。`status` 取 `waiting | running | done | stopped`。`mode` 取 `foreground | background`：前台 `delegate` 是 `foreground`，后台 `subagent` spawn 是 `background`。主 Agent 那一项没有 `mode`，也没有下面这些可选字段。没有子 Agent 时，`agents` 只有主 Agent 那一项。

可选字段都来自子对话 transcript，缺数据就不返回，不编造：

- `brief`：第一条 user 消息原文（主 Agent 派活时的 `task` / `message`）
- `startedAt`：第一条消息的 `timestamp`（毫秒）
- `lastActivityAt`：最后一条 assistant 或 tool 结果的 `timestamp`
- `endedAt`：`status` 为 `done` / `stopped` / `failed` 时最后一条消息的 `timestamp`；运行中不返回
- `currentAction`：仅 `running` 时返回。最后一个工具调用：有参数 `description` 就用它，否则是「工具名: 主要参数」短文本（如 `bash: npm test`），截断到 60 字；最后一条是 assistant 纯文本则不返回

父对话 SSE 不混入子对话的 `message.delta` / `tool.*`。子 Agent 状态变化时，父对话收到 `agent` 事件，字段与芯片相同，包含 `mode` 和上述可选字段。主 Agent 的 `agent` 事件不带 `mode`。

| 方法 路径 | 响应 |
|---|---|
| `GET /api/conversations/:cid/agents/:aid/messages` | `200 {id, name, status, mode, messages}`。`mode` 与芯片相同。`messages` 与父对话消息同形。对话不存在 `404 {error:'conversation not found'}`；`aid` 不是这个对话的子 Agent `404 {error:'agent not found'}` |
| `POST /api/conversations/:cid/agents/:aid/messages` | `{text}`。`200 {ok:true}`。对运行中的子对话 `submit({type:'input', content, whenBusy:'steer'})`；再给主对话写一条 `app.weft.user-to-subagent`，不唤醒主对话。空文本 `400 {error:'text required'}`；未知对话或子 Agent `404`；`status` 不是 `running` `409 {error:'agent not running'}` |
| `POST /api/conversations/:cid/agents/:aid/stop` | `200 {status:'stopped'}`。只 abort 这个子对话，不碰主对话和其他子 Agent。未知 `404`。主对话 SSE 推一条该子 Agent 的 `agent` 事件，`status` 为 `stopped` |
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

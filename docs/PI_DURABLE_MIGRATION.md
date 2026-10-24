# T5-0：把运行时换回 Pi Durable 内核

历史迁移稿，暂停 / recovering / 409 等语义已在 T12-2 移除，当前行为以 docs/ARCHITECTURE.md 为准。

本文是可执行的迁移方案。原型在分支 [`spike/pi-durable-kernel`](https://github.com/lawrencewzen/weft/tree/spike/pi-durable-kernel)（提交 `7b7ab38`），不合并。真正换内核按文末分批另派。

API 以已安装的 `@earendil-works/pi-durable@1.1.0`、`@earendil-works/pi-ai@1.1.0` 的 `dist/**/*.d.ts` 和 `node_modules/@earendil-works/pi-durable/README.md` 为准。GitHub `earendil-works/pi` 上 `main` 的示例 22/23 比 1.1.0 新：示例返回 `{ output }`，已发布的 `ToolExecutionResult` 和 README 用 `content`。原型按已发布包写。

## 结论

1a–1h 在 Pi Durable Harness 上跑通了。存储、恢复、前台/后台子 Agent、中止、工具沙箱、OpenAI 兼容接口，都能用已发布 API 做出来。Grok 订阅代理不能用包里的 `xaiProvider`，需要一个自定义 provider；最小版本已在原型里跑通，没有新依赖。

有四件事内核没有现成开关，迁移时要用扩展、hook 或宿主状态补上，不能再写一套编排器去替换 Harness：

- 用户意义上的暂停 / 继续（`abort()` 会停掉当前工作；`resume()` 是把上次进程留下的任务调度起来）。
- `stallMs` 卡住看门狗。
- 单步工具上限、重复翻找拦截（PR #18）和流水线交接。
- 前端现在用的「最近一次调用」用量；`docs["pi.usage"]` 是累计值。

这四项的取舍写在文末，需要用户拍板之后才能派对应批次。拍板之前不要在自写编排器上继续加运行时功能，也不要另起一个调度器。

## 原型

入口 `spike/server-durable.mjs` 只导出 `openKernel`。`server.mjs` 和 `src/` 没有改。数据在调用方给的独立目录里的 `session.sqlite`，用 `openNodeSqliteStorage`。冒烟脚本 `node spike/smoke.mjs`，完整日志 `spike/logs/smoke.log`（已去掉令牌；日志里只有 `access-1` / `access-2` 这种代号）。

本地一次完整通过：Node v22.14.0，linux。`node:sqlite` 打印 ExperimentalWarning。三件套的 `engines` 写的是 `>=22.19`，这次在 22.14 上 1a–1h 都跑完了。

| 条 | 证据（`spike/logs/smoke.log`） |
|---|---|
| 1a | 打开后 root 为 `1`；关掉再开仍是 `1`，`scheduling=running`，`tasks=0` |
| 1b | OpenAI 兼容假服务回答 `pong-openai`，`POST /v1/chat/completions`，`keyMatched:true`。Grok 假代理回答 `pong-grok`，`refreshes=1`：先 `access-1` 打 `/v1/responses`，再 `POST /oauth2/token`，再用 `access-2`。请求头有 `x-grok-client-identifier=grok-shell`、`x-grok-client-version=1.0.50`、`x-grok-model-override=grok-build`、`x-xai-token-auth=xai-grok-cli` |
| 1c | `write/read/edit/ls/grep/bash` 都走 Harness。`hello.txt` 最终是 `hello!`，工作区外文件仍是 `secret`，两次越界结果都是 `E_SANDBOX: path outside workspace`。第二个 ownerless 对话（id `44`）的 cwd 不同，只把自己的 `hello.txt` 写成 `from-b` |
| 1d 前台 | 主对话回答 `parent saw CHILD_OK`。子对话 `14` 的工具列表是 `read,write,edit,ls,grep,bash`，cwd 是该对话的工作区。角色正文来自 `roles/coder.json` |
| 1d 后台 | `maxConcurrentSubagents: 1`。同一轮两个 spawn：`Started a.` 与 `limit 1`，没有 `Started b.`。`list` 得到 `a: idle role=echo`，`wait` 得到 `echo PING_A`，`send` 得到 `Sent to a.`，子对话随后回答 `echo PING_A_AGAIN`，reporter 把这句作为 follow-up 写回主对话 |
| 1e | 主对话和子对话都打出 `run_start`→`status running`、`message_end`→`message.done`、`tool_execution_start/end`→`tool.start/end`、`usage_changed`→`usage`。子对话 id 来自 `tool_execution_update.details.conversationId`（数字）。快的 faux 回合没有 `message_update`，因为默认 partial 提交间隔是 100ms |
| 1f | 见下面摘录。恢复后仍是 2 个对话、1 条 `RECOVER_HOLD` 用户消息、根提交 `done`，子结果含 `resumed-after-kill`，父结果含 `parent-finished` |
| 1g | 前台：`status=unanswered reason=aborted`，子工具结果是 `Tool hold was aborted`。后台：普通 `abort()` 期间 tick 从 1 增到 4；`abort({ background: true })` 之后 tick 停在 4 |
| 1h | Windows：`windows-latest`，Node v22.23.3，`platform=win32`。[Actions 运行](https://github.com/lawrencewzen/weft/actions/runs/38600496463) 成功。`node:sqlite` 同样打印 ExperimentalWarning。bash 经 `cmd.exe` 得到 `bash-ok`，越界仍是 `E_SANDBOX`，cwd 是该对话的临时目录。杀进程用 `taskkill /PID /T /F`，被杀进程退出码是 1、没有 signal；随后的 resume 退出码 0，结果与 Linux 相同 |

1f 摘录：

```
=== 1f kill and resume ===
worker-crash [crash] conversation=1 raw=tool_execution_start ... name":"delegate" ... "task":"RECOVER_HOLD","roleId":"recover"
worker-crash [crash] attach conversation=14
worker-crash [crash] conversation=14 raw=tool_execution_start ... name":"hold" ... "token":"recover"
1f killing pid 3558
1f killed code=null signal=SIGKILL
worker-resume [resume] attach conversation=1 entries=3
worker-resume [resume] snapshot conversation=1 kind=pi.user text=RECOVER_DISPATCH
worker-resume [resume] attach conversation=14 entries=4
worker-resume [resume] snapshot conversation=14 kind=pi.user text=RECOVER_HOLD
worker-resume [resume] snapshot conversation=14 kind=pi.tool-result text=resumed-after-kill
worker-resume [resume] conversation=14 ... text":"child-finished"
worker-resume [resume] conversation=1 ... text":"child-finished"
worker-resume [resume] conversation=1 ... text":"parent-finished"
worker-resume [resume] {"conversations":2,"holdUserEntries":1,"rootRequestStatus":"done","parentText":"RECOVER_DISPATCH\n\n\nchild-finished\nparent-finished","childText":"RECOVER_HOLD\n\n\nresumed-after-kill\nchild-finished"}
1f resume code=0 signal=
=== smoke passed ===
```

### 1b：Grok 代理要自定义 provider

`pi-ai` 的 `xaiProvider()`（`dist/providers/xai.js`）把地址钉在 `https://api.x.ai/v1`。它的 OAuth `toAuth` 只返回 `{ apiKey }`，刷新按过期时间打 `https://auth.x.ai/oauth2/token`，不带 `conversations:read/write` 这条订阅 scope，也不写 `~/.grok/auth.json`，请求上没有 `x-grok-*` 头，401 不会触发刷新。

`HarnessSettings.stream`（`ConversationStreamOptions`）有 `headers`、`timeoutMs`、`maxRetries`，没有 `fetch`。所以 401 刷新不能塞进 settings。

最小可用做法已经在 `spike/lib/providers.mjs`：`createProvider`，`api` 用 `openai-responses` 的 `stream` / `streamSimple`，`baseUrl` 指向代理，静态头来自现有 `grokProxyHeaders`（去掉 `authorization`，access token 当 `apiKey`）。包一层 `fetch`：响应 401 时丢掉 body、用 refresh token 换一次新 access token、再请求一次。OpenAI SDK 这一跳 `maxRetries: 0`，Harness 的 `settings.retry.enabled` 在原型里关掉，避免和这一次刷新叠在一起。

OpenAI 兼容来源同样用 `createProvider`，`api` 用 `openai-completions`，`baseUrl` 和 key 由调用方传入。没有用钉死 `api.openai.com` 的 `openaiProvider`。

### 原型里和内核绑在一起的选择

这些选择迁移时沿用，除非文末拍板改掉：

- 前台 `delegate` 的 `replay: "safe"`。崩溃后用 `scanConversations({ ownerTaskId })` 找回同一个子对话，用 `requestId: subagent:${taskId}` 找回同一次提交。1f 走的是这条，不是后台工具。
- 后台 `subagent` 的 `replay: "unsafe"`，和 README 示例 23 一致（重复 stop 有副作用）。子对话挂在立刻结束的 background anchor 上；发消息和回报用 background reporter，`requestId` 防止重启后发两次。普通 `abort()` 留着后台子 Agent；`abort(context, { background: true })` 一起停。
- 并发上限数的是花名册里还活着的子 Agent（含已经 idle 的），在创建那次 commit 里数。不用 `LiveDoc.run`，因为第二个并行工具的 commit 里它可能还没写上。
- `hold` 用文件标记而不是 `memo`。`memo` 只能写一次，不能改；恢复要靠「标记已经存在」来跳过第二次等待。
- 工作区工具复用 `src/tools/workspace.mjs` 和 `resolveInWorkspace`。`write` / `edit` / `bash` 标成 `replay: "unsafe"`。Windows 上现有 bash 写死 `/bin/sh`，原型只在 `spike/lib/tools.mjs` 里对 `win32` 改走 `cmd.exe /d /s /c`，cwd 仍锁在对话工作区。`src/tools/workspace.mjs` 没改。
- 子 Agent 的 `configure` 会摘掉派发扩展，避免子 Agent 再派子 Agent。`hold` 放在另一个扩展里，恢复角色用得到它，又不带上派发工具。

## 2a. 能力对照

图例：**直接可用** = 已发布 API 就能表达。**需适配** = 用扩展、hook、document 或现有纯函数包一层，内核仍是 Harness。**有缺口** = 内核没有对应机制，要用户先定语义。

| 现有能力 | Pi Durable 机制 | 标记 |
|---|---|---|
| 多对话并行 | 一个 Session 里多个 `createConversation({ ownership: { kind: "ownerless" } })`。各自运行、各自 `cwd`。原型里对话 1 和 44 同时存在 | 直接可用。前端继续用 UUID；Harness 的 `ConversationId` 在 `.d.ts` 里是带品牌的 `number`（这次运行里是 1、14、16、44）。映射表放在应用库 |
| 终止 | `conversation.abort(context)`。前台子 Agent 跟着停 | 直接可用 |
| 暂停 / 继续 | 没有用户暂停。`abort()` 撤回排队输入并中止当前任务。`harness.resume()` 只负责进程重启后把调度器拉起来 | 有缺口。见 2f |
| 自动继续 | `hook(GenerationTask, { onYield })` 可以再塞一条用户消息。`decideAutoContinue` 仍是宿主策略 | 需适配 |
| 重试（`src/core/retry.mjs`） | `settings.retry` 形状同 pi-ai `RetryPolicy`：`enabled`、`maxRetries`、`baseDelayMs`、`maxAgentDelayMs`。分类器是 `isRetryableAssistantError`，对着错误文案做正则（429/5xx、timeout、terminated、流提前结束等）。延迟函数 `retryDelayMs` 是 `baseDelayMs * 2^(attempt-1)`，封顶 `maxAgentDelayMs`，这次读到的 `dist/utils/retry.js` 没有抖动（`.d.ts` 注释写了 before jitter，以 js 为准）。事件 `auto_retry_start` 带 `attempt`、`at`、`errorMessage`，没有 `delayMs` | 需适配。错误码集合和现有 `shouldRetry` 不完全一样：现有策略认 `ETIMEDOUT`、`ECONNRESET`、`E_STREAM_CUT`、`E_EMPTY_OUTPUT`、429/5xx，拒绝 400/401/403、`E_SANDBOX`、`E_ABORTED`、`E_NO_MODEL`，且无抖动。生成重试交给 `settings.retry`；工具错误和 `E_NO_MODEL` 仍由宿主拒绝重试 |
| 卡住检测 `stallMs` | 没有看门狗。进度在 `pi.live` 和 agent events 里 | 有缺口。见 2f |
| 进程重启恢复 | `Harness.open` 同一个 sqlite，`resume()` 继续未完成任务。同一 `requestId` 不会再提交一次。README：WAL、`synchronous=NORMAL`，进程崩溃后已提交的写入还在；断电或宿主机故障可能丢掉最新一次提交 | 直接可用。1f 用 SIGKILL 验证了进程崩溃这条。和现编排器的差别：`replay: "unsafe"` 的工具不会重跑，模型收到 `interrupted`；`replay: "safe"` 会重跑 `execute`。见 2f |
| read/write/edit/ls/grep/bash 与沙箱 | 包内 `CodingTools` 只有 read/write/edit/bash，没有 ls/grep，也不走 `resolveInWorkspace`。原型用 `defineTool` 包现有六个工具，`env` 用对话 `cwd` | 需适配。继续用现有沙箱，不用 `CodingTools` 当工作区边界。Windows 的 `/bin/sh` 要单独适配 |
| 单步工具上限、重复翻找（PR #18） | `beforeTool` 可以改写或拦住参数；`afterTool` 可以换结果；`onYield` / `control: { terminate: true }` 可以结束这一轮。计数器放 conversation document | 需适配。规则仍用现有 `exploreTarget` 等纯函数，hook 只负责调用它们 |
| 流水线（按步骤交接角色） | 没有流水线类型。`configure` 能换模型、工具、提示词、cwd。`onYield` 是单次生成结束后的钩子 | 需适配。建议仍在同一条对话里交接，这样现有消息列表和 Agent 芯片不用改。每步结束由宿主 `configure` 下一步角色再 `submit`。不要改成每个步骤一个子 Agent，除非 2f 改决定 |
| Agent 芯片切换角色；草稿对话 | 空闲时 `configure`。草稿是 `public/app.js` 的 `state.draft`，第一条消息才 `POST` 创建对话 | 需适配切换；草稿留在前端。忙碌时 409 仍由宿主看对话是不是 busy |
| SSE | `watchEvents`：挂上时给 snapshot，之后每批 commit 一条。晚加入不重放历史事件，只给当前 snapshot。落后超过 100 批会收到一份新 snapshot。`viewState` / `watch` 是另一条结构化视图 | 需适配。事件名映射见 2b。`Last-Event-ID` 要宿主自己把已发出的 SSE 存下来（现有 `events` 表），因为 watch 不重放 |
| 上下文用量芯片 | `usage_changed` 和 `docs["pi.usage"]` 按模型累计，失败和中止的尝试也算。`message_update.usage` 才是这一段 partial 的用量。快回合可能只有 `message_end` | 需适配。芯片继续显示最近一次调用。从最新 assistant 条目取 usage，再用现有 `presentContext` 格式化。不要把 `pi.usage` 直接绑到芯片 |
| Skills 拼进系统提示 | `section()` 渲染进系统提示。启用表仍在 settings | 已改为清单：`renderSkillList` 只放名字和简介；正文由主 Agent 的 `skill` 工具按需加载 |
| 插件工具 | `defineTool` + `registry.install`。同名后者替换前者。已开始的调用用旧实现，下一阶段用新代码 | 需适配。沿用 `plugins.mjs` 的加载和校验，注册成扩展工具 |
| faux 演示模型 | `fauxProvider()`、`setResponses`、`fauxAssistantMessage`、`fauxToolCall`、`fauxText` | 需适配。见 2d。未显式要求时仍然禁止落到演示模型 |
| 多模型来源、按角色路由 | 每个对话 `configure({ model })`。OpenAI 兼容用自定义 provider + `openai-completions`。Grok 订阅用上面的自定义 provider | 需适配。路由继续用 `resolveRoleTarget`。Grok 没有现成 provider，见 1b |
| 对话 / 消息 / 工具调用的 REST | 条目种类是 `pi.user`、`pi.assistant`、`pi.tool-result` 等。查询走 `viewState`、`scanConversations`、`submissionByRequest` | 需适配。HTTP 形状保持契约，见 2b |

T4-1（`feat/agents-backend`）会给角色加 description、skills、pluginTools、自动 id、预设，并把模型收进 `settings.models`。本方案不实现那些字段。子 Agent 批次开始时以当时的角色记录为准；现在的 `roles/*.json` 只有 `id`、`name`、`systemPrompt`、`tools`。

当前门面以契约和本文为准，对话运行时在 `src/kernel/`。

## 2b. REST 与 SSE

原则：浏览器继续打现在的路径和字段。Harness 的数字 id、累计用量、条目种类都停在服务端。

下面每个接口都由「应用库 + 一个 Harness Session」实现。应用库继续放工作区、设置、角色、流水线、UUID 对话行、SSE 事件日志、文件变更日志。对话正文以 Harness 条目为准；旧对话在归档模式下仍读应用库（见 2c）。

| 接口 | 新内核下 |
|---|---|
| `GET /api/health`、启动行 `WEFT_READY` | 不变。Harness 打开失败时进程不要打印 READY |
| `POST/GET /workspaces`、文件、树、`workspace-root` | 仍写应用库和磁盘。沙箱仍是 `resolveInWorkspace` / `resolveAllowedWorkspacePath`。与内核无关 |
| `POST /workspaces/:wid/conversations` | 应用库插入 UUID 行，并 `createConversation({ ownership: "ownerless" })`，把数字 id 记在该行。响应仍是 `{id, workspaceId, title, status:'idle'}`，id 仍是 UUID |
| `GET /workspaces/:wid/conversations` | 应用库列表。`status` 用 Harness 是否 busy、加上宿主的 paused/stopped 标记合成契约里的枚举 |
| `GET /conversations/:cid` | 消息由条目映射：`pi.user`→`user`，`pi.assistant`→`assistant`，`pi.tool-result`→`tool`。`usage` / `contextWindow` / `contextLabel` 用最近一次调用，经现有 `presentContext`。`agents` 仍由 `buildAgents` 从角色、流水线和消息推导。`llmError` 仍是宿主字段 |
| `POST /conversations/:cid/messages` | `submit({ type:"input", content, requestId })`，立刻 `202 {runId}`。`runId` 用 submission id 的字符串形式。忙碌时的拒绝保持现在的 409 `err_send_blocked`（契约写的是 202；现实现在 stopped 时返回 409。门面保持现行为，不改前端） |
| `PATCH /conversations/:cid` | 空闲时改应用库，并对 Harness `configure` 角色的模型、工具、提示词。`running` / `recovering` / `paused` 仍 409 `err_role_busy` |
| `POST .../pause` `/resume` `/stop` | 路径和 `{status}` 保持。语义等 2f。在拍板前，切换默认内核的那一批必须已经实现选定语义，否则暂停按钮会坏 |
| `GET .../changes`、`GET .../diff` | 内核没有变更日志。工具成功写盘时，宿主用现有 `diffStats` 写 `changes` 表（基线、toolCallId）。读接口不变 |
| `GET .../events` | 宿主把映射后的 SSE 写入现有 `events` 表，带会话内递增 id。`Last-Event-ID` 先重放这张表，再接上 `watchEvents` 的增量。晚连接用 snapshot 补当前正文，避免只靠 watch 丢掉已经结束的回合 |
| 角色、流水线、tombstone、内置提示词 | 仍是应用库和 `roles/*.json`。不进 Harness |
| `GET/PUT /api/settings`、`/api/sources`、`POST /api/sources/test` | 不变。这些是配置，不是对话内核。探测仍走现有 `probeModels`。发消息时按 `resolveRoleTarget` 选 provider 再 `configure` |
| `POST /api/sse-ticket`、鉴权、安全头 | 不变 |

状态枚举 `idle | running | waiting | paused | recovering | failed | done | stopped` 的对应：

| 契约状态 | 来源 |
|---|---|
| `idle` | 没有未完成提交，也没有宿主标记 |
| `running` | 对话 busy，或 `run_start` |
| `waiting` | 流水线当前步还没轮到；或后台子 Agent 在跑而主对话已 idle。主对话本身不新增状态值 |
| `paused` | 只有 2f 选定「暂停」之后才写。内核没有这个状态 |
| `recovering` | `resume()` 之后、被中断的那次提交重新跑完之前。由宿主在打开时标上，跑完改成 `done` |
| `failed` | 提交失败，或 `E_NO_MODEL`。`task_failed` 映射为 SSE `error` |
| `done` | 提交 `done` 且本步没有失败 |
| `stopped` | 用户终止。用宿主标记，因为 abort 之后对话只是 idle |

消息字段保持 `{id, role, text?, tool?}`。`tool.id` 用 `toolCallId`（Harness 已保证稳定）。`path` / `added` / `removed` 仍由宿主从参数和 `diffStats` 填，条目里没有这三项。

SSE 映射（`spike/lib/events.mjs` 已按这个打日志）：

| 契约事件 | Harness 事件 | 字段 |
|---|---|---|
| `status` | `run_start` / `run_end`，外加宿主的 pause/stop/recovering | `{status}`。恢复开始时带上 `autoContinues`，与现在一致 |
| `message.delta` | `message_update` 里的 `text_delta` | `{messageId, text}`。100ms 内结束的回合可能没有 delta；前端会在 `message.done` 后 `GET` 对话，正文仍会到。流式体验变粗一档，字段不改 |
| `message.done` | `message_end` | 契约只要 `{messageId}`。前端如果带了 `text` 会写上。门面可以多带 `text`，旧前端忽略不了的多余字段也能用 |
| `tool.start` | `tool_execution_start` | `{tool:{id,name,input}}`。`path` 从参数里的 `path` 填上，供现有工具行使用 |
| `tool.end` | `tool_execution_end` | `{tool}` 带上输出、`added`、`removed`、`status` |
| `checkpoint` | 每次工具 commit 由宿主发 | `{at, step}`。内核的 checkpoint 是任务相位，不是这个字段 |
| `retry` | `auto_retry_start` | 契约要 `{attempt, delayMs, reason}`。事件只有 `attempt` 和 `errorMessage`。`reason` 用 `errorMessage`；`delayMs` 用 `retryDelayMs(settings.retry, attempt)` 算。这是门面补的字段 |
| `error` | `task_failed`，以及宿主的 `E_NO_MODEL` | `{code, message}` |
| `usage` | 最近一条 assistant 的 usage，不使用累计的 `usage_changed` | `{usage, contextWindow, contextLabel}`，格式继续走 `presentContext` |
| `agent` | 宿主在角色/流水线步骤变化时照旧发 | 契约正文没有这条，`public/app.js` 在听。继续发，否则侧栏不更新 |

子 Agent 的事件挂在它自己的对话上。门面收 `details.conversationId` 后再 `watchEvents`。要不要把子对话的 token 打进父对话的 SSE，由 2f 决定；默认只把子 Agent 的最终文本当作工具结果，父对话的工具行保持现在的形状。

## 2c. 数据

现在的库是 `data/weft.sqlite`（`src/store/sqlite.mjs`）：`workspaces`、`settings`、`conversations`、`messages`、`tool_calls`、`changes`、`events`、`roles`、`pipelines`、`catalog_tombstones`。Pi Durable 的 sqlite 是另一套表（条目、任务、document、提交），由 `openNodeSqliteStorage` 自己建。两个文件不要合成一个，也不要让两个进程打开同一个 Harness 文件（README：一个进程独占，没有跨进程锁）。

建议：

1. 设置、工作区、角色、流水线、tombstone 留在 `weft.sqlite`，不转换。
2. 新对话：应用库只留 UUID、工作区、标题、角色、流水线步骤、Harness 数字 id、宿主状态。正文、工具结果、恢复点放在 `data/harness/session.sqlite`。
3. 旧对话只读归档。打开时仍从 `messages` / `tool_calls` / `changes` 读，状态显示为已归档。`POST` 消息返回明确错误，并提供「用这段历史开一条新对话」：只复制用户和助手的可见文本，不重放工具。不要把旧行导入成 `pi.user` / `pi.tool-result`。工具日志的 before/after 哈希、流水线步骤和「已完成的 toolCallId 不重放」都对不齐，导入是有损的。
4. 不写双向同步。切换之后，新消息只进 Harness。

不建议把旧对话重放进 Harness 再删应用表。那会在切换当天改写用户还能看见的历史。

## 2d. 测试

`pi-ai` 有假模型：`fauxProvider()`。`setResponses` 换掉整条队列，队列在 provider 上共享，不按对话分开。官方示例和这次原型都用它。它和当时 `src/llm/faux.mjs` 的脚本不是同一种 JSON。T5-11 已删除 `src/llm/`；同一份剧本 JSON 现在由 `src/kernel/faux-script.mjs` 转成 `fauxAssistantMessage`。

下面这段是切换前的计划。T5-11 已经把直接 import `createOrchestrator` 的用例改成打 HTTP 或打内核。

新内核的演示模型：写一个适配器，把同一份脚本 JSON 变成 `fauxAssistantMessage`。并行对话不能共用一个游标。原型用的是「看最后一条用户或工具消息」的纯函数路由，重启后仍然成立；脚本适配器也要做成纯函数，或者按 `sessionId`（每个对话在 `pi.provider` 里有持久 UUIDv7）分开队列。`cut` 第一次抛可重试错误、第二次跳过，要对齐 `settings.retry`，否则现有「流被掐断再重试」的用例对不上。

| 套件 | 切换前 | 切换后 |
|---|---|---|
| `npm run check`、`npm test` | 必须保持绿色。直接 import `createOrchestrator` 的用例先别改 | 编排器用例改成打门面或打 Harness。纯函数（paths、diff、retry、sse、config、usage）不动 |
| Playwright | 继续打 HTTP 契约 | 同一套用例打新内核。不改 `data-testid` |
| 演示模型 | `WEFT_LLM=faux` / `LLM_API=faux` / `WEFT_FAUX_SCRIPT` 才启用 | 同样的三个开关。没有 Grok 会话、API Key、Base URL 时仍然失败为 `E_NO_MODEL`，界面仍标「演示模型」 |
| 原型冒烟 | 留在 spike 分支 | 缩成内核单测：重开、不重复提交、沙箱、前台恢复。Windows 用 `windows-latest` 跑这组，直到 `/bin/sh` 的适配进了产品代码 |

## 2e. 分批

每一批单独合并。合并之后现有界面仍可用：在切换默认值之前，`node server.mjs` 仍走现在的编排器；新代码由单测覆盖。默认值只在最后一批、契约测试已经绿的时候翻。翻过之后每一批都不许把契约改坏。

工作量按要动的部分估，不按日历。

| 批 | 内容 | 依赖 | 可并行 | 验收 | 规模 |
|---|---|---|---|---|---|
| T5-1 | 新模块打开 Harness + `openNodeSqliteStorage`（独立目录）、注册 faux、`submit` + `requestId`、关掉再开能跑完。`server.mjs` 默认路径不动 | 无 | 无后续批能先于它 | 新单测：同一 requestId 不产生第二条提交；`npm test` 全绿 | 一个新目录和一份测试。小 |
| T5-2 | UUID↔数字 id、`POST` 消息、`GET` 对话、SSE 日志和 `watchEvents`。用环境变量才走新路径 | T5-1 | 作为后面各批的底 | 环境变量关闭时现有 HTTP 测试不变；打开时一条 faux 对话能 202、能断线续传、重启后消息还在 | 对话路由和事件表。中 |
| T5-3 | 六个工具、沙箱、按对话 cwd、`changes` 日志。Windows 上 bash 不再调用 `/bin/sh` | T5-2 | 可与 T5-4、T5-5 并行 | 越界 `E_SANDBOX`；两个对话写各自的文件；`changes`/`diff` 与现在一致；Windows CI 跑到 bash | 工具扩展加变更表。中 |
| T5-4 | OpenAI 兼容 provider、Grok 自定义 provider、`resolveRoleTarget`、显式 faux、没有来源时 `E_NO_MODEL` | T5-2 | 可与 T5-3、T5-5 并行 | 两个本地假服务（与 spike 相同的断言：自定义头、401 刷新一次）；设置接口仍不回明文密钥 | 把 `spike/lib/providers.mjs` 收进产品模块。中 |
| T5-5 | 空闲时 `configure` 换角色；流水线在同一对话里按步 `configure` + `submit`；草稿仍只在前端 | T5-2 | 可与 T5-3、T5-4 并行 | 现有角色/流水线 HTTP 测试在默认路径下仍绿；新路径下两步流水线交接后 `pipelineStep` 和 `agents` 与现在一致 | 宿主步骤状态。中 |
| T5-6 | 前台 delegate、后台 spawn/send/wait/stop/list、并发上限、角色模板作子 Agent 配置。若 T4-1 已合并，读取它的 skills / pluginTools / `settings.models` | T5-3、T5-5 | 可与 T5-7、T5-8、T5-9 并行 | 前台崩溃恢复不新建子对话、不重复提交；普通 abort 留下后台子 Agent；`abort({background:true})` 停掉它 | 以 `spike/lib/subagents.mjs` 为底。中到大 |
| T5-7 | 重试事件、工具上限、重复翻找、自动继续。暂停和 `stallMs` 只实现 2f 里选定的那一种 | T5-2，且 2f 已拍板 | 可与 T5-6 并行 | 现有 retry / explore / tool cap 用例改打 hook 之后结果不变；暂停按钮符合选定语义 | hook 加一份 document。中。未拍板不开工 |
| T5-8 | 用量芯片用最近一次调用，`usage` SSE 字段不变 | T5-2、T5-4 | 可与 T5-6、T5-7 并行 | 第二次调用覆盖第一次，不把 `pi.usage` 的累计值显示出来；没有 usage 时芯片是 `—` | 小 |
| T5-9 | Skills section；插件工具注册、热替换按 README 的「下一阶段生效」 | T5-2、T5-5 | 可与 T5-6 并行 | 现有 skills/plugins 单测在默认路径下仍绿；新路径下启用的 skill 出现在系统提示，禁用的插件不出现在工具列表 | 中 |
| T5-10 | 旧对话只读归档；新对话走 Harness。不导入旧正文 | T5-2 | 可与 T5-3 之后的批并行 | 旧 id 仍能 `GET` 消息和 diff；对旧 id 发消息得到明确错误；新对话重启后还在 | 读路径分叉。中 |
| T5-11 | 默认改为 Harness。删除编排器的运行循环。保留 paths、diff、retry 纯函数、sse 格式、config、usage、model-sources。**已完成：不再读取 `WEFT_KERNEL`，启动只打开 Harness。** | T5-3 到 T5-10 | 最后 | `npm run check`、`npm test`、Playwright 全绿；未配置模型不会落到 faux；进程杀掉后一条带前台子 Agent 的对话能跑完 | 测试改写面大 |

T5-11 之前产品行为就是今天的行为。T5-11 之后产品行为是契约加上 2f 的决定。

### T5-2 开关

T5-11 之后这只开关已经去掉：启动始终打开 Harness，不再读取 `WEFT_KERNEL`，也没有编排器可退回。下面是 T5-2 当时的范围，留作迁移记录。

`WEFT_KERNEL=durable` 时，进程启动打开 `<dataDir>/harness/session.sqlite` 上的 Pi Durable Harness，并调用 `harness.resume()`。下面这些接口改走内核，其它接口和默认路径不动：

- `POST /api/workspaces/:wid/conversations`
- `GET /api/workspaces/:wid/conversations`
- `GET /api/conversations/:cid`
- `POST /api/conversations/:cid/messages`
- `GET /api/conversations/:cid/events`

Harness 打开失败时进程退出，不打印 `WEFT_READY`。

演示模型仍只在 `WEFT_LLM=faux`、`LLM_API=faux` 或设置了 `WEFT_FAUX_SCRIPT` 时启用，这一路径用的是 pi-ai 的 `fauxProvider`。显式剧本（`WEFT_FAUX_SCRIPT`）按已提交的助手条数取下一拍。一段文字紧跟工具调用时合成一条助手消息，由 Harness 跑完工具回合；一段文字后面没有工具调用时这一轮结束。没有显式演示模式时，Harness 以 `no_model` 结束这次提交，门面映射成现有的 `E_NO_MODEL`。未设置 `WEFT_FAUX_TEXT` 时演示回复是空字符串，不会冒出一行 `ok`。`WEFT_FAUX_HOLD=1` 让这次模型调用不返回，供杀进程恢复测试使用，配合 `WEFT_FAUX_HOLD_READY` 写出一个就绪文件。

## 2f. 风险和要拍板的决定

1. **暂停。** 内核只能中止，不能把一次工具调用冻住再thaw。两个可落地的做法：甲，暂停 = `abort()`，继续 = 用新的 `requestId` 提交「从已有工具结果接着做」；进行中的 `replay: "unsafe"` 工具不会重跑，已写的一半文件留在磁盘。乙，暂停只停止宿主往模型发下一次请求，已经在跑的工具让它跑完。乙更接近「不要弄坏写到一半的文件」，甲更接近现在 `pause()` 立刻 abort 控制器的行为。在选定之前，T5-7 不实现暂停。
2. **卡住。** 没有 `stallMs`。可选：宿主计时，超时后走第 1 点的暂停，或 `submit` 一条「继续」并计入 `autoContinues`。现有 `decideAutoContinue` 只在 `status==='running'` 时继续。选定之前不做看门狗。
3. **后台子 Agent 和中止。** 原型按 README：普通中止留下后台子 Agent，`abort({ background: true })` 一起停。若产品希望「停止按钮永远停掉所有子 Agent」，停止走后者，暂停走第 1 点。
4. **工具重放。** 现契约：已完成的 `toolCallId` 不得重放。Harness：意图先提交，崩溃后只有 `replay: "safe"` 会重跑。`write`/`edit`/`bash` 在原型里是 unsafe，崩溃后模型看到 `interrupted`，磁盘上可能已经有半次写入。若要更接近现在的日志，宿主仍用 toolCallId 记「已成功」，unsafe 重放时直接把记好的结果交回去，不再执行。这要用户认可，因为它改变了「unsafe 就不重跑」的内核默认。
5. **用量。** 芯片保持「最近一次」，会话级成本另用 `harness.usage()` 时再做，不塞进现在的 `usage` 字段。
6. **旧对话。** 建议只读归档，不导入。若要导入，接受工具日志和流水线步骤对不齐。
7. **Grok。** 用本文的自定义 provider，不改 `xaiProvider`，不加依赖。等上游提供订阅代理之后再删这层。
8. **Windows shell。** 产品代码里的 bash 今天是 `/bin/sh`。切换工具的那一批要在 Windows 上改成不依赖 `/bin/sh` 的实现，并用 `windows-latest` 跑冒烟。原型里的 `cmd.exe` 只证明能跑 `echo`，不是最终沙箱。
9. **并发上限数谁。** 原型数的是花名册里的子 Agent，含 idle。若只想限制正在跑的数量，要另定，并接受两个并行 spawn 可能同时通过检查。
10. **流水线是否拆成子 Agent。** 建议同一对话内交接，前端不改。拆成子 Agent 会改消息归属和芯片。
11. **子对话事件是否进父 SSE。** 建议不进，父对话只看到工具结果。调试需要时再挂第二条 watch。
12. **Node 版本。** 应用 `engines` 是 `>=22.13`，三件套是 `>=22.19`。22.14 上原型已通过，并带 `node:sqlite` 的 ExperimentalWarning。切换默认内核时把应用 engines 抬到 `>=22.19`，与依赖一致。
13. **T4-1 的顺序。** 子 Agent 批次可以在 T4-1 之后，直接读新的角色字段；也可以先按现在的 `roles/*.json` 做，T4-1 合并后再加 skills 和 pluginTools。不要在两批里各写一套角色加载。

## 不确定之处

- `ConversationRetryPolicy` 的 `.d.ts` 注释写延迟在 jitter 之前封顶。`pi-ai@1.1.0` 的 `retryDelayMs` 实现里没有 jitter。迁移时以 `dist/utils/retry.js` 为准。
- `auto_retry_start` 没有 `delayMs`。上面的补法是用同一公式现算，还没有在打开 `settings.retry` 的情况下对过真实事件。
- 快回合没有 `message.delta` 是这次 faux 运行里观察到的，和 README 的 100ms partial 间隔一致。慢的真实模型应能看到 delta，尚未用真实模型验证。
- GitHub `main` 上的示例 22 返回 `output`。1.1.0 的工具结果用 `content`。以后升级包要先对 `.d.ts`，再改调用。
- `node:sqlite` 在这次 Windows 运行里可用（Node v22.23.3，ExperimentalWarning，冒烟通过）。更早或更晚的 Node 22 补丁版没有逐个试过。

## 这次验证了什么

- `node spike/smoke.mjs` 在 Linux、Node v22.14.0 上从 1a 跑到 1h，退出码 0。日志：`spike/logs/smoke.log`。
- 在 spike 分支上 `npm run check`、`npm test`（113 项）通过。该分支的 `check` 多检查了 `spike/` 下的入口；`main` 上的 `check` 不含这些文件。
- 没有跑 Playwright。原型没有页面。
- 没有调用真实的 `cli-chat-proxy.grok.com` 或 `auth.x.ai`。Grok 断言打在本地假服务上。
- Windows：GitHub Actions [`38600496463`](https://github.com/lawrencewzen/weft/actions/runs/38600496463)，`windows-2025`，Node v22.23.3，结论 success。日志里的 `=== smoke passed ===` 和 `1f result` 与 Linux 一致：`conversations:2`、`holdUserEntries:1`、`rootRequestStatus:done`，子文本含 `resumed-after-kill`。

## 已拍板的决定（2026-10-14）

用户确认，迁移各批按此执行，不再另议：

1. **暂停**：选乙。暂停 = 等当前这一步（进行中的模型请求和工具调用）做完，宿主不再发下一次模型请求；继续 = 从下一步接着做。不 abort 进行中的工具。
2. **卡住（stallMs）**：宿主计时；超时后提交一条「继续」，计入 `autoContinues`，受现有自动继续上限约束；超过上限按失败处理。
3. **停止**：停止 = 这条对话里的所有工作全停，包括后台子 Agent（`abort(context, { background: true })`）。
4. **崩溃时进行中的工具**：沿用内核默认。`write` / `edit` / `bash` 为 `replay: "unsafe"`，崩溃后不重跑，模型收到 `interrupted` 自行处理；不额外记录「已成功」结果去替代。
5. **用量芯片**：显示最近一次调用，不用 `pi.usage` 累计值；会话级成本以后另做。
6. **旧对话**：只读归档，不导入。可查看消息和 Diff，不能再发消息，提供「用这段历史开新对话」（只复制可见文本）。设置、工作区、角色、流水线全部保留。
7. **Grok**：用本文的自定义 provider，不改 `xaiProvider`，不加依赖。
8. **Windows shell**：工具批次里把 bash 改成不依赖 `/bin/sh` 的实现，`windows-latest` 跑冒烟。
9. **子 Agent 并发上限**：沿用原型（在创建那次 commit 里数花名册中未停止的子 Agent），默认不限，`WEFT_MAX_SUBAGENTS` 可选限制；子 Agent 被停止后释放名额。
10. **流水线**：同一对话内按步 `configure` + `submit` 交接，不拆成子 Agent。
11. **子 Agent 事件**：不混进父对话 SSE，父对话只看到工具结果；界面需要查看子 Agent 时单独挂 watch。
12. **Node 版本**：切换默认内核的那一批把 `engines` 抬到 `>=22.19`。
13. **角色来源**：T4-1 已合并（PR #34），子 Agent 批次直接读角色的 `description`、`skills`、`pluginTools` 和 `settings.models`，只写一套角色加载。

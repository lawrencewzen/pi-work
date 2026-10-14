# pi-work 架构

> **目标架构**：内核是 Pi Durable Harness（对话、任务、检查点、子 Agent），模型调用走 pi-ai，见 `AGENTS.md`「内核」。
>
> **现状（偏离目标，待迁移）**：默认路径仍是 `server.mjs` + `src/core/orchestrator.mjs`。`PI_WORK_KERNEL=durable` 时，对话的创建、读取、发消息和 SSE 走 `src/kernel/` 的 Pi Durable Harness（T5-2，不切默认）。其余能力仍在编排器上。迁回完成前不要在编排器上新增大的运行时能力。

单个 Node 22 进程，浏览器通过 REST + SSE 通信。下面描述的是当前（自写编排器）的实现。

```mermaid
flowchart LR
  subgraph Browser["浏览器（三栏 UI）"]
    L[左栏：工作区 / 会话 / 扁平 Agent 列表 / 运行中]
    C[中栏：对话 + 工具行 + 状态条]
    R[右栏：Diff / 文件 / Markdown 编辑器]
  end

  subgraph Node["Node 22 单进程（server.mjs）"]
    API[REST API + 鉴权 / Host / Origin]
    SSE[SSE 事件流]
    ORC[编排器 Orchestrator<br/>角色 Roles · 流水线 Pipelines · 并发]
    MON[监控 Monitor<br/>卡住检测 · 自动续跑 · 重试]
    J[自定义 SQLite 日志<br/>会话 · 工具调用 · 检查点 · WAL]
    T[工作区工具<br/>read / write / edit / grep / bash]
    D[Diff 记录器]
    DB[(SQLite<br/>检查点 · 会话 · diff)]
  end

  WS[(工作区目录)]
  LLM[OpenAI 兼容模型接口<br/>xAI / DeepSeek / 内网]

  L & C & R -->|HTTP cookie/bearer| API
  SSE -->|事件| Browser
  API --> ORC
  ORC -->|启动/暂停/停止 Agent| J
  MON -->|观察进度 / 触发续跑| ORC
  J --> DB
  ORC -->|调用模型| LLM
  ORC -->|工具调用| T
  T --> WS
  T --> D --> DB
  J -->|状态/消息/工具事件| SSE
```

## 关键概念
- **Agent** = 一个会话运行（角色 + 检查点），可多个并行。
- **Role**：系统提示词、工具白名单、模型。未知工具名在执行前被拒绝（`E_UNKNOWN_TOOL`），不会发出 `tool.start`。
- **Pipeline**：角色有序组合，带交接产物和失败回退。流水线步骤作为会话的 sub-agent 暴露（`GET /api/conversations/:cid` 的 `agents[]`，SSE `agent` 事件）。演示见 [SUBAGENTS.md](SUBAGENTS.md)。
- **Monitor**：每个 Agent 记录最后进展时间；超时或流中断 → 从最近检查点续跑，计数显示在状态条（↻ N）。
- **工具沙箱**：所有路径解析后必须位于工作区根目录内；写操作生成 diff 并入库，供右栏展示。`bash` 使用环境变量白名单、进程组 SIGKILL、1 MiB 输出上限；完整 OS 沙箱（bubblewrap）为 v1 之后的工作。
- **Skills**：`skills/<id>/SKILL.md`（前言里的 `id` / `name` / `description` + 正文）。仓库自带的 Skill 与 `$PI_WORK_DATA_DIR/skills` 中用户新建的 Skill 合并，同名时用户副本优先。`settings.skills[id] === false` 表示关闭，缺省为开启。编排器每次请求模型前，把已开启 Skill 的正文追加到系统提示词。
- **插件**：`plugins/<id>/plugin.json` 声明 `main`（插件目录内的相对 `.mjs`）和 `tools`。加载器 `import()` 该模块，并按工具名查找导出的函数。只有已开启且加载成功的工具会进入模型工具列表，并在编排器里执行；关闭、冲突或加载失败的名字仍是 `E_UNKNOWN_TOOL`。内置工具白名单不变。导入必须指向本机目录，模块能加载才复制到数据目录；只提交名称和描述会被拒绝。相对路径先按进程工作目录解析，不存在时再按安装目录解析。`examples/plugins/` 下的示例不会自动加载。工具函数收到 `(args, ctx)`，`ctx.workspacePath` 是当前工作区。插件代码在进程内运行，没有额外沙箱。

## 耐久性设计

`src/store/sqlite.mjs` 使用 Node 22 的 `node:sqlite`（`DatabaseSync`）：

- `PRAGMA journal_mode=WAL`
- `PRAGMA busy_timeout=5000`
- `PRAGMA synchronous=NORMAL`
- `schema_version` 表 + `PRAGMA user_version`（当前为 2；迁移时递增）
- 数据库文件与 `auth.token` 权限 `0600`
- 启动时在 `$PI_WORK_DATA_DIR/.lock` 上用 `O_EXCL` 抢单实例锁；若锁文件中的 pid 在 `/proc` 中仍存活则拒绝启动；进程退出时删除锁

**已知限制：** `node:sqlite` 仍带实验性警告，API 可能变化。多进程写入不受支持（靠锁文件保证单实例）。崩溃只在 e2e 层做过部分覆盖。

## 恢复不变量

- 每个工具调用有稳定 `toolCallId = ${conversationId}:${currentStep}`。`currentStep` 在**调用工具之前**写入会话行，避免步号回滚把新调用映射到旧的已完成结果。
- 已 `completed` 的工具调用恢复时不得重放。
- `bash` 在运行前标记 `started`。恢复时若仍为 `started`：**不重跑**，完成并写入固定文案 `INTERRUPTED — side effects unknown, check state before retrying`。
- `write` / `edit` 在突变前标记 `started`，并记录 `beforeHash` 与意图中的 `afterHash`（内容 SHA-256）。写入使用 `<path>.tmp.<pid>` 再 `rename`。恢复时：
  - 文件哈希等于 `afterHash` → 视为已应用，标 `completed`
  - 文件哈希等于 `beforeHash` → 再应用一次后标 `completed`
  - 其它 → 标 `completed` 且 `{interrupted:true, conflict:true, note:'file changed externally'}`，**不再写入**
- 进程重启：status 为 `running` / `recovering` 的会话自动恢复，先置 `recovering`，完成后 `done`。

## Git 工作区与 worktree

`POST /api/workspaces` 支持 `{name, gitUrl, branch?}`：用 `git clone --depth 1`（`execFile`，无 shell，`--` 分隔 URL，`protocol.file.allow=never` / `protocol.ext.allow=never`）把仓库克隆到 `PI_WORK_DATA_DIR/workspaces/<id>/repo`。仅允许 `https:`、`ssh:` 与 `git@host:path`。存储的 `gitUrl` 会去掉 `user:pass@`。工作区记录额外字段：

```
{ source: 'local' | 'git', gitUrl, branch, rootPath, worktrees: [] }
```

本地 `path` 必须位于 `$PI_WORK_DATA_DIR/workspaces` 或 `$PI_WORK_WORKSPACE_ROOT`（默认 `$HOME/projects` 若存在，否则 `$HOME`）之下，且不得为 `/`、`$HOME` 本身、`~/.ssh`、`~/.gnupg` 或系统目录。省略 `path` 时在 data dir 下创建空仓库目录。

**TODO：git worktree 尚未实现。** `worktrees` 目前恒为空数组，预留给后续 `git worktree add`（每个对话/Agent 独立工作树、互不覆盖工作区文件）。不要在当前版本假设存在多 worktree。

## 鉴权与绑定

- 首次启动若 `PI_WORK_TOKEN` 与 `$PI_WORK_DATA_DIR/auth.token` 皆空，生成 32 字节 hex 令牌并打印 `PI_WORK_LOGIN` / `PI_WORK_TOKEN`。
- `/api/*` 必须 `Authorization: Bearer` 或 cookie `pi_work_token`（HttpOnly, SameSite=Strict）。
- `GET /login?token=` 校验后 Set-Cookie 并 302 `/`。
- SSE 优先 cookie；`POST /api/sse-ticket` 签发 60s 一次性 `?ticket=`。不接受长效 token 作为 query。
- `Host` 必须是 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，可用 `PI_WORK_ALLOWED_HOSTS` 追加。
- 写方法要求 `Content-Type: application/json`；若带 `Origin` 则必须同源。

自定义 `baseUrl` 可指向任意 OpenAI 兼容主机（openai / x.ai / deepseek / anthropic 为常见值）。更换 `baseUrl` 或 `provider` 且请求中没有新的明文 `apiKey` 时，会清空已存密钥，避免把密钥发到攻击者主机。

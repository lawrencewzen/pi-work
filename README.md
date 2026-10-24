# Weft

网页版多 Agent 编码工作台：对话断点恢复由 Pi Durable 负责。

对话运行时是 **Pi Durable Harness**（`src/kernel/`，`@earendil-works/pi-durable`）。工作区、设置和对话索引在应用库 `src/store/sqlite.mjs`。耐久性设计见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，安全修复见 [SECURITY.md](SECURITY.md)。

启动：`node server.mjs`（Node >= 22.19）。进程只监听 `127.0.0.1`。浏览器打开启动日志里的 `WEFT_READY` 地址（`http://127.0.0.1:<端口>/`）即可使用，默认不需要登录链接。需要限制本机其他程序访问时，设置 `WEFT_TOKEN`，再用 `/login?token=` 或 `Authorization: Bearer`。不设令牌时，`Host` 白名单、跨域 `Origin` 和写请求必须是 JSON 这几项仍然生效；若同时设置了 `WEFT_ALLOWED_HOSTS`，启动会警告服务对这些主机开放且没有鉴权。

演示模型只在显式设置 `WEFT_LLM=faux`、`LLM_API=faux` 或 `WEFT_FAUX_SCRIPT` 时使用。没有可用模型时发消息以 `E_NO_MODEL` 失败，不会自动改走演示剧本。

> 本项目 fork 自 [xiaomoBoy/pi-durable-assistant](https://github.com/xiaomoBoy/pi-durable-assistant)（MIT），感谢原作者。

- 方案：[docs/PLAN.md](docs/PLAN.md)
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 界面稿：[design/mockup.html](design/mockup.html)

![mockup](design/mockup.png)

## 目标
- 三栏界面：工作区与会话、对话（Markdown + 折叠工具行）、Diff / 文件 / Markdown 编辑器
- 多个 Agent 并行；主 Agent 用 delegate / subagent 派子 Agent，子 Agent 是自包含派活，不套角色模板
- 监控：卡住检测、模型中断自动续跑与重试，SQLite 检查点
- 工作区内的 read / write / edit / grep / bash 工具，自动记录 diff
- 任意 OpenAI 兼容模型接口（xAI、DeepSeek、内网）
- Windows 内网可直接 `node server.mjs` 运行，无需 Docker

## Windows 下导入 GitLab 仓库

在设置 → Git 里添加 GitLab 连接（自建或 GitLab.com），填入个人访问令牌（`read_repository` 和 `read_api`）。新建工作区 → Git 导入可以「从 GitLab 选择」项目和分支。克隆时使用连接里的令牌，通过 Git 的 `http.extraHeader`（`Authorization: Bearer`，只放在 `GIT_CONFIG_VALUE_*` 环境变量里）交给 git，并清空这一次的 `credential.helper`。令牌不会写进仓库地址、工作区记录或 `.git/config`，也不会调用系统的 git 凭证助手。

不添加连接时，仍可以「填写地址」。Weft 调用这台机器上的 git，并沿用系统级和用户级配置。只要本机 git 能拉这个仓库（Git Credential Manager 里已经有凭证，或已经配好 SSH 密钥），就可以直接导入。地址的主机如果属于某个已连接的服务，会自动用那个连接的令牌。自建服务的「允许 http」和「高级」里的 CA 证书路径对测试和克隆同样生效。

- 安装 Git for Windows，或把 `WEFT_GIT_BIN` 设为 `git.exe` 的完整路径。找不到 git 时，导入对话框会提示安装或设置该变量。
- 导入过程不会弹出登录窗口。请先在终端用 git 克隆一次，让 Git Credential Manager 记住口令；或配置 SSH 密钥。
- 没有连接时，内网 `http://` 默认拒绝。把主机名写入 `WEFT_GIT_HTTP_HOSTS`（逗号分隔，不含端口）后才放行，例如 `WEFT_GIT_HTTP_HOSTS=gitlab.corp.local`。已添加的自建连接则用该连接的「允许 http」。
- 自签证书把 CA 文件路径设到 `WEFT_GIT_CA_FILE`，或填在连接的「高级」里。
- 地址里的 `user:token@` 不会写入工作区记录。克隆成功后，`.git/config` 里的 origin 也会改成去掉凭证的地址。这种地址只在这一次克隆里加上 `-c credential.helper=`，避免 git 把口令写进钥匙串或 Windows 凭据管理器；地址不带凭证、也没有连接令牌时，仍使用本机已配置的凭证助手。

## 插件

设置 → 插件 → 导入插件，填写运行 Weft 的机器上的目录。相对路径先按启动时的工作目录解析，找不到再按安装目录（`server.mjs` 所在目录）解析。只填名称不会安装。

目录里要有 `plugin.json`，以及它的 `main` 指向的 `.mjs`：

- `id`：小写字母、数字、连字符，最长 64 个字符。
- `name`、`description`、`version`。
- `main`：插件目录内的相对 `.mjs`，不能是绝对路径，也不能用 `../` 跳出目录。
- `tools`：至少一项。`name` 以小写字母开头，后面只能是小写字母、数字和下划线；另有 `description` 和 JSON Schema `parameters`。
- 模块按工具名导出函数 `(args, ctx) => ({ output, status })`。`ctx.workspacePath` 是当前工作区根目录。`status` 为 `error` 表示失败，`output` 是给对话看的文本。

`plugins/echo` 会预装。[`examples/plugins/word-count`](examples/plugins/word-count) 不会，导入路径填 `examples/plugins/word-count`。成功后复制到数据目录的 `plugins/<id>/`，开关写在设置里，重启后仍在。清单无效或模块加载失败时，对话框保持打开并说明原因，不新增卡片。插件在进程内执行，没有额外沙箱。

## 从 pi-work 升级

项目已改名为 Weft。旧名称不再读取，也不打兼容提示。GitHub 仓库将改名为 [`lawrencewzen/weft`](https://github.com/lawrencewzen/weft)，旧地址 `lawrencewzen/pi-work` 会自动跳转。

### 环境变量

把启动脚本和文档里的 `PI_WORK_*` 全部改成 `WEFT_*`。设置了旧变量、没设新变量时，效果等于没设。

| 旧名称 | 新名称 |
| --- | --- |
| `PI_WORK_DATA_DIR` | `WEFT_DATA_DIR` |
| `PI_WORK_TOKEN` | `WEFT_TOKEN` |
| `PI_WORK_ALLOWED_HOSTS` | `WEFT_ALLOWED_HOSTS` |
| `PI_WORK_LLM` | `WEFT_LLM` |
| `PI_WORK_FAUX_SCRIPT` | `WEFT_FAUX_SCRIPT` |
| `PI_WORK_FAUX_TEXT` | `WEFT_FAUX_TEXT` |
| `PI_WORK_FAUX_PLAN` | `WEFT_FAUX_PLAN` |
| `PI_WORK_FAUX_RECORD` | `WEFT_FAUX_RECORD` |
| `PI_WORK_FAUX_HOLD` | `WEFT_FAUX_HOLD` |
| `PI_WORK_FAUX_HOLD_READY` | `WEFT_FAUX_HOLD_READY` |
| `PI_WORK_FAUX_TPS` | `WEFT_FAUX_TPS` |
| `PI_WORK_FAUX_TOOL_LOG` | `WEFT_FAUX_TOOL_LOG` |
| `PI_WORK_FAUX_DELAY_TICK` | `WEFT_FAUX_DELAY_TICK` |
| `PI_WORK_RETRY_MAX` | `WEFT_RETRY_MAX` |
| `PI_WORK_RETRY_BASE_MS` | `WEFT_RETRY_BASE_MS` |
| `PI_WORK_STREAM_TIMEOUT_MS` | `WEFT_STREAM_TIMEOUT_MS` |
| `PI_WORK_MAX_OUTPUT_TOKENS` | `WEFT_MAX_OUTPUT_TOKENS` |
| `PI_WORK_MAX_SUBAGENTS` | `WEFT_MAX_SUBAGENTS` |
| `PI_WORK_WORKSPACE_ROOT` | `WEFT_WORKSPACE_ROOT` |
| `PI_WORK_GIT_BIN` | `WEFT_GIT_BIN` |
| `PI_WORK_GIT_HTTP_HOSTS` | `WEFT_GIT_HTTP_HOSTS` |
| `PI_WORK_GIT_CA_FILE` | `WEFT_GIT_CA_FILE` |
| `PI_WORK_GROK_AUTH` | `WEFT_GROK_AUTH` |
| `PI_WORK_GROK_CLIENT_VERSION` | `WEFT_GROK_CLIENT_VERSION` |
| `PI_WORK_GROK_PROXY` | `WEFT_GROK_PROXY` |
| `PI_WORK_CHROME` | `WEFT_CHROME` |
| `PI_WORK_ROOT` | `WEFT_ROOT` |
| `PI_WORK_TEST_GROK_TOKEN_URL` | `WEFT_TEST_GROK_TOKEN_URL` |
| `PI_WORK_KERNEL` | `WEFT_KERNEL`（仍不读取，运行时始终是 Pi Durable Harness） |
| `PI_WORK_KERNEL_MODE` | `WEFT_KERNEL_MODE`（测试辅助） |

日志前缀同样由 `PI_WORK_` 改为 `WEFT_`，例如 `PI_WORK_READY` → `WEFT_READY`，`PI_WORK_WARN` → `WEFT_WARN`，`PI_WORK_LOGIN` → `WEFT_LOGIN`（未设令牌时仍不打印登录行）。

登录 cookie `pi_work_token` 改为 `weft_token`。浏览器 `localStorage` 键由 `piwork_` 改为 `weft_`（主题、侧栏宽度等本地偏好会回到默认值）。

### 数据文件

应用库文件由 `data/pi-work.sqlite`（含 `-wal` / `-shm`）改为 `data/weft.sqlite`。这是文件改名，不是两套库并行读取：

- 启动时若只有旧文件，就连同 WAL/SHM 重命名为 `weft.sqlite`，旧对话仍在。
- 两个都存在时使用 `weft.sqlite`，并打一条日志说明旧文件未改名。

Harness 的 `data/harness/session.sqlite` 文件名没有改。包名由 `pi-work` 改为 `weft`。

## License
MIT，保留原作者版权声明。

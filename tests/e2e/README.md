# 手工验收用例

`tests/e2e/` 里的 Markdown 是功能验收的唯一清单。每个功能一个文件，里面是步骤和预期结果。由 cloud agent 在真实运行的 Weft 上逐条执行（可以用浏览器自动操作），全部通过才算接受。

同目录下的 `*.spec.mjs` 是旧的自动化子集，不能代替这里的用例。Linux CI 的 `e2e` job（`.github/workflows/v3-ci.yml`）跑这一套。

## Playwright 自动化子集

```bash
# 仓库根目录，Node ≥ 22
npm ci
npx playwright install chromium          # CI 用：npx playwright install --with-deps chromium
npm run test:e2e                         # playwright test -c tests/playwright.config.mjs
```

- 用例自己起 `server.mjs`，走演示模型（`WEFT_LLM=faux`），不需要登录或 API Key。
- 用系统 Chrome 时设 `WEFT_CHROME`（例如 `/usr/bin/google-chrome`）。
- 默认用测试结果证明，确实需要看画面时另行说明。Playwright 失败时仍会留下报告（`screenshot: only-on-failure`），CI 作为 artifact 保留 7 天。
- Windows CI 不跑 e2e。

## 规则

- 每个新功能的 PR 必须在本目录新增或更新对应用例，和功能改动放在同一个 PR 里。
- 一条用例只覆盖一个可观察的结果。步骤写操作，预期写屏幕上或回复里应出现的内容。
- 默认界面是中文。`appearance.md` 会切到英文，结束时必须切回中文。
- 需要模型的用例依赖已经登录的 Grok 会话，或已保存的 API Key。没有可用模型时把该条记为阻塞，不要记为失败。
- 把令牌、用户码和 API Key 写进记录是不允许的。

## 用例

| 文件 | 功能 |
|---|---|
| [open.md](open.md) | 不带登录链接直接打开工作台 |
| [workspaces.md](workspaces.md) | 工作区、本地目录、Git 导入 |
| [chat.md](chat.md) | 左右气泡、Markdown |
| [context-chip.md](context-chip.md) | 上下文用量：无用量为 —，模型返回后显示已用 / 窗口 |
| [agent-chip.md](agent-chip.md) | 调度模型芯片：显示默认模型、切换对话模型 |
| [files.md](files.md) | 写文件，Diff / 文件 / Markdown，工具写入后文件树立即更新 |
| [tool-loop.md](tool-loop.md) | 相同工具连呼、重复翻找与单步工具上限 |
| [conversation-control.md](conversation-control.md) | 暂停、继续、终止，终止后再次发送 |
| [running-overview.md](running-overview.md) | 运行中概览 |
| [grok-login.md](grok-login.md) | Grok 设备码登录、退出登录 |
| [model-connection.md](model-connection.md) | 未连接模型时报错，登录后真实回复，演示模式有徽章 |
| [model-sources.md](model-sources.md) | 模型来源增删改测、默认模型、保存条、换主机重填 Key |
| [skills.md](skills.md) | 新建 Skill、开关、启用后影响回复 |
| [plugins.md](plugins.md) | Echo 列表、开关、调用工具、空导入被拒绝、导入 word-count、重启后仍在、无效插件报错 |
| [agents.md](agents.md) | 侧栏里的真实子 Agent：前台点开消息、后台标记 |
| [archive.md](archive.md) | 切换内核前的对话只读归档，并用这段历史开新对话 |
| [appearance.md](appearance.md) | 语言与主题 |

## 记录

每条用例记通过、失败或阻塞，并写一句看到的现象。失败时记下对话标题和状态栏文字，不要附带密钥。

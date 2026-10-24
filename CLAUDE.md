# Weft

Web 编码工作台，内核是 Pi Durable（`@earendil-works/pi-durable` 的 Harness，`src/kernel/`），目标运行环境是内网 Windows + Node 22。项目规则、核心模型和文档索引见 `AGENTS.md`。审 PR 时检查有没有新的自写运行时、调度或检查点。

- 仓库：`lawrencewzen/weft`，基准分支 `main`，PR 用 squash 合并。
- 入口 `server.mjs`；代码在 `src/`（core / llm / store / tools）、`public/`（前端）；插件在 `plugins/`、`examples/plugins/`。
- 验证：`npm run check`（语法检查）、`npm test`（`tests/unit`）；e2e 用 Playwright（`tests/playwright.config.mjs`）。
- 新增 `.mjs` 入口文件时，记得加进 `package.json` 的 `check` 脚本。

## 开发方式：通过 grokbot 调度

开发需求（新功能、修 bug、重构）不要自己直接改代码，用 `/grokbot` skill：我负责理解需求、读代码、拆任务、写任务单、审 PR、合并；小克负责派 Cursor cloud agent 写代码、跑测试、开 PR。完整流程、任务单模板和通道用法都写在 skill 里。

- 动手前先读台账 `~/.claude/grokbot-tasks.md`，接上之前的进度。
- 读代码、复跑测试只在 `~/.cache/claude-review/lawrencewzen/weft` 里做，不碰本工作副本。
- 发给小克的任务单要写明本项目的验证要求：`npm run check`、`npm test`；默认用测试结果证明，确实需要看画面时另行说明。
- 上线部署、不可逆的数据操作、对外发布、明显花钱的事，先问用户。

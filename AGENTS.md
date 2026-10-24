# 协作规则（Weft）

Weft 是基于 Pi Durable（`@earendil-works/pi-durable`，作为库嵌入）的 Web 编码工作台，fork 自 xiaomoBoy/pi-durable-assistant（MIT）。目标运行环境：内网 Windows，Node 22。

## 内核（硬性规定）
- 运行时内核必须是 Pi Durable（`@earendil-works/pi-durable` 的 Harness）：对话、任务、检查点、断点续跑、子 Agent、中止、压缩都用它提供的机制，模型调用走 `@earendil-works/pi-ai`。
- 禁止自写编排器、任务调度或检查点机制来替代 Pi Durable 已有的能力。Pi Durable 做不到、需要绕开或改换内核的，必须先停下来报告，经用户同意后才能动。
- 现状（2026-10-20，T12-2）：默认运行时已经是 Pi Durable Harness（`src/kernel/`）。对话状态只在 Harness 里，应用库只留最近一次提交的 id。卡住和重试只用它的 `stream.timeoutMs` 和 `retry`。没有 harness id 的旧对话不出现在列表里。
- 改动架构（内核、存储、模型调用层）属于需用户确认的决定；`docs/ARCHITECTURE.md` 必须如实反映现状，不能为了贴合代码就悄悄改掉原定架构。

## 核心模型
- **工作区（Workspace）** > **对话（Conversation）** > **主 Agent（Main Agent）** > **子 Agent（Sub Agents）**。
- 每个对话默认只有一个主 Agent：理解需求、拆任务、管理子 Agent、汇总结果；简单对话不派子 Agent。主 Agent 没有角色，系统提示词为空。
- 子 Agent 是主 Agent 用 `delegate` / `subagent` 在某个对话里生成的独立实例，只属于该对话。没有固定角色模板。
- 需求支持断点续跑、自动继续、状态监控、多 Agent 并行。多 Agent 协作由主 Agent 用子 Agent 派活，宿主不轮换 Agent。

## 文档
- 计划与设计：`docs/PLAN.md`、`docs/ARCHITECTURE.md`、`design/`。接口契约以测试仓库的 `docs/API_CONTRACT.md` 为准。
- Pi API 以 `node_modules/@earendil-works/*/dist/**/*.d.ts` 和 `node_modules/@earendil-works/pi-durable/README.md` 为准，不凭记忆编 API。

## 分工
- **编排者（总指挥）**：拆分任务、合并分支、最终亲手验收（默认用测试结果证明，确实需要看画面时另行说明），只有编排者往 `main` 合并。
- **Coder**：在 `backend`（或编排者指定的功能分支）上开发，可以提交并推送自己的分支，**禁止提交或推送 `main`**。
- **测试**：单元测试、`tests/e2e/` 验收用例的编写和执行都交给 cloud agent。可以由写代码的同一个 agent 在同一个 PR 里完成，也可以另派 agent 单独验证，由编排者按任务决定。
- **Auditor**：独立 Agent，只做代码审计与报告，不直接改代码。
- **设计**：Antigravity（`--model gemini-3.8-flash-high`）出设计稿；设计稿和架构由用户确认。

## Grok 登录

模型调用优先复用本机 Grok Build 会话 `~/.grok/auth.json`（与 `grok login` 相同的 access / refresh）。设置 → 模型里的「用 Grok 登录」走 `grok login --device-auth` 同款设备码：页面显示网址和用户码，服务端轮询完成后把令牌写回该文件（0600）。会话有效时请求发往订阅代理 `https://cli-chat-proxy.grok.com/v1/responses`，模型默认 `grok-build`，不走按量的 `api.x.ai`。API Key 仍是没有会话时的回退，会话有效时密钥框收起。退出登录只删除 OIDC 会话，保留 `xai::api_key`。不要把 `auth.json` 提交进仓库。只有显式要求时才走本地剧本：`WEFT_LLM=faux`、`LLM_API=faux` 或设置了 `WEFT_FAUX_SCRIPT`，界面要标出「演示模型」。未显式要求时，有 Grok 会话、API Key 或 Base URL 才调用真实模型；都没有则拒绝回复，不能回落到剧本。

## 验证
- `npm run check`：语法检查。
- `npm test`：`tests/unit` 单元测试。Linux CI 的 `test` job 和 Windows 的 `kernel-unit` 跑这一套。
- `npm run test:e2e`：Playwright 自动化子集（`tests/e2e/*.spec.mjs`），配置 `tests/playwright.config.mjs`。先装浏览器：`npx playwright install chromium`；CI 用 `npx playwright install --with-deps chromium`。用例自己起服务，走演示模型（`WEFT_LLM=faux`）。系统 Chrome 可设 `WEFT_CHROME`（例如 `/usr/bin/google-chrome`）。默认用测试结果证明，确实需要看画面时另行说明。Linux CI 的 `e2e` job 跑这一套；Windows job 不跑 e2e。手工验收清单仍是 `tests/e2e/*.md`。

## 约束
- 只改任务范围内的文件；新增依赖需说明理由。保持原生 ESM。
- 不读取、不打印 `.env` 和密钥；不访问未授权的远程服务器。
- 交付前运行 `npm run check`、`npm test` 及适用的本地验证；交付时列出改了哪些文件、怎么验证的、哪些没验证。
- UI 风格：简洁、低饱和；效果图一律 4K。


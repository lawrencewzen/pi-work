# Weft 测试方案（TDD，先于实现）

## 范围
- 单元测试（`node:test`）：纯函数与编排器核心，见 `tests/unit/`。
- 功能验收：`tests/e2e/*.md`。一个功能一个文件，含步骤和预期。QA 在真实服务器上手工执行，全部通过才接受。规则见 `tests/e2e/README.md`。新功能 PR 必须同时改这里的对应用例。
- `tests/e2e/*.spec.mjs` 是旧的 Playwright 子集，不代替手工清单。
- 契约：`docs/API_CONTRACT.md`（模块路径、REST、SSE、环境变量、faux 脚本、data-testid）。实现必须按此对齐，改契约需同步改测试。
- 不在范围：视觉像素比对、Windows 专属行为（后续补）。真实模型的手工验收走 `tests/e2e/*.md`，不在 Playwright 子集里。

## 用例
| # | 层 | 用例 | 文件 |
|---|---|---|---|
| U1 | 单元 | 路径省略：短路径不变、`src/…/foo.ts`、`\` 归一、超长文件名不超 max | unit/paths |
| U2 | 单元 | 沙箱：允许内部/新文件；拒绝 `../`、外部绝对路径、NUL、符号链接（文件/目录）越界 → `E_SANDBOX` | unit/paths |
| U3 | 单元 | diff 统计：新建/删除/修改/相同/仅末尾换行/CRLF；unified diff 头与 hunk | unit/diff |
| U4 | 单元 | 重试策略：可重试/不可重试错误、次数上限、指数退避封顶；自动续跑决策 continue/wait/give_up | unit/retry |
| U5 | 单元 | SSE：格式、缺 id、对象内换行单行、多行字符串、往返含中文 | unit/sse |
| U6 | 单元 | 内置工具清单 `TOOLS`；主 Agent 配置（空 instructions、全部工具与启用技能） | unit/config、unit/kernel-agent-config |
| U7 | 单元 | 内核：两个会话并行且工作区隔离；暂停一个不影响另一个；stop 终态；断流重试后完成 | unit/kernel-control、unit/kernel-tools |
| U-md | 单元 | Markdown：表格、分隔线、引用、嵌套列表、代码块、链接、任务列表；`<script>` / onerror / javascript: 被清掉；`/vendor/` 只提供 marked 与 DOMPurify | unit/markdown |
| E1 | E2E | 新建工作区+会话，发消息，Markdown（h2/strong/代码块/表格/分隔线/引用）渲染，XSS 节点不进 DOM，状态点 done；助手回复上方模型标签为实际模型名、不以「·」开头 | e2e/ui |
| E2 | E2E | 工具行折叠：路径含 `…`、`+3 −0`，点击展开详情 | e2e/ui |
| E3 | E2E | 点改动文件 → diff；打开 md 编辑器编辑保存 → 落盘，刷新仍在 | e2e/ui |
| E4 | E2E | 刷新后工作区、会话、消息、工具行、状态保持 | e2e/ui |
| E5 | E2E | 文件 API 越界 → 403 `E_SANDBOX` | e2e/ui |
| E6 | E2E | 暂停期间不推进、继续后完成；停止后保持 stopped | e2e/control |
| E7 | E2E | 两个工作区两个 Agent 同时 running，总耗时显著小于串行 | e2e/control |
| E8 | E2E | 断流桩 → 自动重试，续跑计数 ≥1，最终写入正确 | e2e/control |
| E9 | E2E | 执行中 `kill -9`，同数据目录重启 → 恢复中 → 完成；bash 副作用和写文件不重复，工具行不重复 | e2e/recovery |
| E10 | E2E | 无用量时上下文芯片为 `—`；模型上报 `total_tokens` 后显示 `16.4k / 200k`（窗口来自 `LLM_CONTEXT_WINDOW`），刷新仍在 | e2e/composer-chips |
| E11 | E2E | 模型未配置时芯片为 `Agent`；跑完无 usage 的回合后上下文仍为 `—` | e2e/composer-chips |
| E12 | E2E | 芯片显示设置里的默认模型；菜单切换对话模型/默认绑定，文案与 `GET /conversations/:cid` 一致，刷新保持 | e2e/composer-chips |
| E13 | E2E | 无对话时点击芯片只提示、不打开菜单；运行中点击提示忙碌且不切换 | e2e/composer-chips |
| M1 | 手工 | 未登录且未配置模型时发送：对话和 toast 都是「未连接模型…」，状态失败，没有助手回复；登录后得到真实回复；`LLM_API=faux` 或 `WEFT_FAUX_SCRIPT` 时顶栏和 Agent 芯片旁显示「演示模型」 | e2e/model-connection |

## 判定
全部单元测试通过，并且 `tests/e2e/*.md` 由 QA 在真实服务器上手工通过，才算交付。`*.spec.mjs` 失败仍须修，但不能代替手工清单。测试 Agent 只改测试/契约，不改功能代码。

## 运行
```bash
# 仓库根目录，Node ≥ 22
node --test tests/unit/*.test.mjs
npx playwright install chromium
npx playwright test -c tests/playwright.config.mjs
```

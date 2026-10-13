# pi-work 测试方案（TDD，先于实现）

## 范围
- 单元测试（`node:test`）：纯函数与编排器核心，见 `tests/unit/`。
- 端到端（Playwright）：真实启动 `server.mjs`（faux 模型），浏览器操作三栏界面，见 `tests/e2e/`。
- 契约：`docs/API_CONTRACT.md`（模块路径、REST、SSE、环境变量、faux 脚本、data-testid）。实现必须按此对齐，改契约需同步改测试。
- 不在范围：真实模型全流程（由总控验收阶段做）、视觉像素比对、Windows 专属行为（后续补）。

## 用例
| # | 层 | 用例 | 文件 |
|---|---|---|---|
| U1 | 单元 | 路径省略：短路径不变、`src/…/foo.ts`、`\` 归一、超长文件名不超 max | unit/paths |
| U2 | 单元 | 沙箱：允许内部/新文件；拒绝 `../`、外部绝对路径、NUL、符号链接（文件/目录）越界 → `E_SANDBOX` | unit/paths |
| U3 | 单元 | diff 统计：新建/删除/修改/相同/仅末尾换行/CRLF；unified diff 头与 hunk | unit/diff |
| U4 | 单元 | 重试策略：可重试/不可重试错误、次数上限、指数退避封顶；自动续跑决策 continue/wait/give_up | unit/retry |
| U5 | 单元 | SSE：格式、缺 id、对象内换行单行、多行字符串、往返含中文 | unit/sse |
| U6 | 单元 | Role/Pipeline 校验：合法、默认工具、非法 id/空提示词/未知工具、空步骤/未知角色/超 20 步 | unit/config |
| U7 | 单元 | 编排器：两个会话真并行且消息与工作区隔离；暂停一个不影响另一个；stop 终态；断流重试后完成 | unit/orchestrator |
| E1 | E2E | 新建工作区+会话，发消息，Markdown（h2/strong/代码块）渲染，状态点 done | e2e/ui |
| E2 | E2E | 工具行折叠：路径含 `…`、`+3 −0`，点击展开详情 | e2e/ui |
| E3 | E2E | 点改动文件 → diff；打开 md 编辑器编辑保存 → 落盘，刷新仍在 | e2e/ui |
| E4 | E2E | 刷新后工作区、会话、消息、工具行、状态保持 | e2e/ui |
| E5 | E2E | 文件 API 越界 → 403 `E_SANDBOX` | e2e/ui |
| E6 | E2E | 暂停期间不推进、继续后完成；停止后保持 stopped | e2e/control |
| E7 | E2E | 两个工作区两个 Agent 同时 running，总耗时显著小于串行 | e2e/control |
| E8 | E2E | 断流桩 → 自动重试，续跑计数 ≥1，最终写入正确 | e2e/control |
| E9 | E2E | 执行中 `kill -9`，同数据目录重启 → 恢复中 → 完成；bash 副作用和写文件不重复，工具行不重复 | e2e/recovery |

## 判定
全部单元 + E2E 通过才算交付；失败打回写代码 Agent。测试 Agent 只改测试/契约，不改功能代码。

## 运行
```bash
# 仓库根目录，Node ≥ 22
node --test tests/unit/
npx playwright install chromium
npx playwright test -c tests/playwright.config.mjs
```

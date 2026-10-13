# pi-work

基于 [Pi Durable](https://github.com/earendil-works/pi) 的网页版多 Agent 编码工作台：断点恢复、自动续跑、多角色并行、流水线编排。

> 本项目 fork 自 [xiaomoBoy/pi-durable-assistant](https://github.com/xiaomoBoy/pi-durable-assistant)（MIT），感谢原作者。原 README 见 [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)。

**状态：设计阶段**，功能开发尚未开始。

- 方案：[docs/PLAN.md](docs/PLAN.md)
- 架构：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- 界面稿：[design/mockup.html](design/mockup.html)

![mockup](design/mockup.png)

## 目标
- 三栏界面：工作区与会话、对话（Markdown + 折叠工具行）、Diff / 文件 / Markdown 编辑器
- 多个 Agent 并行，角色（提示词 / 工具 / 模型）和流水线（如 测试 → 编码 → 审计）可配置
- 监控：卡住检测、模型中断自动续跑与重试，SQLite 检查点
- 工作区内的 read / write / edit / grep / bash 工具，自动记录 diff
- 任意 OpenAI 兼容模型接口（xAI、DeepSeek、内网）
- Windows 内网可直接 `node server.mjs` 运行，无需 Docker

## License
MIT，保留原作者版权声明。

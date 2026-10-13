# pi-work 架构

单个 Node 22 进程，浏览器通过 REST + SSE 通信，Pi Durable Harness 负责持久化执行，SQLite 保存检查点。

```mermaid
flowchart LR
  subgraph Browser["浏览器（三栏 UI）"]
    L[左栏：工作区 / 会话 / Agent 状态]
    C[中栏：对话 + 工具行 + 状态条]
    R[右栏：Diff / 文件 / Markdown 编辑器]
  end

  subgraph Node["Node 22 单进程（server.mjs）"]
    API[REST API]
    SSE[SSE 事件流]
    ORC[编排器 Orchestrator<br/>角色 Roles · 流水线 Pipelines · 并发]
    MON[监控 Monitor<br/>卡住检测 · 自动续跑 · 重试]
    H[Pi Durable Harness<br/>Tasks · 会话 · 检查点]
    T[工作区工具<br/>read / write / edit / grep / bash]
    D[Diff 记录器]
    DB[(SQLite<br/>检查点 · 会话 · diff)]
  end

  WS[(工作区目录)]
  LLM[OpenAI 兼容模型接口<br/>xAI / DeepSeek / 内网]

  L & C & R -->|HTTP| API
  SSE -->|事件| Browser
  API --> ORC
  ORC -->|启动/暂停/停止 Agent| H
  MON -->|观察进度 / 触发续跑| H
  H --> DB
  H -->|调用模型| LLM
  H -->|工具调用| T
  T --> WS
  T --> D --> DB
  H -->|状态/消息/工具事件| SSE
```

## 关键概念
- **Agent** = 一个 Durable Task（角色 + 会话 + 检查点），可多个并行。
- **Role**：系统提示词、工具白名单、模型。
- **Pipeline**：角色有序组合，带交接产物和失败回退。
- **Monitor**：每个 Agent 记录最后进展时间；超时或流中断 → 从最近检查点续跑，计数显示在状态条（↻ N）。
- **工具沙箱**：所有路径解析后必须位于工作区根目录内；写操作生成 diff 并入库，供右栏展示。

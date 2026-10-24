# 内核精简方案

> 2026-10-20 用户拍板：第 3 节 6 点全部同意（去掉暂停；去掉工具兜底策略；流水线改为子 Agent 派活；去掉旧对话归档；忙时发消息默认插话；删除无用代码）。

目标：Weft 只做三件事：**工作区与文件**、**模型来源与角色配置**、**把 Pi Durable 的对话原样展示给浏览器**。其余运行时行为都交给 Pi Durable，自己写的外壳能删就删。

基准：main `09b9cb5`，`@earendil-works/pi-durable` 1.1.0。

## 1. 现状：外壳有多厚

`src/kernel/` 共约 3,800 行，再加上 `server.mjs` 里的对话接口和应用库里的 5 张表。真正属于"把 Pi Durable 接进来"的代码不到三分之一，其余都是我们在它外面又包的一层：

| 模块 | 行数 | 做什么 | Pi Durable 有没有现成的 |
|---|---|---|---|
| `control.mjs` | 829 | 暂停；卡住看门狗（120 秒没动静就发"继续"，最多 10 次后判失败）；改写错误信息，让 pi-ai 的重试分类和旧编排器一致；每步工具调用上限 15 次；同参数连续调用拦截；同一路径反复查看拦截；"请直接回答"催促；为"结束本步"伪造一条助手消息 | 卡住：`settings.stream.timeoutMs`。重试：`settings.retry`。其余几项都是给弱模型兜底的产品策略，不是运行时必需 |
| `events.mjs` | 383 | 把 `watchEvents` 改名成旧 SSE 事件，写进应用库的 `events` 表，断线后补发、对齐快照，再合成一个状态 | `viewState()` / `watch()` / `watchEvents()` 本身就是给界面用的，断线重连直接拿当前视图 |
| `conversations.mjs` | 625 | UUID 和 Harness id 对照、`hostMark` 状态机（paused / stopped / failed / recovering 互相压制）、事件串行队列、启动时逐个"结算"状态、发送前先查忙不忙 | 状态都在 `pi.live`、`pi.inbox` 和条目里；对话忙时 Pi Durable 支持"插话"（steer）和"排队"（follow-up） |
| `roles.mjs` | 471 | 角色配置；**流水线**：一轮跑完后由宿主换角色、再提交一条交接消息，相当于一个小编排器 | 角色就是 `configure({ model, tools, instructions })`；多角色协作可以用子 Agent |
| `subagents.mjs` | 603 | 前台和后台子 Agent、Roster 文档、暂停同步、列表、读子对话 | README 第 "Abort and Subagents" 节和示例 22、23 就是这两种写法，所有权、中止、重启后复用都已内建 |
| `faux-script.mjs` + 演示部分 | 约 400 | 演示模型脚本回放；`DRAIN` 在每段文字后自动塞"继续"；`PLAN`、`HOLD`、`RECORD` 等测试开关 | pi-ai 自带 faux provider，`setResponses` 就能排脚本 |
| `archive.mjs` | 121 | 切内核前的旧对话只读展示、"用这段历史开新对话" | 无，需要我们决定还要不要 |
| `usage.mjs` / `plugins.mjs` / `tools.mjs` / `models.mjs` | 约 820 | 上下文用量芯片、插件工具注册、六个工作区工具加沙箱、模型来源路由 | 这部分基本是必要的薄适配，保留 |

应用库（`src/store/sqlite.mjs`，698 行）里，`messages`、`tool_calls` 只给旧对话归档用；`events` 是上面那套 SSE 转录；`changes` 记录写文件的 diff；`pipelines` 是流水线。对话正文其实已经全部在 Harness 里，同一份状态存了两遍。

另外还有完全没人引用的旧代码：`lib/` 下 8 个文件（约 1,900 行）、`legacy/` 目录，以及上游项目留下的文档（`UPSTREAM_README*`、`WECHAT.md`、`KNOWLEDGE_FEATURE_REQUIREMENTS.md`、`V3_PLAN.md`）。

## 2. 精简后的样子

```
浏览器 ──HTTP──▶ server.mjs ──▶ Pi Durable Harness（唯一的对话状态）
                    │                 ├─ 工作区工具扩展（沙箱 + 在结果 details 里带 diff）
                    │                 ├─ 子 Agent 扩展（照官方示例 22 / 23）
                    │                 └─ 插件工具扩展
                    └─▶ 应用库：工作区、设置（模型来源 / Git 连接）、角色、对话索引
```

- **对话状态只有一份**：在 Harness 里。应用库只留一张很薄的对话索引表（UUID、Harness id、所属工作区、标题、角色），用来按工作区列出对话。
- **实时推送直接转发**：每个对话打开一个 `watchEvents`，原样转发给浏览器（SSE）；断线重连时先发当前 snapshot，不再补发历史事件。`events` 表、改名映射、补缺口逻辑全部删除。
- **状态直接读**：运行中看 `pi.live` 里有没有 run，失败看最后一条助手消息的 `stopReason`，已停止看是否被中止。删除 `hostMark` 状态机。
- **对话忙时也能发消息**：默认用"插话"（steer），模型在下一个工具回合就能读到。这正好就是原型里输入框的提示"补充说明，Agent 会在下一步读到"。不再返回 409。
- **卡住和重试交给 Pi Durable**：设置 `stream.timeoutMs`（比如 120 秒没收到数据就报错）和 `retry.maxRetries`，然后照常重试。删除看门狗、自动"继续"和改写错误信息的那段。
- **只保留"停止"**：用 `conversation.abort()`。去掉暂停（Pi Durable 没有暂停，我们是靠在工具结果上做手脚模拟出来的）。原型的运行条上本来也只有"停止"。
- **子 Agent 照官方示例写**：前台子 Agent 就是一个工具，返回子对话的答案；后台子 Agent 用后台锚点任务，结果以排队消息的形式送回主对话。界面通过工具调用的 `details` 找到子对话。
- **流水线改成子 Agent**：不再由宿主按"规划 → 编码 → 测试 → 审计"轮流切换角色。主 Agent 用子 Agent 工具，把活派给对应角色。角色仍然可以在设置里配置模型、工具和提示词。
- **diff 跟着工具结果走**：`write` 和 `edit` 把增删行数和 diff 放进工具结果的 `details`；右栏的"变更"直接从对话条目里汇总。删除 `changes` 表。
- **演示模型保留最小一套**：fixture 改成"一条消息里同时带文字和工具调用"，Harness 本来就会自己跑完工具回合，不再需要 `DRAIN` 塞"继续"。

预计 `src/kernel/` 从约 3,800 行降到约 1,000 行，应用库减掉 5 张表，`server.mjs` 的对话接口部分也会明显变短。

## 3. 需要你拍板的点

1. **暂停**：去掉，只留"停止"。
2. **工具调用的兜底策略**（每步上限、重复调用拦截、重复翻找拦截、"请直接回答"催促）：全部去掉，靠模型自己。真遇到某个模型死循环再说，到时候也只加一个最简单的总次数上限。
3. **流水线**：去掉"宿主轮流切换角色"的做法，改成主 Agent 用子 Agent 派活。设置里的"流程"页随之去掉或改成"子 Agent 模板"。
4. **旧对话归档**（10-15 切内核之前的对话）：删掉这套只读模式。需要的话我先把这些旧对话导出成 Markdown 文件留底。
5. **对话忙时发消息**：默认"插话"。如果你更想要"等这一轮做完再处理"，就改成"排队"。
6. **删掉无用代码**：`lib/`、`legacy/`、上游项目留下的文档。

## 4. 不在这次范围

- Grok 订阅登录（`grok-auth.mjs`）、模型来源、Git 连接：它们是模型或工作区的接入层，不是内核外壳，这次不动。
- 界面：前端要从"旧 SSE 事件"改成直接吃 Pi Durable 的事件，会和这次一起改，但样式沿用 #57。

## 5. 做法

在新分支上一次性重写对话这一层，不做新旧并存：

1. 删除无用代码和旧对话归档。
2. 重写 `conversations.mjs`：对话索引、创建、发送（steer）、停止、事件直推、状态直读。
3. 用官方示例改写子 Agent；流水线改成子 Agent 派活。
4. 工具 diff 改放进 `details`，删掉 `changes`、`events`、`messages`、`tool_calls`、`pipelines` 表（升级时直接删表，不迁移数据）。
5. 设置 `stream.timeoutMs` 和 `retry`，删除 `control.mjs`。
6. 前端改成吃 Pi Durable 事件；e2e 按新行为改写；`npm test` 和 Windows 上的 `kernel-unit` 必须全过。

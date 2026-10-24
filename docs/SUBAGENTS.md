# Sub-agents

Sub-agents follow Pi Durable's Abort and Subagents section and examples 22 (foreground) and 23 (background). The Harness owns the child conversation, its submission, abort, and restart reuse. Weft configures a self-contained child from the task text only (empty instructions, no role template, no skills) and reads what the tools already committed.

A conversation has one main agent (`agents[0]`, `name: 'Agent'`, empty instructions). Extra agents are sub-agent instances spawned with `delegate` / `subagent`, each in its own Harness conversation. The host does not rotate agents in the same chat. The child cannot see the parent conversation or the parent's instructions; everything it needs goes in `task` / `message`.

`GET /api/conversations/:cid` returns the main agent chip (`agents` without `mode`) first. Real sub-agent instances are appended after that chip.

## Tools

The main agent has dispatch tools plus `skill`. Children are configured with this extension removed, so they cannot spawn further sub-agents or load skills.

- **`delegate`** (example 22, `replay: 'safe'`): parameters `{ task }`. Creates a child owned by `{ kind: 'task', taskId: api.taskId }`, reuses it on rerun with `tx.scanConversations({ ownerTaskId })`, publishes `api.details({ conversationId, name })` (`name` is the first line of `task`, one line, at most 30 characters), submits with `requestId` `subagent:${api.taskId}`, and returns the child's answer. The child is configured with `instructions: ''`, the parent's workspace and plugin tools (no `delegate` / `subagent` / `skill`, and no skills catalog), the copied parent model, and the parent's `cwd`. Aborting only that child returns `[subagent <name> was stopped by the user]` to the caller so the parent turn continues; aborting the caller itself still throws `AbortError`.
- **`subagent`** (example 23, `replay: 'unsafe'`): `action` is `spawn` / `send` / `wait` / `stop` / `list`. Spawn parameters are `{ name, message }`. Each named child is owned by a background anchor task, so the parent's Esc and idle waits do not stop it. A background reporter delivers the message and posts the answer back to the main conversation as a follow-up. Request IDs keep a restart from sending a message or a report twice. The name → conversation map is the example 23 document, not a separate roster. `[subagent <name> answered, no reply needed]` uses the spawn `name`.

`POST /api/conversations/:cid/stop` calls `conversation.abort(context, { background: true })`, which also stops background sub-agents.

## HTTP

```bash
curl -sS http://127.0.0.1:3000/api/conversations/<cid>
# → agents: main Agent chip, then
#   {id, name, status, step, totalSteps, toolCalls, lastText, mode,
#    brief?, startedAt?, lastActivityAt?, endedAt?, currentAction?}
#   id is <cid>:sub:<child conversation id>
#   mode is foreground | background
#   brief is the first user message (the dispatched task)
#   startedAt / lastActivityAt / endedAt are pi-ai timestamps in ms
#   endedAt only when done / stopped / failed; currentAction only while running
#   missing timestamps or text omit that field

curl -sS http://127.0.0.1:3000/api/conversations/<cid>/agents/<aid>/messages
# → {id, name, status, mode, messages}

curl -sS -X POST http://127.0.0.1:3000/api/conversations/<cid>/agents/<aid>/messages \
  -H 'content-type: application/json' -d '{"text":"改用 pnpm"}'
# → 200 {ok:true}  子 Agent 须 running；空文本 400，未知 404，非运行 409

curl -sS -X POST http://127.0.0.1:3000/api/conversations/<cid>/agents/<aid>/stop
# → 200 {status:stopped}  只停这一个子对话，主 Agent 和其他子 Agent 继续

curl -sN -H 'Accept: text/event-stream' \
  http://127.0.0.1:3000/api/conversations/<cid>/events
# event: agent   data: same fields as the chip, including mode and the optional
#   brief / startedAt / lastActivityAt / endedAt / currentAction fields
```

`POST .../agents/:aid/messages` 把用户的话 `steer` 进该子对话，并给主对话写一条 `app.weft.user-to-subagent`（带 model 的 write，不新开一轮）。主对话 GET 的 `messages` 把它映射成 `role:'note'`，文案是「你对 <名字> 说：<text>」。子 Agent 自己的记录里仍是普通 user 消息。子 Agent 只有一层，上级一律是主对话。

The list is rebuilt from the Harness after a process restart: tool-result `details.conversationId`, the ownership index, the background name document, and each child's `viewState`. Child transcript events stay on the child conversation; the parent SSE does not mix in `message.delta` / `tool.*` from the child.

## Demo (faux)

From the repo root, Node 22:

```bash
export PATH=$HOME/.local/node22/bin:$PATH
PORT=3000 WEFT_LLM=faux WEFT_FAUX_SCRIPT=examples/faux/subagents.json node server.mjs
```

Create a workspace and a conversation, then send a message that causes the main agent to call `delegate` / `subagent`.

`start()` does not overwrite a title the client already set. The first user message becomes the title only when the current title is empty or `New conversation`.

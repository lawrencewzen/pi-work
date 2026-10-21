# Sub-agents

Sub-agents follow Pi Durable's Abort and Subagents section and examples 22 (foreground) and 23 (background). The Harness owns the child conversation, its submission, abort, and restart reuse. pi-work only configures a child from a role template and reads what the tools already committed.

A conversation has one main agent (the conversation role, or `default`). Extra agents are sub-agent instances spawned with `delegate` / `subagent`, each in its own Harness conversation. There is no host-side pipeline that rotates roles in the same chat.

A conversation still has a role chip on `GET /api/conversations/:cid` (`agents` without `mode`). Real sub-agent instances are appended after that chip.

## Tools

The main agent has two tools. Children are configured with this extension removed, so they cannot spawn further sub-agents.

- **`delegate`** (example 22, `replay: 'safe'`): parameters `{ agent, task }`. Creates a child owned by `{ kind: 'task', taskId: api.taskId }`, reuses it on rerun with `tx.scanConversations({ ownerTaskId })`, publishes `api.details({ conversationId, roleId, name })`, submits with `requestId` `subagent:${api.taskId}`, and returns the child's answer. The tool `description` lists available roles (`id`, name, and the role's "when to use" description) so the main agent can pick one.
- **`subagent`** (example 23, `replay: 'unsafe'`): `action` is `spawn` / `send` / `wait` / `stop` / `list`. Each named child is owned by a background anchor task, so the parent's Esc and idle waits do not stop it. A background reporter delivers the message and posts the answer back to the main conversation as a follow-up. Request IDs keep a restart from sending a message or a report twice. The name → conversation map is the example 23 document, not a separate roster.

`POST /api/conversations/:cid/stop` calls `conversation.abort(context, { background: true })`, which also stops background sub-agents.

## HTTP

```bash
curl -sS http://127.0.0.1:3000/api/conversations/<cid>
# → agents: role chip, then
#   {id, roleId, name, status, step, totalSteps, toolCalls, lastText, mode}
#   id is <cid>:sub:<child conversation id>
#   mode is foreground | background

curl -sS http://127.0.0.1:3000/api/conversations/<cid>/agents/<aid>/messages
# → {id, roleId, name, status, mode, messages}

curl -sN -H 'Accept: text/event-stream' \
  http://127.0.0.1:3000/api/conversations/<cid>/events
# event: agent   data: same fields as the chip, including mode
```

The list is rebuilt from the Harness after a process restart: tool-result `details.conversationId`, the ownership index, the background name document, and each child's `viewState`. Child transcript events stay on the child conversation; the parent SSE does not mix in `message.delta` / `tool.*` from the child.

## Demo (faux)

From the repo root, Node 22:

```bash
export PATH=$HOME/.local/node22/bin:$PATH
PORT=3000 PI_WORK_LLM=faux PI_WORK_FAUX_SCRIPT=examples/faux/subagents.json node server.mjs
```

Startup seeds roles from `roles/*.json` when that id is not already stored. Create a workspace and a conversation, then send a message that causes the main agent to call `delegate` / `subagent`.

`start()` does not overwrite a title the client already set. The first user message becomes the title only when the current title is empty or `New conversation`.

# Sub-agents and the demo pipeline

Pipeline steps are exposed as sub-agents on each conversation. A conversation without a pipeline has a single agent (the conversation role, or `default`).

## Demo (faux, watchable)

From the repo root, Node 22:

```bash
export PATH=$HOME/.local/node22/bin:$PATH
PORT=3000 PI_WORK_LLM=faux PI_WORK_FAUX_SCRIPT=examples/faux/subagents.json node server.mjs
```

Startup loads `roles/*.json` and `examples/pipelines/*.json` (pipeline id `demo`) into the store if they are not already present.

Create a workspace and a conversation that uses that pipeline, then send a message:

```bash
# workspace path must already exist
curl -sS -X POST http://127.0.0.1:3000/api/workspaces \
  -H 'content-type: application/json' \
  -d '{"name":"demo-ws","path":"/tmp/pi-work-demo"}'

# use the returned workspace id
curl -sS -X POST http://127.0.0.1:3000/api/workspaces/<wid>/conversations \
  -H 'content-type: application/json' \
  -d '{"title":"Pipeline demo","pipelineId":"demo"}'

# use the returned conversation id
curl -sS -X POST http://127.0.0.1:3000/api/conversations/<cid>/messages \
  -H 'content-type: application/json' \
  -d '{"text":"Add a hello helper and cover it."}'
```

Watch progress:

```bash
curl -sS http://127.0.0.1:3000/api/conversations/<cid>
# → agents: [{id, roleId, name, status, step, totalSteps, toolCalls, lastText}, ...]
# first entry is the conversation's role/default agent (here: coder); then tester, auditor

curl -sN -H 'Accept: text/event-stream' \
  http://127.0.0.1:3000/api/conversations/<cid>/events
# event: agent   data: {id, roleId, name, status, step, totalSteps, lastText}
```

`examples/faux/subagents.json` inserts short delays between turns so the three steps are visible in the event stream. `{ "end": true }` ends the current pipeline agent and hands off to the next (same turn-union shape as `tests/fixtures/*.json`, plus this explicit end).

Reconnect with `Last-Event-ID` to replay persisted `agent` events. `GET /api/conversations/:cid` rebuilds `agents` from stored conversation + pipeline + messages, so the list survives a process restart.

## Title

`start()` does not overwrite a title the client already set. The first user message becomes the title only when the current title is empty or `New conversation`.

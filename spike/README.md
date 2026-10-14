# Pi Durable kernel spike

This branch is a feasibility prototype. It does not replace `server.mjs`.

```bash
node spike/server-durable.mjs
node spike/smoke.mjs
```

`spike/smoke.mjs` covers storage reopen, an OpenAI-compatible base URL, the Grok subscription-proxy adapter (custom headers and a 401 refresh), workspace tools in a per-conversation directory, foreground and background subagents from role templates, abort, and killing the process mid-subagent. The redacted run log is `spike/logs/smoke.log`.

Windows coverage is the `spike pi-durable windows` GitHub Actions workflow on this branch. The existing `bash` tool in `src/tools/workspace.mjs` launches `/bin/sh`, so the spike uses `cmd.exe` for that one tool when `process.platform === 'win32'`.

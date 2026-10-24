import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ROOT, load } from './_root.mjs';

const {
  validateGitUrl,
  validateBranch,
  stripGitUrlCredentials,
  prepareGitClone,
  redactGitOutput,
  classifyCloneFailure,
  cloneGitRepo,
} = await load('src/core/git-import.mjs');

const execFileP = promisify(execFile);

test('validateGitUrl allows https, ssh, and git@, rejects file and plain http', () => {
  assert.equal(validateGitUrl('https://github.com/a/b.git'), true);
  assert.equal(validateGitUrl('ssh://git@github.com/a/b.git'), true);
  assert.equal(validateGitUrl('git@github.com:a/b.git'), true);
  assert.equal(validateGitUrl('file:///tmp/repo.git'), false);
  assert.equal(validateGitUrl('git://github.com/a/b.git'), false);
  assert.equal(validateGitUrl('http://gitlab.corp.local/group/repo.git'), false);
  assert.equal(validateGitUrl('http://-bad.example/a.git', { httpHosts: ['-bad.example'] }), false);
  assert.equal(validateBranch('-main'), false);
  assert.equal(validateBranch('feature/one'), true);
});

test('http:// is allowed only for WEFT_GIT_HTTP_HOSTS', () => {
  const url = 'http://gitlab.corp.local/group/repo.git';
  assert.equal(validateGitUrl(url, { httpHosts: ['gitlab.corp.local'] }), true);
  assert.equal(validateGitUrl('http://other.corp.local/group/repo.git', { httpHosts: ['gitlab.corp.local'] }), false);
  assert.equal(validateGitUrl('http://GitLab.Corp.Local/group/repo.git', {
    env: { WEFT_GIT_HTTP_HOSTS: ' gitlab.corp.local , other.example ' },
  }), true);
  assert.equal(validateGitUrl('http://127.0.0.1:9/repo.git', { httpHosts: ['127.0.0.1'] }), true);
  assert.equal(validateGitUrl('http://u:p@gitlab.corp.local/a.git', { httpHosts: ['gitlab.corp.local'] }), true);
  assert.equal(validateGitUrl(url, { env: { WEFT_GIT_HTTP_HOSTS: '' } }), false);
});

test('prepareGitClone keeps the process environment and does not disable system git config', () => {
  const plan = prepareGitClone({
    url: 'https://example.com/a.git',
    branch: 'dev',
    dest: 'D:\\work\\repo',
    env: {
      PATH: 'C:\\Windows\\System32',
      SystemRoot: 'C:\\Windows',
      USERPROFILE: 'C:\\Users\\me',
      APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
      HOMEDRIVE: 'C:',
      HOMEPATH: '\\Users\\me',
      ProgramData: 'C:\\ProgramData',
      TEMP: 'C:\\Temp',
      TMP: 'C:\\Temp',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      HOME: 'C:\\Users\\me',
      SSH_AUTH_SOCK: '\\\\.\\pipe\\ssh-agent',
      WEFT_GIT_BIN: 'D:\\Git\\cmd\\git.exe',
      WEFT_GIT_CA_FILE: 'D:\\certs\\corp.pem',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_ASKPASS: 'echo',
      SSH_ASKPASS: 'C:\\askpass.exe',
      LANG: 'zh_CN.UTF-8',
    },
  });
  assert.equal(plan.bin, 'D:\\Git\\cmd\\git.exe');
  assert.deepEqual(plan.args.slice(0, 6), [
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    '-c', 'http.sslCAInfo=D:\\certs\\corp.pem',
  ]);
  assert.deepEqual(plan.args.slice(6), [
    'clone', '--depth', '1', '--branch', 'dev', '--', 'https://example.com/a.git', 'D:\\work\\repo',
  ]);
  assert.equal(plan.env.PATH, 'C:\\Windows\\System32');
  assert.equal(plan.env.SystemRoot, 'C:\\Windows');
  assert.equal(plan.env.USERPROFILE, 'C:\\Users\\me');
  assert.equal(plan.env.APPDATA, 'C:\\Users\\me\\AppData\\Roaming');
  assert.equal(plan.env.LOCALAPPDATA, 'C:\\Users\\me\\AppData\\Local');
  assert.equal(plan.env.HOMEDRIVE, 'C:');
  assert.equal(plan.env.HOMEPATH, '\\Users\\me');
  assert.equal(plan.env.ProgramData, 'C:\\ProgramData');
  assert.equal(plan.env.TEMP, 'C:\\Temp');
  assert.equal(plan.env.TMP, 'C:\\Temp');
  assert.equal(plan.env.COMSPEC, 'C:\\Windows\\System32\\cmd.exe');
  assert.equal(plan.env.HOME, 'C:\\Users\\me');
  assert.equal(plan.env.SSH_AUTH_SOCK, '\\\\.\\pipe\\ssh-agent');
  assert.equal(plan.env.GIT_CONFIG_NOSYSTEM, undefined);
  assert.equal(plan.env.GIT_ASKPASS, undefined);
  assert.equal(plan.env.SSH_ASKPASS, undefined);
  assert.equal(plan.env.GIT_SSH_COMMAND, undefined);
  assert.equal(plan.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(plan.env.GCM_INTERACTIVE, 'never');
  assert.equal(plan.env.LANG, 'C.UTF-8');
  assert.equal(plan.env.LC_ALL, 'C.UTF-8');
  assert.equal(plan.env.LANGUAGE, 'C');
});

test('WEFT_GIT_CA_FILE is omitted when empty, and an inherited GIT_SSH_COMMAND is left alone', () => {
  const plan = prepareGitClone({
    url: 'https://example.com/a.git',
    dest: 'repo',
    env: {
      PATH: '/usr/bin',
      WEFT_GIT_CA_FILE: '   ',
      GIT_SSH_COMMAND: 'ssh -i /keys/id_ed25519',
    },
  });
  assert.equal(plan.args.some((arg) => String(arg).includes('sslCAInfo')), false);
  assert.equal(plan.args.includes('credential.helper='), false);
  assert.equal(plan.env.GIT_SSH_COMMAND, 'ssh -i /keys/id_ed25519');
  assert.equal(plan.bin, 'git');
});

test('prepareGitClone disables credential helpers only when the URL embeds credentials', () => {
  const withCreds = prepareGitClone({
    url: 'https://importer:s3cr3t-token-value@example.com/a.git',
    dest: 'repo',
    env: { PATH: '/usr/bin', WEFT_GIT_CA_FILE: '/certs/ca.pem' },
  });
  const helperAt = withCreds.args.indexOf('credential.helper=');
  assert.equal(withCreds.args[helperAt - 1], '-c');
  assert.ok(helperAt > withCreds.args.indexOf('http.sslCAInfo=/certs/ca.pem'));
  assert.ok(helperAt < withCreds.args.indexOf('clone'));

  const plain = prepareGitClone({
    url: 'https://example.com/a.git',
    dest: 'repo',
    env: { PATH: '/usr/bin' },
  });
  assert.equal(plain.args.includes('credential.helper='), false);
});

test('redactGitOutput removes user:token and classifyCloneFailure maps git stderr', () => {
  const leaked = "fatal: repository 'http://importer:s3cr3t-token-value@127.0.0.1/nope.git/' not found";
  const redacted = redactGitOutput(leaked);
  assert.equal(redacted.includes('s3cr3t-token-value'), false);
  assert.match(redacted, /repository 'http:\/\/127\.0\.0\.1\/nope\.git\/' not found/);

  assert.equal(classifyCloneFailure({ code: 'ENOENT', message: 'spawn git ENOENT' }).code, 'git_not_found');
  assert.equal(classifyCloneFailure({ killed: true, stderr: 'still working' }).code, 'timeout');
  assert.equal(classifyCloneFailure({
    code: 128,
    stderr: "fatal: unable to access 'https://gitlab.example/a.git/': SSL certificate problem: unable to get local issuer certificate",
  }).code, 'cert_failed');
  assert.equal(classifyCloneFailure({
    code: 128,
    stderr: "fatal: Authentication failed for 'https://gitlab.example/a.git/'",
  }).code, 'auth_failed');
  assert.equal(classifyCloneFailure({
    code: 128,
    stderr: "fatal: unable to access 'http://127.0.0.1:1/repo.git/': Failed to connect to 127.0.0.1 port 1: Couldn't connect to server",
  }).code, 'network');
  const unknown = classifyCloneFailure({
    code: 128,
    stderr: 'fatal: boom http://importer:s3cr3t-token-value@h/x\nline-two',
  });
  assert.equal(unknown.code, 'unknown');
  assert.equal(unknown.detail.includes('s3cr3t-token-value'), false);
  assert.match(unknown.detail, /fatal: boom http:\/\/h\/x/);
  assert.equal(stripGitUrlCredentials('http://importer:s3cr3t-token-value@127.0.0.1/repo.git'), 'http://127.0.0.1/repo.git');
});

function cloneEnv(extra = {}) {
  return { ...process.env, WEFT_GIT_HTTP_HOSTS: '127.0.0.1', ...extra };
}

async function findHttpBackend() {
  const { stdout } = await execFileP('git', ['--exec-path'], { windowsHide: true, timeout: 15_000 });
  const dir = stdout.trim();
  for (const name of ['git-http-backend', 'git-http-backend.exe']) {
    const candidate = path.join(dir, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch { /* try the other name */ }
  }
  throw new Error(`git-http-backend missing under ${dir}`);
}

function splitCgi(raw) {
  let idx = raw.indexOf('\r\n\r\n');
  if (idx >= 0) return [raw.subarray(0, idx).toString('latin1'), raw.subarray(idx + 4)];
  idx = raw.indexOf('\n\n');
  if (idx >= 0) return [raw.subarray(0, idx).toString('latin1'), raw.subarray(idx + 2)];
  return [raw.toString('latin1'), Buffer.alloc(0)];
}

const PRIVATE_USER = 'importer';
const PRIVATE_PASS = 's3cr3t-token-value';

function basicAuthorized(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
  if (!match) return false;
  let decoded = '';
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return false;
  }
  const split = decoded.indexOf(':');
  if (split < 0) return false;
  return decoded.slice(0, split) === PRIVATE_USER && decoded.slice(split + 1) === PRIVATE_PASS;
}

async function startSmartGit() {
  const backend = await findHttpBackend();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-git-'));
  const src = path.join(root, 'src');
  const bare = path.join(root, 'repo.git');
  await fs.mkdir(src);
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Weft',
    GIT_AUTHOR_EMAIL: 'Weft@example.com',
    GIT_COMMITTER_NAME: 'Weft',
    GIT_COMMITTER_EMAIL: 'Weft@example.com',
  };
  const git = (args, cwd) => execFileP('git', args, { cwd, windowsHide: true, timeout: 20_000, env: gitEnv });
  await git(['init', '-b', 'main'], src);
  await fs.writeFile(path.join(src, 'README.md'), 'hello\n');
  await git(['add', 'README.md'], src);
  await git(['-c', 'commit.gpgsign=false', '-c', 'user.name=Weft', '-c', 'user.email=Weft@example.com', 'commit', '-m', 'init'], src);
  await git(['clone', '--bare', src, bare]);

  function runCgi(req, pathInfo) {
    const u = new URL(req.url, 'http://127.0.0.1');
    return new Promise((resolve, reject) => {
      const child = spawn(backend, [], {
        windowsHide: true,
        env: {
          ...process.env,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: pathInfo,
          QUERY_STRING: u.search.startsWith('?') ? u.search.slice(1) : '',
          REQUEST_METHOD: req.method || 'GET',
          CONTENT_TYPE: req.headers['content-type'] || '',
          CONTENT_LENGTH: req.headers['content-length'] || '',
          GATEWAY_INTERFACE: 'CGI/1.1',
          REMOTE_ADDR: '127.0.0.1',
          SERVER_NAME: '127.0.0.1',
          SERVER_PORT: '80',
          SERVER_PROTOCOL: 'HTTP/1.1',
          MSYS_NO_PATHCONV: '1',
          MSYS2_ARG_CONV_EXCL: '*',
        },
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      child.stdin.on('error', () => {});
      child.on('error', reject);
      child.on('close', () => resolve({ out: Buffer.concat(out), err: Buffer.concat(err).toString('utf8') }));
      req.pipe(child.stdin);
    });
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    let pathInfo = u.pathname;
    if (pathInfo === '/private' || pathInfo.startsWith('/private/')) {
      if (!basicAuthorized(req)) {
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"', 'Content-Type': 'text/plain' });
        res.end('Authentication failed');
        return;
      }
      pathInfo = pathInfo.slice('/private'.length) || '/';
    }
    let result;
    try {
      result = await runCgi(req, pathInfo);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(err.message);
      return;
    }
    const [head, body] = splitCgi(result.out);
    if (!head) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(result.err || 'cgi failed');
      return;
    }
    let status = 200;
    const headers = {};
    for (const line of head.split(/\r?\n/)) {
      const statusMatch = line.match(/^Status:\s+(\d+)/i);
      if (statusMatch) {
        status = Number(statusMatch[1]);
        continue;
      }
      const colon = line.indexOf(':');
      if (colon > 0) headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
    res.writeHead(status, headers);
    res.end(body);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    root,
    port,
    url: `http://127.0.0.1:${port}/repo.git`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

async function gitTreeHas(dir, needle) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await gitTreeHas(full, needle);
      if (found) return found;
    } else if (entry.isFile()) {
      const buf = await fs.readFile(full);
      if (buf.includes(Buffer.from(needle))) return full;
    }
  }
  return '';
}

async function rejectCode(fn, code) {
  await assert.rejects(fn, (err) => {
    assert.equal(err.gitCode, code);
    assert.equal(err.message, 'git clone failed');
    assert.equal(err.detail, undefined);
    return true;
  });
}

test('cloneGitRepo: success', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const dest = path.join(git.root, 'out-ok');
  await cloneGitRepo({ url: git.url, dest, env: cloneEnv() });
  const readme = await fs.readFile(path.join(dest, 'README.md'), 'utf8');
  assert.equal(readme.replace(/\r\n/g, '\n'), 'hello\n');
});

test('cloneGitRepo: auth_failed', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const dest = path.join(git.root, 'out-auth');
  await rejectCode(
    () => cloneGitRepo({ url: `http://127.0.0.1:${git.port}/private/repo.git`, dest, env: cloneEnv() }),
    'auth_failed',
  );
});

test('cloneGitRepo: correct Basic credentials succeed', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const token = PRIVATE_PASS;
  const dest = path.join(git.root, 'out-private-ok');
  const url = `http://${PRIVATE_USER}:${token}@127.0.0.1:${git.port}/private/repo.git`;
  await cloneGitRepo({ url, dest, env: cloneEnv() });
  const readme = await fs.readFile(path.join(dest, 'README.md'), 'utf8');
  assert.equal(readme.replace(/\r\n/g, '\n'), 'hello\n');
  const cfg = await fs.readFile(path.join(dest, '.git', 'config'), 'utf8');
  assert.equal(cfg.includes(token), false);
  assert.equal(cfg.includes(`${PRIVATE_USER}:`), false);
  assert.match(cfg, new RegExp(`url = http://127\\.0\\.0\\.1:${git.port}/private/repo\\.git`));
  assert.equal(await gitTreeHas(path.join(dest, '.git'), token), '');
});

test('cloneGitRepo: wrong Basic password is auth_failed', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const dest = path.join(git.root, 'out-private-bad');
  await rejectCode(
    () => cloneGitRepo({
      url: `http://${PRIVATE_USER}:wrong-password@127.0.0.1:${git.port}/private/repo.git`,
      dest,
      env: cloneEnv(),
    }),
    'auth_failed',
  );
  await assert.rejects(() => fs.access(dest));
});

test('cloneGitRepo: a credentialed URL does not ask the credential helper to store', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const helperPath = path.join(git.root, 'cred-helper.mjs');
  const configPath = path.join(git.root, 'cred.gitconfig');
  const controlLog = path.join(git.root, 'cred-control.log');
  const cloneLog = path.join(git.root, 'cred-clone.log');
  await fs.writeFile(helperPath, [
    "import fs from 'node:fs';",
    'const logPath = process.env.PIW_CRED_LOG;',
    'const chunks = [];',
    'const timer = setTimeout(finish, 1500);',
    "process.stdin.on('data', (chunk) => chunks.push(chunk));",
    "process.stdin.on('end', finish);",
    'function finish() {',
    '  if (finish.done) return;',
    '  finish.done = true;',
    '  clearTimeout(timer);',
    "  const body = Buffer.concat(chunks).toString('utf8');",
    '  const text = `argv=${JSON.stringify(process.argv.slice(2))}\\n${body}\\n---\\n`;',
    '  try { fs.appendFileSync(logPath, text); } catch { /* log is best-effort */ }',
    '  process.exit(0);',
    '}',
    '',
  ].join('\n'));
  const node = process.execPath.replace(/\\/g, '/');
  const helper = helperPath.replace(/\\/g, '/');
  await fs.writeFile(configPath, `[credential]\n\thelper = !'${node}' '${helper}'\n`);

  const token = PRIVATE_PASS;
  const url = `http://${PRIVATE_USER}:${token}@127.0.0.1:${git.port}/private/repo.git`;
  const controlDest = path.join(git.root, 'out-helper-control');
  await execFileP('git', ['clone', '--depth', '1', '--', url, controlDest], {
    windowsHide: true,
    timeout: 30_000,
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: configPath,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      PIW_CRED_LOG: controlLog,
    },
  });
  const controlText = await fs.readFile(controlLog, 'utf8');
  assert.match(controlText, /\bstore\b/);

  const dest = path.join(git.root, 'out-helper');
  await cloneGitRepo({
    url,
    dest,
    env: cloneEnv({
      GIT_CONFIG_GLOBAL: configPath,
      GIT_CONFIG_NOSYSTEM: '1',
      PIW_CRED_LOG: cloneLog,
    }),
  });
  let cloneText = '';
  try { cloneText = await fs.readFile(cloneLog, 'utf8'); } catch { cloneText = ''; }
  assert.doesNotMatch(cloneText, /\bstore\b/);
  const cfg = await fs.readFile(path.join(dest, '.git', 'config'), 'utf8');
  assert.equal(cfg.includes(token), false);
});

test('cloneGitRepo: repo_not_found', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const dest = path.join(git.root, 'out-missing');
  await rejectCode(
    () => cloneGitRepo({ url: `http://127.0.0.1:${git.port}/nope.git`, dest, env: cloneEnv() }),
    'repo_not_found',
  );
});

test('cloneGitRepo: branch_not_found', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const dest = path.join(git.root, 'out-branch');
  await rejectCode(
    () => cloneGitRepo({ url: git.url, branch: 'no-such', dest, env: cloneEnv() }),
    'branch_not_found',
  );
});

test('cloneGitRepo: user:token is not written to .git/config', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const token = 's3cr3t-token-value';
  const dest = path.join(git.root, 'out-token');
  const url = `http://importer:${token}@127.0.0.1:${git.port}/repo.git`;
  await cloneGitRepo({ url, dest, env: cloneEnv() });
  const cfg = await fs.readFile(path.join(dest, '.git', 'config'), 'utf8');
  assert.equal(cfg.includes(token), false);
  assert.equal(cfg.includes('importer:'), false);
  assert.match(cfg, new RegExp(`url = http://127\\.0\\.0\\.1:${git.port}/repo\\.git`));
  assert.equal(await gitTreeHas(path.join(dest, '.git'), token), '');
});

test('cloneGitRepo: a failed clone does not leave user:token on disk', { timeout: 30_000 }, async (t) => {
  const git = await startSmartGit();
  t.after(() => git.close());
  const token = 's3cr3t-token-value';
  const dest = path.join(git.root, 'out-fail-token');
  await assert.rejects(
    () => cloneGitRepo({
      url: `http://importer:${token}@127.0.0.1:${git.port}/nope.git`,
      dest,
      env: cloneEnv(),
    }),
    (err) => {
      assert.equal(err.gitCode, 'repo_not_found');
      assert.equal(String(err.message).includes(token), false);
      assert.equal(String(err.detail || '').includes(token), false);
      return true;
    },
  );
  await assert.rejects(() => fs.access(dest));
});

test('cloneGitRepo: git_not_found when WEFT_GIT_BIN is missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-gitbin-'));
  try {
    await assert.rejects(
      () => cloneGitRepo({
        url: 'https://example.com/repo.git',
        dest: path.join(dir, 'out'),
        env: cloneEnv({ WEFT_GIT_BIN: path.join(dir, 'missing-git') }),
      }),
      (err) => err.gitCode === 'git_not_found' && err.message === 'git clone failed',
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('cloneGitRepo rejects http hosts outside WEFT_GIT_HTTP_HOSTS before calling git', async () => {
  await assert.rejects(
    () => cloneGitRepo({
      url: 'http://gitlab.corp.local/group/repo.git',
      dest: path.join(os.tmpdir(), 'piw-should-not-clone'),
      env: { WEFT_GIT_HTTP_HOSTS: 'other.example' },
    }),
    (err) => err.message === 'invalid gitUrl' && err.gitCode == null,
  );
});

function stopProcess(proc) {
  return new Promise((resolve) => {
    if (proc.exitCode != null) return resolve();
    const timer = setTimeout(() => proc.kill('SIGKILL'), 2000);
    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    proc.kill('SIGTERM');
  });
}

function requestJson(port, method, reqPath, body) {
  const payload = body == null ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path: reqPath,
      headers: payload == null ? {} : {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

test('POST /api/workspaces returns git import error codes and stores a stripped URL', { timeout: 60_000 }, async (t) => {
  const git = await startSmartGit();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-git-api-'));
  const proc = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: '0',
      WEFT_DATA_DIR: dataDir,
      WEFT_GIT_HTTP_HOSTS: '127.0.0.1',
      WEFT_GROK_AUTH: path.join(dataDir, 'grok-auth.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (buf) => { log += buf; });
  proc.stderr.on('data', (buf) => { log += buf; });
  t.after(async () => {
    await stopProcess(proc);
    await git.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server not ready:\n${log}`)), 20_000);
    const timerCheck = setInterval(() => {
      const match = log.match(/WEFT_READY (http:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        clearInterval(timerCheck);
        resolve(match[1]);
      }
    }, 20);
    proc.once('exit', (code) => {
      clearTimeout(timer);
      clearInterval(timerCheck);
      reject(new Error(`server exited ${code}:\n${log}`));
    });
  });
  const port = Number(new URL(base).port);

  const missing = await requestJson(port, 'POST', '/api/workspaces', {
    name: 'missing-repo',
    gitUrl: `http://127.0.0.1:${git.port}/nope.git`,
  });
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error, 'git clone failed');
  assert.equal(missing.json.code, 'repo_not_found');
  assert.equal(missing.json.detail, undefined);

  const blocked = await requestJson(port, 'POST', '/api/workspaces', {
    name: 'blocked-http',
    gitUrl: 'http://gitlab.corp.local/group/repo.git',
  });
  assert.equal(blocked.status, 400);
  assert.equal(blocked.json.error, 'invalid gitUrl');
  assert.equal(blocked.json.code, undefined);

  const token = 's3cr3t-token-value';
  const created = await requestJson(port, 'POST', '/api/workspaces', {
    name: 'token-repo',
    gitUrl: `http://importer:${token}@127.0.0.1:${git.port}/repo.git`,
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.gitUrl, `http://127.0.0.1:${git.port}/repo.git`);
  assert.equal(String(created.json.gitUrl).includes(token), false);
  const cfg = await fs.readFile(path.join(created.json.path, '.git', 'config'), 'utf8');
  assert.equal(cfg.includes(token), false);
});

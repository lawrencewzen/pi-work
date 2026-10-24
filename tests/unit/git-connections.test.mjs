import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startFakeGitlab } from '../helpers/fake-gitlab.mjs';
import { buildConnectionCloneArgs, buildConnectionCloneEnv, sanitizeConnectionCloneUrl } from '../../src/core/git-connection-clone.mjs';
import { matchConnectionByUrl } from '../../src/core/git-connections.mjs';
import { request as serverRequest, startServer, stopServer } from './_server.mjs';

const AUTH = 'unit-git-conn-token';
const PAT = 'glpat-unit-secret-9k3q';
const BAD = 'glpat-unit-secret-bad1';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, AUTH);

function readSettings(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'), { readOnly: true });
  try {
    const row = db.prepare('SELECT json FROM settings WHERE id = ?').get('app');
    return row ? JSON.parse(row.json) : null;
  } finally {
    db.close();
  }
}

function readWorkspaces(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'weft.sqlite'), { readOnly: true });
  try {
    return db.prepare('SELECT id, name, path, source, git_url, branch, root_path, worktrees_json FROM workspaces').all();
  } finally {
    db.close();
  }
}

function assertNoSecret(text, secrets, label) {
  const raw = String(text || '');
  for (const secret of secrets) {
    assert.equal(raw.includes(secret), false, `${label} contains a token`);
  }
}

test('clone arguments and environment keep the token out of argv', () => {
  const args = buildConnectionCloneArgs({
    url: 'https://gitlab.example/acme/widget.git',
    branch: 'main',
    dest: '/tmp/widget',
  });
  assert.equal(args.join('\n').includes(PAT), false);
  assert.equal(args.includes('-c') && args.includes('credential.helper='), false);
  const env = buildConnectionCloneEnv({ PATH: '/usr/bin', GIT_TRACE: '1', GIT_CONFIG_KEY_0: 'old' }, {
    token: PAT,
    caFile: '',
    origin: 'https://gitlab.example',
  });
  assert.equal(env.GIT_TRACE, undefined);
  // Scoped to the connection origin: a redirect to another host does not get the header.
  assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://gitlab.example/.extraHeader');
  assert.equal(env.GIT_CONFIG_VALUE_0, `Authorization: Bearer ${PAT}`);
  assert.equal(env.GIT_CONFIG_KEY_1, 'credential.helper');
  assert.equal(env.GIT_CONFIG_VALUE_1, '');
  assert.equal(args.some((arg) => String(arg).includes('Bearer')), false);
});

test('GitLab connection API masks tokens and lists projects', async () => {
  const gitlab = await startFakeGitlab({
    token: PAT,
    username: 'zhangsan',
    projects: [
      {
        id: 7,
        path: 'acme/widget',
        description: 'Widget service',
        defaultBranch: 'main',
        branches: [{ name: 'main', default: true }, { name: 'develop', default: false }],
      },
      {
        id: 8,
        path: 'acme/other',
        description: 'Notes',
        defaultBranch: 'main',
        branches: [{ name: 'main', default: true }],
      },
    ],
  });
  const server = await startServer({ token: AUTH, env: { WEFT_RETRY_MAX: '2' } });
  try {
    const unsaved = await request(server.base, 'POST', '/api/git/connections/test', {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    assert.equal(unsaved.status, 200);
    assert.equal(unsaved.body.ok, true);
    assert.equal(unsaved.body.username, 'zhangsan');
    const empty = await request(server.base, 'GET', '/api/git/connections');
    assert.deepEqual(empty.body, []);

    const bad = await request(server.base, 'POST', '/api/git/connections/test', {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: BAD,
      allowHttp: true,
    });
    assert.equal(bad.status, 200);
    assert.equal(bad.body.ok, false);
    assert.equal(bad.body.code, 'auth_failed');
    assert.equal(JSON.stringify(bad.body).includes(BAD), false);

    const created = await request(server.base, 'POST', '/api/git/connections', {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.token, '••••9k3q');
    assert.equal(created.body.hasToken, true);
    assert.equal(created.body.baseUrl, gitlab.origin);
    assert.equal(JSON.stringify(created.body).includes(PAT), false);
    const id = created.body.id;

    const listed = await request(server.base, 'GET', '/api/git/connections');
    assert.equal(listed.body[0].token, '••••9k3q');
    assert.equal(listed.body[0].hasToken, true);
    assert.equal(JSON.stringify(listed.body).includes(PAT), false);

    const settings = await request(server.base, 'GET', '/api/settings');
    assert.equal(JSON.stringify(settings.body).includes(PAT), false);
    assert.equal(settings.body.gitConnections, undefined);

    const tested = await request(server.base, 'POST', `/api/git/connections/${id}/test`);
    assert.equal(tested.status, 200);
    assert.equal(tested.body.ok, true);
    assert.equal(tested.body.username, 'zhangsan');
    assert.equal(tested.body.connection.lastTest.ok, true);
    assert.equal(tested.body.connection.lastTest.username, 'zhangsan');
    assert.equal(tested.body.connection.token, '••••9k3q');

    const userHits = gitlab.hits.filter((hit) => hit.path === '/api/v4/user');
    assert.ok(userHits.length >= 2);
    assert.ok(userHits.every((hit) => hit.privateToken === PAT || hit.privateToken === BAD));
    assert.ok(userHits.some((hit) => hit.privateToken === PAT));

    const projects = await request(server.base, 'GET', `/api/git/connections/${id}/projects?search=${encodeURIComponent('widget')}`);
    assert.equal(projects.status, 200);
    assert.equal(projects.body.projects.length, 1);
    assert.equal(projects.body.projects[0].path, 'acme/widget');
    assert.equal(projects.body.projects[0].defaultBranch, 'main');
    const projectHit = gitlab.hits.find((hit) => hit.path === '/api/v4/projects');
    assert.match(projectHit.search, /membership=true/);
    assert.match(projectHit.search, /simple=true/);
    assert.match(projectHit.search, /order_by=last_activity_at/);
    assert.match(projectHit.search, /search=widget/);
    assert.equal(projectHit.privateToken, PAT);

    const branches = await request(server.base, 'GET', `/api/git/connections/${id}/projects/7/branches`);
    assert.equal(branches.status, 200);
    assert.equal(branches.body.defaultBranch, 'main');
    const main = branches.body.branches.find((item) => item.name === 'main');
    const develop = branches.body.branches.find((item) => item.name === 'develop');
    assert.equal(main.default, true);
    assert.equal(develop.default, false);

    const renamed = await request(server.base, 'PATCH', `/api/git/connections/${id}`, {
      name: '内网 GitLab 改名',
      token: '••••9k3q',
    });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, '内网 GitLab 改名');
    assert.equal(renamed.body.token, '••••9k3q');
    let stored = readSettings(server.dataDir);
    assert.equal(stored.gitConnections[0].token, PAT);

    const blank = await request(server.base, 'PATCH', `/api/git/connections/${id}`, { token: '' });
    assert.equal(blank.status, 200);
    stored = readSettings(server.dataDir);
    assert.equal(stored.gitConnections[0].token, PAT);

    const overwritten = await request(server.base, 'PUT', '/api/settings', {
      language: 'zh',
      gitConnections: [{ id: 'aaaaaaaa', token: 'glpat-should-not-land' }],
    });
    assert.equal(overwritten.status, 200);
    assert.equal(overwritten.body.gitConnections, undefined);
    stored = readSettings(server.dataDir);
    assert.equal(stored.gitConnections[0].token, PAT);
    assert.equal(JSON.stringify(stored).includes('glpat-should-not-land'), false);

    const com = await request(server.base, 'POST', '/api/git/connections', {
      kind: 'gitlab-com',
      name: 'GitLab.com',
      baseUrl: 'http://evil.example',
      token: 'glpat-com-token-zz99',
    });
    assert.equal(com.status, 201);
    assert.equal(com.body.baseUrl, 'https://gitlab.com');
    assert.equal(com.body.allowHttp, false);
    assert.equal(com.body.token, '••••zz99');

    const plain = await request(server.base, 'POST', '/api/git/connections', {
      kind: 'gitlab-self',
      name: '禁止 HTTP',
      baseUrl: 'http://127.0.0.1:9',
      token: PAT,
      allowHttp: false,
    });
    const blocked = await request(server.base, 'POST', `/api/git/connections/${plain.body.id}/test`);
    assert.equal(blocked.body.ok, false);
    assert.equal(blocked.body.code, 'http_not_allowed');

    const other = await request(server.base, 'POST', '/api/git/connections', {
      kind: 'other',
      name: '其它',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    const notGitlab = await request(server.base, 'GET', `/api/git/connections/${other.body.id}/projects`);
    assert.equal(notGitlab.status, 400);
    assert.equal(notGitlab.body.code, 'not_gitlab');
  } finally {
    await stopServer(server);
    gitlab.close();
    await fs.rm(server.dataDir, { recursive: true, force: true });
  }
});

async function writeHelper(dir) {
  const helper = path.join(dir, 'cred-helper.mjs');
  const log = path.join(dir, 'cred-helper.log');
  const config = path.join(dir, 'gitconfig');
  await fs.writeFile(helper, `import { appendFileSync } from 'node:fs';
const file = process.env.HELPER_LOG;
if (file) appendFileSync(file, 'called\\n');
process.stdout.write('username=git\\npassword=nope\\n');
`);
  const node = process.execPath.replace(/\\/g, '/');
  const script = helper.replace(/\\/g, '/');
  await fs.writeFile(config, `[credential]\n\thelper = !'${node}' '${script}'\n`);
  return { helper, log, config };
}

function credentialFill(config, log) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: config, GIT_CONFIG_NOSYSTEM: '1', HELPER_LOG: log, GIT_TERMINAL_PROMPT: '0' };
    for (const key of Object.keys(env)) {
      if (/^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
    }
    const child = spawn('git', ['credential', 'fill'], { env });
    let out = '';
    child.stdout.on('data', (buf) => { out += buf; });
    child.stderr.on('data', (buf) => { out += buf; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
    child.stdin.end('protocol=https\nhost=example.test\n\n');
  });
}

test('import uses the connection token and does not persist it', async () => {
  const helperDir = await fs.mkdtemp(path.join(os.tmpdir(), 'piw-helper-'));
  const { log, config } = await writeHelper(helperDir);
  const probe = await credentialFill(config, log);
  const probeLog = await fs.readFile(log, 'utf8');
  assert.match(probeLog, /called/, `credential helper control failed (${probe.code}): ${probe.out}`);
  await fs.writeFile(log, '');

  const gitlab = await startFakeGitlab({
    token: PAT,
    username: 'zhangsan',
    withGit: true,
    projects: [
      {
        id: 7,
        path: 'acme/widget',
        description: 'Widget service',
        defaultBranch: 'main',
        branches: [{ name: 'main', default: true }, { name: 'develop', default: false }],
      },
    ],
  });
  const server = await startServer({
    token: AUTH,
    env: {
      WEFT_RETRY_MAX: '2',
      GIT_CONFIG_GLOBAL: config,
      GIT_CONFIG_NOSYSTEM: '1',
      HELPER_LOG: log,
    },
  });
  try {
    const created = await request(server.base, 'POST', '/api/git/connections', {
      kind: 'gitlab-self',
      name: '内网 GitLab',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const imported = await request(server.base, 'POST', '/api/workspaces', {
      name: 'widget',
      connectionId: id,
      projectId: 7,
      branch: 'main',
    });
    assert.equal(imported.status, 201, imported.text);
    assert.equal(imported.body.source, 'git');
    assert.equal(imported.body.branch, 'main');
    assert.match(imported.body.gitUrl, /\/acme\/widget\.git$/);
    assertNoSecret(imported.text, [PAT, BAD], 'workspace response');

    const readme = await fs.readFile(path.join(imported.body.path, 'README.md'), 'utf8');
    assert.match(readme, /hello from acme\/widget/);
    const gitConfig = await fs.readFile(path.join(imported.body.path, '.git', 'config'), 'utf8');
    assertNoSecret(gitConfig, [PAT], '.git/config');
    assert.doesNotMatch(gitConfig, /authorization:\s*bearer/i);

    const rows = readWorkspaces(server.dataDir);
    assert.equal(rows.length, 1);
    assertNoSecret(JSON.stringify(rows), [PAT], 'workspace row');
    assert.equal(rows[0].git_url, imported.body.gitUrl);

    const helperAfter = await fs.readFile(log, 'utf8');
    assert.equal(helperAfter, '', 'credential helper was invoked during clone');

    const authHits = gitlab.hits.filter((hit) => hit.path.includes('/acme/widget.git/'));
    assert.ok(authHits.length > 0);
    assert.ok(authHits.every((hit) => hit.authorization === `Bearer ${PAT}`));

    await request(server.base, 'PATCH', `/api/git/connections/${id}`, { token: BAD });
    const failed = await request(server.base, 'POST', '/api/workspaces', {
      name: 'widget-bad',
      connectionId: id,
      projectId: 7,
    });
    assert.equal(failed.status, 400);
    assert.equal(failed.body.code, 'auth_failed');
    assert.equal(failed.body.via, 'connection');
    assertNoSecret(failed.text, [PAT, BAD], 'clone error');
    assertNoSecret(server.logs(), [PAT, BAD], 'server log');
    const helperStill = await fs.readFile(log, 'utf8');
    assert.equal(helperStill, '');
    const rowsAfter = readWorkspaces(server.dataDir);
    assert.equal(rowsAfter.length, 1);
  } finally {
    await stopServer(server);
    gitlab.close();
    await fs.rm(server.dataDir, { recursive: true, force: true });
    await fs.rm(helperDir, { recursive: true, force: true });
  }
});

test('address import uses a saved connection for the same host', async () => {
  const gitlab = await startFakeGitlab({
    token: PAT,
    withGit: true,
    projects: [
      {
        id: 3,
        path: 'acme/notes',
        defaultBranch: 'main',
        branches: [{ name: 'main', default: true }],
      },
    ],
  });
  const server = await startServer({ token: AUTH, env: { WEFT_RETRY_MAX: '2' } });
  try {
    const created = await request(server.base, 'POST', '/api/git/connections', {
      kind: 'gitlab-self',
      name: '内网',
      baseUrl: gitlab.origin,
      token: PAT,
      allowHttp: true,
    });
    const url = `${gitlab.origin}/acme/notes.git`;
    const imported = await request(server.base, 'POST', '/api/workspaces', {
      name: 'notes',
      gitUrl: url,
      branch: 'main',
    });
    assert.equal(imported.status, 201, imported.text);
    assert.equal(imported.body.gitUrl, url);
    const gitConfig = await fs.readFile(path.join(imported.body.path, '.git', 'config'), 'utf8');
    assertNoSecret(gitConfig, [PAT], '.git/config');
    assert.equal(created.body.hasToken, true);
  } finally {
    await stopServer(server);
    gitlab.close();
    await fs.rm(server.dataDir, { recursive: true, force: true });
  }
});

test('a connection token only goes to the connection host', () => {
  const conn = { kind: 'gitlab-self', baseUrl: 'https://gitlab.example', token: PAT };
  assert.equal(sanitizeConnectionCloneUrl('https://gitlab.example/acme/widget.git', conn), 'https://gitlab.example/acme/widget.git');
  for (const url of ['https://evil.example/acme/widget.git', 'https://gitlab.example:8443/acme/widget.git']) {
    assert.throws(() => sanitizeConnectionCloneUrl(url, conn), (err) => err.gitCode === 'host_mismatch');
  }
  assert.throws(() => buildConnectionCloneEnv({}, { token: PAT }), (err) => err.gitCode === 'unknown');
  const list = [{ id: 'c1', baseUrl: 'https://gitlab.example' }];
  assert.equal(matchConnectionByUrl(list, 'https://gitlab.example/a/b.git')?.id, 'c1');
  assert.equal(matchConnectionByUrl(list, 'https://gitlab.example:8443/a/b.git'), null);
});

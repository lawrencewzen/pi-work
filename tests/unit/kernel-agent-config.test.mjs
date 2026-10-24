import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { killChild, request as serverRequest, startServer, stopServer } from './_server.mjs';
import { autoTitleFromText } from '../../src/kernel/agent-config.mjs';
import { isAutoContinueText } from '../../src/kernel/continuation.mjs';
import { createSkillTool, SKILL_TOOL_DESCRIPTION } from '../../src/kernel/skill-tool.mjs';
import { SKILL_LIST_INTRO } from '../../src/core/skills.mjs';

const TOKEN = 'unit-kernel-agent-config-token';
const request = (base, method, apiPath, body) => serverRequest(base, method, apiPath, body, TOKEN);

async function waitFor(base, cid, ready, attempts = 50) {
  let body = null;
  for (let i = 0; i < attempts; i += 1) {
    const got = await request(base, 'GET', `/api/conversations/${cid}`);
    body = got.body;
    if (ready(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return body;
}

function sectionText(snapshot, key) {
  return snapshot.sections.find((section) => section.key === key)?.value || '';
}

function sectionInner(snapshot, key) {
  return String(sectionText(snapshot, key) || '').replace(new RegExp(`</?${key}>`, 'gi'), '').trim();
}

async function readRecords(file) {
  const text = await readFile(file, 'utf8');
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('autoTitleFromText still skips auto-continue text', () => {
  assert.equal(isAutoContinueText('[auto-continue] more'), true);
  assert.equal(autoTitleFromText('New conversation', '[auto-continue] more'), undefined);
  assert.equal(autoTitleFromText('New conversation', 'hello world'), 'hello world');
});

test('new conversation: empty instructions, all tools, enabled skills, Agent name', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kagent-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_TEXT: 'noted',
      WEFT_FAUX_RECORD: record,
    },
  });
  try {
    assert.equal((await request(srv.base, 'GET', '/api/roles')).status, 404);
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'agent-config' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'main' });
    assert.equal(conv.status, 201);
    assert.equal(Object.hasOwn(conv.body, 'roleId'), false);
    const sent = await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'hello' });
    assert.equal(sent.status, 202);
    const done = await waitFor(srv.base, conv.body.id, (body) => body.status === 'done');
    assert.equal(done.status, 'done', srv.logs());
    assert.equal(Object.hasOwn(done, 'roleId'), false);
    const main = (done.agents || []).find((agent) => agent.id === `${conv.body.id}:agent:0`);
    assert.ok(main);
    assert.equal(main.name, 'Agent');
    assert.equal(Object.hasOwn(main, 'roleId'), false);

    const [call] = await readRecords(record);
    assert.equal(sectionInner(call, 'instructions'), '');
    assert.equal(/You are a helpful coding assistant|default coding Agent|规划角色|编码角色/.test(sectionText(call, 'instructions')), false);
    const skills = sectionInner(call, 'skills');
    assert.equal(skills.split('\n')[0], SKILL_LIST_INTRO);
    assert.match(skills, /^- commit-message: /m);
    assert.match(skills, /^- review-notes: /m);
    assert.equal(skills.includes('Subject line is imperative'), false);
    assert.equal(skills.includes('Lead with findings'), false);
    for (const name of ['read', 'write', 'edit', 'ls', 'grep', 'bash', 'echo', 'skill', 'delegate', 'subagent']) {
      assert.equal(call.tools.includes(name), true, name);
    }
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('skill tool is read-only load-by-name', async () => {
  const tool = createSkillTool({
    loadSkill: async (name) => (
      name === 'ok' ? { body: 'FULL BODY' } : { error: 'unknown skill nope，可用：ok' }
    ),
  });
  assert.equal(tool.name, 'skill');
  assert.equal(tool.description, SKILL_TOOL_DESCRIPTION);
  assert.equal(tool.replay, 'safe');
  assert.deepEqual(Object.keys(tool.parameters?.properties || {}), ['name']);
  const ok = await tool.execute({ name: 'ok' });
  assert.equal(ok.isError, undefined);
  assert.equal(ok.output[0].text, 'FULL BODY');
  const bad = await tool.execute({ name: 'nope' });
  assert.equal(bad.isError, true);
  assert.match(bad.output[0].text, /unknown skill nope/);
});

test('main agent skill tool loads body; disabled or unknown skills error', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kskill-'));
  const record = path.join(dataDir, 'requests.jsonl');
  const script = path.join(dataDir, 'faux.json');
  await writeFile(script, JSON.stringify({
    turns: [
      { when: 'load commit skill', tool: 'skill', args: { name: 'commit-message' } },
      { when: 'load commit skill', tool: 'skill', args: { name: 'Commit messages' } },
      { when: 'load commit skill', text: 'loaded' },
      { when: 'load again', tool: 'skill', args: { name: 'commit-message' } },
      { when: 'load again', tool: 'skill', args: { name: 'missing-skill' } },
      { when: 'load again', text: 'after-disable' },
    ],
  }));
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_SCRIPT: script,
      WEFT_FAUX_RECORD: record,
    },
  });
  try {
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'skills' });
    assert.equal(ws.status, 201);
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'load' });
    assert.equal(conv.status, 201);
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'load commit skill' })).status, 202);
    const first = await waitFor(srv.base, conv.body.id, (body) => body.status === 'done');
    assert.equal(first.status, 'done', srv.logs());
    const loaded = (first.messages || []).filter((message) => message.role === 'tool').map((message) => message.text || '');
    assert.equal(loaded.length, 2, JSON.stringify(first.messages));
    assert.match(loaded[0], /When the user asks for a commit message/);
    assert.match(loaded[0], /Subject line is imperative/);
    assert.equal(loaded[1], loaded[0]);
    const [call] = await readRecords(record);
    const catalog = sectionInner(call, 'skills');
    assert.equal(catalog.split('\n')[0], SKILL_LIST_INTRO);
    assert.match(catalog, /^- commit-message: /m);
    assert.equal(catalog.includes('Subject line is imperative'), false);
    assert.equal((call.tools || []).includes('skill'), true);

    const skillOff = await request(srv.base, 'PUT', '/api/skills/commit-message', { enabled: false });
    assert.equal(skillOff.status, 200);
    const conv2 = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'off' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv2.body.id}/messages`, { text: 'load again' })).status, 202);
    const second = await waitFor(srv.base, conv2.body.id, (body) => body.status === 'done');
    assert.equal(second.status, 'done', srv.logs());
    const errors = (second.messages || []).filter((message) => message.role === 'tool').map((message) => message.text || '');
    assert.equal(errors.length, 2, JSON.stringify(second.messages));
    assert.match(errors[0], /^unknown skill commit-message，可用：/);
    assert.match(errors[0], /review-notes/);
    assert.equal(errors[0].split('可用：')[1].includes('commit-message'), false);
    assert.match(errors[1], /^unknown skill missing-skill，可用：/);
    const later = await readRecords(record);
    const shut = sectionInner(later[later.length - 1], 'skills');
    assert.equal(shut.includes('commit-message'), false);
    assert.match(shut, /review-notes/);
  } finally {
    await stopServer(srv);
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('PATCH while busy still accepts a model change', { timeout: 30000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kagent-busy-'));
  const ready = path.join(dataDir, 'hold-ready');
  const srv = await startServer({
    token: TOKEN,
    dataDir,
    env: {
      WEFT_LLM: 'faux',
      WEFT_FAUX_HOLD: '1',
      WEFT_FAUX_HOLD_READY: ready,
    },
  });
  try {
    const ws = await request(srv.base, 'POST', '/api/workspaces', { name: 'busy' });
    const conv = await request(srv.base, 'POST', `/api/workspaces/${ws.body.id}/conversations`, { title: 'busy' });
    assert.equal((await request(srv.base, 'POST', `/api/conversations/${conv.body.id}/messages`, { text: 'wait' })).status, 202);
    const started = Date.now();
    while (Date.now() - started < 15000) {
      try {
        await readFile(ready, 'utf8');
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    }
    await readFile(ready, 'utf8');
    const ignored = await request(srv.base, 'PATCH', `/api/conversations/${conv.body.id}`, { leftover: true });
    assert.equal(ignored.status, 200);
    const modelPatch = await request(srv.base, 'PATCH', `/api/conversations/${conv.body.id}`, {
      modelSourceId: null,
      modelId: null,
    });
    assert.equal(modelPatch.status, 200);
    assert.equal(modelPatch.body.modelSourceId, null);
    assert.equal(modelPatch.body.modelId, null);
    assert.equal(Object.hasOwn(modelPatch.body, 'roleId'), false);
  } finally {
    killChild(srv.proc);
    await new Promise((resolve) => srv.proc.once('exit', resolve));
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('legacy sqlite with roles table and role_id still opens and continues', { timeout: 40000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'piw-kagent-legacy-'));
  const first = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'first-turn' },
  });
  let cid;
  let wid;
  try {
    const ws = await request(first.base, 'POST', '/api/workspaces', { name: 'legacy' });
    assert.equal(ws.status, 201);
    wid = ws.body.id;
    const conv = await request(first.base, 'POST', `/api/workspaces/${wid}/conversations`, { title: 'old' });
    assert.equal(conv.status, 201);
    cid = conv.body.id;
    const sent = await request(first.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'hi' });
    assert.equal(sent.status, 202);
    const done = await waitFor(first.base, cid, (body) => body.status === 'done');
    assert.equal(done.status, 'done', first.logs());
  } finally {
    await stopServer(first);
  }

  const dbPath = path.join(dataDir, 'weft.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      name TEXT,
      system_prompt TEXT,
      tools_json TEXT
    );
  `);
  raw.prepare('INSERT OR REPLACE INTO roles (id, name, system_prompt, tools_json) VALUES (?, ?, ?, ?)').run(
    'coder',
    'Coder',
    'You are a leftover role prompt that must not be used.',
    '["read"]',
  );
  const cols = new Set(raw.prepare('PRAGMA table_info(conversations)').all().map((c) => c.name));
  if (!cols.has('role_id')) raw.exec('ALTER TABLE conversations ADD COLUMN role_id TEXT');
  raw.prepare('UPDATE conversations SET role_id = ? WHERE id = ?').run('coder', cid);
  assert.ok(raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='roles'").get());
  raw.close();

  const second = await startServer({
    token: TOKEN,
    dataDir,
    env: { WEFT_LLM: 'faux', WEFT_FAUX_TEXT: 'second-turn' },
  });
  try {
    const check = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        check.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='roles'").get(),
        undefined,
      );
    } finally {
      check.close();
    }
    const got = await request(second.base, 'GET', `/api/conversations/${cid}`);
    assert.equal(got.status, 200, JSON.stringify(got.body));
    assert.equal(got.body.id, cid);
    assert.equal(Object.hasOwn(got.body, 'roleId'), false);
    const sent = await request(second.base, 'POST', `/api/conversations/${cid}/messages`, { text: 'again' });
    assert.equal(sent.status, 202);
    const done = await waitFor(second.base, cid, (body) => (
      body.messages?.filter((msg) => msg.role === 'assistant').length >= 2 && body.status === 'done'
    ));
    assert.equal(done.status, 'done', second.logs());
    assert.equal(done.messages.some((msg) => msg.role === 'assistant' && msg.text === 'second-turn'), true);
  } finally {
    await stopServer(second);
    await rm(dataDir, { recursive: true, force: true });
  }
});

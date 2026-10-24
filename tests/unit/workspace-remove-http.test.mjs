import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, prepareWorkspaces, api } from '../e2e/helpers/server.mjs';

test('removing a workspace hides it, keeps files and chats, and re-adding the path brings it back', async () => {
  const { root, dirs: [dir] } = await prepareWorkspaces(['keep-me']);
  const srv = await startServer({ extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const ws = await api(srv.url, 'POST', '/workspaces', { name: 'keep', path: dir });
    assert.equal(ws.status, 201);
    const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, { title: 'old chat' });
    assert.equal(conv.status, 201);

    const removed = await api(srv.url, 'DELETE', `/workspaces/${ws.body.id}`);
    assert.equal(removed.status, 200);
    const list = await api(srv.url, 'GET', '/workspaces');
    assert.equal(list.body.some((w) => w.id === ws.body.id), false);
    assert.equal((await api(srv.url, 'DELETE', `/workspaces/${ws.body.id}`)).status, 404);

    const again = await api(srv.url, 'POST', '/workspaces', { name: 'keep again', path: dir });
    assert.equal(again.status, 201);
    assert.equal(again.body.id, ws.body.id);
    const chats = await api(srv.url, 'GET', `/workspaces/${ws.body.id}/conversations`);
    assert.deepEqual(chats.body.map((c) => c.title), ['old chat']);
    const names = (await api(srv.url, 'GET', '/workspaces')).body.map((w) => w.name);
    assert.deepEqual(names, ['keep again']);
  } finally {
    await srv.kill();
  }
});

test('a workspace with a running chat is not removed', async () => {
  const { root, dirs: [dir] } = await prepareWorkspaces(['busy']);
  const srv = await startServer({ script: 'slow.json', extraEnv: { WEFT_WORKSPACE_ROOT: root } });
  try {
    const ws = await api(srv.url, 'POST', '/workspaces', { name: 'busy', path: dir });
    const conv = await api(srv.url, 'POST', `/workspaces/${ws.body.id}/conversations`, {});
    const sent = await api(srv.url, 'POST', `/conversations/${conv.body.id}/messages`, { text: 'go' });
    assert.equal(sent.status < 300, true);
    const removed = await api(srv.url, 'DELETE', `/workspaces/${ws.body.id}`);
    assert.equal(removed.status, 409);
    assert.equal(removed.body.code, 'E_WS_BUSY');
    await api(srv.url, 'POST', `/conversations/${conv.body.id}/stop`);
  } finally {
    await srv.kill();
  }
});

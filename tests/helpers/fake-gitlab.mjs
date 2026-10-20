import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);

async function gitBackend() {
  const { stdout } = await exec('git', ['--exec-path']);
  return path.join(stdout.trim(), 'git-http-backend');
}

async function makeRepo(root, project) {
  const src = path.join(root, 'src', String(project.id));
  await mkdir(src, { recursive: true });
  await exec('git', ['init', '-q', '-b', project.defaultBranch || 'main'], { cwd: src });
  await exec('git', ['config', 'user.email', 't@example.com'], { cwd: src });
  await exec('git', ['config', 'user.name', 't'], { cwd: src });
  await writeFile(path.join(src, 'README.md'), `hello from ${project.path}\n`);
  await exec('git', ['add', 'README.md'], { cwd: src });
  await exec('git', ['commit', '-qm', 'init'], { cwd: src });
  for (const branch of project.branches || []) {
    if (branch.name && branch.name !== (project.defaultBranch || 'main')) {
      await exec('git', ['branch', branch.name], { cwd: src });
    }
  }
  const destParent = path.join(root, 'repos', path.dirname(project.path));
  await mkdir(destParent, { recursive: true });
  await exec('git', ['clone', '-q', '--bare', src, path.join(root, 'repos', `${project.path}.git`)]);
}

function cgi(backend, repos, req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const env = {
    PATH: process.env.PATH || '',
    GIT_PROJECT_ROOT: repos,
    GIT_HTTP_EXPORT_ALL: '1',
    REQUEST_METHOD: req.method,
    PATH_INFO: decodeURIComponent(url.pathname),
    QUERY_STRING: url.search.slice(1),
    CONTENT_TYPE: req.headers['content-type'] || '',
    CONTENT_LENGTH: String(req.headers['content-length'] || 0),
  };
  const child = spawn(backend, [], { env });
  req.pipe(child.stdin);
  const chunks = [];
  child.stdout.on('data', (chunk) => chunks.push(chunk));
  child.on('close', () => {
    const buf = Buffer.concat(chunks);
    const sep = buf.indexOf('\r\n\r\n');
    if (sep < 0) {
      res.writeHead(500);
      res.end(buf);
      return;
    }
    const header = buf.slice(0, sep).toString('utf8');
    const body = buf.slice(sep + 4);
    let status = 200;
    const headers = {};
    for (const line of header.split('\r\n')) {
      const index = line.indexOf(':');
      if (index < 0) continue;
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      if (/^status$/i.test(key)) status = Number(value) || 200;
      else headers[key] = value;
    }
    res.writeHead(status, headers);
    res.end(body);
  });
}

/**
 * Local GitLab API plus, when projects include branches, a git smart HTTP
 * backend on the same origin. Both require the given token.
 */
export async function startFakeGitlab({
  token,
  username = 'zhangsan',
  projects = [],
  withGit = false,
} = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'piw-gitlab-'));
  const hits = [];
  if (withGit) {
    for (const project of projects) await makeRepo(root, project);
  }
  const backend = withGit ? await gitBackend() : '';
  const repos = path.join(root, 'repos');
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    hits.push({
      method: req.method,
      path: url.pathname,
      search: url.search,
      privateToken: req.headers['private-token'] || '',
      authorization: req.headers.authorization || '',
    });
    const authed = (req.headers['private-token'] || '') === token
      || (req.headers.authorization || '') === `Bearer ${token}`;
    if (!authed) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: '401 Unauthorized' }));
      return;
    }
    if (url.pathname === '/api/v4/user') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 1, username, name: username }));
      return;
    }
    if (url.pathname === '/api/v4/projects') {
      const search = (url.searchParams.get('search') || '').toLowerCase();
      const rows = projects.filter((project) => {
        if (!search) return true;
        return `${project.path} ${project.description || ''}`.toLowerCase().includes(search);
      }).slice(0, 50);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(rows.map((project) => ({
        id: project.id,
        path_with_namespace: project.path,
        description: project.description || '',
        default_branch: project.defaultBranch || 'main',
        last_activity_at: project.lastActivityAt || '2026-10-14T00:00:00.000Z',
        http_url_to_repo: project.httpUrl || '',
      }))));
      return;
    }
    const projectMatch = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)$/);
    if (projectMatch && req.method === 'GET') {
      const id = decodeURIComponent(projectMatch[1]);
      const project = projects.find((item) => String(item.id) === id);
      if (!project) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        id: project.id,
        path_with_namespace: project.path,
        description: project.description || '',
        default_branch: project.defaultBranch || 'main',
        http_url_to_repo: project.httpUrl || '',
      }));
      return;
    }
    const branchMatch = url.pathname.match(/^\/api\/v4\/projects\/([^/]+)\/repository\/branches$/);
    if (branchMatch) {
      const id = decodeURIComponent(branchMatch[1]);
      const project = projects.find((item) => String(item.id) === id);
      if (!project) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('[]');
        return;
      }
      const branches = (project.branches || [{ name: project.defaultBranch || 'main', default: true }]).map((branch) => ({
        name: branch.name,
        default: branch.default === true || branch.name === project.defaultBranch,
      }));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(branches));
      return;
    }
    if (withGit && url.pathname.includes('.git/')) {
      cgi(backend, repos, req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: '404' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  for (const project of projects) {
    if (!project.httpUrl) project.httpUrl = `${origin}/${project.path}.git`;
  }
  return {
    origin,
    hits,
    root,
    close() {
      server.close();
    },
  };
}

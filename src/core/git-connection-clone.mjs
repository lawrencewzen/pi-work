const TRACE_ENV = /^(git_trace|git_trace_.*|git_curl_verbose|git_config_count|git_config_key_\d+|git_config_value_\d+|git_askpass|git_askpass_require)$/i;

/**
 * GitLab accepts a personal access token as `Authorization: Bearer`.
 * The header is passed with GIT_CONFIG_KEY/VALUE so it is not a process argument.
 * `credential.helper` set to empty clears inherited helpers for this command.
 * cloneGitRepo applies these pairs when a connection token or CA file is set.
 */
export function buildConnectionGitConfig({ token, caFile } = {}) {
  const pairs = [];
  if (token) {
    pairs.push(['http.extraHeader', `Authorization: Bearer ${token}`]);
    pairs.push(['credential.helper', '']);
  }
  const ca = String(caFile || '').trim();
  if (ca) pairs.push(['http.sslCAInfo', ca]);
  return pairs;
}

export function buildConnectionCloneEnv(baseEnv = process.env, options = {}) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (value == null) continue;
    if (TRACE_ENV.test(key)) continue;
    env[key] = String(value);
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  env.LANG = 'C.UTF-8';
  env.LC_ALL = 'C.UTF-8';
  env.LANGUAGE = 'C';
  const pairs = buildConnectionGitConfig(options);
  if (pairs.length) {
    env.GIT_CONFIG_COUNT = String(pairs.length);
    pairs.forEach(([key, value], index) => {
      env[`GIT_CONFIG_KEY_${index}`] = key;
      env[`GIT_CONFIG_VALUE_${index}`] = value;
    });
  }
  return env;
}

export function buildConnectionCloneArgs({ url, branch, dest } = {}) {
  const args = [
    '-c', 'protocol.file.allow=never',
    '-c', 'protocol.ext.allow=never',
    'clone', '--depth', '1',
  ];
  if (branch) args.push('--branch', String(branch));
  args.push('--', String(url || '').trim(), dest);
  return args;
}

export function redactSecrets(text, secrets = []) {
  let out = String(text || '');
  for (const secret of secrets) {
    const value = String(secret || '');
    if (value.length >= 6) out = out.split(value).join('***');
  }
  out = out.replace(/(Authorization:\s*(?:Basic|Bearer)\s+)\S+/gi, '$1***');
  out = out.replace(/\b(glpat-|gldt-|ghp_|gho_|ghu_|ghs_|github_pat_|glptt-)[A-Za-z0-9_-]+/g, '$1***');
  return out;
}

function gitFail(code, detail) {
  const err = new Error(code === 'http_not_allowed' ? 'http not allowed' : 'git clone failed');
  err.status = 400;
  err.gitCode = code;
  if (detail) err.detail = detail;
  return err;
}

export function sanitizeConnectionCloneUrl(url, connection) {
  const text = String(url || '').trim();
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw gitFail('unknown');
  }
  parsed.username = '';
  parsed.password = '';
  parsed.hash = '';
  parsed.search = '';
  if (!parsed.hostname || parsed.hostname.startsWith('-')) throw gitFail('unknown');
  const base = connection?.baseUrl ? new URL(connection.baseUrl) : null;
  if (parsed.protocol === 'http:') {
    const allowed = connection?.kind === 'gitlab-self' && connection?.allowHttp === true;
    const sameHost = base && parsed.hostname.toLowerCase() === base.hostname.toLowerCase();
    if (!allowed || !sameHost) throw gitFail('http_not_allowed');
  } else if (parsed.protocol !== 'https:') {
    throw gitFail('unknown');
  }
  return `${parsed.origin}${parsed.pathname}`;
}

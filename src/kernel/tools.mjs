// Workspace tools for the Pi Durable kernel.
// read/write/edit/bash are official Pi Durable tools. ls and grep use the
// conversation ExecutionEnv. Path checks live only in workspace-env.mjs.
import path from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import { defineExtension, defineTool, hook, ToolTask } from '@earendil-works/pi-durable';
import { FileError, getOrThrow } from '@earendil-works/pi-durable/env';
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from '@earendil-works/pi-durable/tools';
import { diffStats, splitLines } from '../core/diff.mjs';

const DETAIL_CAP = 1024 * 1024;
const WORKSPACE_TOOL_NAMES = ['read', 'write', 'edit', 'ls', 'grep', 'bash'];
const SKIP_DIR_NAMES = new Set(['.git', 'node_modules']);

function withReplay(tool, replay) {
  return { ...tool, replay };
}

/** Map the previous `{ old, new }` shape onto the official edit schema. */
function withLegacyEditArgs(tool) {
  const prepare = tool.prepareArguments;
  return {
    ...tool,
    prepareArguments(input) {
      let next = input;
      if (next && typeof next === 'object' && !Array.isArray(next)) {
        const mapped = { ...next };
        if (typeof mapped.old === 'string' && mapped.oldText === undefined) mapped.oldText = mapped.old;
        if (typeof mapped.new === 'string' && mapped.newText === undefined) mapped.newText = mapped.new;
        next = mapped;
      }
      return prepare ? prepare(next) : next;
    },
  };
}

/**
 * Official write/edit details have no before/after. Capture them here because
 * afterTool's HookApi has no env. afterTool then applies the 1 MB cap.
 */
function withFileChangeDetails(tool) {
  const execute = tool.execute;
  return {
    ...tool,
    async execute(args, api, context) {
      const env = api.env;
      const filePath = typeof args?.path === 'string' ? args.path : '';
      let before = '';
      if (env && filePath) {
        const previous = await env.readTextFile(filePath, context);
        before = previous.ok ? previous.value : '';
      }
      const result = await execute(args, api, context);
      if (!env || !filePath || result?.isError) return result;
      const next = await env.readTextFile(filePath, context);
      const after = next.ok
        ? next.value
        : (typeof args.content === 'string' ? args.content : '');
      const details = result?.details && typeof result.details === 'object' ? result.details : {};
      return {
        ...result,
        details: { ...details, path: filePath, before, after },
      };
    },
  };
}

function requireEnv(api) {
  if (!api?.env) throw new FileError('invalid', 'E_SANDBOX: conversation cwd is not set');
  return api.env;
}

function displayPath(cwd, filePath) {
  const rel = path.relative(cwd, filePath);
  const text = (!rel || rel.startsWith('..') || path.isAbsolute(rel)) ? filePath : rel;
  return String(text).replaceAll('\\', '/');
}

function matchGlob(file, glob) {
  if (!glob) return true;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '::DS::').replace(/\*/g, '[^/]*').replace(/::DS::/g, '.*');
  return new RegExp(`^${escaped}$`).test(file) || new RegExp(`${escaped}$`).test(file);
}

async function collectFiles(env, start, context, acc) {
  const info = getOrThrow(await env.fileInfo(start, context));
  if (info.kind === 'directory') {
    const listing = getOrThrow(await env.listDir(start, context));
    for (const entry of listing) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      const child = await env.joinPath([start, entry.name], context);
      if (!child.ok) continue;
      try {
        await collectFiles(env, child.value, context, acc);
      } catch {
        continue;
      }
    }
    return;
  }
  acc.push(start);
}

function createLsTool() {
  return defineTool({
    name: 'ls',
    description: 'List a directory inside this conversation\'s workspace.',
    parameters: Type.Object({ path: Type.Optional(Type.String()) }),
    replay: 'safe',
    async execute(args, api, context) {
      const env = requireEnv(api);
      const rel = args.path || '.';
      const info = getOrThrow(await env.fileInfo(rel, context));
      if (info.kind !== 'directory') {
        return { output: [{ type: 'text', text: info.name }] };
      }
      const entries = getOrThrow(await env.listDir(rel, context));
      const lines = entries
        .map((entry) => `${entry.kind === 'directory' ? 'd' : 'f'} ${entry.name}`)
        .join('\n');
      return { output: [{ type: 'text', text: lines }] };
    },
  });
}

function createGrepTool() {
  return defineTool({
    name: 'grep',
    description: 'Search file contents inside this conversation\'s workspace.',
    parameters: Type.Object({
      pattern: Type.String(),
      path: Type.Optional(Type.String()),
      glob: Type.Optional(Type.String()),
    }),
    replay: 'safe',
    async execute(args, api, context) {
      const env = requireEnv(api);
      const rel = args.path || '.';
      const files = [];
      await collectFiles(env, rel, context, files);
      let re;
      try {
        re = new RegExp(args.pattern);
      } catch {
        re = new RegExp(String(args.pattern).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
      const hits = [];
      for (const file of files) {
        const shown = displayPath(env.cwd, file);
        if (args.glob && !matchGlob(shown, args.glob) && !matchGlob(path.basename(file), args.glob)) continue;
        const text = await env.readTextFile(file, context);
        if (!text.ok) continue;
        const lines = text.value.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) hits.push(`${shown}:${i + 1}:${lines[i]}`);
        }
      }
      return { output: [{ type: 'text', text: hits.join('\n') }] };
    },
  });
}

const workspaceToolList = [
  withReplay(createReadTool(), 'safe'),
  withReplay(withFileChangeDetails(createWriteTool()), 'unsafe'),
  withReplay(withFileChangeDetails(withLegacyEditArgs(createEditTool())), 'unsafe'),
  createLsTool(),
  createGrepTool(),
  withReplay(createBashTool(), 'unsafe'),
];

export function workspaceTools() {
  return workspaceToolList;
}

/** Role whitelist. An empty list matches the orchestrator and offers every workspace tool. */
export function toolsForRole(role) {
  const allowed = Array.isArray(role?.tools) && role.tools.length
    ? role.tools
    : WORKSPACE_TOOL_NAMES;
  const byName = new Map(workspaceToolList.map((tool) => [tool.name, tool]));
  return allowed.map((name) => byName.get(name)).filter(Boolean);
}

function byteLength(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

/** Keep path, before, after, and line stats on the tool result. Over 1 MB, line stats only. */
export function fileChangeDetails({ path: filePath, before, after }) {
  const oldText = before ?? '';
  const newText = after ?? '';
  const { added, removed } = diffStats(oldText, newText);
  if (byteLength(oldText) > DETAIL_CAP || byteLength(newText) > DETAIL_CAP) {
    return {
      path: filePath,
      added,
      removed,
      linesBefore: splitLines(oldText).length,
      linesAfter: splitLines(newText).length,
      oversized: true,
    };
  }
  return { path: filePath, before: oldText, after: newText, added, removed };
}

/**
 * Host hook: after write/edit succeeds, keep official details and the diff
 * snapshot the right-hand changes list reads back.
 */
export function createWorkspaceExtension() {
  return defineExtension({
    name: 'pi-work-workspace',
    tools: workspaceToolList,
    hooks: [
      hook(ToolTask, {
        async afterTool(call, result) {
          const details = result?.details;
          const tracked = details
            && !result.isError
            && (call.name === 'write' || call.name === 'edit')
            && typeof details.path === 'string';
          if (!tracked) return undefined;
          const change = fileChangeDetails({
            path: details.path,
            before: details.before ?? '',
            after: details.after ?? '',
          });
          const { before: _before, after: _after, ...rest } = details;
          return {
            ...result,
            details: { ...rest, ...change },
          };
        },
      }),
    ],
  });
}

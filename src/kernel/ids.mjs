/** Persisted kinds and extension names written into Pi Durable storage. */
export const BRAND = 'weft';
export const KIND_PREFIX = `app.${BRAND}.`;

export const SUBAGENTS_DOC_KIND = `${KIND_PREFIX}subagents`;
export const SUBAGENT_ANCHOR_KIND = `${KIND_PREFIX}subagent-anchor`;
export const SUBAGENT_REPORTER_KIND = `${KIND_PREFIX}subagent-reporter`;
export const USER_TO_SUBAGENT_KIND = `${KIND_PREFIX}user-to-subagent`;

export const EXT_SUBAGENTS = `${BRAND}-subagents`;
export const EXT_SKILLS = `${BRAND}-skills`;
export const EXT_BUILTIN_TOOLS = `${BRAND}-builtin-tools`;
export const EXT_PLUGIN_TOOLS = `${BRAND}-plugin-tools`;
export const EXT_PLUGIN_RELOAD = `${BRAND}-plugin-reload`;
export const EXT_USAGE = `${BRAND}-usage`;
export const EXT_CONTINUATION = `${BRAND}-continuation`;
export const EXT_WORKSPACE = `${BRAND}-workspace`;
export const EXT_FAUX_SCRIPT = `${BRAND}-faux-script`;

export const KIND_NAMES = Object.freeze([
  SUBAGENTS_DOC_KIND,
  SUBAGENT_ANCHOR_KIND,
  SUBAGENT_REPORTER_KIND,
  USER_TO_SUBAGENT_KIND,
]);

export const EXTENSION_NAMES = Object.freeze([
  EXT_SUBAGENTS,
  EXT_SKILLS,
  EXT_BUILTIN_TOOLS,
  EXT_PLUGIN_TOOLS,
  EXT_PLUGIN_RELOAD,
  EXT_USAGE,
  EXT_CONTINUATION,
  EXT_WORKSPACE,
  EXT_FAUX_SCRIPT,
]);

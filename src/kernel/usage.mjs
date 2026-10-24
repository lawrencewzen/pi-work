// Latest-call context chip for the Pi Durable kernel.
// `docs["pi.usage"]` and `usage_changed` accumulate every attempt. The chip
// reads the newest assistant entry that reported tokens, then `presentContext`.
// A later call that reports nothing leaves the previous chip in place.
// Faux estimates are replaced in `afterResponse`, before the entry is committed,
// and only when a script turn named its own usage. This hook does not schedule.
import { defineExtension, GenerationTask, hook } from '@earendil-works/pi-durable';
import { EXT_USAGE } from './ids.mjs';
import { normalizeUsage } from '../core/usage.mjs';

const MARK = 'weftScriptUsage';
const OMITTED = 'weftUsageOmitted';

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toProviderUsage(normalized) {
  const input = normalized.input ?? 0;
  const output = normalized.output ?? 0;
  const cacheRead = normalized.cacheRead ?? 0;
  const cacheWrite = normalized.cacheWrite ?? 0;
  const totalTokens = normalized.total ?? (input + output + cacheRead + cacheWrite);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * Remember the script turn's usage on the faux message.
 * `withUsageEstimate` overwrites `usage` and keeps other own fields, so
 * `afterResponse` can put the script numbers back before the entry is stored.
 * A turn with no usage field is marked omitted so the estimate does not become the chip.
 */
export function stampScriptTurn(message, turn) {
  if (!message || !turn || typeof turn !== 'object') return message;
  if (!Object.prototype.hasOwnProperty.call(turn, 'usage')) {
    message[MARK] = { omit: true };
    return message;
  }
  const normalized = normalizeUsage(turn.usage);
  message[MARK] = normalized ? { usage: toProviderUsage(normalized) } : { omit: true };
  return message;
}

/** Apply a stamp, if this message has one. Safe to call on every assistant message. */
export function applyStampedUsage(message) {
  if (!message || !Object.prototype.hasOwnProperty.call(message, MARK)) return false;
  const mark = message[MARK];
  delete message[MARK];
  if (!mark || mark.omit || !mark.usage) {
    message.usage = zeroUsage();
    message[OMITTED] = true;
    return true;
  }
  delete message[OMITTED];
  message.usage = mark.usage;
  return true;
}

/** Usage the chip may show for one assistant message, or null when that call reported none. */
export function reportedUsage(message) {
  if (!message || message[OMITTED] === true) return null;
  const usage = message.usage;
  if (!usage || typeof usage !== 'object') return null;
  return usage;
}

/**
 * Usage of the newest assistant call that reported tokens.
 * A later call with no usage does not clear the one before it.
 */
export function latestCallUsage(entries) {
  let usage = null;
  for (const entry of entries || []) {
    if (entry?.kind !== 'pi.assistant') continue;
    const reported = reportedUsage(entry.model?.[0]);
    if (reported) usage = reported;
  }
  return usage;
}

/** Install the generation hook that copies script usage onto the committed assistant entry. */
export function installUsageExtension(registry) {
  if (!registry) throw new Error('registry is required');
  registry.install(defineExtension({
    name: EXT_USAGE,
    hooks: [
      hook(GenerationTask, {
        afterResponse(message) {
          applyStampedUsage(message);
        },
      }),
    ],
  }));
}

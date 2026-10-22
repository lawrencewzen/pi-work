// Re-exported so the server and the browser share one implementation.
// The browser can only load files under public/.
export {
  normalizeUsage,
  attachUsage,
  contextUsed,
  contextWindowFromEnv,
  formatTokenCount,
  formatContextValue,
  presentContext,
  composerContextText,
} from '../../public/usage.js';

import { formatContextValue, presentContext } from '../../public/usage.js';

/**
 * Prefer a resolved model window over `presentContext`'s env/provider value.
 * `window` null leaves the presented object unchanged (no available model).
 */
export function overlayContextWindow(presented, window) {
  if (presented == null || window == null) return presented;
  let usageForLabel = presented.usage;
  if (usageForLabel && Object.prototype.hasOwnProperty.call(usageForLabel, 'contextWindow')) {
    usageForLabel = { ...usageForLabel };
    delete usageForLabel.contextWindow;
  }
  return {
    usage: presented.usage,
    contextWindow: window,
    contextLabel: formatContextValue(usageForLabel, window),
  };
}

/** presentContext, then overlay a per-model window when one was resolved. */
export function presentConversationContext(usage, window, env = process.env) {
  return overlayContextWindow(presentContext(usage, env), window);
}

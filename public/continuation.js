// Shared auto-continue prefix. The kernel, the browser, and tests all match this.

export const AUTO_CONTINUE_PREFIX = '[auto-continue]';

export const CONTINUE_TEXT = `${AUTO_CONTINUE_PREFIX} 上一条回复因输出长度上限被截断，请从断点处直接接着写，不重复已写内容，不加开场白（若断在代码块里，接着写代码块内容）。`;

/** User-facing continue button sends this as a real user message. */
export const MANUAL_CONTINUE_TEXT = '继续';

/** Consecutive auto-continues in one run, counted from the last real user message. */
export const MAX_AUTO_CONTINUES = 8;

export function isAutoContinueText(text) {
  return String(text ?? '').startsWith(AUTO_CONTINUE_PREFIX);
}

export function isPromptUserMessage(message) {
  if (!message || message.role !== 'user') return false;
  if (message.kind === 'auto-continue') return false;
  return !isAutoContinueText(message.text);
}

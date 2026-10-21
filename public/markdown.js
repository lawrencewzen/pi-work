import { Marked } from './vendor/marked.esm.js';
import DOMPurify from './vendor/purify.es.mjs';

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  async: false,
  renderer: {
    code({ text, lang }) {
      const language = String(lang || '').trim().split(/\s+/)[0] || 'text';
      const body = String(text ?? '').replace(/\n$/, '');
      return (
        `<div class="code-block-card">` +
        `<div class="code-block-bar"><span>${escapeHtml(language)}</span></div>` +
        `<pre class="code-block-pre"><code>${escapeHtml(body)}</code></pre>` +
        `</div>\n`
      );
    },
    list(token) {
      const ordered = token.ordered;
      const start = token.start;
      let items = '';
      for (const item of token.items) items += this.listitem(item);
      const tag = ordered ? 'ol' : 'ul';
      const startAttr = ordered && start !== 1 ? ` start="${start}"` : '';
      const cls = token.items.some((item) => item.task) ? ' class="contains-task-list"' : '';
      return `<${tag}${startAttr}${cls}>\n${items}</${tag}>\n`;
    },
    listitem(item) {
      const body = this.parser.parse(item.tokens);
      if (item.task) return `<li class="task-list-item">${body}</li>\n`;
      return `<li>${body}</li>\n`;
    },
  },
});

const PURIFY_CONFIG = {
  ADD_TAGS: ['input'],
  ADD_ATTR: ['target', 'rel', 'checked', 'disabled', 'type', 'class', 'start'],
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
};

let purifyInstance = null;

function getPurify() {
  if (purifyInstance?.isSupported) return purifyInstance;
  let impl = DOMPurify;
  if (!impl.isSupported) {
    const root = globalThis.window;
    if (root?.document) impl = DOMPurify(root);
  }
  if (!impl?.isSupported) {
    throw new Error('DOMPurify requires a DOM');
  }
  impl.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  impl.addHook('uponSanitizeElement', (node, data) => {
    if (data.tagName !== 'input') return;
    const type = String(node.getAttribute?.('type') || '').toLowerCase();
    if (type !== 'checkbox') node.parentNode?.removeChild(node);
  });
  purifyInstance = impl;
  return impl;
}

export function renderMarkdown(src = '') {
  if (!src) return '';
  const html = marked.parse(String(src), { async: false });
  return getPurify().sanitize(html, PURIFY_CONFIG);
}

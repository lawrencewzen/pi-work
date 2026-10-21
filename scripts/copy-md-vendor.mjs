import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'public', 'vendor');

/** Exact browser ESM builds to copy. Do not add other node_modules files. */
const FILES = [
  ['marked', 'marked.esm.js'],
  ['dompurify', 'purify.es.mjs'],
];

mkdirSync(DEST, { recursive: true });
for (const [pkg, destName] of FILES) {
  const src = fileURLToPath(import.meta.resolve(pkg));
  let text = readFileSync(src, 'utf8');
  text = text.replace(/\n\/\/# sourceMappingURL=[^\n]*\n?/g, '\n');
  if (!text.endsWith('\n')) text += '\n';
  writeFileSync(path.join(DEST, destName), text);
  process.stdout.write(`copied ${pkg} -> public/vendor/${destName}\n`);
}

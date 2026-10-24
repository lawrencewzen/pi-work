import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// tests/unit/_root.mjs -> repo root (override with WEFT_ROOT)
export const ROOT = process.env.WEFT_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);

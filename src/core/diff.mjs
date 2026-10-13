/** Split into lines; trailing newline and CRLF are not counted as extra lines. */
export function splitLines(text) {
  if (text == null || text === '') return [];
  const s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsLengths(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp;
}

function diffOps(a, b) {
  const dp = lcsLengths(a, b);
  const ops = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      ops.push({ type: 'equal', line: a[i - 1] });
      i--;
      j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      ops.push({ type: 'remove', line: a[i - 1] });
      i--;
    } else {
      ops.push({ type: 'add', line: b[j - 1] });
      j--;
    }
  }
  while (i > 0) ops.push({ type: 'remove', line: a[--i] });
  while (j > 0) ops.push({ type: 'add', line: b[--j] });
  ops.reverse();
  return ops;
}

export function diffStats(oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'remove') removed++;
  }
  return { added, removed };
}

function hunkHeader(oldStart, oldCount, newStart, newCount) {
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/** Unified diff with 3 lines of context. */
export function unifiedDiff(filePath, oldText, newText) {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  const ops = diffOps(a, b);
  if (!ops.some((op) => op.type !== 'equal')) return `--- a/${filePath}\n+++ b/${filePath}\n`;

  const indexed = [];
  let oi = 0;
  let ni = 0;
  for (const op of ops) {
    if (op.type === 'equal') {
      oi++;
      ni++;
      indexed.push({ ...op, oldLine: oi, newLine: ni });
    } else if (op.type === 'remove') {
      oi++;
      indexed.push({ ...op, oldLine: oi, newLine: ni });
    } else {
      ni++;
      indexed.push({ ...op, oldLine: oi, newLine: ni });
    }
  }

  const context = 3;
  const changeIdx = [];
  for (let i = 0; i < indexed.length; i++) if (indexed[i].type !== 'equal') changeIdx.push(i);
  if (changeIdx.length === 0) return `--- a/${filePath}\n+++ b/${filePath}\n`;

  const ranges = [];
  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(indexed.length - 1, changeIdx[0] + context);
  for (let k = 1; k < changeIdx.length; k++) {
    const ci = changeIdx[k];
    if (ci - context <= end + 1) {
      end = Math.min(indexed.length - 1, ci + context);
    } else {
      ranges.push([start, end]);
      start = Math.max(0, ci - context);
      end = Math.min(indexed.length - 1, ci + context);
    }
  }
  ranges.push([start, end]);

  const parts = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (const [hs, he] of ranges) {
    const slice = indexed.slice(hs, he + 1);
    let oldCount = 0;
    let newCount = 0;
    for (const op of slice) {
      if (op.type === 'equal' || op.type === 'remove') oldCount++;
      if (op.type === 'equal' || op.type === 'add') newCount++;
    }
    let oldStart;
    let newStart;
    const firstOld = slice.find((op) => op.type === 'equal' || op.type === 'remove');
    const firstNew = slice.find((op) => op.type === 'equal' || op.type === 'add');
    if (oldCount === 0) oldStart = slice[0]?.oldLine ?? 0;
    else oldStart = firstOld.oldLine;
    if (newCount === 0) newStart = slice[0]?.newLine ?? 0;
    else newStart = firstNew.newLine;
    if (oldCount === 0 && a.length === 0) oldStart = 0;
    if (newCount === 0 && b.length === 0) newStart = 0;
    parts.push(hunkHeader(oldStart, oldCount, newStart, newCount));
    for (const op of slice) {
      if (op.type === 'equal') parts.push(` ${op.line}`);
      else if (op.type === 'remove') parts.push(`-${op.line}`);
      else parts.push(`+${op.line}`);
    }
  }
  return parts.join('\n') + '\n';
}

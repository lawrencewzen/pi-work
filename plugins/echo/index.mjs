const MAX = 4000;

export async function echo(args) {
  const text = args && typeof args.text === 'string' ? args.text : '';
  if (!text) return { output: 'echo: text is required', status: 'error' };
  if (text.length > MAX) return { output: 'echo: text is too long', status: 'error' };
  return { output: text, status: 'completed' };
}

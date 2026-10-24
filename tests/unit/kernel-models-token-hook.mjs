// Test-only fetch hook. The product never loads this file.
// Grok refresh always posts to the x.ai issuer; this redirects that one URL
// at a local fake so the suite does not call the network.
const target = String(process.env.WEFT_TEST_GROK_TOKEN_URL || '').trim();
if (target) {
  const orig = globalThis.fetch.bind(globalThis);
  const tokenPath = 'https://auth.x.ai/oauth2/token';
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string'
      ? input
      : (input instanceof URL ? input.href : (input && typeof input.url === 'string' ? input.url : ''));
    if (url === tokenPath || url.startsWith(`${tokenPath}?`)) return orig(target, init);
    return orig(input, init);
  };
}

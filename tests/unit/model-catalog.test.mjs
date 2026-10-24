import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogContextWindow, catalogMaxTokens, lookupModelCatalog } from '../../src/kernel/model-catalog.mjs';

test('lookup prefers same id and hostname, then a unique id', () => {
  const flash = lookupModelCatalog('deepseek-flash', 'https://api.deepseek.com/v1');
  assert.equal(flash?.id, 'deepseek-flash');
  assert.equal(flash.contextWindow, 1_000_000);
  assert.equal(flash.maxTokens, 384000);
  assert.equal(flash.reasoning, true);
  assert.deepEqual(flash.input, ['text', 'image']);
  assert.equal(flash.compat?.maxTokensField, 'max_tokens');
  assert.equal(catalogContextWindow(flash), 1_000_000);
  assert.equal(catalogMaxTokens(flash), 384000);

  const uniqueOnLocal = lookupModelCatalog('deepseek-flash', 'http://127.0.0.1:9/v1');
  assert.equal(uniqueOnLocal?.id, 'deepseek-flash');
  assert.equal(uniqueOnLocal.contextWindow, 1_000_000);

  const pro = lookupModelCatalog('deepseek-v4-pro', 'https://api.deepseek.com/v1');
  assert.equal(pro?.id, 'deepseek-v4-pro');
  assert.equal(pro.provider, 'deepseek');
  assert.equal(pro.contextWindow, 1_000_000);

  assert.equal(lookupModelCatalog('deepseek-v4-pro', 'http://127.0.0.1:9/v1'), null);
  assert.equal(lookupModelCatalog('not-a-real-model', 'https://api.deepseek.com/v1'), null);
  assert.equal(lookupModelCatalog('', 'https://api.deepseek.com/v1'), null);

  const grokOnOpenai = lookupModelCatalog('grok-4.6', 'https://api.openai.com/v1');
  assert.equal(grokOnOpenai, null);
  const grokOnXai = lookupModelCatalog('grok-4.6', 'https://api.x.ai/v1');
  assert.equal(grokOnXai?.id, 'grok-4.6');
  assert.equal(grokOnXai.contextWindow, 500000);
});

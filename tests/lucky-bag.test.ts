import assert from 'node:assert/strict';
import test from 'node:test';
import { enterLuckyBag } from '../lib/lucky-bag.ts';

test('lucky bag POST preserves a real Origin under the site no-referrer policy', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ state: 'off', campaign: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    assert.deepEqual(await enterLuckyBag(), { state: 'off', campaign: null });
    assert.equal(requestUrl, '/api/lucky-bag/enter');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(requestInit?.credentials, 'same-origin');
    assert.equal(requestInit?.mode, undefined);
    assert.equal(requestInit?.redirect, 'error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

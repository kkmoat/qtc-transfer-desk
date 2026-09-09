import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc, RPC_URLS } from '../lib/quantus/protocol.ts';

test('RPC rejects unexpected destinations and methods before making a request', async t => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('Unexpected request'); };
  t.after(() => { globalThis.fetch = original; });
  assert.throws(() => new Rpc('https://example.com'), /官方主网/);
  await assert.rejects(new Rpc().call('author_insertKey', ['secret']), /允许范围/);
  const client = new Rpc();
  Object.assign(client, { endpoint: 'https://example.com' });
  await assert.rejects(client.call('system_properties'), /允许范围/);
  assert.equal(calls, 0);
});

test('RPC omits cookies and referrers, rejects redirects and sends only explicit parameters', async t => {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    assert.equal(url, RPC_URLS[0]);
    assert.equal(options?.credentials, 'omit');
    assert.equal(options?.referrerPolicy, 'no-referrer');
    assert.equal(options?.redirect, 'error');
    const body = JSON.parse(String(options?.body));
    assert.deepEqual(Object.keys(body).sort(), ['id', 'jsonrpc', 'method', 'params']);
    assert.equal(body.method, 'chain_getBlockHash');
    assert.deepEqual(body.params, [0]);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: 'public-block-hash' }));
  };
  t.after(() => { globalThis.fetch = original; });
  assert.equal(await new Rpc().call('chain_getBlockHash', [0]), 'public-block-hash');
});

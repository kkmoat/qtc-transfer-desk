// Read-only verification. Never imports a wallet or broadcasts a transaction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DOCUMENT_CSP, WORKER_CSP, RPC_ORIGINS } from './security-policy.mjs';

const rpcOnly = process.argv.includes('--rpc-only');
const withRpc = rpcOnly || process.argv.includes('--with-rpc');
const origin = new URL(process.argv.find(value => value.startsWith('https://')) ?? 'https://www.qtc123.com');
assert.equal(origin.protocol, 'https:');
assert.equal(origin.pathname, '/');
assert(!origin.username && !origin.password && !origin.search && !origin.hash);
const digest = value => createHash('sha256').update(value).digest('hex');
const request = (url, options = {}) => fetch(url, { redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000), ...options });

async function verifyDirectory(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await verifyDirectory(path, relative + '/'); continue; }
    const route = relative.endsWith('index.html') ? '/' + relative.slice(0, -'index.html'.length) : '/' + relative;
    const response = await request(new URL(route, origin));
    assert.equal(response.status, 200, `Public resource unavailable: ${route}`);
    const expectedCSP = relative === 'crypto/worker.js' ? WORKER_CSP : DOCUMENT_CSP;
    assert.equal(response.headers.get('content-security-policy'), expectedCSP, `Unexpected CSP: ${route}`);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    if (relative.endsWith('.wasm')) assert(response.headers.get('content-type')?.startsWith('application/wasm'));
    if (relative.endsWith('.js')) assert(/(?:text|application)\/javascript/.test(response.headers.get('content-type') ?? ''));
    const actual = Buffer.from(await response.arrayBuffer());
    assert.equal(digest(actual), digest(await readFile(path)), `Deployed bytes differ from this checkout: ${route}`);
    console.log(`Verified ${route}: HTTP 200, security headers and SHA-256 match`);
  }
}

if (!rpcOnly) {
  await verifyDirectory('dist');
  for (const route of ['/api/sign', '/.env.local', '/.git/config']) {
    const response = await request(new URL(route, origin));
    assert([403, 404].includes(response.status), `Unexpected exposed route: ${route}`);
    console.log(`Unavailable as expected: ${route} (${response.status})`);
  }
  console.log('Public static deployment verified without wallet credentials or transaction submission.');
}
if (withRpc) for (const endpoint of RPC_ORIGINS) {
  const response = await request(endpoint, { method: 'OPTIONS', headers: { Origin: origin.origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert(response.ok, `RPC preflight failed: ${endpoint} (HTTP ${response.status})`);
  assert(['*', origin.origin].includes(response.headers.get('access-control-allow-origin')), `RPC does not permit this browser origin: ${endpoint}`);
  assert(/post|\*/i.test(response.headers.get('access-control-allow-methods') ?? ''));
  assert(/content-type|\*/i.test(response.headers.get('access-control-allow-headers') ?? ''));
  const rpc = await request(endpoint, { method: 'POST', headers: { Origin: origin.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'system_properties', params: [] }) });
  assert(rpc.ok, `RPC public query failed: ${endpoint} (HTTP ${rpc.status})`);
  assert(['*', origin.origin].includes(rpc.headers.get('access-control-allow-origin')));
  const result = await rpc.json();
  assert.equal(result.id, 1);
  assert.equal(result.result.tokenSymbol, 'QTC');
  assert.equal(result.result.tokenDecimals, 12);
  console.log(`Verified browser RPC CORS and public query: ${endpoint}`);
}

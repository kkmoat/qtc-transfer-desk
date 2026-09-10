import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto';
import { GENESIS, RPC_URLS, addressBytes, compact, concat, fromLittle, hex, little, storagePrefix, unhex } from '../lib/quantus/protocol.ts';
import { WORMHOLE_CODE_HASH, WORMHOLE_QUANTUM, WormholeRpc, WormholeRpcError, summarizeWormholeSelection, prepareWormholeWithdrawal, bindWormholeProof, parseWormholeExtrinsicPublicInputs, parseWormholeWithdrawalReceipt, submitWormholeWithdrawalOnce, type WormholeRpcLike, type WormholeVerifiedProof, type PreparedWormholeWithdrawal, type WormholeWithdrawalReceipt } from '../lib/wormhole/withdraw.ts';
import type { WormholeBalanceSnapshot, WormholeUtxo } from '../lib/wormhole/data.ts';

const metadata = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-metadata.json', import.meta.url), 'utf8')).result;
const live = JSON.parse(fs.readFileSync(new URL('./fixtures/wormhole-public-merkle.json', import.meta.url), 'utf8'));
const BLOCK = live.blockHash as string;
const HEIGHT = Number(BigInt(live.header.number));
const BEST = '0x' + '23'.repeat(32);
const DEPOSIT = '0x' + '34'.repeat(32);
const self = encodeAddress(little(753n, 32), 189);
const other = encodeAddress(little(754n, 32), 189);
const depositAddress = encodeAddress(Uint8Array.from(live.proof.leaf_data.slice(0, 32)), 189);
const realNullifier = hex(little(911n, 32));
const allNullifiers = Array.from({ length: 7 }, (_, i) => i ? hex(little(BigInt(911 + i), 32)) : realNullifier);
const baseUtxo: WormholeUtxo = { branch: 0, index: 0, address: depositAddress, id: 'public-leaf-zero', blockHeight: 1, amountPlanck: 3_000_000_000_000n, leafIndex: '0', transferCount: '0', toHash: '11'.repeat(32) };
function snapshot(utxos = [{ ...baseUtxo }]): WormholeBalanceSnapshot {
  return { balancePlanck: utxos.reduce((sum, u) => sum + u.amountPlanck, 0n), utxos, addresses: [], branches: [{ branch: 0, scannedCount: 21, usedIndices: [0], nextIndex: 1 }, { branch: 1, scannedCount: 20, usedIndices: [], nextIndex: 0 }], snapshot: { genesis: GENESIS, blockHash: BLOCK, blockHeight: HEIGHT, indexedHeight: HEIGHT + 100, checkedAt: 123, finality: 'finalized' }, scope: 'gap-limit-20', gapLimit: 20, maxAddressesPerBranch: 1000, receivedTransferCount: utxos.length, spentTransferCount: 0 };
}
function depositEvent(utxo = baseUtxo): string {
  const event = concat(Uint8Array.of(20, 0), addressBytes(other), addressBytes(utxo.address), little(utxo.amountPlanck, 16), little(BigInt(utxo.transferCount), 8), little(BigInt(utxo.leafIndex), 8));
  return hex(concat(compact(1n), Uint8Array.of(2), event, Uint8Array.of(0))); // Initialization phase, no topics.
}
function fixture() {
  const calls: { method: string; params: unknown[] }[] = [];
  let mutate: ((method: string, result: unknown, params: unknown[]) => unknown) | undefined;
  let checked = 0;
  const rpc: WormholeRpcLike = { async call<T>(method: string, params: unknown[] = []): Promise<T> {
    calls.push({ method, params }); let result: unknown;
    if (method === 'chain_getFinalizedHead') result = BLOCK;
    else if (method === 'chain_getBlockHash') result = params[0] === 0 ? GENESIS : params[0] === 1 ? DEPOSIT : params.length ? BLOCK : BEST;
    else if (method === 'chain_getHeader') result = params[0] === BEST ? { ...live.header, number: '0x' + (HEIGHT + 100).toString(16) } : structuredClone(live.header);
    else if (method === 'state_getRuntimeVersion') result = { specName: 'quantus-runtime', specVersion: 152, transactionVersion: 6 };
    else if (method === 'state_getStorageHash') result = WORMHOLE_CODE_HASH;
    else if (method === 'state_getMetadata') result = metadata;
    else if (method === 'state_getStorage') result = params[0] === storagePrefix('System', 'Events') ? depositEvent() : String(params[0]).startsWith(storagePrefix('System', 'BlockHash')) ? BLOCK : null;
    else if (method === 'state_queryStorageAt') result = [{ block: params[1], changes: (params[0] as string[]).map(key => [key, null]) }];
    else if (method === 'zkTree_getMerkleProof') result = structuredClone(live.proof);
    else if (method === 'author_submitExtrinsic') result = blake2AsHex(params[0] as string, 256);
    else assert.fail('Unexpected RPC call: ' + method);
    return (mutate ? mutate(method, result, params) : result) as T;
  } };
  const options = { snapshot: snapshot(), selectedIds: [baseUtxo.id], selfAddress: self, normalAccountIndex: 0, rpc,
    computeNullifiers: async () => [realNullifier],
    checkProofRequest: async (request: Parameters<import('../lib/wormhole/withdraw.ts').PrepareWormholeWithdrawalOptions['checkProofRequest']>[0]) => {
      checked++; assert.equal(request.block.hash, BLOCK); assert.equal(request.inputs[0].leafData, hex(Uint8Array.from(live.proof.leaf_data)));
      assert.equal(request.inputs[0].siblings.length, live.proof.depth);
      return { verified: true as const, codeHash: WORMHOLE_CODE_HASH, normalAddress: request.expectedNormalAddress, inputPlanck: request.expected.inputPlanck, netPlanck: request.expected.netPlanck, feePlanck: request.expected.feePlanck, realNullifiers: [realNullifier] };
    },
  };
  return { rpc, calls, options, checked: () => checked, mutate: (fn: typeof mutate) => { mutate = fn; } };
}
let fixtureNonce = 1;
function proofResult(prepared: PreparedWormholeWithdrawal, modify?: (values: bigint[]) => void): WormholeVerifiedProof {
  const pi = new Array<bigint>(162).fill(0n); const limbs = (bytes: Uint8Array) => Array.from({ length: 4 }, (_, i) => fromLittle(bytes.slice(i * 8, i * 8 + 8)));
  pi[0] = 14n; pi[2] = 4n; pi.splice(3, 4, ...limbs(unhex(BLOCK))); pi[7] = BigInt(HEIGHT);
  pi[8] = prepared.selection.netToSelfPlanck / WORMHOLE_QUANTUM; pi.splice(9, 4, ...limbs(addressBytes(self)));
  allNullifiers.forEach((value, i) => pi.splice(78 + i * 4, 4, ...limbs(unhex(value))));
  modify?.(pi);
  // PUBLIC framing fixture, not a cryptographically valid proof and never sent to a live node.
  const bytes = concat(little(BigInt(fixtureNonce++), 16), little(162n, 8), ...pi.map(value => little(value, 8)));
  return { verified: true, codeHash: WORMHOLE_CODE_HASH, normalAddress: self, inputPlanck: prepared.selection.inputPlanck.toString(), netPlanck: prepared.selection.netToSelfPlanck.toString(), feePlanck: prepared.selection.totalLossPlanck.toString(), realNullifiers: [realNullifier], publicInputs: pi.map(String), proofBytes: Array.from(bytes) };
}
async function readyFixture() { const f = fixture(); const p = await prepareWormholeWithdrawal(f.options); return { ...f, prepared: p, ready: bindWormholeProof(p, proofResult(p)) }; }

test('selection consumes only explicitly selected leaves, keeps remaining funds, and computes exact dust', () => {
  const a = { ...baseUtxo, amountPlanck: 1_000_000_000_001n };
  const b = { ...baseUtxo, id: 'second', leafIndex: '1', amountPlanck: 2_000_000_000_002n };
  const result = summarizeWormholeSelection([a, b], [b.id]);
  assert.equal(result.inputPlanck, b.amountPlanck); assert.equal(result.remainingPlanck, a.amountPlanck);
  assert.equal(result.quantumDustPlanck, 2n); assert.deepEqual(result.scaledInputs, [200]); assert.equal(result.selectedCount, 1);
  assert.notEqual(result.selected[0], b);
});

test('selection rejects no leaves, more than seven, duplicates, unavailable leaves, dust-only and u32 overflow', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ ...baseUtxo, id: String(i) }));
  for (const ids of [[], ['0', '0'], ['missing'], many.map(u => u.id)]) assert.throws(() => summarizeWormholeSelection(many, ids));
  for (const value of [0n, WORMHOLE_QUANTUM - 1n, (1n << 32n) * WORMHOLE_QUANTUM]) assert.throws(() => summarizeWormholeSelection([{ ...baseUtxo, amountPlanck: value }], [baseUtxo.id]));
});

test('prepare binds runtime code, finalized block, original event, Merkle bytes and Worker ownership check', async () => {
  const f = fixture(); const p = await prepareWormholeWithdrawal(f.options);
  assert.equal(f.checked(), 1); assert.equal(p.context.codeHash, WORMHOLE_CODE_HASH);
  assert.equal(p.context.proofBlock, HEIGHT); assert.equal(p.context.expiresAt, HEIGHT + 4097);
  assert.equal(p.selection.inputPlanck, 3_000_000_000_000n); assert.equal(p.selection.netToSelfPlanck, 2_990_000_000_000n);
  assert.equal(p.selection.volumeFeePlanck, WORMHOLE_QUANTUM); assert.equal(p.selection.quantumDustPlanck, 0n);
  assert.ok(f.calls.some(c => c.method === 'state_getStorage' && c.params[0] === storagePrefix('System', 'Events')));
  assert.ok(!f.calls.some(c => c.method === 'author_submitExtrinsic'));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.proofRequest.inputs[0]) && Object.isFrozen(p.selection.selected[0]));
});

test('changed runtime, wrong snapshot, missing deposit and indexer amount mismatch all stop before proof check', async () => {
  for (const mutation of [
    (method: string, value: unknown) => method === 'state_getStorageHash' ? BEST : value,
    (method: string, value: unknown) => method === 'state_getRuntimeVersion' ? { specName: 'quantus-runtime', specVersion: 153, transactionVersion: 6 } : value,
    (method: string, value: unknown, params: unknown[]) => method === 'chain_getBlockHash' && params[0] === HEIGHT ? BEST : value,
    (method: string, value: unknown, params: unknown[]) => method === 'state_getStorage' && params[0] === storagePrefix('System', 'Events') ? null : value,
    (method: string, value: unknown, params: unknown[]) => method === 'state_getStorage' && params[0] === storagePrefix('System', 'Events') ? depositEvent({ ...baseUtxo, amountPlanck: baseUtxo.amountPlanck + 1n }) : value,
  ]) {
    const f = fixture(); f.mutate(mutation); await assert.rejects(prepareWormholeWithdrawal(f.options)); assert.equal(f.checked(), 0);
  }
});

test('Merkle response leaf identity, recipient, count, amount, root and path shape are mandatory', async () => {
  for (const mutate of [
    (proof: typeof live.proof) => { proof.leaf_index = 1; },
    (proof: typeof live.proof) => { proof.leaf_data[0] ^= 1; },
    (proof: typeof live.proof) => { proof.leaf_data[32] = 1; },
    (proof: typeof live.proof) => { proof.leaf_data[40] = 1; },
    (proof: typeof live.proof) => { proof.leaf_data[44] ^= 1; },
    (proof: typeof live.proof) => { proof.root[0] ^= 1; },
    (proof: typeof live.proof) => { proof.siblings[0].pop(); },
  ]) { const f = fixture(); f.mutate((method, result) => { if (method === 'zkTree_getMerkleProof') mutate(result); return result; }); await assert.rejects(prepareWormholeWithdrawal(f.options)); }
});

test('cryptographic Worker check is required and cannot change normal ownership or amounts', async () => {
  for (const changed of [{ normalAddress: other }, { netPlanck: '1' }, { realNullifiers: [BEST] }, { verified: false }]) {
    const f = fixture(); const check = f.options.checkProofRequest;
    await assert.rejects(prepareWormholeWithdrawal({ ...f.options, checkProofRequest: async request => ({ ...await check(request), ...changed }) as never }), /local proof check/);
  }
  const f = fixture(); await assert.rejects(prepareWormholeWithdrawal({ ...f.options, checkProofRequest: async () => { throw new Error('Merkle verification failed'); } }), /Merkle verification failed/);
});

test('spent or incomplete nullifier response prevents preparing a new proof', async () => {
  for (const changes of [[], [['unexpected', null]]]) {
    const f = fixture(); f.mutate((method, result) => method === 'state_queryStorageAt' ? [{ block: BEST, changes }] : result);
    await assert.rejects(prepareWormholeWithdrawal(f.options));
  }
  const f = fixture(); f.mutate((method, result) => method === 'state_queryStorageAt' ? [{ block: BEST, changes: (result as { changes: [string, null][] }[])[0].changes.map(([key]) => [key, '0x01']) }] : result);
  await assert.rejects(prepareWormholeWithdrawal(f.options), /already spent/);
});

test('proof public fields are decoded from actual bytes and must match the checked request', async () => {
  const f = fixture(); const p = await prepareWormholeWithdrawal(f.options);
  const valid = proofResult(p); const ready = bindWormholeProof(p, valid);
  assert.equal(parseWormholeExtrinsicPublicInputs(ready.bytes).outputs[0].address, self);
  for (const mutate of [
    (pi: bigint[]) => { pi[8]--; },
    (pi: bigint[]) => { pi[9]++; },
    (pi: bigint[]) => { pi[7]--; },
    (pi: bigint[]) => { pi[3]++; },
    (pi: bigint[]) => { pi[78]++; },
    (pi: bigint[]) => { pi[106] = 1n; },
    (pi: bigint[]) => { pi[2] = 5n; },
  ]) assert.throws(() => bindWormholeProof(p, proofResult(p, mutate)));
  const mismatch = proofResult(p); mismatch.publicInputs[8] = '1'; assert.throws(() => bindWormholeProof(p, mismatch), /actual proof bytes/);
  const unverified = proofResult(p); unverified.verified = false as true; assert.throws(() => bindWormholeProof(p, unverified));
  assert.throws(() => bindWormholeProof({ ...p }, valid), /Prepare this withdrawal locally/);
});

test('synchronous persistence precedes broadcast; quota or async persistence failure never sends', async () => {
  const a = await readyFixture();
  await assert.rejects(submitWormholeWithdrawalOnce(a.ready, () => { throw new Error('QuotaExceeded'); }, { rpc: a.rpc }), /QuotaExceeded/);
  assert.equal(a.calls.filter(c => c.method === 'author_submitExtrinsic').length, 0);
  const b = await readyFixture();
  await assert.rejects(submitWormholeWithdrawalOnce(b.ready, (() => Promise.resolve()) as never, { rpc: b.rpc }), /synchronously/);
  assert.equal(b.calls.filter(c => c.method === 'author_submitExtrinsic').length, 0);
});

test('one exact byte sequence broadcasts once; uncertain response is retained and never retried', async () => {
  const f = await readyFixture(); const saved: WormholeWithdrawalReceipt[] = [];
  f.mutate((method, result) => { if (method === 'author_submitExtrinsic') { assert.equal(saved[0].phase, 'submitting'); throw new Error('Disconnected after write'); } return result; });
  const result = await submitWormholeWithdrawalOnce(f.ready, receipt => { saved.push(receipt); }, { rpc: f.rpc });
  assert.equal(result.phase, 'unknown'); assert.equal(result.bytes, f.ready.bytes);
  assert.equal(f.calls.filter(c => c.method === 'author_submitExtrinsic').length, 1);
  await assert.rejects(submitWormholeWithdrawalOnce(f.ready, () => {}, { rpc: f.rpc }), /already attempted/);
  assert.equal(f.calls.filter(c => c.method === 'author_submitExtrinsic').length, 1);
});

test('immediately before sending runtime, retained proof block and every public nullifier are rechecked', async () => {
  for (const kind of ['code', 'block', 'spent']) {
    const f = await readyFixture(); f.mutate((method, value, params) => {
      if (kind === 'code' && method === 'state_getStorageHash') return BEST;
      if (kind === 'block' && method === 'state_getStorage' && String(params[0]).startsWith(storagePrefix('System', 'BlockHash'))) return null;
      if (kind === 'spent' && method === 'state_queryStorageAt') return [{ block: BEST, changes: (params[0] as string[]).map((key, i) => [key, i === 6 ? '0x01' : null]) }];
      return value;
    });
    await assert.rejects(submitWormholeWithdrawalOnce(f.ready, () => {}, { rpc: f.rpc }));
    assert.equal(f.calls.filter(c => c.method === 'author_submitExtrinsic').length, 0);
  }
});

test('public receipt supports metadata-only storage, rejects altered binding, and strips unknown fields', async () => {
  const f = await readyFixture();
  // Give this framing fixture distinct bytes so the process-wide one-attempt guard remains meaningful.
  const proof = proofResult(f.prepared); proof.proofBytes[0] = 9;
  const ready = bindWormholeProof(f.prepared, proof);
  const r = await submitWormholeWithdrawalOnce(ready, () => {}, { rpc: f.rpc });
  assert.equal(r.phase, 'submitted');
  const { bytes: _bytes, ...publicReceipt } = r;
  assert.deepEqual(parseWormholeWithdrawalReceipt(publicReceipt), publicReceipt);
  const parsed = parseWormholeWithdrawalReceipt({ ...publicReceipt, phrase: 'must-not-persist' }); assert.ok(parsed && !('phrase' in parsed));
  for (const changed of [{ expiresAt: r.proofBlock + 64 }, { netToSelfPlanck: '1' }, { selfAddress: other }, { nullifiers: allNullifiers.slice(1) }, { bytes: r.bytes + '00' }]) assert.equal(parseWormholeWithdrawalReceipt({ ...r, ...changed }), null);
});

test('RPC confines endpoints/methods and applies credential/referrer restrictions', async () => {
  assert.throws(() => new WormholeRpc({ endpoint: 'https://example.com' }));
  let seen = 0;
  const rpc = new WormholeRpc({ fetcher: async (url, init) => { assert.equal(url, RPC_URLS[0]); assert.equal(init?.credentials, 'omit'); assert.equal(init.referrerPolicy, 'no-referrer'); assert.equal(init.redirect, 'error'); seen++; const body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ id: body.id, jsonrpc: '2.0', result: GENESIS })); } });
  assert.equal(await rpc.call('chain_getBlockHash', [0]), GENESIS);
  await assert.rejects(rpc.call('author_insertKey'), /Unsupported/); assert.equal(seen, 1);
});

test('default RPC transport preserves the browser fetch receiver while injected transport still overrides it', async context => {
  let browserCalls = 0;
  // Browsers reject Window.fetch called with a client object as its receiver;
  // Node's native fetch does not, so model that browser contract explicitly.
  context.mock.method(globalThis, 'fetch', async function (this: unknown, _url: Parameters<typeof fetch>[0], init?: RequestInit) {
    if (this !== globalThis) throw new TypeError('Illegal invocation');
    browserCalls++;
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: body.id, jsonrpc: '2.0', result: GENESIS }));
  });
  assert.equal(await new WormholeRpc().call('chain_getBlockHash', [0]), GENESIS);
  let injectedCalls = 0;
  const injected = new WormholeRpc({ fetcher: async (_url, init) => {
    injectedCalls++;
    const body = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ id: body.id, jsonrpc: '2.0', result: BEST }));
  } });
  assert.equal(await injected.call('chain_getBlockHash'), BEST);
  assert.equal(browserCalls, 1);
  assert.equal(injectedCalls, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { encodeAddress, blake2AsU8a } from '@polkadot/util-crypto';
import { GENESIS, RPC_URLS, addressBytes, hex, little, storagePrefix } from '../lib/quantus/protocol.ts';
import { scanWormholeBalance, WORMHOLE_INDEXER_URL, type WormholeBranch, type WormholeNullifierInput, type WormholeScanOptions } from '../lib/wormhole/data.ts';

const metadata = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-metadata.json', import.meta.url), 'utf8')).result;
const BLOCK = '0x' + 'ab'.repeat(32);
const OTHER = '0x' + 'cd'.repeat(32);
const addr = (branch: number, index: number) => encodeAddress(little(BigInt(branch * 10_000 + index + 1), 32), 189);
const nullifier = ({ branch, index, transferCount }: WormholeNullifierInput) => hex(little(BigInt(branch * 1_000_000 + index * 10_001) + BigInt(transferCount) + 1n, 32));
const key = (item: string, raw: Uint8Array) => storagePrefix('Wormhole', item) + hex(blake2AsU8a(raw, 128)).slice(2) + hex(raw).slice(2);
type Transfer = { id: string; block: { height: number }; to: { id: string }; amount: string; toHash: string; leafIndex: string; transferCount: string };
type Body = { id?: number; method?: string; params?: unknown[]; query?: string; variables?: Record<string, unknown> };
function fixture() {
  const used = new Set<string>();
  const counts = new Map<string, bigint>();
  const spent = new Set<string>();
  const transfers: Transfer[] = [];
  const calls: { url: string; body: Body; init: RequestInit }[] = [];
  let change: ((body: Body, result: unknown) => unknown) | undefined;
  let leaf = 0;
  function fund(branch: WormholeBranch, index: number, amounts: bigint[]) {
    const address = addr(branch, index);
    used.add(address);
    counts.set(key('TransferCount', addressBytes(address)), BigInt(amounts.length));
    for (let i = 0; i < amounts.length; i++) {
      const leafIndex = leaf++;
      transfers.push({ id: String(leafIndex).padStart(10, '0'), block: { height: 7 }, to: { id: address }, amount: amounts[i].toString(), toHash: '11'.repeat(32), leafIndex: String(leafIndex), transferCount: String(i) });
    }
  }
  const fetcher: typeof fetch = async (url, init) => {
    assert.ok(init);
    const body = JSON.parse(String(init.body)) as Body;
    calls.push({ url: String(url), body, init });
    let result: unknown;
    if (body.method) {
      assert.equal(String(url), RPC_URLS[0]);
      if (body.method === 'chain_getBlockHash') result = body.params?.[0] === 0 ? GENESIS : BLOCK;
      else if (body.method === 'chain_getFinalizedHead') result = BLOCK;
      else if (body.method === 'chain_getHeader') result = { number: '0xa' };
      else if (body.method === 'state_getMetadata') result = metadata;
      else if (body.method === 'state_queryStorageAt') {
        assert.equal(body.params?.[1], BLOCK);
        const keys = body.params?.[0] as string[];
        result = [{ block: BLOCK, changes: keys.map(k => [k, k.startsWith(storagePrefix('Wormhole', 'TransferCount')) ? (counts.has(k) ? hex(little(counts.get(k)!, 8)) : null) : spent.has(k) ? '0x01' : null]) }];
      } else assert.fail(`Unexpected RPC method ${body.method}`);
      result = change?.(body, result) ?? result;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    }
    assert.equal(String(url), WORMHOLE_INDEXER_URL);
    if (body.query?.includes('WormholeCheckpoint')) result = { genesis: [{ height: 0, hash: GENESIS }], indexedHead: [{ height: 10, hash: BLOCK }], snapshot: [{ height: 10, hash: BLOCK }] };
    else if (body.query?.includes('WormholeAccounts')) result = { accounts: (body.variables?.ids as string[]).filter(id => used.has(id)).map(id => ({ id })) };
    else if (body.query?.includes('WormholeTransfers')) {
      assert.match(body.query, /\{height: \{_lte: \$height\}\}/);
      assert.match(body.query, /order_by: \[\{block: \{height: asc\}\}, \{id: asc\}\]/);
      const tos = body.variables?.tos as string[];
      const offset = body.variables?.offset as number;
      result = { transfers: transfers.filter(t => tos.includes(t.to.id)).slice(offset, offset + Number(body.variables?.limit)) };
    } else assert.fail('Unexpected GraphQL operation');
    result = change?.(body, result) ?? result;
    return new Response(JSON.stringify({ data: result }));
  };
  const options: WormholeScanOptions = {
    fetcher,
    deriveAddresses: async (branch, start, count) => Array.from({ length: count }, (_, i) => addr(branch, start + i)),
    computeNullifiers: async inputs => inputs.map(nullifier),
  };
  return { options, fund, used, counts, transfers, calls, spent, mutate: (callback: typeof change) => { change = callback; } };
}

test('both branches reset gap20 at used addresses; spent leaves are checked on chain and amounts stay exact', async () => {
  const f = fixture();
  f.fund(0, 19, [9_007_199_254_740_993n, 5n]);
  f.fund(0, 38, [2n]);
  f.fund(1, 0, [3n]);
  f.spent.add(key('UsedNullifiers', little(190_020n, 32))); // branch0/index19/count0
  const result = await scanWormholeBalance(f.options);
  assert.equal(result.balancePlanck, 10n);
  assert.equal(result.spentTransferCount, 1);
  assert.deepEqual(result.branches, [
    { branch: 0, scannedCount: 59, usedIndices: [19, 38], nextIndex: 39 },
    { branch: 1, scannedCount: 21, usedIndices: [0], nextIndex: 1 },
  ]);
  assert.equal(result.gapLimit, 20);
  assert.equal(result.snapshot.blockHash, BLOCK);
  assert.equal(result.snapshot.finality, 'finalized');
  assert.equal(f.calls.filter(c => c.body.method === 'chain_getFinalizedHead').length, 1);
  assert.ok(!f.calls.some(c => c.body.method === 'chain_getBlockHash' && c.body.params?.length === 0));
  assert.equal(result.utxos.length, 3);
  assert.ok(result.utxos.every(value => !('nullifierHex' in value) && !('secretHex' in value)));
  for (const call of f.calls) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal(call.init.referrerPolicy, 'no-referrer');
    assert.equal(call.init.redirect, 'error');
    assert.equal(call.init.cache, 'no-store');
    assert.ok(!call.body.method || !/submit|author|sign/i.test(call.body.method));
  }
});

test('unspent amounts beyond Number precision remain exact', async () => {
  const f = fixture(); f.fund(0, 0, [9_007_199_254_740_993n]);
  assert.equal((await scanWormholeBalance(f.options)).balancePlanck, 9_007_199_254_740_993n);
});

test('genuine zero requires successful identity, two full gaps and on-chain transfer counts', async () => {
  const f = fixture();
  f.options.computeNullifiers = async () => { assert.fail('No leaves require nullifiers'); };
  const result = await scanWormholeBalance(f.options);
  assert.equal(result.balancePlanck, 0n);
  assert.deepEqual(result.branches.map(b => [b.scannedCount, b.nextIndex]), [[20, 0], [20, 0]]);
  assert.equal(result.addresses.length, 40);
  assert.equal(f.calls.filter(c => c.body.method === 'state_queryStorageAt').length, 2);
});

test('same-block siblings paginate beyond 300 without omission', async () => {
  const f = fixture(); f.fund(1, 0, Array.from({ length: 301 }, () => 1n));
  const result = await scanWormholeBalance(f.options);
  assert.equal(result.balancePlanck, 301n);
  assert.equal(result.receivedTransferCount, 301);
  assert.deepEqual(f.calls.filter(c => c.body.query?.includes('WormholeTransfers')).map(c => c.body.variables?.offset), [0, 300]);
});

test('address and transfer limits report incomplete balance rather than partial success', async () => {
  const f = fixture(); f.used.add(addr(0, 0));
  await assert.rejects(scanWormholeBalance({ ...f.options, maxAddressesPerBranch: 20 }), /scan limit/);
  const tooMany = fixture(); tooMany.fund(0, 0, []); tooMany.counts.set(key('TransferCount', addressBytes(addr(0, 0))), 10_001n);
  await assert.rejects(scanWormholeBalance(tooMany.options), /10,000-transfer scan limit/);
});

test('lagging indexer, wrong genesis and conflicting snapshot cannot produce zero', async () => {
  for (const [field, replacement, expected] of [
    ['indexedHead', [{ height: 9, hash: BLOCK }], /still syncing/],
    ['genesis', [{ height: 0, hash: OTHER }], /genesis/],
    ['snapshot', [{ height: 10, hash: OTHER }], /disagree/],
  ] as const) {
    const f = fixture();
    f.mutate((body, result) => body.query?.includes('WormholeCheckpoint') ? { ...(result as object), [field]: replacement } : result);
    await assert.rejects(scanWormholeBalance(f.options), expected);
  }
});

test('funded address omitted by indexer, absent account field, and missing storage keys all fail closed', async () => {
  const funded = fixture(); funded.fund(0, 0, [1n]); funded.used.clear();
  await assert.rejects(scanWormholeBalance(funded.options), /missing a funded address/);
  const missing = fixture(); missing.mutate((body, result) => body.query?.includes('WormholeAccounts') ? {} : result);
  await assert.rejects(scanWormholeBalance(missing.options), /Incomplete/);
  const storage = fixture(); storage.mutate((body, result) => body.method === 'state_queryStorageAt' ? [{ block: BLOCK, changes: [] }] : result);
  await assert.rejects(scanWormholeBalance(storage.options), /omitted a requested key/);
});

test('truncated transfer page and duplicate transfer counters cannot silently reduce or inflate balance', async () => {
  const truncated = fixture(); truncated.fund(0, 0, [1n, 2n]); truncated.transfers.pop();
  await assert.rejects(scanWormholeBalance(truncated.options), /history is incomplete/);
  const duplicate = fixture(); duplicate.fund(0, 0, [1n, 2n]); duplicate.transfers[1].transferCount = '0';
  await assert.rejects(scanWormholeBalance(duplicate.options), /Duplicate Wormhole transfer count/);
  const counter = fixture(); counter.fund(0, 0, [1n]); counter.transfers[0].transferCount = '1';
  await assert.rejects(scanWormholeBalance(counter.options), /disagrees with chain state/);
});

test('invalid amount and leaf fields are rejected without precision coercion', async () => {
  for (const bad of ['1e12', '-1', '1.0', 'NaN', (1n << 128n).toString(), 9007199254740992]) {
    const f = fixture(); f.fund(0, 0, [1n]); f.transfers[0].amount = bad as string;
    await assert.rejects(scanWormholeBalance(f.options), /Invalid transfer amount/);
  }
  const leaf = fixture(); leaf.fund(0, 0, [1n]); leaf.transfers[0].leafIndex = (1n << 64n).toString();
  await assert.rejects(scanWormholeBalance(leaf.options), /Invalid leaf index/);
});

test('invalid Worker results and chain nullifier flags cannot report unspent funds', async () => {
  const incomplete = fixture(); incomplete.options.deriveAddresses = async () => [];
  await assert.rejects(scanWormholeBalance(incomplete.options), /incomplete address batch/);
  const duplicate = fixture(); duplicate.fund(0, 0, [1n, 2n]); duplicate.options.computeNullifiers = async () => [OTHER, OTHER];
  await assert.rejects(scanWormholeBalance(duplicate.options), /duplicate or invalid nullifier/);
  const flags = fixture(); flags.fund(0, 0, [1n]);
  flags.mutate((body, result) => {
    if (body.method === 'state_queryStorageAt' && ((body.params?.[0] as string[])[0]).startsWith(storagePrefix('Wormhole', 'UsedNullifiers'))) {
      return [{ block: BLOCK, changes: (body.params?.[0] as string[]).map(k => [k, '0x02']) }];
    }
    return result;
  });
  await assert.rejects(scanWormholeBalance(flags.options), /Invalid on-chain Wormhole nullifier flag/);
});

test('snapshot reorganization and cancellation discard otherwise valid zero', async () => {
  const reorg = fixture(); reorg.mutate((body, result) => body.method === 'chain_getBlockHash' && body.params?.[0] === 10 ? OTHER : result);
  await assert.rejects(scanWormholeBalance(reorg.options), /reorganized/);
  const aborted = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(scanWormholeBalance({ ...aborted.options, signal: controller.signal }), /cancelled/);
  assert.equal(aborted.calls.length, 0);
});


test('indexer may trail best head while already covering the finalized snapshot', async () => {
  const f = fixture();
  f.mutate((body, result) => {
    if (body.query?.includes('WormholeCheckpoint')) return { ...(result as object), indexedHead: [{ height: 109, hash: OTHER }] };
    return result;
  });
  const result = await scanWormholeBalance(f.options);
  assert.equal(result.snapshot.blockHeight, 10);
  assert.equal(result.snapshot.indexedHeight, 109);
  assert.equal(result.snapshot.finality, 'finalized');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { blake2AsHex, encodeAddress } from '@polkadot/util-crypto';
import { addressBytes, compact, concat, fromLittle, hex, little, storagePrefix, unhex, validateMetadata } from '../lib/quantus/protocol.ts';
import { WORMHOLE_CODE_HASH } from '../lib/wormhole/withdraw.ts';
import type { WormholeRpcLike, WormholeWithdrawalReceipt } from '../lib/wormhole/withdraw.ts';
import { inspectWormholeInclusion, scanFinalizedWormholeEra, trackWormholeWithdrawal } from '../lib/wormhole/withdraw-tracking.ts';

const metadata = JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-metadata.json', import.meta.url), 'utf8')).result;
const { registry } = validateMetadata(metadata);
const self = encodeAddress(new Uint8Array(32).fill(3), 189);
const other = encodeAddress(new Uint8Array(32).fill(4), 189);
const mint = encodeAddress(new Uint8Array(32).fill(1), 189);
const proofHash = hex(new Uint8Array(32).fill(0x11));
const nullifiers = Array.from({ length: 7 }, (_, i) => hex(new Uint8Array(32).fill(i + 10)));
const amount = 1_000_000_000_000n;
const blockHash = (h: number, branch = 1) => '0x' + branch.toString(16).padStart(2, '0') + h.toString(16).padStart(62, '0');
const limbValues = (bytes: Uint8Array) => Array.from({ length: 4 }, (_, i) => fromLittle(bytes.slice(i * 8, i * 8 + 8)));

// Synthetic PUBLIC-input framing only. This is deliberately not a valid ZK
// proof and is never broadcast. Chain inclusion is mocked; event decoding uses
// the exact pinned mainnet SCALE metadata instead of a mock event registry.
function extrinsic(destination = self, outputAmount = amount): string {
  const pis = new Array<bigint>(162).fill(0n);
  pis[0] = 14n; pis[1] = 0n; pis[2] = 4n;
  pis.splice(3, 4, ...limbValues(unhex(proofHash))); pis[7] = 100n;
  pis[8] = outputAmount / 10_000_000_000n;
  pis.splice(9, 4, ...limbValues(addressBytes(destination)));
  nullifiers.forEach((value, i) => pis.splice(78 + i * 4, 4, ...limbValues(unhex(value))));
  const proof = concat(new Uint8Array(16).fill(7), little(162n, 8), ...pis.map(value => little(value, 8)));
  const body = concat(Uint8Array.of(4, 20, 2), compact(BigInt(proof.length)), proof);
  return hex(concat(compact(BigInt(body.length)), body));
}
const tx = extrinsic();
const receipt: WormholeWithdrawalReceipt = {
  version: 1, kind: 'wormhole-withdrawal', hash: blake2AsHex(tx, 256), bytes: tx,
  selfAddress: self, normalAccountIndex: 0, inputPlanck: '1010000000000', netToSelfPlanck: amount.toString(),
  volumeFeePlanck: '10000000000', quantumDustPlanck: '0', proofBlock: 100, proofBlockHash: proofHash,
  firstBlock: 102, expiresAt: 4197, nullifiers, phase: 'submitted', message: '', createdAt: 123456,
  endpoint: 'https://rpc1-mainnet.quantus.com',
};
const dispatch = registry.createType('DispatchInfo', { weight: { refTime: 1, proofSize: 0 }, class: 'Normal', paysFee: 'No' }).toU8a();
const success = concat(Uint8Array.of(0, 0), dispatch);
const dispatchFailed = concat(Uint8Array.of(0, 1), registry.createType('DispatchError', 'BadOrigin').toU8a(), dispatch);
const credited = (value = amount, to = self, from = mint) => concat(Uint8Array.of(20, 0), addressBytes(from), addressBytes(to), little(value, 16), little(0n, 8), little(42n, 8));
const proofVerified = (value = amount, ns = nullifiers) => concat(Uint8Array.of(20, 2), little(value, 16), compact(BigInt(ns.length)), ...ns.map(unhex));
const mintFailed = concat(Uint8Array.of(20, 5), addressBytes(self), little(amount, 16));
const denied = concat(Uint8Array.of(20, 4), compact(1n), little(0n, 4));
type EventItem = { index: number; event: Uint8Array };
const at = (event: Uint8Array, index = 1): EventItem => ({ index, event });
const validEvents = () => [at(credited()), at(proofVerified()), at(success)];
const eventBytes = (items: EventItem[]) => hex(concat(compact(BigInt(items.length)), ...items.map(({ index, event }) => concat(Uint8Array.of(0), little(BigInt(index), 4), event, Uint8Array.of(0)))));
interface FakeOptions {
  events?: EventItem[]; transaction?: string; inclusionHeight?: number | null; best?: number; finalized?: number;
  missingBlock?: number; missingHash?: number; branch?: number; rawEvents?: string | null;
  reference?: string | null; runtimeCodeHash?: string | null; expiryReference?: string | null; expiryCodeHash?: string | null;
}
function fake(options: FakeOptions = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const branch = options.branch ?? 1;
  const inclusionHeight = options.inclusionHeight === undefined ? 101 : options.inclusionHeight;
  const final = options.finalized ?? 101;
  const rpc: WormholeRpcLike = {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      calls.push({ method, params });
      let result: unknown;
      if (method === 'chain_getHeader') result = { number: '0x' + (params.length ? final : (options.best ?? Math.max(110, final))).toString(16) };
      else if (method === 'chain_getFinalizedHead') result = blockHash(final, branch);
      else if (method === 'chain_getBlockHash') result = Number(params[0]) === options.missingHash ? null : blockHash(Number(params[0]), branch);
      else if (method === 'chain_getBlock') {
        const h = Number(BigInt('0x' + String(params[0]).slice(4)));
        result = h === options.missingBlock ? null : { block: {
          header: { number: '0x' + h.toString(16), parentHash: blockHash(Math.max(0, h - 1), branch) },
          extrinsics: h === inclusionHeight ? ['0xbeef', options.transaction ?? tx] : [],
        } };
      } else if (method === 'state_getMetadata') result = metadata;
      else if (method === 'state_getStorageHash') result = params[1] === blockHash(receipt.expiresAt, branch) && options.expiryCodeHash !== undefined ? options.expiryCodeHash : options.runtimeCodeHash === undefined ? WORMHOLE_CODE_HASH : options.runtimeCodeHash;
      else if (method === 'state_getStorage') {
        if (params[0] === storagePrefix('System', 'Events')) result = options.rawEvents === undefined ? eventBytes(options.events ?? validEvents()) : options.rawEvents;
        else result = params[1] === blockHash(receipt.expiresAt, branch) && options.expiryReference !== undefined ? options.expiryReference : options.reference === undefined ? null : options.reference;
      }
      else throw new Error('Unexpected RPC method (broadcast forbidden): ' + method);
      return result as T;
    },
  };
  return { rpc, calls };
}

test('real SCALE events bind successful proof, all seven nullifiers and actual self credit', async () => {
  const { rpc } = fake();
  const result = await inspectWormholeInclusion(rpc, { ...receipt, nullifiers: [...nullifiers].reverse() }, blockHash(101), 101);
  assert.equal(result?.phase, 'included'); assert.equal(result?.execution, 'success');
  assert.equal(result?.includedHeight, 101);
});

test('ExtrinsicSuccess and ProofVerified alone cannot claim a successful mint', async () => {
  for (const events of [[at(success)], [at(proofVerified()), at(success)], [at(credited(), 0), at(proofVerified()), at(success)], [at(credited()), at(proofVerified(), 0), at(success)]]) {
    await assert.rejects(inspectWormholeInclusion(fake({ events }).rpc, receipt, blockHash(101), 101), /完整核对/);
  }
});

test('wrong credited amount, source, destination, proof amount, or nullifiers fail closed', async () => {
  const invalid = [
    [at(credited(1n)), at(proofVerified()), at(success)],
    [at(credited(amount, self, other)), at(proofVerified()), at(success)],
    [at(credited(amount, other)), at(proofVerified()), at(success)],
    [at(credited()), at(proofVerified(1n)), at(success)],
    [at(credited()), at(proofVerified(amount, [...nullifiers.slice(1), proofHash])), at(success)],
    [at(credited()), at(proofVerified(amount, [...nullifiers.slice(1), nullifiers[1]])), at(success)],
    [at(credited()), at(proofVerified()), at(proofVerified()), at(success)],
  ];
  for (const events of invalid) await assert.rejects(inspectWormholeInclusion(fake({ events }).rpc, receipt, blockHash(101), 101));
});

test('ExitMintFailed, SegmentsDenied, and dispatch failures override ExtrinsicSuccess', async () => {
  for (const event of [mintFailed, denied, dispatchFailed]) {
    const result = await inspectWormholeInclusion(fake({ events: [...validEvents(), at(event)] }).rpc, receipt, blockHash(101), 101);
    assert.equal(result?.execution, 'failed'); assert.equal(result?.phase, 'included');
    assert.match(result!.message, /失败|未能完整到账/);
  }
  const irrelevant = await inspectWormholeInclusion(fake({ events: [...validEvents(), at(mintFailed, 0)] }).rpc, receipt, blockHash(101), 101);
  assert.equal(irrelevant?.execution, 'success');
});

test('miner volume fee credits after ProofVerified never replace or inflate self exit credit', async () => {
  await assert.rejects(inspectWormholeInclusion(fake({ events: [at(proofVerified()), at(credited()), at(success)] }).rpc, receipt, blockHash(101), 101));
  const result = await inspectWormholeInclusion(fake({ events: [at(credited()), at(proofVerified()), at(credited(10_000_000_000n)), at(success)] }).rpc, receipt, blockHash(101), 101);
  assert.equal(result?.execution, 'success');
});

test('actual unsigned extrinsic is bound independently when stored receipt omits bytes', async () => {
  const { bytes: _bytes, ...publicReceipt } = receipt;
  const { rpc } = fake();
  assert.equal((await inspectWormholeInclusion(rpc, publicReceipt, blockHash(101), 101))?.execution, 'success');
  for (const changed of [
    { selfAddress: other }, { netToSelfPlanck: '2000000000000' }, { proofBlockHash: blockHash(100) },
    { proofBlock: 99 }, { nullifiers: [...nullifiers.slice(1), proofHash] },
  ]) await assert.rejects(inspectWormholeInclusion(rpc, { ...publicReceipt, ...changed }, blockHash(101), 101));
  const wrongCall = tx.replace('041402', '041403');
  await assert.rejects(inspectWormholeInclusion(fake({ transaction: wrongCall }).rpc, { ...publicReceipt, hash: blake2AsHex(wrongCall, 256) }, blockHash(101), 101));
});

test('missing, trailing, or mismatched-height block data cannot verify a receipt', async () => {
  for (const rawEvents of [null, '0x', eventBytes(validEvents()) + '00']) {
    await assert.rejects(inspectWormholeInclusion(fake({ rawEvents }).rpc, receipt, blockHash(101), 101));
  }
  await assert.rejects(inspectWormholeInclusion(fake({ missingBlock: 101 }).rpc, receipt, blockHash(101), 101));
  await assert.rejects(inspectWormholeInclusion(fake().rpc, receipt, blockHash(102), 101));
});

test('saved finalized success is only a hint and can become verified finalized failure', async () => {
  const { rpc, calls } = fake({ events: [at(mintFailed), at(proofVerified(0n)), at(success)] });
  const result = await trackWormholeWithdrawal(rpc, { ...receipt, phase: 'finalized', execution: 'success', includedHash: blockHash(101), includedHeight: 101, finalizedHeight: 10000 }, () => {});
  assert.equal(result.phase, 'failed'); assert.equal(result.execution, 'failed'); assert.equal(result.finalizedHeight, 101);
  assert.ok(calls.some(call => call.method === 'state_getStorage'));
  assert.ok(calls.every(call => !call.method.startsWith('author_')));
});

test('a cached inclusion on a replaced block is discarded and the canonical range rescanned', async () => {
  const { rpc, calls } = fake({ branch: 2, inclusionHeight: 103, finalized: 103 });
  const updates: WormholeWithdrawalReceipt[] = [];
  const result = await trackWormholeWithdrawal(rpc, { ...receipt, phase: 'finalized', execution: 'success', includedHash: blockHash(101), includedHeight: 101 }, value => updates.push(value));
  assert.equal(result.phase, 'finalized'); assert.equal(result.includedHeight, 103); assert.equal(result.includedHash, blockHash(103, 2));
  assert.ok(updates.some(value => value.includedHash === undefined));
  assert.ok(calls.some(call => call.method === 'chain_getBlock' && call.params[0] === blockHash(100, 2)));
});

test('a reorg replacing previously scanned empty blocks rewinds the active scan', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const before = fake({ inclusionHeight: null, finalized: 100 });
  const after = fake({ branch: 2, inclusionHeight: 103, finalized: 103 });
  let replaced = false;
  const rpc: WormholeRpcLike = { call<T>(method: string, params: unknown[] = []) { return (replaced ? after : before).rpc.call<T>(method, params); } };
  const pending = trackWormholeWithdrawal(rpc, receipt, () => {});
  while (!before.calls.some(call => call.method === 'chain_getBlock' && call.params[0] === blockHash(110))) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  await new Promise<void>(resolve => setImmediate(resolve));
  replaced = true;
  t.mock.timers.tick(7000);
  const result = await pending;
  assert.equal(result.phase, 'finalized'); assert.equal(result.includedHash, blockHash(103, 2));
  assert.ok(after.calls.some(call => call.method === 'chain_getBlock' && call.params[0] === blockHash(100, 2)));
});

test('saved successful events must be checked again even on the same canonical block', async () => {
  const { rpc } = fake({ events: [at(success)] });
  const result = await trackWormholeWithdrawal(rpc, { ...receipt, phase: 'finalized', execution: 'success', includedHash: blockHash(101), includedHeight: 101 }, () => {}, undefined, { maxDurationMs: 20 });
  assert.equal(result.phase, 'unknown'); assert.equal(result.execution, undefined);
});

test('expiry requires strictly later finality and every block in the complete proof window', async () => {
  const { rpc, calls } = fake({ inclusionHeight: null, finalized: 4198 });
  assert.equal(await scanFinalizedWormholeEra(rpc, receipt, 4198), null);
  const visited = calls.filter(call => call.method === 'chain_getBlockHash').map(call => call.params[0]);
  assert.deepEqual(visited, Array.from({ length: 4098 }, (_, i) => i + 100));
  await assert.rejects(scanFinalizedWormholeEra(rpc, receipt, 4197));
});

test('any unavailable finalized block preserves unknown, never expired', async () => {
  for (const missing of [{ missingHash: 200 }, { missingBlock: 200 }]) {
    const { rpc } = fake({ ...missing, inclusionHeight: null, finalized: 4198 });
    await assert.rejects(scanFinalizedWormholeEra(rpc, receipt, 4198));
    const result = await trackWormholeWithdrawal(rpc, receipt, () => {}, undefined, { maxDurationMs: 20 });
    assert.equal(result.phase, 'unknown');
  }
});

test('a late-inclusion record is found by the full finalized scan instead of expiring', async () => {
  const { rpc } = fake({ inclusionHeight: 150, finalized: 4198 });
  const result = await trackWormholeWithdrawal(rpc, receipt, () => {});
  assert.equal(result.phase, 'finalized'); assert.equal(result.includedHeight, 150);
});

test('a proven complete finalized window expires without broadcast or implicit retry', async () => {
  const lateReceipt = { ...receipt, firstBlock: 4194 };
  const { rpc, calls } = fake({ inclusionHeight: null, finalized: 4198 });
  const result = await trackWormholeWithdrawal(rpc, lateReceipt, () => {});
  assert.equal(result.phase, 'expired'); assert.equal(result.execution, undefined);
  assert.deepEqual(calls.filter(call => call.method === 'chain_getBlock').map(call => call.params[0]), [4192, 4193, 4194, 4195, 4196, 4197].map(h => blockHash(h)));
  assert.ok(calls.every(call => !call.method.startsWith('author_')));
});

test('old arithmetic expiry cannot authorize replacement while the final proof reference remains live', async () => {
  for (const options of [{ reference: proofHash }, { runtimeCodeHash: blockHash(9) }, { runtimeCodeHash: null }]) {
    const { rpc } = fake({ ...options, inclusionHeight: null, finalized: 4198 });
    const result = await trackWormholeWithdrawal(rpc, { ...receipt, firstBlock: 4194 }, () => {}, undefined, { maxDurationMs: 20 });
    assert.equal(result.phase, 'unknown');
  }
});

test('a temporary upgrade cannot hide an inclusion beyond the originally scanned expiry', async () => {
  for (const options of [{ expiryReference: proofHash }, { expiryCodeHash: blockHash(9) }]) {
    const { rpc } = fake({ ...options, reference: null, runtimeCodeHash: WORMHOLE_CODE_HASH, inclusionHeight: null, finalized: 4198 });
    const result = await trackWormholeWithdrawal(rpc, { ...receipt, firstBlock: 4194 }, () => {}, undefined, { maxDurationMs: 20 });
    assert.equal(result.phase, 'unknown');
  }
});

test('a removed reference encoded as the default zero hash also establishes expiry', async () => {
  const { rpc } = fake({ reference: '0x' + '00'.repeat(32), inclusionHeight: null, finalized: 4198 });
  const result = await trackWormholeWithdrawal(rpc, { ...receipt, firstBlock: 4194 }, () => {});
  assert.equal(result.phase, 'expired');
});

test('mixed parent chains cannot establish exhaustive expiry', async () => {
  const original = fake({ inclusionHeight: null, finalized: 4198 }).rpc;
  const rpc: WormholeRpcLike = { async call<T>(method: string, params: unknown[] = []) {
    const value = await original.call<T>(method, params);
    if (method === 'chain_getBlock' && params[0] === blockHash(101)) (value as { block: { header: { parentHash: string } } }).block.header.parentHash = blockHash(100, 9);
    return value;
  } };
  await assert.rejects(scanFinalizedWormholeEra(rpc, receipt, 4198), /重组/);
});

test('aborting a polling wait returns promptly and never emits subsequent updates', async () => {
  const controller = new AbortController();
  const updates: WormholeWithdrawalReceipt[] = [];
  const pending = trackWormholeWithdrawal(fake({ finalized: 100 }).rpc, receipt, value => {
    updates.push(value); setTimeout(() => controller.abort(), 5);
  }, controller.signal);
  const result = await pending;
  assert.equal(result.phase, 'included'); assert.equal(result.execution, 'success'); assert.equal(updates.length, 1);
});

test('aborting an unresolved RPC read does not wait for the transport or notify', async () => {
  const controller = new AbortController();
  const original = fake().rpc;
  let reads = 0, updates = 0;
  const rpc: WormholeRpcLike = { call<T>(method: string, params: unknown[] = []): Promise<T> {
    reads++;
    if (method === 'state_getStorage') { queueMicrotask(() => controller.abort()); return new Promise<T>(() => {}); }
    return original.call<T>(method, params);
  } };
  const result = await trackWormholeWithdrawal(rpc, receipt, () => { updates++; }, controller.signal);
  assert.equal(result.phase, 'unknown'); assert.equal(result.execution, undefined); assert.equal(updates, 0); assert.ok(reads > 0);
});

test('the finite tracking deadline also ends an unresolved RPC read with manual-resume status', async () => {
  const rpc: WormholeRpcLike = { call<T>(): Promise<T> { return new Promise<T>(() => {}); } };
  const updates: WormholeWithdrawalReceipt[] = [];
  const result = await trackWormholeWithdrawal(rpc, receipt, value => updates.push(value), undefined, { maxDurationMs: 10 });
  assert.equal(result.phase, 'unknown'); assert.match(result.message, /时间上限/); assert.equal(updates.length, 1);
});

test('unbounded receipt ranges and aggressive query options are rejected before RPC', async () => {
  let calls = 0;
  const rpc: WormholeRpcLike = { async call<T>(): Promise<T> { calls++; throw Error('must not query'); } };
  await assert.rejects(trackWormholeWithdrawal(rpc, { ...receipt, expiresAt: 1000000 }, () => {}));
  await assert.rejects(trackWormholeWithdrawal(rpc, { ...receipt, expiresAt: receipt.expiresAt - 1 }, () => {}));
  await assert.rejects(trackWormholeWithdrawal(rpc, { ...receipt, hash: blockHash(101) }, () => {}));
  await assert.rejects(trackWormholeWithdrawal(rpc, receipt, () => {}, undefined, { pollIntervalMs: 1 }));
  await assert.rejects(trackWormholeWithdrawal(rpc, receipt, () => {}, undefined, { maxDurationMs: 30 * 60_000 + 1 }));
  assert.equal(calls, 0);
});

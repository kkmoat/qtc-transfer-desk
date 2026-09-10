import { blake2AsHex, blake2AsU8a, encodeAddress, xxhashAsHex } from '@polkadot/util-crypto';
import type { EventRecord } from '@polkadot/types/interfaces';
import { GENESIS, RPC_URLS, addressBytes, accountKey, compact, concat, decodeAccount, fromLittle, hex, little, readCompact, same, storagePrefix, unhex, validateMetadata } from '../quantus/protocol.ts';
import type { WormholeBalanceSnapshot, WormholeNullifierInput, WormholeUtxo } from './data.ts';

export const WORMHOLE_CODE_HASH = '0x4a2d509dfa3faf06a9645bd444d5f2f63ac8ab2f75ba540a0b84680a514514fa';
export const WORMHOLE_QUANTUM = 10_000_000_000n;
export const WORMHOLE_MAX_BATCH = 7;
export interface WormholeRpcLike { call<T = unknown>(method: string, params?: unknown[]): Promise<T> }
export interface WormholeWithdrawalReceipt {
  version: 1; kind: 'wormhole-withdrawal'; hash: string; bytes?: string;
  selfAddress: string; normalAccountIndex: number;
  inputPlanck: string; netToSelfPlanck: string; volumeFeePlanck: string; quantumDustPlanck: string;
  proofBlock: number; proofBlockHash: string; firstBlock: number; expiresAt: number; nullifiers: string[];
  phase: 'submitting' | 'submitted' | 'included' | 'finalized' | 'failed' | 'unknown' | 'expired';
  execution?: 'success' | 'failed'; includedHash?: string; includedHeight?: number; finalizedHeight?: number;
  message: string; createdAt: number; endpoint: string;
}
export interface WormholeSelectionSummary {
  selected: WormholeUtxo[]; selectedCount: number; inputPlanck: bigint; quantumDustPlanck: bigint;
  remainingPlanck: bigint; scaledInputs: number[];
}
export interface WormholeWithdrawalSelection extends WormholeSelectionSummary {
  netToSelfPlanck: bigint; volumeFeePlanck: bigint; totalLossPlanck: bigint;
}
export interface WormholeProofRequest {
  specVersion: 152; genesisHash: string; codeHash: string; volumeFeeBps: number;
  normalAccountIndex: number; expectedNormalAddress: string;
  expected: { inputPlanck: string; netPlanck: string; feePlanck: string };
  block: { hash: string; number: number; parentHash: string; stateRoot: string; extrinsicsRoot: string; zkTreeRoot: string; digest: string };
  inputs: { branch: 0 | 1; index: number; address: string; transferCount: string; leafIndex: string; amountPlanck: string; leafData: string; leafHash: string; siblings: string[][] }[];
}
export interface WormholeCheckedSummary {
  realNullifiers: string[]; normalAddress: string; inputPlanck: string; netPlanck: string; feePlanck: string;
  verified: true; codeHash: string;
}
export interface WormholeVerifiedProof extends WormholeCheckedSummary { proofBytes: number[]; publicInputs: string[] }
export interface PreparedWormholeWithdrawal {
  selection: WormholeWithdrawalSelection;
  context: { genesis: string; codeHash: string; volumeFeeBps: number; proofBlock: number; proofBlockHash: string; bestBlock: number; expiresAt: number; blockHashCount: number; endpoint: string; createdAt: number };
  proofRequest: WormholeProofRequest; realNullifiers: string[];
}
export interface ReadyWormholeWithdrawal { prepared: PreparedWormholeWithdrawal; bytes: string; hash: string; publicInputs: WormholePublicInputs }
export interface WormholePublicInputs { blockNumber: number; blockHash: string; assetId: number; volumeFeeBps: number; nullifiers: string[]; outputs: { address: string; amountPlanck: bigint }[] }
export interface PrepareWormholeWithdrawalOptions {
  snapshot: WormholeBalanceSnapshot; selectedIds: string[]; selfAddress: string; normalAccountIndex: number;
  computeNullifiers: (inputs: WormholeNullifierInput[]) => Promise<string[]>;
  checkProofRequest: (request: WormholeProofRequest) => Promise<WormholeCheckedSummary>;
  signal?: AbortSignal; rpc?: WormholeRpcLike;
}

const ZERO_HASH = '0x' + '00'.repeat(32);
const MAX_U32 = 0xffffffffn;
const MAX_U128 = (1n << 128n) - 1n;
const GOLDILOCKS = 0xffffffff00000001n;
const PI_COUNT = 162;
const MAX_PROOF_BYTES = 512 * 1024;
const HEX32 = /^0x[0-9a-f]{64}$/;
const phases = new Set(['submitting','submitted','included','finalized','failed','unknown','expired']);
const RPC_METHODS = new Set(['chain_getBlockHash','chain_getHeader','chain_getBlock','chain_getFinalizedHead','state_getMetadata','state_getRuntimeVersion','state_getStorage','state_getStorageHash','state_queryStorageAt','zkTree_getMerkleProof','author_submitExtrinsic']);
const preparedObjects = new WeakSet<PreparedWormholeWithdrawal>();
const readyObjects = new WeakSet<ReadyWormholeWithdrawal>();
const attemptedHashes = new Set<string>();
function obj(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Incomplete Wormhole response.'); return value as Record<string, unknown>; }
function uint(value: unknown, max = 0xffffffff): number { if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) throw new Error('Invalid Wormhole integer.'); return value; }
function amount(value: unknown, max = MAX_U128): bigint { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(value) || BigInt(value) > max) throw new Error('Invalid Wormhole amount.'); return BigInt(value); }
function hash32(value: unknown): string { if (typeof value !== 'string' || !HEX32.test(value)) throw new Error('Invalid Wormhole hash.'); return value; }
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new Error('Wormhole operation cancelled.'); }
function normalizeNullifier(value: unknown): string { if (typeof value !== 'string') throw new Error('Invalid nullifier.'); const result = (value.startsWith('0x') ? value : `0x${value}`).toLowerCase(); hash32(result); if (result === ZERO_HASH) throw new Error('A real nullifier cannot be zero.'); return result; }
function identicalSet(a: string[], b: string[]): boolean { return a.length === b.length && new Set(a).size === a.length && a.every(value => b.includes(value)); }
function freeze<T>(value: T): T { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.freeze(value); for (const item of Object.values(value)) freeze(item); } return value; }
export class WormholeRpcError extends Error { code: number; constructor(message: string, code: number) { super(message); this.code = code; this.name = 'WormholeRpcError'; } }
export class WormholeRpc implements WormholeRpcLike {
  readonly endpoint: string;
  private id = 0;
  private fetcher: typeof fetch;
  private signal?: AbortSignal;
  constructor(options: { endpoint?: string; fetcher?: typeof fetch; signal?: AbortSignal } = {}) {
    this.endpoint = options.endpoint ?? RPC_URLS[0];
    if (!RPC_URLS.includes(this.endpoint as typeof RPC_URLS[number])) throw new Error('Only official Quantus mainnet RPC endpoints are allowed.');
    this.fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis); this.signal = options.signal;
  }
  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    if (!RPC_METHODS.has(method)) throw new Error('Unsupported Wormhole RPC method.');
    checkAbort(this.signal);
    const id = ++this.id;
    const controller = new AbortController(); const cancel = () => controller.abort();
    this.signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 20_000);
    try {
      const response = await this.fetcher(this.endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error(`Wormhole RPC is unavailable (${response.status}).`);
      const data = obj(await response.json());
      if (data.id !== id || data.jsonrpc !== '2.0') throw new Error('Wormhole RPC response does not match its request.');
      if (data.error) { const error = obj(data.error); throw new WormholeRpcError(typeof error.message === 'string' ? error.message.slice(0, 500) : 'Wormhole RPC rejected the request.', typeof error.code === 'number' ? error.code : -1); }
      if (!('result' in data)) throw new Error('Wormhole RPC returned no result.');
      return data.result as T;
    } catch (error) { checkAbort(this.signal); if (controller.signal.aborted) throw new Error('Wormhole RPC timed out.'); throw error; }
    finally { clearTimeout(timer); this.signal?.removeEventListener('abort', cancel); }
  }
}

/** Selected leaves are consumed completely. Fee-free summary; never assumes a live fee rate. */
export function summarizeWormholeSelection(utxos: WormholeUtxo[], selectedIds: string[]): WormholeSelectionSummary {
  if (!Array.isArray(utxos) || utxos.length > 10_000 || !Array.isArray(selectedIds) || selectedIds.length < 1 || selectedIds.length > WORMHOLE_MAX_BATCH || new Set(selectedIds).size !== selectedIds.length) throw new Error('Select between 1 and 7 distinct encrypted transfers.');
  const all = new Map<string, WormholeUtxo>(); let total = 0n;
  for (const utxo of utxos) {
    if (!utxo || typeof utxo.id !== 'string' || !utxo.id || all.has(utxo.id) || typeof utxo.amountPlanck !== 'bigint' || utxo.amountPlanck < 0n || utxo.amountPlanck > MAX_U128) throw new Error('Invalid or duplicate encrypted transfer.');
    all.set(utxo.id, utxo); total += utxo.amountPlanck;
  }
  const selected = selectedIds.map(id => { const utxo = all.get(id); if (!utxo) throw new Error('A selected transfer is no longer in the scanned balance.'); return { ...utxo }; });
  const scaledInputs = selected.map(utxo => { const scaled = utxo.amountPlanck / WORMHOLE_QUANTUM; if (scaled < 1n || scaled > MAX_U32) throw new Error('A selected transfer is below 0.01 QTC or exceeds the proof amount limit.'); return Number(scaled); });
  const inputPlanck = selected.reduce((sum, utxo) => sum + utxo.amountPlanck, 0n);
  const quantumDustPlanck = selected.reduce((sum, utxo) => sum + utxo.amountPlanck % WORMHOLE_QUANTUM, 0n);
  return { selected, selectedCount: selected.length, inputPlanck, quantumDustPlanck, remainingPlanck: total - inputPlanck, scaledInputs };
}
function feeSelection(summary: WormholeSelectionSummary, volumeFeeBps: number): WormholeWithdrawalSelection {
  if (volumeFeeBps !== 4) throw new Error('The Wormhole volume fee changed. Update this app before withdrawing.');
  const scaled = summary.scaledInputs.reduce((sum, n) => sum + BigInt(n), 0n);
  const net = scaled * BigInt(10_000 - volumeFeeBps) / 10_000n;
  if (net < 1n || net > MAX_U32) throw new Error('The selected batch has no usable net output or exceeds the single-account proof limit.');
  const netToSelfPlanck = net * WORMHOLE_QUANTUM;
  return { ...summary, netToSelfPlanck, volumeFeePlanck: (scaled - net) * WORMHOLE_QUANTUM, totalLossPlanck: summary.inputPlanck - netToSelfPlanck };
}
function parseProofPublicInputs(proof: Uint8Array): { values: string[]; parsed: WormholePublicInputs } {
  const suffix = 8 + PI_COUNT * 8;
  if (proof.length <= suffix || proof.length > MAX_PROOF_BYTES || fromLittle(proof.slice(proof.length - suffix, proof.length - suffix + 8)) !== BigInt(PI_COUNT)) throw new Error('The proof does not contain the canonical 162-field public input suffix.');
  const data = proof.slice(proof.length - PI_COUNT * 8);
  const values = Array.from({ length: PI_COUNT }, (_, i) => fromLittle(data.slice(i * 8, (i + 1) * 8)));
  if (values.some(value => value >= GOLDILOCKS) || values[0] !== 14n || values[1] !== 0n || values[2] !== 4n || values[7] > MAX_U32) throw new Error('The proof public input header is not supported.');
  const digest = (offset: number) => hex(concat(...values.slice(offset, offset + 4).map(value => little(value, 8))));
  const outputs: WormholePublicInputs['outputs'] = [];
  for (let i = 0; i < 14; i++) {
    const offset = 8 + i * 5; const quantity = values[offset]; const address = digest(offset + 1);
    if (quantity > MAX_U32 || (quantity > 0n && address === ZERO_HASH)) throw new Error('Invalid proof output amount or destination.');
    if (quantity > 0n) outputs.push({ address: encodeAddress(unhex(address), 189), amountPlanck: quantity * WORMHOLE_QUANTUM });
  }
  const nullifiers = Array.from({ length: 7 }, (_, i) => normalizeNullifier(digest(78 + i * 4)));
  if (new Set(nullifiers).size !== 7 || values.slice(106).some(value => value !== 0n)) throw new Error('The proof has duplicate nullifiers or nonzero padding.');
  return { values: values.map(String), parsed: { blockNumber: Number(values[7]), blockHash: digest(3), assetId: Number(values[1]), volumeFeeBps: Number(values[2]), nullifiers, outputs } };
}
/** Decodes/binds public fields only. Mathematical proof verification remains mandatory in the local Worker. */
export function parseWormholeExtrinsicPublicInputs(bytes: string): WormholePublicInputs {
  const data = unhex(bytes); const [size, start] = readCompact(data);
  if (size !== BigInt(data.length - start) || data[start] !== 4 || data[start + 1] !== 20 || data[start + 2] !== 2) throw new Error('Not an unsigned Wormhole verify_private_batch extrinsic.');
  const [length, proofStart] = readCompact(data, start + 3);
  if (length !== BigInt(data.length - proofStart)) throw new Error('Wormhole proof length does not match the extrinsic.');
  return parseProofPublicInputs(data.slice(proofStart)).parsed;
}
export function parseWormholeWithdrawalReceipt(value: unknown): WormholeWithdrawalReceipt | null {
  try {
    const r = obj(value);
    if (r.version !== 1 || r.kind !== 'wormhole-withdrawal' || typeof r.selfAddress !== 'string' || typeof r.phase !== 'string' || !phases.has(r.phase) || typeof r.message !== 'string' || r.message.length > 1000 || !RPC_URLS.includes(r.endpoint as typeof RPC_URLS[number])) return null;
    addressBytes(r.selfAddress); hash32(r.hash); hash32(r.proofBlockHash); uint(r.normalAccountIndex, 999999); uint(r.proofBlock); uint(r.firstBlock); uint(r.expiresAt); uint(r.createdAt, Number.MAX_SAFE_INTEGER);
    if (r.proofBlock === 0 || (r.expiresAt as number) !== (r.proofBlock as number) + 4097 || (r.firstBlock as number) < (r.proofBlock as number) || (r.firstBlock as number) > (r.expiresAt as number)) return null;
    const input = amount(r.inputPlanck); const net = amount(r.netToSelfPlanck); const fee = amount(r.volumeFeePlanck); const dust = amount(r.quantumDustPlanck);
    if (input <= 0n || net <= 0n || net % WORMHOLE_QUANTUM || fee % WORMHOLE_QUANTUM || input !== net + fee + dust || dust >= 7n * WORMHOLE_QUANTUM) return null;
    if (!Array.isArray(r.nullifiers) || r.nullifiers.length !== 7 || new Set(r.nullifiers).size !== 7) return null;
    if (r.nullifiers.some(value => normalizeNullifier(value) !== value)) return null;
    if (r.execution !== undefined && r.execution !== 'success' && r.execution !== 'failed') return null;
    for (const field of ['includedHeight', 'finalizedHeight']) if (r[field] !== undefined) uint(r[field]);
    if (r.includedHash !== undefined) hash32(r.includedHash);
    if (r.bytes !== undefined) {
      if (typeof r.bytes !== 'string' || r.bytes.length > 2 * (MAX_PROOF_BYTES + 20) || blake2AsHex(r.bytes, 256) !== r.hash) return null;
      assertReceiptPublicInputs(r as unknown as WormholeWithdrawalReceipt, parseWormholeExtrinsicPublicInputs(r.bytes));
    }
    const allowed = ['version','kind','hash','bytes','selfAddress','normalAccountIndex','inputPlanck','netToSelfPlanck','volumeFeePlanck','quantumDustPlanck','proofBlock','proofBlockHash','firstBlock','expiresAt','nullifiers','phase','execution','includedHash','includedHeight','finalizedHeight','message','createdAt','endpoint'];
    return Object.fromEntries(allowed.filter(key => r[key] !== undefined).map(key => [key, key === 'nullifiers' ? [...r.nullifiers as string[]] : r[key]])) as unknown as WormholeWithdrawalReceipt;
  } catch { return null; }
}
function assertReceiptPublicInputs(receipt: WormholeWithdrawalReceipt, pi: WormholePublicInputs) {
  if (pi.blockNumber !== receipt.proofBlock || pi.blockHash !== receipt.proofBlockHash || pi.assetId !== 0 || pi.volumeFeeBps !== 4 || !identicalSet(pi.nullifiers, receipt.nullifiers) || !pi.outputs.length || pi.outputs.some(output => output.address !== receipt.selfAddress) || pi.outputs.reduce((sum, output) => sum + output.amountPlanck, 0n) !== BigInt(receipt.netToSelfPlanck)) throw new Error('The public withdrawal receipt does not match its proof.');
}

function headerHeight(header: Record<string, unknown>): number { if (typeof header.number !== 'string' || !/^0x[0-9a-f]+$/.test(header.number)) throw new Error('Invalid Wormhole header number.'); return uint(Number(BigInt(header.number))); }
function bytesField(value: unknown, length: number): Uint8Array {
  const bytes = typeof value === 'string' ? unhex(value) : Array.isArray(value) && value.every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 255) ? Uint8Array.from(value) : null;
  if (!bytes || bytes.length !== length) throw new Error('Invalid Wormhole Merkle byte field.'); return bytes;
}
function nullifierKey(nullifier: string): string { const bytes = unhex(normalizeNullifier(nullifier)); return storagePrefix('Wormhole', 'UsedNullifiers') + hex(blake2AsU8a(bytes, 128)).slice(2) + nullifier.slice(2); }
function historicalBlockKey(number: number): string { const bytes = little(BigInt(uint(number)), 4); return storagePrefix('System', 'BlockHash') + xxhashAsHex(bytes, 64).slice(2) + hex(bytes).slice(2); }
async function assertUnused(rpc: WormholeRpcLike, nullifiers: string[], at: string) {
  if (!nullifiers.length || nullifiers.length > 7 || new Set(nullifiers).size !== nullifiers.length) throw new Error('Invalid withdrawal nullifier set.');
  const keys = nullifiers.map(nullifierKey);
  const rows = await rpc.call<unknown>('state_queryStorageAt', [keys, at]);
  if (!Array.isArray(rows) || rows.length !== 1 || obj(rows[0]).block !== at || !Array.isArray(obj(rows[0]).changes)) throw new Error('The nullifier check is not pinned to the requested block.');
  const map = new Map<string, string | null>();
  for (const pair of obj(rows[0]).changes as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || !keys.includes(pair[0]) || map.has(pair[0]) || (pair[1] !== null && pair[1] !== '0x00' && pair[1] !== '0x01')) throw new Error('Incomplete or invalid nullifier state.');
    map.set(pair[0], pair[1]);
  }
  if (map.size !== keys.length) throw new Error('The node omitted a required nullifier check.');
  if ([...map.values()].some(value => value === '0x01')) throw new Error('One of these encrypted inputs was already spent. Rescan before preparing another withdrawal.');
}
async function runtimeAt(rpc: WormholeRpcLike, at: string) {
  const [genesis, codeHash, versionValue, metadataHex] = await Promise.all([
    rpc.call('chain_getBlockHash', [0]), rpc.call('state_getStorageHash', ['0x3a636f6465', at]), rpc.call('state_getRuntimeVersion', [at]), rpc.call('state_getMetadata', [at]),
  ]);
  const version = obj(versionValue);
  if (genesis !== GENESIS || codeHash !== WORMHOLE_CODE_HASH || version.specName !== 'quantus-runtime' || version.specVersion !== 152 || version.transactionVersion !== 6) throw new Error('Quantus runtime code changed or the node is on another network. Withdrawal is disabled.');
  if (typeof metadataHex !== 'string') throw new Error('Runtime metadata is unavailable.');
  let decoded: ReturnType<typeof validateMetadata>;
  try { decoded = validateMetadata(metadataHex); } catch { throw new Error('Runtime metadata does not match the verified Wormhole implementation.'); }
  const constant = (pallet: string, name: string): bigint => {
    const value = decoded.metadata.asLatest.pallets.find(p => p.name.toString() === pallet)?.constants.find(c => c.name.toString() === name);
    if (!value) throw new Error(`Missing ${pallet}.${name} runtime constant.`);
    return fromLittle(unhex(value.value.toHex()));
  };
  const fee = constant('Wormhole', 'VolumeFeeRateBps'); const quantum = constant('Vesting', 'PayoutQuantum'); const count = constant('System', 'BlockHashCount');
  if (fee !== 4n || quantum !== WORMHOLE_QUANTUM || count !== 4096n) throw new Error('Wormhole fee, amount quantum, or proof lifetime changed. Update this app.');
  return { ...decoded, volumeFeeBps: Number(fee), blockHashCount: Number(count) };
}
function proofBlock(header: Record<string, unknown>, blockHash: string, registry: ReturnType<typeof validateMetadata>['registry']): WormholeProofRequest['block'] {
  const logs = obj(header.digest).logs;
  if (!Array.isArray(logs) || logs.length > 4) throw new Error('Unsupported Wormhole block digest.');
  const encoded = logs.map(log => {
    if (typeof log !== 'string') throw new Error('Invalid block digest log.');
    const bytes = unhex(log);
    if (bytes.length > 110 || registry.createType('DigestItem', log).toHex() !== log) throw new Error('Non-canonical block digest.');
    return bytes;
  });
  const digest = concat(compact(BigInt(logs.length)), ...encoded);
  if (digest.length > 110) throw new Error('This block header exceeds the supported Wormhole circuit digest size.');
  return { hash: blockHash, number: headerHeight(header), parentHash: hash32(header.parentHash), stateRoot: hash32(header.stateRoot), extrinsicsRoot: hash32(header.extrinsicsRoot), zkTreeRoot: hash32(header.zkTreeRoot), digest: hex(digest) };
}
async function verifyDepositEvents(rpc: WormholeRpcLike, selected: WormholeUtxo[], atHeight: number, signal?: AbortSignal) {
  const groups = new Map<number, WormholeUtxo[]>();
  for (const utxo of selected) {
    if (uint(utxo.blockHeight) > atHeight || utxo.blockHeight === 0) throw new Error('A selected deposit is not finalized at the proof block.');
    groups.set(utxo.blockHeight, [...groups.get(utxo.blockHeight) ?? [], utxo]);
  }
  for (const [height, deposits] of groups) {
    checkAbort(signal);
    const blockHash = hash32(await rpc.call('chain_getBlockHash', [height]));
    const [metadata, raw] = await Promise.all([rpc.call<string>('state_getMetadata', [blockHash]), rpc.call<string | null>('state_getStorage', [storagePrefix('System', 'Events'), blockHash])]);
    if (!raw) throw new Error('Original deposit events are unavailable. Indexed amounts cannot be trusted for withdrawal.');
    const { registry } = validateMetadata(metadata);
    const decodedEvents = registry.createType('Vec<EventRecord>', raw);
    if (decodedEvents.toHex() !== raw) throw new Error('Original deposit event encoding is non-canonical or contains trailing bytes.');
    const events = decodedEvents as unknown as Iterable<EventRecord>;
    const remaining = new Map(deposits.map(utxo => [utxo.leafIndex, utxo]));
    for (const record of events) {
      const event = record.event;
      if (event.section !== 'wormhole' || event.method !== 'NativeTransferred') continue;
      const leaf = event.data[4].toString(); const utxo = remaining.get(leaf);
      if (!utxo) continue;
      if (event.data[1].toString() !== utxo.address || event.data[2].toString() !== utxo.amountPlanck.toString() || event.data[3].toString() !== utxo.transferCount) throw new Error('Indexed deposit ownership or amount disagrees with the original chain event.');
      remaining.delete(leaf);
    }
    if (remaining.size) throw new Error('A selected deposit could not be verified against its original chain event.');
  }
}
function assertChecked(prepared: Pick<PreparedWormholeWithdrawal, 'selection' | 'proofRequest' | 'realNullifiers'>, result: WormholeCheckedSummary) {
  const data = obj(result);
  if (data.verified !== true || data.codeHash !== WORMHOLE_CODE_HASH || data.normalAddress !== prepared.proofRequest.expectedNormalAddress || data.inputPlanck !== prepared.selection.inputPlanck.toString() || data.netPlanck !== prepared.selection.netToSelfPlanck.toString() || data.feePlanck !== prepared.selection.totalLossPlanck.toString() || !Array.isArray(data.realNullifiers) || !identicalSet(data.realNullifiers.map(normalizeNullifier), prepared.realNullifiers)) throw new Error('The local proof check does not match the selected inputs, owned address, or exact amounts.');
}
export async function prepareWormholeWithdrawal(options: PrepareWormholeWithdrawalOptions): Promise<PreparedWormholeWithdrawal> {
  const { snapshot, selfAddress, normalAccountIndex, signal } = options;
  checkAbort(signal); addressBytes(selfAddress); uint(normalAccountIndex, 999999);
  if (!snapshot || snapshot.snapshot?.genesis !== GENESIS || snapshot.snapshot.finality !== 'finalized' || snapshot.scope !== 'gap-limit-20') throw new Error('Complete a verified finalized encrypted balance scan first.');
  const summary = summarizeWormholeSelection(snapshot.utxos, options.selectedIds);
  const leaves = new Set<string>();
  for (const utxo of summary.selected) {
    addressBytes(utxo.address); uint(utxo.index, 0x7fffffff); amount(utxo.leafIndex, (1n << 64n) - 1n); amount(utxo.transferCount, (1n << 64n) - 1n);
    if ((utxo.branch !== 0 && utxo.branch !== 1) || leaves.has(utxo.leafIndex) || BigInt(utxo.leafIndex) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid or unsupported selected leaf index.');
    leaves.add(utxo.leafIndex);
  }
  const rpc = options.rpc ?? new WormholeRpc({ signal });
  const [finalizedHashValue, bestHashValue] = await Promise.all([rpc.call('chain_getFinalizedHead'), rpc.call('chain_getBlockHash')]);
  const finalizedHash = hash32(finalizedHashValue); const bestHash = hash32(bestHashValue);
  const [headerValue, bestHeaderValue, rules, snapshotHash] = await Promise.all([rpc.call('chain_getHeader', [finalizedHash]), rpc.call('chain_getHeader', [bestHash]), runtimeAt(rpc, finalizedHash), rpc.call('chain_getBlockHash', [snapshot.snapshot.blockHeight])]);
  if (snapshotHash !== snapshot.snapshot.blockHash) throw new Error('The scanned snapshot was reorganized. Rescan encrypted balances.');
  const block = proofBlock(obj(headerValue), finalizedHash, rules.registry); const bestBlock = headerHeight(obj(bestHeaderValue));
  if (block.number === 0 || block.number < snapshot.snapshot.blockHeight || bestBlock < block.number) throw new Error('The node did not return a current finalized proof block.');
  const expiresAt = uint(block.number + rules.blockHashCount + 1);
  if (bestBlock >= expiresAt - 16) throw new Error('The finalized proof block is too close to its runtime expiry. Try a fresher node.');
  const selection = feeSelection(summary, rules.volumeFeeBps);
  const realNullifiers = (await options.computeNullifiers(summary.selected.map(({ branch, index, address, transferCount }) => ({ branch, index, address, transferCount })))).map(normalizeNullifier);
  if (realNullifiers.length !== summary.selected.length || new Set(realNullifiers).size !== realNullifiers.length) throw new Error('The Worker returned an invalid input nullifier set.');
  checkAbort(signal);
  await Promise.all([assertUnused(rpc, realNullifiers, bestHash), verifyDepositEvents(rpc, summary.selected, block.number, signal)]);
  const inputs: WormholeProofRequest['inputs'] = [];
  for (const utxo of summary.selected) {
    checkAbort(signal);
    const proof = obj(await rpc.call('zkTree_getMerkleProof', [Number(utxo.leafIndex), finalizedHash]));
    if (proof.leaf_index !== Number(utxo.leafIndex)) throw new Error('Merkle response belongs to a different leaf.');
    const leafData = bytesField(proof.leaf_data, 60); const leafHash = bytesField(proof.leaf_hash, 32); const root = bytesField(proof.root, 32);
    if (!same(leafData.slice(0, 32), addressBytes(utxo.address)) || fromLittle(leafData.slice(32, 40)).toString() !== utxo.transferCount || fromLittle(leafData.slice(40, 44)) !== 0n || fromLittle(leafData.slice(44, 60)) !== utxo.amountPlanck || hex(root) !== block.zkTreeRoot) throw new Error('Merkle leaf ownership, amount, asset, or root does not match the finalized deposit.');
    const depth = uint(proof.depth, 32);
    if (!Array.isArray(proof.siblings) || proof.siblings.length !== depth) throw new Error('Incomplete Merkle proof path.');
    const siblings = proof.siblings.map(level => { if (!Array.isArray(level) || level.length !== 3) throw new Error('The Wormhole tree requires three siblings per level.'); return level.map(value => hex(bytesField(value, 32))); });
    inputs.push({ branch: utxo.branch, index: utxo.index, address: utxo.address, transferCount: utxo.transferCount, leafIndex: utxo.leafIndex, amountPlanck: utxo.amountPlanck.toString(), leafData: hex(leafData), leafHash: hex(leafHash), siblings });
  }
  const request: WormholeProofRequest = { specVersion: 152, genesisHash: GENESIS, codeHash: WORMHOLE_CODE_HASH, volumeFeeBps: rules.volumeFeeBps, normalAccountIndex, expectedNormalAddress: selfAddress, expected: { inputPlanck: selection.inputPlanck.toString(), netPlanck: selection.netToSelfPlanck.toString(), feePlanck: selection.totalLossPlanck.toString() }, block, inputs };
  const prepared: PreparedWormholeWithdrawal = { selection, proofRequest: request, realNullifiers, context: { genesis: GENESIS, codeHash: WORMHOLE_CODE_HASH, volumeFeeBps: rules.volumeFeeBps, proofBlock: block.number, proofBlockHash: block.hash, bestBlock, expiresAt, blockHashCount: rules.blockHashCount, endpoint: rpc instanceof WormholeRpc ? rpc.endpoint : RPC_URLS[0], createdAt: Date.now() } };
  // This callback verifies leaf Poseidon hashes, full Merkle paths, canonical header hash,
  // and same-seed ordinary account ownership inside the local Worker, without proving.
  assertChecked(prepared, await options.checkProofRequest(request));
  checkAbort(signal);
  if (await rpc.call('chain_getBlockHash', [block.number]) !== block.hash) throw new Error('The proof block was reorganized during preparation.');
  freeze(prepared); preparedObjects.add(prepared); return prepared;
}
export function bindWormholeProof(prepared: PreparedWormholeWithdrawal, result: WormholeVerifiedProof): ReadyWormholeWithdrawal {
  if (!preparedObjects.has(prepared)) throw new Error('Prepare this withdrawal locally before binding a proof.');
  assertChecked(prepared, result);
  if (!Array.isArray(result.proofBytes) || result.proofBytes.length > MAX_PROOF_BYTES || !result.proofBytes.every(value => Number.isInteger(value) && value >= 0 && value <= 255) || !Array.isArray(result.publicInputs)) throw new Error('The Worker returned invalid proof bytes.');
  const proof = Uint8Array.from(result.proofBytes); const { values, parsed } = parseProofPublicInputs(proof);
  if (values.length !== result.publicInputs.length || values.some((value, i) => value !== result.publicInputs[i])) throw new Error('The reported public inputs differ from the actual proof bytes.');
  if (parsed.blockNumber !== prepared.context.proofBlock || parsed.blockHash !== prepared.context.proofBlockHash || !prepared.realNullifiers.every(value => parsed.nullifiers.includes(value)) || !parsed.outputs.length || parsed.outputs.some(value => value.address !== prepared.proofRequest.expectedNormalAddress) || parsed.outputs.reduce((sum, value) => sum + value.amountPlanck, 0n) !== prepared.selection.netToSelfPlanck) throw new Error('The proof does not pay the complete confirmed net amount to your verified ordinary account.');
  const call = concat(Uint8Array.of(20, 2), compact(BigInt(proof.length)), proof);
  const body = concat(Uint8Array.of(4), call); const bytes = hex(concat(compact(BigInt(body.length)), body));
  const ready: ReadyWormholeWithdrawal = { prepared, bytes, hash: blake2AsHex(bytes, 256), publicInputs: parsed };
  freeze(ready); readyObjects.add(ready); return ready;
}

/** Calls author_submitExtrinsic at most once for a locally bound proof. No automatic retry. */
export async function submitWormholeWithdrawalOnce(ready: ReadyWormholeWithdrawal, notify: (receipt: WormholeWithdrawalReceipt) => void, options: { rpc?: WormholeRpcLike; signal?: AbortSignal } = {}): Promise<WormholeWithdrawalReceipt> {
  if (!readyObjects.has(ready) || !preparedObjects.has(ready.prepared) || attemptedHashes.has(ready.hash)) throw new Error('This proof was not prepared locally or a broadcast was already attempted. Check the existing transaction.');
  checkAbort(options.signal);
  const p = ready.prepared; const rpc = options.rpc ?? new WormholeRpc({ endpoint: p.context.endpoint, signal: options.signal });
  const bestHash = hash32(await rpc.call('chain_getBlockHash'));
  const [rules, header, reference, recipientRaw] = await Promise.all([runtimeAt(rpc, bestHash), rpc.call('chain_getHeader', [bestHash]), rpc.call('state_getStorage', [historicalBlockKey(p.context.proofBlock), bestHash]), rpc.call<string | null>('state_getStorage', [accountKey('System', 'Account', p.proofRequest.expectedNormalAddress), bestHash])]);
  const firstBlock = headerHeight(obj(header));
  if (rules.volumeFeeBps !== p.context.volumeFeeBps || rules.blockHashCount !== p.context.blockHashCount || reference !== p.context.proofBlockHash || firstBlock >= p.context.expiresAt - 2) throw new Error('The proof block or runtime rules are no longer valid. Prepare again after checking pending withdrawals.');
  const account = decodeAccount(p.proofRequest.expectedNormalAddress, recipientRaw);
  if (account.free + p.selection.netToSelfPlanck < rules.ed || account.free + p.selection.netToSelfPlanck > MAX_U128) throw new Error('Your ordinary account cannot receive this exact withdrawal amount.');
  await assertUnused(rpc, ready.publicInputs.nullifiers, bestHash);
  checkAbort(options.signal);
  let receipt: WormholeWithdrawalReceipt = { version: 1, kind: 'wormhole-withdrawal', hash: ready.hash, bytes: ready.bytes, selfAddress: p.proofRequest.expectedNormalAddress, normalAccountIndex: p.proofRequest.normalAccountIndex, inputPlanck: p.selection.inputPlanck.toString(), netToSelfPlanck: p.selection.netToSelfPlanck.toString(), volumeFeePlanck: p.selection.volumeFeePlanck.toString(), quantumDustPlanck: p.selection.quantumDustPlanck.toString(), proofBlock: p.context.proofBlock, proofBlockHash: p.context.proofBlockHash, firstBlock, expiresAt: p.context.expiresAt, nullifiers: [...ready.publicInputs.nullifiers], phase: 'submitting', message: 'Saving the public receipt before broadcasting this withdrawal once.', createdAt: Date.now(), endpoint: p.context.endpoint };
  if (!parseWormholeWithdrawalReceipt(receipt)) throw new Error('The prepared withdrawal receipt is invalid.');
  // Deliberately outside the broadcast catch: persistence failure MUST prevent sending.
  const persisted = notify({ ...receipt, nullifiers: [...receipt.nullifiers] });
  if (persisted !== undefined) throw new Error('Receipt persistence must complete synchronously before broadcasting.');
  checkAbort(options.signal);
  if (attemptedHashes.has(ready.hash)) throw new Error('A broadcast was already attempted for this proof.');
  attemptedHashes.add(ready.hash);
  try {
    const returned = await rpc.call('author_submitExtrinsic', [ready.bytes]);
    if (returned !== ready.hash) throw new Error('The node returned a different transaction hash.');
    receipt = { ...receipt, phase: 'submitted', message: 'The node accepted the withdrawal. Waiting for verified inclusion and finality; do not withdraw these inputs again.' };
  } catch (error) {
    const rejected = error instanceof WormholeRpcError && error.code === 1010 && /invalid transaction|bad proof|invalid proof/i.test(error.message) && !/already|priority|temporarily|banned/i.test(error.message);
    receipt = { ...receipt, phase: rejected ? 'failed' : 'unknown', message: rejected ? 'The node explicitly rejected this withdrawal. No automatic replacement proof will be sent.' : 'Broadcast outcome is uncertain. Keep this receipt and check its original hash; do not prepare another withdrawal for these inputs.' };
  }
  try { notify({ ...receipt, nullifiers: [...receipt.nullifiers] }); } catch { receipt = { ...receipt, message: receipt.message + ' The latest status could not be saved; the pre-broadcast receipt remains the recovery record.' }; }
  return receipt;
}

import { blake2AsU8a } from '@polkadot/util-crypto';
import { GENESIS, RPC_URLS, addressBytes, fromLittle, hex, little, same, storagePrefix, unhex, validateMetadata } from '../quantus/protocol.ts';

// Protocol reference: Quantus-Network/quantus-apps @ 76df7b06d7a092c9cdfb9a459f8effb9ddb5e737.
// This module handles public chain data only. Seed/secret derivation belongs in the wallet Worker.
export const WORMHOLE_INDEXER_URL = 'https://sqm.quantus.com/v1/graphql';
export const WORMHOLE_GAP_LIMIT = 20;
export const WORMHOLE_TRANSFER_PAGE_SIZE = 300;
export const WORMHOLE_MAX_TRANSFERS = 10_000;
export const WORMHOLE_DEFAULT_ADDRESS_LIMIT = 1_000;
export type WormholeBranch = 0 | 1;
export interface WormholeAddress { branch: WormholeBranch; index: number; address: string }
export interface WormholeNullifierInput extends WormholeAddress { transferCount: string }
export interface WormholeUtxo extends WormholeAddress {
  id: string;
  blockHeight: number;
  amountPlanck: bigint;
  leafIndex: string;
  transferCount: string;
  toHash: string;
}
export interface WormholeBranchScan {
  branch: WormholeBranch;
  scannedCount: number;
  usedIndices: number[];
  nextIndex: number;
}
export interface WormholeScanProgress { stage: 'network' | 'addresses' | 'transfers' | 'nullifiers'; branch?: WormholeBranch; scannedCount?: number; transferCount?: number }
export interface WormholeBalanceSnapshot {
  balancePlanck: bigint;
  utxos: WormholeUtxo[];
  addresses: WormholeAddress[];
  branches: [WormholeBranchScan, WormholeBranchScan];
  snapshot: { genesis: string; blockHash: string; blockHeight: number; indexedHeight: number; checkedAt: number; finality: 'finalized' };
  scope: 'gap-limit-20';
  gapLimit: 20;
  maxAddressesPerBranch: number;
  receivedTransferCount: number;
  spentTransferCount: number;
}
export interface WormholeScanOptions {
  deriveAddresses: (branch: WormholeBranch, startIndex: number, count: number) => Promise<string[]>;
  computeNullifiers: (inputs: WormholeNullifierInput[]) => Promise<string[]>;
  signal?: AbortSignal;
  onProgress?: (progress: WormholeScanProgress) => void;
  /** Reaching this limit before a full unused gap is an error, never a partial balance. */
  maxAddressesPerBranch?: number;
  /** Test transport injection. The endpoint and read-only method allowlists still apply. */
  fetcher?: typeof fetch;
}

const CHECKPOINT_QUERY = `query WormholeCheckpoint($height: Int!) {
  genesis: block(where: {height: {_eq: 0}}, limit: 1) { height hash }
  indexedHead: block(order_by: {height: desc}, limit: 1) { height hash }
  snapshot: block(where: {height: {_eq: $height}}, limit: 1) { height hash }
}`;
const ACCOUNTS_QUERY = `query WormholeAccounts($ids: [String!]!) {
  accounts: account(where: {id: {_in: $ids}}) { id }
}`;
const TRANSFERS_QUERY = `query WormholeTransfers($tos: [String!]!, $limit: Int!, $offset: Int!, $height: Int!) {
  transfers: transfer(where: {to: {id: {_in: $tos}}, block: {height: {_lte: $height}}},
    order_by: [{block: {height: asc}}, {id: asc}], limit: $limit, offset: $offset) {
    id block {height} to {id} amount toHash: to_hash leafIndex: leaf_index transferCount: transfer_count
  }
}`;
const HASH = /^0x[0-9a-f]{64}$/;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const RPC_METHODS = new Set(['chain_getBlockHash', 'chain_getFinalizedHead', 'chain_getHeader', 'state_getMetadata', 'state_queryStorageAt']);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Incomplete Wormhole network response. Retry the balance scan.');
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Incomplete Wormhole indexer response. Balance is unknown.');
  return value;
}
function integer(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${name} in Wormhole data.`);
  return value;
}
function decimal(value: unknown, max: bigint, name: string): string {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39 || BigInt(value) > max) throw new Error(`Invalid ${name} in Wormhole data.`);
  return value;
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('Invalid Wormhole block hash.');
  return value;
}
function abort(signal?: AbortSignal) { if (signal?.aborted) throw new Error('Wormhole balance scan cancelled.'); }
function canonicalRecipient(address: string): Uint8Array {
  const raw = addressBytes(address);
  // Runtime canonical_leaf_recipient reduces four little-endian Goldilocks limbs.
  const canonical = new Uint8Array(32);
  for (let i = 0; i < 32; i += 8) canonical.set(little(fromLittle(raw.slice(i, i + 8)) % 0xffffffff00000001n, 8), i);
  if (!same(raw, canonical)) throw new Error('The Worker returned a non-canonical encrypted address.');
  return canonical;
}
function mapKey(item: 'TransferCount' | 'UsedNullifiers', key: Uint8Array): string {
  return storagePrefix('Wormhole', item) + hex(blake2AsU8a(key, 128)).slice(2) + hex(key).slice(2);
}

/**
 * Restores both HD branches through a 20-address unused gap. The returned balance is
 * the raw sum of received, unspent leaves at snapshot.blockHash, before fees/dust. Recent incoming and outgoing transfers may not be reflected.
 * No persistent cache and no fallback to zero on unavailable/incomplete data.
 * Public RPC/indexer operators can associate queried addresses and nullifiers with IP.
 */
export async function scanWormholeBalance(options: WormholeScanOptions): Promise<WormholeBalanceSnapshot> {
  const maxAddresses = options.maxAddressesPerBranch ?? WORMHOLE_DEFAULT_ADDRESS_LIMIT;
  if (!Number.isSafeInteger(maxAddresses) || maxAddresses < WORMHOLE_GAP_LIMIT || maxAddresses > 5_000) throw new Error('The per-branch scan limit must be between 20 and 5,000 addresses.');
  const fetcher = options.fetcher ?? globalThis.fetch;
  const signal = options.signal;
  let rpcId = 0;
  async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
    abort(signal);
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 20_000);
    try {
      const response = await fetcher(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'no-store' });
      if (!response.ok) throw new Error(`Wormhole data service is unavailable (${response.status}). Balance is unknown.`);
      return object(await response.json());
    } catch (error) {
      abort(signal);
      if (controller.signal.aborted) throw new Error('Wormhole data request timed out. Balance is unknown.');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
    if (!RPC_METHODS.has(method)) throw new Error('Unsupported Wormhole read-only RPC method.');
    const id = ++rpcId;
    const result = await post(RPC_URLS[0], { jsonrpc: '2.0', id, method, params });
    if (result.id !== id || result.error || !('result' in result)) throw new Error('Wormhole RPC did not return a valid result. Balance is unknown.');
    return result.result;
  }
  async function graphql(query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await post(WORMHOLE_INDEXER_URL, { query, variables });
    if (result.errors) throw new Error('The Wormhole indexer rejected the query. Balance is unknown.');
    return object(result.data);
  }
  options.onProgress?.({ stage: 'network' });
  const [genesis, head] = await Promise.all([rpc('chain_getBlockHash', [0]), rpc('chain_getFinalizedHead')]);
  if (genesis !== GENESIS) throw new Error('Wormhole RPC is connected to a different network.');
  const blockHash = hash(head);
  const [headerResult, metadata] = await Promise.all([rpc('chain_getHeader', [blockHash]), rpc('state_getMetadata', [blockHash])]);
  const number = object(headerResult).number;
  if (typeof number !== 'string' || !/^0x[0-9a-f]+$/.test(number)) throw new Error('Invalid Wormhole block height.');
  const blockHeight = integer(Number(BigInt(number)), 'block height');
  if (blockHeight > 2_147_483_647) throw new Error('Wormhole block height exceeds the supported indexer range.');
  // Pinned metadata verifies both storage layouts; unknown runtime layouts fail closed.
  if (typeof metadata !== 'string') throw new Error('Wormhole runtime metadata is unavailable.');
  try { validateMetadata(metadata); } catch { throw new Error('Wormhole runtime rules changed. Update this app before scanning encrypted balances.'); }
  async function checkpoint(): Promise<number> {
    const result = await graphql(CHECKPOINT_QUERY, { height: blockHeight });
    const indexedGenesis = array(result.genesis);
    if (indexedGenesis.length !== 1 || object(indexedGenesis[0]).height !== 0 || object(indexedGenesis[0]).hash !== GENESIS) throw new Error('Wormhole indexer genesis does not match Quantus mainnet.');
    const heads = array(result.indexedHead);
    if (heads.length !== 1) throw new Error('Wormhole indexer height is unavailable. Balance is unknown.');
    const indexedHeight = integer(object(heads[0]).height, 'indexer height');
    hash(object(heads[0]).hash);
    if (indexedHeight < blockHeight) throw new Error('The Wormhole indexer is still syncing. Retry when it reaches the finalized snapshot height.');
    const blocks = array(result.snapshot);
    if (blocks.length !== 1 || object(blocks[0]).height !== blockHeight || object(blocks[0]).hash !== blockHash) throw new Error('Wormhole indexer and RPC disagree on the snapshot block. Retry the scan.');
    return indexedHeight;
  }
  const indexedHeight = await checkpoint();
  async function storage(keys: string[]): Promise<(string | null)[]> {
    if (!keys.length) return [];
    const values: (string | null)[] = [];
    for (let start = 0; start < keys.length; start += 100) {
      const batch = keys.slice(start, start + 100);
      const result = array(await rpc('state_queryStorageAt', [batch, blockHash]));
      if (result.length !== 1 || object(result[0]).block !== blockHash) throw new Error('Wormhole storage response is not pinned to the requested block.');
      const changes = array(object(result[0]).changes);
      const map = new Map<string, string | null>();
      for (const change of changes) {
        const pair = array(change);
        if (pair.length !== 2 || typeof pair[0] !== 'string' || !batch.includes(pair[0]) || map.has(pair[0]) || (pair[1] !== null && typeof pair[1] !== 'string')) throw new Error('Incomplete or duplicate Wormhole storage response.');
        map.set(pair[0], pair[1] as string | null);
      }
      if (map.size !== batch.length) throw new Error('Wormhole storage response omitted a requested key. Balance is unknown.');
      values.push(...batch.map(key => map.get(key)!));
    }
    return values;
  }
  const addresses: WormholeAddress[] = [];
  const allDerived = new Set<string>();
  const counts = new Map<string, bigint>();
  const branches: WormholeBranchScan[] = [];
  for (const branch of [0, 1] as const) {
    let scannedCount = 0;
    let missing = 0;
    const usedIndices: number[] = [];
    while (missing < WORMHOLE_GAP_LIMIT) {
      abort(signal);
      if (scannedCount >= maxAddresses) throw new Error(`Encrypted branch ${branch} reached the ${maxAddresses}-address scan limit before a full unused gap. Balance is incomplete.`);
      const count = Math.min(WORMHOLE_GAP_LIMIT, maxAddresses - scannedCount);
      const derived = await options.deriveAddresses(branch, scannedCount, count);
      abort(signal);
      if (!Array.isArray(derived) || derived.length !== count) throw new Error('The Worker returned an incomplete address batch.');
      const keys = derived.map(address => {
        if (typeof address !== 'string' || allDerived.has(address)) throw new Error('The Worker returned a duplicate or invalid encrypted address.');
        allDerived.add(address);
        return mapKey('TransferCount', canonicalRecipient(address));
      });
      const [accountResult, countResult] = await Promise.all([graphql(ACCOUNTS_QUERY, { ids: derived }), storage(keys)]);
      const used = new Set<string>();
      for (const row of array(accountResult.accounts)) {
        const id = object(row).id;
        if (typeof id !== 'string' || !derived.includes(id) || used.has(id)) throw new Error('The Wormhole indexer returned unexpected or duplicate accounts.');
        used.add(id);
      }
      const startIndex = scannedCount;
      for (let i = 0; i < derived.length && missing < WORMHOLE_GAP_LIMIT; i++) {
        const rawCount = countResult[i];
        if (rawCount !== null && !/^0x[0-9a-f]{16}$/.test(rawCount)) throw new Error('Invalid on-chain Wormhole transfer count.');
        const transferCount = rawCount === null ? 0n : fromLittle(unhex(rawCount));
        const address = derived[i];
        if (transferCount > 0n && !used.has(address)) throw new Error('The Wormhole indexer is missing a funded address. Balance is incomplete.');
        const entry = { branch, index: startIndex + i, address };
        addresses.push(entry);
        counts.set(address, transferCount);
        scannedCount++;
        if (used.has(address)) { usedIndices.push(entry.index); missing = 0; } else missing++;
      }
      options.onProgress?.({ stage: 'addresses', branch, scannedCount });
    }
    branches.push({ branch, scannedCount, usedIndices, nextIndex: usedIndices.length ? usedIndices[usedIndices.length - 1] + 1 : 0 });
  }
  // Count continuity checks below catch empty/missing pages even when indexer head is current.
  const expectedTransfers = [...counts.values()].reduce((sum, count) => sum + count, 0n);
  if (expectedTransfers > BigInt(WORMHOLE_MAX_TRANSFERS)) throw new Error('Encrypted history exceeds the 10,000-transfer scan limit. Balance is incomplete.');
  const owners = new Map(addresses.map(address => [address.address, address]));
  const fundedAddresses = addresses.filter(address => counts.get(address.address)! > 0n).map(address => address.address);
  const transfers: WormholeUtxo[] = [];
  const ids = new Set<string>();
  const recipientCounts = new Map<string, Set<string>>();
  const leaves = new Set<string>();
  for (let start = 0; start < fundedAddresses.length; start += 100) {
    const tos = fundedAddresses.slice(start, start + 100);
    let offset = 0;
    let previous: WormholeUtxo | undefined;
    while (true) {
      const result = await graphql(TRANSFERS_QUERY, { tos, limit: WORMHOLE_TRANSFER_PAGE_SIZE, offset, height: blockHeight });
      const page = array(result.transfers);
      if (page.length > WORMHOLE_TRANSFER_PAGE_SIZE) throw new Error('Wormhole transfer page exceeds its requested limit.');
      for (const value of page) {
        const row = object(value);
        const id = row.id;
        const address = object(row.to).id;
        if (typeof id !== 'string' || !id || id.length > 200 || ids.has(id) || typeof address !== 'string' || !tos.includes(address)) throw new Error('Unexpected or duplicate Wormhole transfer.');
        const height = integer(object(row.block).height, 'transfer height');
        const amount = decimal(row.amount, U128_MAX, 'transfer amount');
        const transferCount = decimal(row.transferCount, U64_MAX, 'transfer count');
        const leafIndex = decimal(row.leafIndex, U64_MAX, 'leaf index');
        if (height > blockHeight || typeof row.toHash !== 'string' || !/^[0-9a-f]{64}$/.test(row.toHash)) throw new Error('Invalid Wormhole transfer metadata.');
        if (BigInt(transferCount) >= counts.get(address)!) throw new Error('Wormhole transfer count disagrees with chain state.');
        const seen = recipientCounts.get(address) ?? new Set<string>();
        if (seen.has(transferCount) || leaves.has(leafIndex)) throw new Error('Duplicate Wormhole transfer count or leaf index.');
        seen.add(transferCount); recipientCounts.set(address, seen); leaves.add(leafIndex); ids.add(id);
        const transfer: WormholeUtxo = { ...owners.get(address)!, id, blockHeight: height, amountPlanck: BigInt(amount), leafIndex, transferCount, toHash: row.toHash };
        if (previous && (height < previous.blockHeight || (height === previous.blockHeight && id <= previous.id))) throw new Error('Wormhole transfer pagination is not in stable order.');
        previous = transfer; transfers.push(transfer);
        if (transfers.length > WORMHOLE_MAX_TRANSFERS) throw new Error('Encrypted history exceeds the transfer scan limit. Balance is incomplete.');
      }
      options.onProgress?.({ stage: 'transfers', transferCount: transfers.length });
      if (page.length < WORMHOLE_TRANSFER_PAGE_SIZE) break;
      offset += WORMHOLE_TRANSFER_PAGE_SIZE;
    }
  }
  for (const [address, count] of counts) {
    if (BigInt(recipientCounts.get(address)?.size ?? 0) !== count) throw new Error('Wormhole transfer history is incomplete or still syncing. Balance is unknown.');
  }
  const utxos: WormholeUtxo[] = [];
  let spentTransferCount = 0;
  const seenNullifiers = new Set<string>();
  for (let start = 0; start < transfers.length; start += 100) {
    abort(signal);
    const batch = transfers.slice(start, start + 100);
    const nullifiers = await options.computeNullifiers(batch.map(({ branch, index, address, transferCount }) => ({ branch, index, address, transferCount })));
    abort(signal);
    if (!Array.isArray(nullifiers) || nullifiers.length !== batch.length) throw new Error('The Worker returned an incomplete nullifier batch.');
    const keys = nullifiers.map(value => {
      const normalized = typeof value === 'string' ? (value.startsWith('0x') ? value : `0x${value}`).toLowerCase() : '';
      if (!HASH.test(normalized) || seenNullifiers.has(normalized)) throw new Error('The Worker returned a duplicate or invalid nullifier.');
      seenNullifiers.add(normalized);
      return mapKey('UsedNullifiers', unhex(normalized));
    });
    const used = await storage(keys);
    for (let i = 0; i < batch.length; i++) {
      if (used[i] === '0x01') spentTransferCount++;
      else if (used[i] === null || used[i] === '0x00') utxos.push(batch[i]);
      else throw new Error('Invalid on-chain Wormhole nullifier flag. Balance is unknown.');
    }
    options.onProgress?.({ stage: 'nullifiers', transferCount: Math.min(start + batch.length, transfers.length) });
  }
  // Detect reorganizations that invalidate an otherwise internally consistent scan.
  const [stillCanonical] = await Promise.all([rpc('chain_getBlockHash', [blockHeight]), checkpoint()]);
  if (stillCanonical !== blockHash) throw new Error('Quantus reorganized the snapshot block. Retry the encrypted balance scan.');
  abort(signal);
  return {
    balancePlanck: utxos.reduce((sum, utxo) => sum + utxo.amountPlanck, 0n), utxos, addresses,
    branches: branches as [WormholeBranchScan, WormholeBranchScan],
    snapshot: { genesis: GENESIS, blockHash, blockHeight, indexedHeight, checkedAt: Date.now(), finality: 'finalized' },
    scope: 'gap-limit-20', gapLimit: WORMHOLE_GAP_LIMIT, maxAddressesPerBranch: maxAddresses,
    receivedTransferCount: transfers.length, spentTransferCount,
  };
}

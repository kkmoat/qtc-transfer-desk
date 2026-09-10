import { blake2AsHex, xxhashAsHex } from '@polkadot/util-crypto';
import { RPC_URLS, fromLittle, unhex, storagePrefix, little, hex } from '../quantus/protocol.ts';
import { MAX_SUPPLY_PLANCK, type SupplySnapshot } from './supply.ts';

// Verified against the mainnet v152 runtime. Do not reinterpret changed storage layouts.
// https://github.com/Quantus-Network/chain/blob/f5828f0bd827f476cad299d0b092da128f863f5c/pallets/vesting/src/lib.rs
export const CIRCULATION_SOURCE = 'https://github.com/Quantus-Network/chain/blob/f5828f0bd827f476cad299d0b092da128f863f5c/pallets/vesting/src/lib.rs';
export const VESTING_PREFIX = storagePrefix('Vesting', 'Schedules');
export const VESTING_LAUNCH_KEY = storagePrefix('Vesting', 'Launch');
export const VESTING_NEXT_KEY = storagePrefix('Vesting', 'NextScheduleId');
export const VESTING_VERSION_KEY = storagePrefix('Vesting', ':__STORAGE_VERSION__:');
// PalletId(*b"qvesting").into_account_truncating(): "modl" + pallet id + zero padding.
const pot = new Uint8Array(32); pot.set(new TextEncoder().encode('modlqvesting'));
export const VESTING_POT_KEY = storagePrefix('System', 'Account') + blake2AsHex(pot,128).slice(2) + hex(pot).slice(2);
export const VESTING_POT_ED = 1_000_000_000n;
export const VESTING_PAGE_SIZE = 64;
export const MAX_VESTING_SCHEDULES = 256;
export type VestingSchedule = { start: bigint; cliff: bigint; end: bigint; total: bigint; claimed: bigint; lastClaimAt: bigint | null };
export type CirculationSnapshot = {
  circulatingPlanck: bigint; lockedPlanck: bigint; unclaimedVestedPlanck: bigint;
  blockHash: string; fetchedAt: number; launchTime: number; scheduleCount: number;
  basis: 'on-chain-vesting'; source: string;
};
const error = () => new Error('暂时无法核实链上解锁数据，请稍后刷新。');
const isHash = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw error();
  return value as Record<string, unknown>;
};
const decodeU64 = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{16}$/.test(value)) throw error();
  return fromLittle(unhex(value));
};
export function decodeVestingSchedule(value: unknown): VestingSchedule {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(value)) throw error();
  const b = unhex(value);
  // AccountId32 + 3*u64 + 2*u128 + Option<u64>.
  if (!((b.length === 89 && b[88] === 0) || (b.length === 97 && b[88] === 1))) throw error();
  const schedule = { start: fromLittle(b.slice(32,40)), cliff: fromLittle(b.slice(40,48)), end: fromLittle(b.slice(48,56)), total: fromLittle(b.slice(56,72)), claimed: fromLittle(b.slice(72,88)), lastClaimAt: b[88] === 1 ? fromLittle(b.slice(89,97)) : null };
  if (schedule.start > schedule.cliff || schedule.cliff > schedule.end || schedule.start >= schedule.end || schedule.total <= 0n || schedule.total > MAX_SUPPLY_PLANCK || schedule.claimed > schedule.total || (schedule.claimed > 0n) !== (schedule.lastClaimAt !== null)) throw error();
  return schedule;
}
export function vestedAmount(schedule: VestingSchedule, now: bigint): bigint {
  if (now < schedule.cliff) return 0n;
  if (now >= schedule.end) return schedule.total;
  // Same integer floor as pallet_vesting::vested_amount; claimed is not subtracted.
  return schedule.total * (now - schedule.start) / (schedule.end - schedule.start);
}
function scheduleKey(id: number): string {
  const bytes = little(BigInt(id),8);
  return VESTING_PREFIX + xxhashAsHex(bytes,64).slice(2) + hex(bytes).slice(2);
}

/** Estimated transferable supply: net issuance minus unvested schedule amounts.
 * Vested-but-unclaimed amounts count as unlocked. This is not an audited free-float
 * figure and does not exclude private holdings, account freezes or lost keys.
 */
export async function fetchCirculationSnapshot(supply: SupplySnapshot, signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<CirculationSnapshot> {
  if (!RPC_URLS.some(endpoint => endpoint === supply.endpoint) || !isHash(supply.blockHash) || !Number.isSafeInteger(supply.blockTime) || supply.blockTime < Date.UTC(2025,0,1) || supply.totalPlanck <= 0n || supply.totalPlanck > MAX_SUPPLY_PLANCK) throw error();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(18_000)]);
  let id = 0;
  const call = async (method: string, params: unknown[]): Promise<unknown> => {
    requestSignal.throwIfAborted();
    const requestId = ++id;
    const response = await fetcher(supply.endpoint, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: requestSignal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
    if (!response.ok) throw error();
    const text = await response.text(); if (text.length > 150_000) throw error();
    const data = object(JSON.parse(text));
    if (data.id !== requestId || data.error || !('result' in data)) throw error();
    return data.result;
  };
  const head = supply.blockHash;
  try {
    const [runtimeRaw, version, launchRaw, nextRaw, potRaw] = await Promise.all([
      call('state_getRuntimeVersion', [head]),
      call('state_getStorage', [VESTING_VERSION_KEY, head]),
      call('state_getStorage', [VESTING_LAUNCH_KEY, head]),
      call('state_getStorage', [VESTING_NEXT_KEY, head]),
      call('state_getStorage', [VESTING_POT_KEY, head]),
    ]);
    const runtime = object(runtimeRaw), nextId = decodeU64(nextRaw);
    if (runtime.specName !== 'quantus-runtime' || runtime.specVersion !== 152 || version !== '0x0000' || nextId < 48n || nextId > BigInt(MAX_VESTING_SCHEDULES) || typeof launchRaw !== 'string' || !/^0x01[0-9a-fA-F]{16}$/.test(launchRaw) || typeof potRaw !== 'string' || !/^0x[0-9a-fA-F]{160}$/.test(potRaw)) throw error();
    const account = unhex(potRaw), potBalance = fromLittle(account.slice(16,32)) + fromLittle(account.slice(32,48));
    const now = BigInt(supply.blockTime), launch = fromLittle(unhex(launchRaw).slice(1));
    if (launch < BigInt(Date.UTC(2025,0,1)) || launch > now) throw error();
    let locked = 0n, unclaimedVested = 0n, outstanding = 0n, scheduleCount = 0;
    // IDs are sequential and never reused. Request every possible id explicitly,
    // so truncated key enumeration cannot silently increase circulating supply.
    for (let first = 0; first < Number(nextId); first += VESTING_PAGE_SIZE) {
        const keys = Array.from({length: Math.min(VESTING_PAGE_SIZE,Number(nextId)-first)},(_,i)=>scheduleKey(first+i));
        const rows = await call('state_queryStorageAt', [keys, head]);
        if (!Array.isArray(rows) || rows.length !== 1) throw error();
        const row = object(rows[0]);
        if (row.block !== head || !Array.isArray(row.changes) || row.changes.length !== keys.length) throw error();
        const expected = new Set(keys);
        for (const change of row.changes) {
          if (!Array.isArray(change) || change.length !== 2 || !expected.delete(change[0])) throw error();
          // Administratively ended schedules are removed. Their funds leave the pot.
          if (change[1] === null) continue;
          const schedule = decodeVestingSchedule(change[1]), vested = vestedAmount(schedule, now);
          if (schedule.start < launch || schedule.claimed > vested || (schedule.lastClaimAt !== null && (schedule.lastClaimAt < launch || schedule.lastClaimAt > now))) throw error();
          locked += schedule.total - vested;
          unclaimedVested += vested - schedule.claimed;
          outstanding += schedule.total - schedule.claimed;
          scheduleCount++;
          if (locked > supply.totalPlanck || unclaimedVested > supply.totalPlanck) throw error();
        }
    }
    // Mainnet's pot is endowed with obligations + ED. Fail closed on omissions or
    // unmatched extra deposits instead of treating an unexplained balance as liquid.
    if (potBalance > supply.totalPlanck || potBalance !== outstanding + VESTING_POT_ED) throw error();
    return { circulatingPlanck: supply.totalPlanck - locked, lockedPlanck: locked, unclaimedVestedPlanck: unclaimedVested, blockHash: head, fetchedAt: Date.now(), launchTime: Number(launch), scheduleCount, basis: 'on-chain-vesting', source: CIRCULATION_SOURCE };
  } catch {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw error();
  }
}

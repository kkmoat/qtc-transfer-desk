import type { EventRecord } from '@polkadot/types/interfaces';
import { blake2AsHex, encodeAddress, xxhashAsHex } from '@polkadot/util-crypto';
import { addressBytes, hex, little, storagePrefix, validateMetadata } from '../quantus/protocol.ts';
import { parseWormholeExtrinsicPublicInputs, WORMHOLE_CODE_HASH } from './withdraw.ts';
import type { WormholeRpcLike, WormholeWithdrawalReceipt } from './withdraw.ts';

const HASH = /^0x[0-9a-f]{64}$/;
const MAX_HEIGHT = 0xffff_ffff;
const MAX_SESSION_MS = 30 * 60_000;
const MINTING_ADDRESS = encodeAddress(new Uint8Array(32).fill(1), 189);
const EVENTS_KEY = storagePrefix('System', 'Events');
const ZERO_HASH = '0x' + '00'.repeat(32);

export interface WormholeTrackingOptions {
  /** Defaults to 7 seconds. Bounded to avoid aggressive RPC polling. */
  pollIntervalMs?: number;
  /** A session never exceeds 30 minutes; its receipt can be queried again. */
  maxDurationMs?: number;
}

function stopped(): Error {
  return new Error('提现查询已停止。');
}

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw stopped();
}

// This tracker only calls read RPCs and never submits or signs. Abort
// stops waiting for an in-flight read and suppresses all subsequent reads/updates;
// the transport remains responsible for cancelling its own underlying request.
async function read<T>(rpc: WormholeRpcLike, method: string, params: unknown[] = [], signal?: AbortSignal): Promise<T> {
  checkAbort(signal);
  if (!signal) return rpc.call<T>(method, params);
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(stopped()); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { checkAbort(signal); return rpc.call<T>(method, params); }).then(
      value => { signal.removeEventListener('abort', abort); if (signal.aborted) reject(stopped()); else resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(error); },
    );
  });
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(stopped()); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

function height(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error('节点返回的区块高度无效。');
  const result = Number(BigInt(value));
  if (!Number.isSafeInteger(result) || result < 0 || result > MAX_HEIGHT) throw new Error('区块高度超出支持范围。');
  return result;
}

function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) throw new Error('节点返回的区块哈希无效。');
  return value;
}

function nullifierSet(values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.length !== 7 || values.some(value => typeof value !== 'string' || !HASH.test(value) || /^0x0+$/.test(value))) {
    throw new Error('提现 nullifier 记录不完整。');
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error('提现 nullifier 记录重复。');
  return sorted;
}

function assertReceipt(r: WormholeWithdrawalReceipt): void {
  if (r.version !== 1 || r.kind !== 'wormhole-withdrawal' || !HASH.test(r.hash) || !HASH.test(r.proofBlockHash)) {
    throw new Error('提现记录格式无效。');
  }
  addressBytes(r.selfAddress);
  if (!/^[1-9][0-9]*$/.test(r.netToSelfPlanck) || BigInt(r.netToSelfPlanck) >= (1n << 128n)) {
    throw new Error('提现到账金额无效。');
  }
  for (const value of [r.proofBlock, r.firstBlock, r.expiresAt]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > MAX_HEIGHT) throw new Error('提现区块范围无效。');
  }
  // BlockHashCount is 4096, but frame-system removes P at finalize(P+4097).
  // Extrinsics in P+4097 can still use P. Do not let restored records shorten
  // that window and incorrectly authorize a replacement withdrawal.
  if (r.firstBlock < r.proofBlock || r.firstBlock > r.expiresAt || r.expiresAt !== r.proofBlock + 4097) {
    throw new Error('提现有效期超出支持范围。');
  }
  nullifierSet(r.nullifiers);
}

function assertPublicInputs(bytes: string, r: WormholeWithdrawalReceipt): void {
  if (r.bytes !== undefined && r.bytes !== bytes) throw new Error('区块中的提现编码与原记录不一致。');
  const input = parseWormholeExtrinsicPublicInputs(bytes);
  if (input.assetId !== 0 || input.blockNumber !== r.proofBlock || input.blockHash !== r.proofBlockHash ||
      nullifierSet(input.nullifiers).join() !== nullifierSet(r.nullifiers).join()) {
    throw new Error('区块中的提现证明与原记录不一致。');
  }
  let output = 0n;
  for (const item of input.outputs) {
    if (item.amountPlanck === 0n) continue;
    if (item.address !== r.selfAddress || item.amountPlanck < 0n) throw new Error('提现证明包含未经确认的收款地址。');
    output += item.amountPlanck;
  }
  if (output !== BigInt(r.netToSelfPlanck)) throw new Error('提现证明到账金额与原记录不一致。');
}

/** Inspect one block without assuming that ExtrinsicSuccess means an exit minted. */
export async function inspectWormholeInclusion<T extends WormholeWithdrawalReceipt>(
  rpc: WormholeRpcLike, r: T, blockHash: string, blockHeight: number, signal?: AbortSignal,
): Promise<T | null> {
  return inspectBlock(rpc, r, blockHash, blockHeight, signal);
}

async function inspectBlock<T extends WormholeWithdrawalReceipt>(
  rpc: WormholeRpcLike, r: T, blockHash: string, blockHeight: number, signal?: AbortSignal, expectedParent?: string,
): Promise<T | null> {
  assertReceipt(r);
  hash(blockHash);
  if (!Number.isSafeInteger(blockHeight) || blockHeight < Math.max(0, r.firstBlock - 2) || blockHeight > r.expiresAt) {
    throw new Error('提现所在区块超出查询范围。');
  }
  const block = await read<{ block: { header: { number: string; parentHash: string }; extrinsics: string[] } }>(rpc, 'chain_getBlock', [blockHash], signal);
  if (!block?.block || height(block.block.header?.number) !== blockHeight || !Array.isArray(block.block.extrinsics)) {
    throw new Error('区块内容暂不可用，不能确认提现结果。');
  }
  hash(block.block.header.parentHash);
  if (expectedParent && block.block.header.parentHash !== expectedParent) throw new Error('扫描期间区块链发生重组，需要重新核对。');
  const matches: number[] = [];
  for (let i = 0; i < block.block.extrinsics.length; i++) {
    const bytes = block.block.extrinsics[i];
    if (typeof bytes !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(bytes)) throw new Error('区块交易编码无效。');
    if (blake2AsHex(bytes, 256) === r.hash) matches.push(i);
  }
  if (matches.length === 0) return null;
  if (matches.length !== 1) throw new Error('区块内交易哈希重复，尚不能确认提现结果。');
  const index = matches[0];
  assertPublicInputs(block.block.extrinsics[index], r);
  const [metadata, raw] = await Promise.all([
    read<string>(rpc, 'state_getMetadata', [blockHash], signal),
    read<string | null>(rpc, 'state_getStorage', [EVENTS_KEY, blockHash], signal),
  ]);
  checkAbort(signal);
  if (typeof raw !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(raw) || raw.length > 16_777_218) {
    throw new Error('提现区块事件暂不可用。');
  }
  const { registry } = validateMetadata(metadata);
  const decoded = registry.createType('Vec<EventRecord>', raw);
  if (decoded.toHex().toLowerCase() !== raw.toLowerCase()) throw new Error('提现区块事件编码不完整。');
  const events = decoded as unknown as Iterable<EventRecord>;
  let successes = 0;
  let failure: string | undefined;
  let proofs = 0;
  let proofAmount: bigint | undefined;
  let proofNullifiers: string[] | undefined;
  let credited = 0n;
  let invalidCredit = false;
  for (const item of events) {
    if (!item.phase.isApplyExtrinsic || item.phase.asApplyExtrinsic.toNumber() !== index) continue;
    const event = item.event;
    if (event.section === 'system' && event.method === 'ExtrinsicSuccess') successes++;
    if (event.section === 'system' && event.method === 'ExtrinsicFailed') failure = '提现交易链上执行失败。';
    if (event.section !== 'wormhole') continue;
    if (event.method === 'ExitMintFailed') failure = '提现到账失败；相应 nullifier 可能已消耗，不能直接重试。';
    if (event.method === 'SegmentsDenied') failure = '提现包含被拒绝的分段，未能完整到账。';
    if (event.method === 'NativeTransferred' && proofs === 0) {
      if (event.data[0].toString() !== MINTING_ADDRESS || event.data[1].toString() !== r.selfAddress) invalidCredit = true;
      credited += BigInt(event.data[2].toString());
    }
    if (event.method === 'ProofVerified') {
      proofs++;
      proofAmount = BigInt(event.data[0].toString());
      proofNullifiers = Array.from(event.data[1] as unknown as Iterable<{ toHex(): string }>, value => value.toHex().toLowerCase());
    }
  }
  const included = { ...r, phase: 'included' as const, includedHash: blockHash, includedHeight: blockHeight };
  if (failure) return { ...included, execution: 'failed', message: `${failure} 等待最终确认；请保留原交易哈希并核对余额。` };
  if (successes !== 1 || proofs !== 1 || proofAmount !== BigInt(r.netToSelfPlanck) ||
      !proofNullifiers || nullifierSet(proofNullifiers).join() !== nullifierSet(r.nullifiers).join() ||
      invalidCredit || credited !== BigInt(r.netToSelfPlanck)) {
    throw new Error('已找到提现交易，但证明、nullifier 和本人账户实际到账事件尚未完整核对。');
  }
  return { ...included, execution: 'success', message: '已核实本人账户实际收到提现金额，等待区块最终确认。' };
}

/** A missing block or event always rejects; it can never establish expiration. */
export async function scanFinalizedWormholeEra<T extends WormholeWithdrawalReceipt>(
  rpc: WormholeRpcLike, r: T, finalHeight: number, signal?: AbortSignal,
): Promise<T | null> {
  assertReceipt(r);
  if (!Number.isSafeInteger(finalHeight) || finalHeight <= r.expiresAt || finalHeight > MAX_HEIGHT) {
    throw new Error('提现有效期尚未全部最终确认。');
  }
  let previous: string | undefined;
  for (let h = Math.max(0, r.firstBlock - 2); h <= r.expiresAt; h++) {
    checkAbort(signal);
    const canonical = hash(await read<string | null>(rpc, 'chain_getBlockHash', [h], signal));
    const found = await inspectBlock(rpc, r, canonical, h, signal, previous);
    if (found) return found;
    previous = canonical;
  }
  return null;
}

function finalize<T extends WormholeWithdrawalReceipt>(r: T): T {
  if (!r.includedHash || r.includedHeight === undefined || r.finalizedHeight === undefined ||
      r.finalizedHeight < r.includedHeight || !r.execution) throw new Error('提现执行结果尚未最终核实。');
  return r.execution === 'success'
    ? { ...r, phase: 'finalized', message: '提现金额已转入本人普通账户，并获得主网最终确认。' }
    : { ...r, phase: 'failed', message: '提现未完整成功，结果已最终确认。部分 nullifier 可能已消耗；请核对到账与加密余额，勿直接重复提现。' };
}

async function assertProofReferenceRemoved(rpc: WormholeRpcLike, r: WormholeWithdrawalReceipt, at: string, signal: AbortSignal): Promise<void> {
  const block = little(BigInt(r.proofBlock), 4);
  const key = storagePrefix('System', 'BlockHash') + xxhashAsHex(block, 64).slice(2) + hex(block).slice(2);
  const [codeHash, reference] = await Promise.all([
    read<string | null>(rpc, 'state_getStorageHash', ['0x3a636f6465', at], signal),
    read<string | null>(rpc, 'state_getStorage', [key, at], signal),
  ]);
  if (codeHash !== WORMHOLE_CODE_HASH || (reference !== null && reference !== ZERO_HASH)) {
    throw new Error('运行时规则或证明引用尚未核实失效，不能判定这笔提现已经过期。');
  }
}

/** Read-only after the caller's one broadcast. Persistence belongs to the caller. */
export async function trackWormholeWithdrawal<T extends WormholeWithdrawalReceipt>(
  rpc: WormholeRpcLike, initial: T, notify: (receipt: T) => void,
  signal?: AbortSignal, options: WormholeTrackingOptions = {},
): Promise<T> {
  assertReceipt(initial);
  if (initial.bytes !== undefined) {
    if (!/^0x(?:[0-9a-fA-F]{2})+$/.test(initial.bytes) || blake2AsHex(initial.bytes, 256) !== initial.hash) {
      throw new Error('保存的提现编码与交易哈希不一致。');
    }
    assertPublicInputs(initial.bytes, initial);
  }
  const pollMs = options.pollIntervalMs ?? 7000;
  const duration = options.maxDurationMs ?? MAX_SESSION_MS;
  if (!Number.isSafeInteger(pollMs) || pollMs < 1000 || pollMs > 30_000 ||
      !Number.isSafeInteger(duration) || duration < 1 || duration > MAX_SESSION_MS) throw new Error('提现查询时间范围无效。');
  let r: T = { ...initial, phase: 'unknown', execution: undefined, finalizedHeight: undefined,
    message: '正在按原提现哈希重新核对链上结果。' };
  const controller = new AbortController();
  const userAbort = () => controller.abort();
  if (signal?.aborted) return r;
  signal?.addEventListener('abort', userAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), duration);
  const active = controller.signal;
  const startHeight = Math.max(0, r.firstBlock - 2);
  let scanned = startHeight - 1;
  let scannedHash: string | undefined;
  let verified = false;
  let errors = 0;
  const emit = () => { if (!signal?.aborted) notify({ ...r }); };
  const clearInclusion = () => {
    verified = false;
    scanned = startHeight - 1;
    scannedHash = undefined;
    r = { ...r, phase: 'unknown', execution: undefined, includedHash: undefined, includedHeight: undefined,
      message: '原区块位置已变化，正在重新扫描提现有效期内的区块。' };
  };
  if (!r.includedHash || !HASH.test(r.includedHash) || !Number.isSafeInteger(r.includedHeight) ||
      r.includedHeight! < startHeight || r.includedHeight! > r.expiresAt) {
    r = { ...r, includedHash: undefined, includedHeight: undefined };
  }
  try {
    while (!active.aborted) {
      try {
        const [bestHeader, finalHashValue] = await Promise.all([
          read<{ number: string }>(rpc, 'chain_getHeader', [], active),
          read<string>(rpc, 'chain_getFinalizedHead', [], active),
        ]);
        const best = height(bestHeader?.number);
        const finalHash = hash(finalHashValue);
        const finalHeight = height((await read<{ number: string }>(rpc, 'chain_getHeader', [finalHash], active))?.number);
        if (finalHeight > best || hash(await read(rpc, 'chain_getBlockHash', [finalHeight], active)) !== finalHash) {
          throw new Error('最终确认区块与当前主链尚未一致。');
        }
        r = { ...r, finalizedHeight: finalHeight };
        if (r.includedHash && r.includedHeight !== undefined) {
          const canonical = hash(await read(rpc, 'chain_getBlockHash', [r.includedHeight], active));
          if (canonical !== r.includedHash) { clearInclusion(); emit(); }
          else if (!verified) {
            const checked = await inspectWormholeInclusion(rpc, r, canonical, r.includedHeight, active);
            if (checked) { r = checked; verified = true; } else clearInclusion();
          }
        }
        if (!r.includedHash) {
          if (finalHeight > r.expiresAt) {
            const found = await scanFinalizedWormholeEra(rpc, r, finalHeight, active);
            // Recheck the finalized checkpoint after the exhaustive scan. It is
            // never safe to declare expiry from a mixed or unavailable chain.
            if (hash(await read(rpc, 'chain_getBlockHash', [finalHeight], active)) !== finalHash) throw new Error('最终链发生变化，需重新查询。');
            if (found) { r = found; verified = true; }
            else {
              // An upgrade may lengthen proof validity. The current runtime and
              // its actual reference must agree before absence can mean expiry.
              await assertProofReferenceRemoved(rpc, r, finalHash, active);
              // Also prove that the reference was already removed at the end of
              // the scanned window. A temporary upgrade followed by rollback
              // must not hide an inclusion after the originally expected expiry.
              const expiryHash = hash(await read(rpc, 'chain_getBlockHash', [r.expiresAt], active));
              await assertProofReferenceRemoved(rpc, r, expiryHash, active);
              r = { ...r, phase: 'expired', message: '证明有效期已最终确认；完整检查对应主链区块后未发现原提现交易。请刷新加密余额，再重新准备。' };
              emit(); return r;
            }
          } else {
            if (scannedHash && hash(await read(rpc, 'chain_getBlockHash', [scanned], active)) !== scannedHash) {
              clearInclusion(); emit();
            }
            for (let h = scanned + 1; h <= Math.min(best, r.expiresAt); h++) {
              const canonical = hash(await read(rpc, 'chain_getBlockHash', [h], active));
              const found = await inspectBlock(rpc, r, canonical, h, active, scannedHash);
              if (found) { r = found; verified = true; break; }
              scanned = h; scannedHash = canonical;
            }
          }
        }
        if (verified && r.includedHash && r.includedHeight !== undefined) {
          // Includes newly found transactions and saved claims that were decoded
          // again above. A previous success flag is never sufficient evidence.
          if (hash(await read(rpc, 'chain_getBlockHash', [r.includedHeight], active)) !== r.includedHash) {
            clearInclusion(); emit(); continue;
          }
          if (r.includedHeight <= finalHeight) {
            if (hash(await read(rpc, 'chain_getBlockHash', [finalHeight], active)) !== finalHash) throw new Error('最终链发生变化，需重新查询。');
            r = finalize(r); emit(); return r;
          }
          r = { ...r, phase: 'included' }; emit();
        }
        errors = 0;
        await wait(pollMs, active);
      } catch {
        if (active.aborted) break;
        errors++;
        if (errors === 1) {
          r = { ...r, phase: verified ? 'included' : 'unknown',
            message: verified ? '已核实入块结果，最终确认查询暂不可用；请保留原提现哈希并继续查询。' : '节点或到账事件暂未完整核实。保留原提现哈希继续查询，请勿重复提现。' };
          emit();
        }
        try { await wait(Math.min(30_000, pollMs + errors * 2000), active); } catch { break; }
      }
    }
    if (!signal?.aborted) {
      r = { ...r, phase: 'unknown', message: '本次提现查询已到时间上限。请继续查询原交易哈希；无需重新广播，也不要重复提现。' };
      emit();
    }
    return r;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', userAbort);
  }
}

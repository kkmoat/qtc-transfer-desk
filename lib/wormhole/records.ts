import { parseWormholeWithdrawalReceipt, type WormholeWithdrawalReceipt } from './withdraw.ts';
export const WORMHOLE_PENDING_KEY = 'qtc-wormhole-pending-v1';
export const WORMHOLE_HISTORY_PREFIX = 'qtc-wormhole-history-v1:';
export const withdrawalComplete = (r: WormholeWithdrawalReceipt) => ['finalized','failed','expired'].includes(r.phase);
export function readWithdrawalHistory(): { records: WormholeWithdrawalReceipt[]; available: boolean } {
  try {
    const records: WormholeWithdrawalReceipt[] = [];
    for (let i=0;i<localStorage.length;i++) {
      const key=localStorage.key(i);if(!key?.startsWith(WORMHOLE_HISTORY_PREFIX))continue;
      const raw=localStorage.getItem(key);if(!raw||raw.length>12000)continue;
      try { const r=parseWormholeWithdrawalReceipt(JSON.parse(raw));if(r&&key===WORMHOLE_HISTORY_PREFIX+r.hash){delete r.bytes;records.push(r);} } catch { /* Ignore one damaged public record. */ }
    }
    return {records:records.sort((a,b)=>b.createdAt-a.createdAt),available:true};
  } catch { return {records:[],available:false}; }
}
export function readWithdrawalPending(): WormholeWithdrawalReceipt|null {
  try {
    const raw=sessionStorage.getItem(WORMHOLE_PENDING_KEY);if(!raw||raw.length>2_000_000)return null;
    return parseWormholeWithdrawalReceipt(JSON.parse(raw));
  } catch { return null; }
}
/** Must succeed before broadcasting. History only contains whitelisted public transaction metadata. */
export function saveWithdrawal(value: WormholeWithdrawalReceipt): void {
  const receipt=parseWormholeWithdrawalReceipt(value);
  if(!receipt)throw new Error('加密转出记录无效，未提交交易。');
  const {bytes,...metadata}=receipt;
  const historyKey=WORMHOLE_HISTORY_PREFIX+receipt.hash;
  let beforeHistory:string|null=null;let beforePending:string|null=null;let read=false;
  try {
    beforeHistory=localStorage.getItem(historyKey);beforePending=sessionStorage.getItem(WORMHOLE_PENDING_KEY);read=true;
    localStorage.setItem(historyKey,JSON.stringify(metadata));
    sessionStorage.setItem(WORMHOLE_PENDING_KEY,JSON.stringify(receipt));
  } catch {
    // Roll back an uncommitted pair: a storage failure before broadcast must not
    // leave a new, never-submitted record falsely blocking future withdrawals.
    if(read){
      try{if(beforeHistory===null)localStorage.removeItem(historyKey);else localStorage.setItem(historyKey,beforeHistory);}catch{/* Preserve any available public recovery record. */}
      try{if(beforePending===null)sessionStorage.removeItem(WORMHOLE_PENDING_KEY);else sessionStorage.setItem(WORMHOLE_PENDING_KEY,beforePending);}catch{/* Preserve any available public recovery record. */}
    }
    throw new Error('无法保存加密转出记录。请允许本站使用浏览器存储，并保留交易哈希。提交前遇到此错误时不会广播。');
  }
}
/** Called inside the origin-wide Web Lock before proving and again before submitting. */
export function assertNoPendingWithdrawal(candidate: {selfAddress:string;nullifiers:string[]}):void {
  const history=readWithdrawalHistory();
  if(!history.available)throw new Error('浏览器存储不可用，不能安全记录加密转出。');
  const pending=readWithdrawalPending();
  const all=[...history.records,...(pending?[pending]:[])];
  if(all.some(r=>!withdrawalComplete(r)&&(r.selfAddress===candidate.selfAddress||r.nullifiers.some(n=>candidate.nullifiers.includes(n))))) {
    throw new Error('存在尚未确认的加密转出。请先查询原交易结果，不要重复提交。');
  }
}

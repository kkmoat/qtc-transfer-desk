import type { WormholeBranch, WormholeNullifierInput } from './data.ts';
export interface EncryptedSession { address: string; accountId: number[]; path: string }
/** A separate local Worker session. Secret material never leaves the Worker. */
export class EncryptedWallet {
  private worker = new Worker('/crypto/worker.js', { type: 'module' });
  private closed = false;
  private id = 0;
  private pending = new Map<number, {resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  private onClosed?: (reason:string)=>void;
  constructor(onClosed?: (reason:string)=>void) {
    this.onClosed=onClosed;
    this.worker.onmessage = event => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      clearTimeout(entry.timer); this.pending.delete(event.data.id);
      if (event.data.ok) entry.resolve(event.data.result);
      else entry.reject(new Error(typeof event.data.error === 'string' ? event.data.error : '本地加密账户操作失败。'));
    };
    this.worker.onerror = () => this.close('本地签名组件加载失败，请重新打开钱包。',true);
  }
  private request<T>(data:Record<string,unknown>):Promise<T> {
    return new Promise((resolve,reject) => {
      if (this.closed) { reject(new Error('钱包已锁定，请重新打开。')); return; }
      const id = ++this.id;
      const timer = setTimeout(() => this.close('本地签名操作超时，钱包已自动锁定。',true),90_000);
      this.pending.set(id,{resolve:v=>resolve(v as T),reject,timer});
      try { this.worker.postMessage({...data,id}); } catch { this.close('本地签名组件不可用，钱包已锁定。',true); }
    });
  }
  open(phrase:string) { return this.request<EncryptedSession>({type:'wormhole-open',phrase}); }
  deriveAddresses(branch:WormholeBranch,startIndex:number,count:number) { return this.request<string[]>({type:'wormhole-derive',branch,startIndex,count}); }
  computeNullifiers(inputs:WormholeNullifierInput[]) { return this.request<string[]>({type:'wormhole-nullifiers',inputs}); }
  close(reason='钱包已锁定。',notify=false) {
    if (this.closed) return;
    this.closed=true; this.worker.terminate();
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(new Error(reason)); }
    this.pending.clear();
    if(notify)this.onClosed?.(reason);
  }
}

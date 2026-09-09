import type { Scheme } from './protocol.ts';
export interface OpenWallet {address:string;accountId:number[];publicKey:number[];scheme:Scheme;path:string;}
export class LocalSigner {
 private worker:Worker;
 private nextId=1;
 private closed=false;
 private pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 constructor(){this.worker=new Worker('/crypto/worker.js',{type:'module'});this.worker.onmessage=e=>{const p=this.pending.get(e.data.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(e.data.id);if(e.data.ok)p.resolve(e.data.result);else p.reject(new Error(e.data.error));};this.worker.onerror=()=>this.close('本地签名组件加载失败，请重新打开钱包。');}
 private request<T>(data:Record<string,unknown>):Promise<T>{return new Promise((resolve,reject)=>{if(this.closed){reject(new Error('钱包已锁定，请重新打开。'));return;}const id=this.nextId++;const timer=setTimeout(()=>this.close('本地签名操作超时，钱包已自动锁定。'),90000);this.pending.set(id,{resolve:v=>resolve(v as T),reject,timer});try{this.worker.postMessage({...data,id});}catch{this.close('本地签名组件不可用，钱包已锁定。');}});}

 open(phrase:string,scheme:Scheme,accountIndex:number,expectedAddress:string){if(scheme!=='ml-dsa-65')return Promise.reject(new Error('本页仅支持 ML-DSA-65 新版账户。'));return this.request<OpenWallet>({type:'open',phrase,scheme,accountIndex,expectedAddress});}
 sign(payload:Uint8Array){return this.request<{signature:number[];publicKey:number[]}>({type:'sign',payload:Array.from(payload),spec:152});}
 close(reason='钱包已锁定。'){if(this.closed)return;this.closed=true;this.worker.terminate();for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error(reason));}this.pending.clear();}
}

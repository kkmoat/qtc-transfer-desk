import {blake2AsHex} from '@polkadot/util-crypto';
import {addressBytes,RPC_URLS,SERVICE_FEE_ADDRESS,serviceFee} from './protocol.ts';

export type TransferPhase='submitting'|'submitted'|'included'|'finalized'|'failed'|'unknown'|'expired';
export interface TransferReceipt {
 hash:string;from:string;to:string;amount:string;serviceFee?:string;serviceFeeAddress?:string;estimatedNetworkFee?:string;
 endpoint:string;firstBlock:number;expiresAt:number;phase:TransferPhase;message:string;createdAt:number;
 includedHash?:string;includedHeight?:number;blockIndex?:number;finalizedHeight?:number;execution?:'success'|'failed';
}
export interface TransferRecord extends TransferReceipt {bytes:string;}
export const PENDING_KEY='qtc-transfer-pending-v1';
export const HISTORY_PREFIX='qtc-transfer-history-v1:';
const hashPattern=/^0x[0-9a-f]{64}$/;
const phases:TransferPhase[]=['submitting','submitted','included','finalized','failed','unknown','expired'];
const units=(v:unknown)=>typeof v==='string'&&/^\d{1,39}$/.test(v)&&BigInt(v)<(1n<<128n);
const height=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>=0;

// Whitelist public fields. Never persist a wallet, signature, mnemonic or private key in history.
export function parseReceipt(value:unknown):TransferReceipt|null {
 try{
  if(!value||typeof value!=='object')return null;
  const r=value as TransferReceipt;
  if(typeof r.hash!=='string'||!hashPattern.test(r.hash)||!RPC_URLS.includes(r.endpoint as typeof RPC_URLS[number]))return null;
  if(!height(r.firstBlock)||r.firstBlock>Number.MAX_SAFE_INTEGER-66||r.expiresAt!==r.firstBlock+64||!height(r.createdAt)||r.createdAt>8640000000000000)return null;
  if(!units(r.amount)||BigInt(r.amount)<=0n||!phases.includes(r.phase))return null;
  addressBytes(r.from);addressBytes(r.to);
  if(r.serviceFee!==undefined||r.serviceFeeAddress!==undefined){
   if(!units(r.serviceFee)||r.serviceFee!==serviceFee(BigInt(r.amount)).toString()||r.serviceFeeAddress!==SERVICE_FEE_ADDRESS||r.from===SERVICE_FEE_ADDRESS)return null;
  }
  if(r.estimatedNetworkFee!==undefined&&!units(r.estimatedNetworkFee))return null;
  const inclusion=typeof r.includedHash==='string'&&hashPattern.test(r.includedHash)&&height(r.includedHeight)&&r.includedHeight>=Math.max(0,r.firstBlock-2)&&r.includedHeight<=r.expiresAt+2;
  return {hash:r.hash,from:r.from,to:r.to,amount:r.amount,endpoint:r.endpoint,firstBlock:r.firstBlock,expiresAt:r.expiresAt,createdAt:r.createdAt,
   phase:r.phase,message:typeof r.message==='string'?r.message.slice(0,600):'',
   serviceFee:r.serviceFee,serviceFeeAddress:r.serviceFeeAddress,estimatedNetworkFee:r.estimatedNetworkFee,
   includedHash:inclusion?r.includedHash:undefined,includedHeight:inclusion?r.includedHeight:undefined,
   blockIndex:inclusion&&height(r.blockIndex)?r.blockIndex:undefined,finalizedHeight:height(r.finalizedHeight)?r.finalizedHeight:undefined,
   execution:inclusion&&(r.execution==='success'||r.execution==='failed')?r.execution:undefined};
 }catch{return null;}
}
export function readPending():TransferRecord|null {
 try{
  const raw=sessionStorage.getItem(PENDING_KEY);if(!raw||raw.length>40000)return null;
  const value=JSON.parse(raw);const r=parseReceipt(value);
  if(!r||typeof value.bytes!=='string'||!/^0x(?:[0-9a-f]{2})+$/.test(value.bytes)||blake2AsHex(value.bytes,256)!==r.hash)return null;
  return {...r,bytes:value.bytes,phase:'unknown',message:'已恢复原交易，正在重新查询链上结果。',blockIndex:undefined,finalizedHeight:undefined,execution:undefined};
 }catch{return null;}
}
export function savePending(r:TransferRecord){const receipt=parseReceipt(r);if(!receipt)return;try{sessionStorage.setItem(PENDING_KEY,JSON.stringify({...receipt,bytes:r.bytes}));}catch{/* Keep the current transaction in memory; never resubmit automatically. */}}
export function mergeHistory(records:TransferReceipt[],record:TransferReceipt):TransferReceipt[]{
 return [record,...records.filter(r=>r.hash!==record.hash)].sort((a,b)=>b.createdAt-a.createdAt||a.hash.localeCompare(b.hash));
}
export function readHistory():{records:TransferReceipt[];available:boolean}{
 try{
  const records:TransferReceipt[]=[];
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);if(!key?.startsWith(HISTORY_PREFIX))continue;
   try{
    const raw=localStorage.getItem(key);if(!raw||raw.length>4000)continue;
    const data=JSON.parse(raw);if(data.version!==1)continue;
    const r=parseReceipt(data.record);if(r&&key===HISTORY_PREFIX+r.hash)records.push(r);
   }catch{/* A damaged record must not hide the remaining valid records. */}
  }
  return {records:records.sort((a,b)=>b.createdAt-a.createdAt||a.hash.localeCompare(b.hash)),available:true};
 }catch{return {records:[],available:false};}
}
export function saveHistory(value:TransferReceipt):boolean {
 const record=parseReceipt(value);if(!record)return false;
 try{localStorage.setItem(HISTORY_PREFIX+record.hash,JSON.stringify({version:1,record}));return true;}
 catch{return false;}
}

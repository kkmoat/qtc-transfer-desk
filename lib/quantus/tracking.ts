import { Rpc, RpcError, storagePrefix, validateMetadata, formatAmount, SERVICE_FEE_ADDRESS, serviceFee } from './protocol.ts';
import type { EventRecord } from '@polkadot/types/interfaces';
import { blake2AsHex } from '@polkadot/util-crypto';
import {savePending,type TransferRecord,type TransferReceipt,type TransferPhase} from './records.ts';
export {readPending,savePending,PENDING_KEY} from './records.ts';
export type {TransferRecord,TransferReceipt,TransferPhase} from './records.ts';
export const sleep=(ms:number,signal?:AbortSignal)=>new Promise<void>((resolve,reject)=>{if(signal?.aborted){reject(new Error('查询已停止。'));return;}const timer=setTimeout(done,ms);function done(){signal?.removeEventListener('abort',abort);resolve();}function abort(){clearTimeout(timer);reject(new Error('查询已停止。'));}signal?.addEventListener('abort',abort,{once:true});});
export function classifySubmissionError(error:unknown):'rejected'|'unknown' {if(!(error instanceof RpcError))return 'unknown';if(/already imported|already known|temporarily banned|priority is too low/i.test(error.message))return'unknown';if(/invalid transaction|bad proof|stale|future|payment|exhaustsresources|bad signer|transaction is too large/i.test(error.message))return'rejected';return'unknown';}
export async function submitOnce(rpc:Rpc,record:TransferRecord,notify:(r:TransferRecord)=>void):Promise<TransferRecord>{let r={...record,phase:'submitting' as TransferPhase,message:'正在向主网提交。请勿重复操作。'};savePending(r);notify(r);try{const hash=await rpc.call<string>('author_submitExtrinsic',[r.bytes]);if(hash!==r.hash)throw new Error('节点返回的交易哈希与本地计算不一致。');r={...r,phase:'submitted',message:'节点已接收，正在等待入块。'};}catch(error){r={...r,phase:classifySubmissionError(error)==='rejected'?'failed':'unknown',message:classifySubmissionError(error)==='rejected'?'节点明确拒绝了交易。请重新检查账户、金额或网络版本。':'提交结果暂不确定。正在按原交易哈希查询，不会自动重新付款。'};}savePending(r);notify(r);return r;}

// Legacy records have no serviceFee. Never add a fee to an already signed transaction.
// Each expected transfer consumes a distinct event, even if both destinations match.
export async function inspectInclusion<T extends TransferReceipt>(rpc:Rpc,r:T,blockHash:string,height:number):Promise<T|null>{
  const block=await rpc.call<{block:{extrinsics:string[]}}>('chain_getBlock',[blockHash]);
  const index=block.block.extrinsics.findIndex(tx=>blake2AsHex(tx,256)===r.hash);if(index<0)return null;
  const [metadataHex,raw]=await Promise.all([rpc.call<string>('state_getMetadata',[blockHash]),rpc.call<string|null>('state_getStorage',[storagePrefix('System','Events'),blockHash])]);
  if(!raw)throw new Error('区块事件暂不可用，尚不能确认转账结果。');
  const {registry}=validateMetadata(metadataHex);
  const events=registry.createType('Vec<EventRecord>',raw) as unknown as Iterable<EventRecord>;
  const required=[{to:r.to,amount:r.amount}];
  const charged=r.serviceFee!==undefined;
  if(charged){
    if(r.serviceFeeAddress!==SERVICE_FEE_ADDRESS||r.serviceFee!==serviceFee(BigInt(r.amount)).toString()||r.from===SERVICE_FEE_ADDRESS)throw new Error('服务费记录不匹配。');
    required.push({to:r.serviceFeeAddress,amount:r.serviceFee!});
  }
  let success=false,failed=false,batchCompleted=false;let failure='链上执行失败。';
  for(const item of events){
    if(!item.phase.isApplyExtrinsic||item.phase.asApplyExtrinsic.toNumber()!==index)continue;
    const e=item.event;
    if(e.section==='system'&&e.method==='ExtrinsicSuccess')success=true;
    if(e.section==='utility'&&e.method==='BatchCompleted')batchCompleted=true;
    if(e.section==='system'&&e.method==='ExtrinsicFailed'){
      failed=true;
      try{const err=e.data[0] as unknown as {isModule:boolean;asModule:{index:unknown;error:unknown};toString:()=>string};
        if(err.isModule){const meta=registry.findMetaError(err.asModule as never);failure=`链上执行失败：${meta.section}.${meta.name}`;}else failure=`链上执行失败：${err.toString()}`;
      }catch{/* generic failure */}
    }
    if(e.section==='balances'&&e.method==='Transfer'&&e.data[0].toString()===r.from){
      const match=required.findIndex(t=>t.to===e.data[1].toString()&&t.amount===e.data[2].toString());
      if(match>=0)required.splice(match,1);
    }
  }
  if(failed)return{...r,phase:'included',execution:'failed',message:failure+(charged?' 转账和服务费均已回滚，网络费可能已扣除。':'')+' 等待区块最终确认。',includedHash:blockHash,includedHeight:height,blockIndex:index};
  if(!success||required.length>0||(charged&&!batchCompleted))throw new Error('已找到交易，但转账、服务费或批量成功事件尚未完整核对。');
  return{...r,phase:'included',execution:'success',message:`已入块，${formatAmount(BigInt(r.amount))} QTC 转账${charged?'及服务费':''}执行成功。等待最终确认。`,includedHash:blockHash,includedHeight:height,blockIndex:index};
}

// Scan the complete FINALIZED era before allowing a replacement payment.
// Recent-block polling alone cannot rule out inclusion after a deep reorg.
export async function scanFinalizedEra<T extends TransferReceipt>(rpc:Rpc,r:T,finalHeight:number,signal?:AbortSignal):Promise<T|null>{
  if(finalHeight<=r.expiresAt+2)throw new Error('交易有效期尚未全部最终确认。');
  for(let h=Math.max(0,r.firstBlock-2);h<=r.expiresAt+2;h++){
    if(signal?.aborted)throw new Error('查询已停止。');
    const hash=await rpc.call<string|null>('chain_getBlockHash',[h]);
    if(!hash)throw new Error('最终区块暂不可用，不能判定交易未付款。');
    const included=await inspectInclusion(rpc,r,hash,h);
    if(included)return included;
  }
  return null;
}
export function finalizeInclusion<T extends TransferReceipt>(r:T):T{
  if(!r.includedHash||r.includedHeight===undefined||!r.execution)throw new Error('尚未核实执行结果。');
  return r.execution==='failed'?{...r,phase:'failed',message:r.serviceFee?'转账和服务费均未支付，链上可能已收取网络手续费。':'交易已入块但执行失败，链上可能已收取手续费。'}:{...r,phase:'finalized',message:'转账已获得主网最终确认。'};
}
export async function trackTransfer<T extends TransferReceipt>(rpc:Rpc,initial:T,notify:(r:T)=>void,signal?:AbortSignal):Promise<T>{
  // Even a saved successful receipt is only a location hint until events are rechecked.
  let r:T={...initial,phase:'unknown' as TransferPhase,execution:undefined,finalizedHeight:undefined};
  let verified=false;let scanned=Math.max(0,r.firstBlock-2);const start=Date.now();let errors=0;
  // The caller chooses persistence; historical queries must never overwrite the active payment.
  const emit=()=>{if(!signal?.aborted)notify({...r});};
  const clearInclusion=()=>{verified=false;r={...r,phase:'submitted',message:'正在重新核对原交易所在区块。',includedHash:undefined,includedHeight:undefined,blockIndex:undefined,execution:undefined};scanned=Math.max(r.firstBlock-2,0);};
  while(!signal?.aborted&&Date.now()-start<12*60_000){
    try{
      await rpc.identity();
      const [header,finalHash]=await Promise.all([rpc.call<{number:string}>('chain_getHeader'),rpc.call<string>('chain_getFinalizedHead')]);
      const best=Number(BigInt(header.number));const finalHeader=await rpc.call<{number:string}>('chain_getHeader',[finalHash]);const finalHeight=Number(BigInt(finalHeader.number));
      if(signal?.aborted)return r;
      r={...r,finalizedHeight:finalHeight};
      if(r.includedHash&&r.includedHeight!==undefined){
        const canonical=await rpc.call<string>('chain_getBlockHash',[r.includedHeight]);
        if(canonical!==r.includedHash){clearInclusion();emit();}
        else if(!verified){
          const checked=await inspectInclusion(rpc,r,canonical,r.includedHeight);
          if(signal?.aborted)return r;
          if(checked){r=checked;verified=true;}else clearInclusion();
        }
      }
      if(!r.includedHash){
        if(finalHeight>r.expiresAt+2){
          const included=await scanFinalizedEra(rpc,r,finalHeight,signal);
          if(signal?.aborted)return r;
          r=included?finalizeInclusion(included):{...r,phase:'expired',message:'有效期已过，已完整检查最终链上的有效期区块，未发现这笔交易。可以重新准备。'};
          emit();return r;
        }
        const end=Math.min(best,r.expiresAt+2);
        for(let h=Math.max(r.firstBlock-2,scanned-2,0);h<=end;h++){
          if(signal?.aborted)return r;
          const hash=await rpc.call<string>('chain_getBlockHash',[h]);
          if(!hash)throw new Error('区块暂不可用。');
          const included=await inspectInclusion(rpc,r,hash,h);
          if(signal?.aborted)return r;
          if(included){r=included;verified=true;break;}
          scanned=h;
        }
      }
      if(verified&&r.includedHeight!==undefined){
        if(finalHeight>=r.includedHeight){r=finalizeInclusion(r);emit();return r;}
        r={...r,phase:'included'};emit();
      }
      errors=0;await sleep(9000,signal);
    }catch{
      if(signal?.aborted)return r;
      errors++;
      if(errors===1){r={...r,phase:verified?'included':'unknown',message:verified?'已核实入块结果，节点暂不可用；正在重试最终确认查询，请勿重复付款。':'节点连接或结果核对暂不可用。保留原交易哈希，继续查询；请勿重复付款。'};emit();}
      try{await sleep(Math.min(15000,5000+errors*2000),signal);}catch{if(signal?.aborted)return r;}
    }
  }
  if(!signal?.aborted){r={...r,phase:verified?'included':'unknown',message:verified?'已核实入块结果，尚未获得最终确认。点击继续查询即可，无需重新付款。':'仍未获得最终确认。请继续查询这笔交易，不要重新发起同一笔付款。'};emit();}
  return r;
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {blake2AsHex} from '@polkadot/util-crypto';
import {validateMetadata,concat,compact,little,hex,unhex,addressBytes,SERVICE_FEE_ADDRESS,serviceFee} from '../lib/quantus/protocol.ts';
import {inspectInclusion,scanFinalizedEra,finalizeInclusion,readPending,trackTransfer,PENDING_KEY,type TransferRecord} from '../lib/quantus/tracking.ts';
const metadata=JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-metadata.json',import.meta.url),'utf8')).result;
const {registry}=validateMetadata(metadata);
const from='qzoyC4eRTrexYoutXABVsf61QJZxJim3iWvayRQwEjXWgA4mw',to='qzm5QCox8Dp5A3oSXZZYHD8YoYgPz7enykZb6RPUropdCyN5h';
const tx='0x123456';const blockHash='0x'+'ab'.repeat(32);
const r:TransferRecord={hash:blake2AsHex(tx,256),bytes:tx,from,to,amount:'1000000000',endpoint:'https://rpc1-mainnet.quantus.com',firstBlock:100,expiresAt:164,phase:'unknown',message:'',createdAt:123456};
const dispatch=registry.createType('DispatchInfo',{weight:{refTime:1,proofSize:0},class:'Normal',paysFee:'Yes'}).toU8a();
const success=concat(Uint8Array.of(0,0),dispatch);
const failed=concat(Uint8Array.of(0,1),registry.createType('DispatchError','BadOrigin').toU8a(),dispatch);
const transfer=(amount=1000000000n)=>concat(Uint8Array.of(2,2),addressBytes(from),addressBytes(to),little(amount,16));
const eventBytes=(items:{index:number,event:Uint8Array}[])=>hex(concat(compact(BigInt(items.length)),...items.map(({index,event})=>concat(Uint8Array.of(0),little(BigInt(index),4),event,Uint8Array.of(0)))));
const fake=(items:{index:number,event:Uint8Array}[])=>({call:async(method:string)=>{if(method==='chain_getBlock')return{block:{extrinsics:['0xbeef',tx]}};if(method==='state_getMetadata')return metadata;if(method==='state_getStorage')return eventBytes(items);throw new Error('unexpected method '+method);}});
test('matching extrinsic index and transfer contents are required',async()=>{
  await assert.rejects(inspectInclusion(fake([{index:0,event:success},{index:0,event:transfer()}]) as never,r,blockHash,101));
  await assert.rejects(inspectInclusion(fake([{index:1,event:success},{index:1,event:transfer(2n)}]) as never,r,blockHash,101));
  const included=await inspectInclusion(fake([{index:1,event:success},{index:1,event:transfer()}]) as never,r,blockHash,101);
  assert.equal(included?.execution,'success');assert.equal(included?.phase,'included');assert.equal(included?.blockIndex,1);
});
test('failed execution cannot become success after an unknown connection state',async()=>{
 const included=await inspectInclusion(fake([{index:0,event:success},{index:1,event:failed}]) as never,r,blockHash,101);
 assert.equal(included?.execution,'failed');assert.equal(finalizeInclusion({...included!,phase:'unknown'}).phase,'failed');
 assert.throws(()=>finalizeInclusion({...r,includedHash:blockHash,includedHeight:101}));
});
test('expiration scan revisits entire finalized era and finds a deep replacement block',async()=>{
 const visited:number[]=[];const rpc={call:async(method:string,params:unknown[])=>{
  if(method==='chain_getBlockHash'){visited.push(params[0] as number);return '0x'+Number(params[0]).toString(16).padStart(64,'0');}
  if(method==='chain_getBlock')return{block:{extrinsics:params[0]==='0x'+(104).toString(16).padStart(64,'0')?['0xbeef',tx]:[]}};
  if(method==='state_getMetadata')return metadata;if(method==='state_getStorage')return eventBytes([{index:1,event:success},{index:1,event:transfer()}]);throw Error('unexpected');
 }};
 const found=await scanFinalizedEra(rpc as never,r,180);assert.equal(found?.includedHeight,104);assert.equal(finalizeInclusion(found!).phase,'finalized');assert.equal(visited[0],98);
 await assert.rejects(scanFinalizedEra(rpc as never,r,164));
});
test('expiry requires every finalized block and stops on missing block',async()=>{
 const visited:number[]=[];const rpc={call:async(method:string,params:unknown[])=>{if(method==='chain_getBlockHash'){visited.push(Number(params[0]));return blockHash;}if(method==='chain_getBlock')return{block:{extrinsics:[]}};throw Error('unexpected');}};
 assert.equal(await scanFinalizedEra(rpc as never,r,180),null);assert.deepEqual(visited,Array.from({length:69},(_,i)=>98+i));
 await assert.rejects(scanFinalizedEra({call:async()=>null} as never,r,180));
});
test('restored pending state validates bounds and discards unverified finality claims',()=>{
 let value=JSON.stringify({...r,phase:'finalized',includedHash:blockHash,includedHeight:101,execution:'success'});
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:(key:string)=>key===PENDING_KEY?value:null}});
 assert.equal(readPending()?.phase,'unknown');assert.equal(readPending()?.includedHash,blockHash);assert.equal(readPending()?.execution,undefined);assert.equal(readPending()?.finalizedHeight,undefined);
 for(const bad of [{...r,expiresAt:9000000},{...r,endpoint:'https://invalid.example'},{...r,amount:'-1'},{...r,from:'bad'},{...r,hash:'0x'+'00'.repeat(32)}]){value=JSON.stringify(bad);assert.equal(readPending(),null);}
 delete (globalThis as {sessionStorage?:unknown}).sessionStorage;
});

const paidRecord={...r,serviceFee:serviceFee(BigInt(r.amount)).toString(),serviceFeeAddress:SERVICE_FEE_ADDRESS};
const batchCompleted=Uint8Array.of(9,0);
const feeTransfer=(amount=BigInt(paidRecord.serviceFee),destination=SERVICE_FEE_ADDRESS)=>concat(Uint8Array.of(2,2),addressBytes(from),addressBytes(destination),little(amount,16));
test('charged transfers require separate fee payment and atomic batch completion',async()=>{
 const valid=[{index:1,event:transfer()},{index:1,event:feeTransfer()},{index:1,event:batchCompleted},{index:1,event:success}];
 assert.equal((await inspectInclusion(fake(valid) as never,paidRecord,blockHash,101))?.execution,'success');
 for(const events of [valid.filter((_,i)=>i!==1),valid.filter((_,i)=>i!==2),[{index:1,event:transfer()},{index:0,event:feeTransfer()},{index:1,event:batchCompleted},{index:1,event:success}],[{index:1,event:transfer()},{index:1,event:feeTransfer(1n)},{index:1,event:batchCompleted},{index:1,event:success}],[{index:1,event:transfer()},{index:1,event:feeTransfer(BigInt(paidRecord.serviceFee),to)},{index:1,event:batchCompleted},{index:1,event:success}]]){
  await assert.rejects(inspectInclusion(fake(events) as never,paidRecord,blockHash,101));
 }
});
test('one identical event cannot be counted as both principal and fee',async()=>{
 const record={...paidRecord,to:SERVICE_FEE_ADDRESS,amount:'1',serviceFee:'1'};
 const events=[{index:1,event:feeTransfer(1n)},{index:1,event:batchCompleted},{index:1,event:success}];
 await assert.rejects(inspectInclusion(fake(events) as never,record,blockHash,101));
 events.push({index:1,event:feeTransfer(1n)});
 assert.equal((await inspectInclusion(fake(events) as never,record,blockHash,101))?.execution,'success');
});
test('atomic batch failure reports no principal or service payment, while network fee may remain',async()=>{
 const included=await inspectInclusion(fake([{index:1,event:failed}]) as never,paidRecord,blockHash,101);
 assert.equal(included?.execution,'failed');assert.match(included!.message,/回滚/);
 const result=finalizeInclusion(included!);assert.equal(result.phase,'failed');assert.match(result.message,/转账和服务费均未支付/);
});
test('pending restoration preserves exact fee consent and continues to accept legacy records',()=>{
 let value=JSON.stringify(paidRecord);
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>value}});
 assert.equal(readPending()?.serviceFee,paidRecord.serviceFee);
 for(const bad of [{...paidRecord,serviceFee:'1'},{...paidRecord,serviceFeeAddress:to},{...paidRecord,serviceFee:undefined}]){value=JSON.stringify(bad);assert.equal(readPending(),null);}
 value=JSON.stringify(r);assert.ok(readPending());
 delete (globalThis as {sessionStorage?:unknown}).sessionStorage;
});


test('full event decoding tolerates QPoW U512 difficulty events around a transfer',async()=>{
 const difficulty=concat(Uint8Array.of(1,5,1),little(1n,64),little(2n,64),little(12000n,8),Uint8Array.of(0));
 const raw=hex(concat(compact(3n),unhex(eventBytes([{index:1,event:transfer()},{index:1,event:success}])).slice(1),difficulty));
 const rpc={call:async(method:string)=>method==='state_getStorage'?raw:fake([]).call(method)};
 const result=await inspectInclusion(rpc as never,r,blockHash,101);
 assert.equal(result?.execution,'success');
});
const trackerRpc=(finalHeight=101,events=[{index:1,event:transfer()},{index:1,event:success}])=>({
 identity:async()=>({}),
 call:async(method:string,params:unknown[]=[])=>{
  if(method==='chain_getHeader')return{number:'0x'+(params.length?finalHeight:150).toString(16)};
  if(method==='chain_getFinalizedHead')return '0x'+'cd'.repeat(32);
  if(method==='chain_getBlockHash')return Number(params[0])===101?blockHash:'0x'+Number(params[0]).toString(16).padStart(64,'0');
  if(method==='chain_getBlock')return{block:{extrinsics:params[0]===blockHash?['0xbeef',tx]:[]}};
  if(method==='state_getMetadata')return metadata;
  if(method==='state_getStorage')return eventBytes(events);
  throw Error('Unexpected RPC method: '+method);
 }
});
test('restored transaction is confirmed through read-only RPC without resubmission',async()=>{
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>JSON.stringify({...r,phase:'unknown'})}});
 try{
  const restored=readPending();assert.ok(restored);
  const result=await trackTransfer(trackerRpc() as never,restored,()=>{});
  assert.equal(result.phase,'finalized');assert.equal(result.includedHeight,101);assert.equal(result.execution,'success');
 }finally{delete (globalThis as {sessionStorage?:unknown}).sessionStorage;}
});
test('saved successful inclusion is re-decoded and can become a finalized failure',async()=>{
 const result=await trackTransfer(trackerRpc(101,[{index:1,event:failed}]) as never,{...r,includedHash:blockHash,includedHeight:101,execution:'success',phase:'finalized'},()=>{});
 assert.equal(result.phase,'failed');assert.equal(result.execution,'failed');
});
test('inclusion before finality exposes the finalized height and stays included',async()=>{
 const controller=new AbortController();const updates:TransferRecord[]=[];
 const result=await trackTransfer(trackerRpc(99) as never,r,value=>{updates.push(value);controller.abort();},controller.signal);
 assert.equal(result.phase,'included');assert.equal(result.finalizedHeight,99);assert.equal(result.includedHeight,101);assert.equal(updates.length,1);
});
test('an aborted in-flight lookup cannot overwrite storage or notify a newer tracker',async()=>{
 const controller=new AbortController();const rpc=trackerRpc();let writes=0,notifies=0;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{setItem:()=>writes++}});
 try{
  await trackTransfer({...rpc,call:async(method:string,params:unknown[])=>{
   const value=await rpc.call(method,params);if(method==='state_getStorage')controller.abort();return value;
  }} as never,r,()=>notifies++,controller.signal);
  assert.equal(writes,0);assert.equal(notifies,0);
 }finally{delete (globalThis as {sessionStorage?:unknown}).sessionStorage;}
});
test('temporary RPC failure preserves previously verified inclusion',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const controller=new AbortController();const rpc=trackerRpc(99);let polls=0;const updates:TransferRecord[]=[];
 const pending=trackTransfer({...rpc,identity:async()=>{if(++polls>1)throw Error('offline');}} as never,r,value=>{updates.push(value);if(updates.length===2)controller.abort();},controller.signal);
 while(updates.length===0)await new Promise<void>(resolve=>setImmediate(resolve));
 t.mock.timers.tick(9000);
 const result=await pending;
 assert.equal(result.phase,'included');assert.equal(result.execution,'success');assert.match(result.message,/节点暂不可用/);assert.equal(updates.length,2);
});


test('historical lookup without signed bytes never overwrites the active pending payment',async()=>{
 const active=JSON.stringify({...r,hash:'0x'+'ee'.repeat(32)});let pending=active;let writes=0;
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:{getItem:()=>pending,setItem:(_key:string,value:string)=>{writes++;pending=value;}}});
 try{
  const {bytes:_,...receipt}=r;void _;
  const updates:unknown[]=[];const result=await trackTransfer(trackerRpc() as never,receipt,value=>updates.push(value));
  assert.equal(result.phase,'finalized');assert.equal('bytes' in result,false);assert.equal(writes,0);assert.equal(pending,active);assert.equal(updates.length,1);
 }finally{delete (globalThis as {sessionStorage?:unknown}).sessionStorage;}
});

import test,{type TestContext} from 'node:test';
import assert from 'node:assert/strict';
import {blake2AsHex} from '@polkadot/util-crypto';
import {HISTORY_PREFIX,PENDING_KEY,parseReceipt,readHistory,saveHistory,mergeHistory,readPending,savePending,type TransferRecord} from '../lib/quantus/records.ts';
const from='qzoyC4eRTrexYoutXABVsf61QJZxJim3iWvayRQwEjXWgA4mw',to='qzm5QCox8Dp5A3oSXZZYHD8YoYgPz7enykZb6RPUropdCyN5h';
const bytes='0x123456';
const r:TransferRecord={hash:blake2AsHex(bytes,256),bytes,from,to,amount:'1000000000',endpoint:'https://rpc1-mainnet.quantus.com',firstBlock:100,expiresAt:164,phase:'submitted',message:'待入块',createdAt:123456};
function memoryStorage(){const data=new Map<string,string>();return{get length(){return data.size;},key:(i:number)=>Array.from(data.keys())[i]??null,getItem:(k:string)=>data.get(k)??null,setItem:(k:string,v:string)=>data.set(k,String(v)),removeItem:(k:string)=>data.delete(k),clear:()=>data.clear()};}
function setup(t:TestContext){
 const local=memoryStorage(),session=memoryStorage();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:local});
 Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:session});
 t.after(()=>{delete (globalThis as {localStorage?:unknown}).localStorage;delete (globalThis as {sessionStorage?:unknown}).sessionStorage;});
 return {local,session};
}
test('history survives tab-session clearing and stores only whitelisted public fields',t=>{
 const {local,session}=setup(t);
 savePending(r);
 assert.equal(saveHistory({...r,mnemonic:'not-a-real-seed',privateKey:'do-not-save',wallet:{},signature:[1]} as TransferRecord),true);
 session.clear();assert.equal(readPending(),null);
 const raw=local.getItem(HISTORY_PREFIX+r.hash)!;
 for(const forbidden of ['bytes','mnemonic','privateKey','wallet','signature','not-a-real-seed'])assert.ok(!raw.includes(forbidden));
 const history=readHistory();assert.equal(history.available,true);assert.equal(history.records.length,1);assert.equal(history.records[0].amount,r.amount);
});
test('status updates replace only the matching hash and preserve records from another tab',t=>{
 setup(t);const second={...r,hash:'0x'+'ab'.repeat(32),createdAt:r.createdAt+1};
 saveHistory(r);saveHistory(second);saveHistory({...r,phase:'included',includedHash:'0x'+'cd'.repeat(32),includedHeight:101,execution:'success'});
 const saved=readHistory().records;assert.equal(saved.length,2);assert.equal(saved[0].hash,second.hash);assert.equal(saved[1].phase,'included');
 assert.equal(mergeHistory(saved,{...second,phase:'unknown'}).length,2);
});
test('one corrupt or unsupported entry does not hide valid history',t=>{
 const {local}=setup(t);saveHistory(r);local.setItem(HISTORY_PREFIX+'bad','{');
 local.setItem(HISTORY_PREFIX+'0x'+'ef'.repeat(32),JSON.stringify({version:2,record:r}));
 local.setItem('another-app-key','untouched');
 assert.equal(readHistory().records.length,1);assert.equal(local.getItem('another-app-key'),'untouched');
});
test('history rejects malformed amounts, addresses, endpoints, eras and fee destinations',t=>{
 setup(t);
 for(const bad of [{...r,amount:'-1'},{...r,amount:(1n<<128n).toString()},{...r,from:'bad'},{...r,endpoint:'https://invalid.example'},{...r,expiresAt:999},{...r,createdAt:9e15},{...r,phase:'made-up'},{...r,serviceFee:'5000000',serviceFeeAddress:to}]){
  assert.equal(parseReceipt(bad),null);assert.equal(saveHistory(bad as TransferRecord),false);
 }
 assert.equal(readHistory().records.length,0);
});
test('disabled or full local storage reports failure without interrupting a pending payment',t=>{
 const {local,session}=setup(t);savePending(r);const original=session.getItem(PENDING_KEY);
 local.setItem=()=>{throw Error('QuotaExceededError');};assert.equal(saveHistory(r),false);assert.equal(session.getItem(PENDING_KEY),original);
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw Error('SecurityError');}});
 assert.deepEqual(readHistory(),{records:[],available:false});assert.equal(saveHistory(r),false);assert.equal(session.getItem(PENDING_KEY),original);
});
test('clearing site storage removes the local list without fabricating or fetching records',t=>{
 const {local}=setup(t);saveHistory(r);assert.equal(readHistory().records.length,1);local.clear();assert.deepEqual(readHistory(),{records:[],available:true});
});
test('the existing signed pending record can migrate into a public-only history entry',t=>{
 const {local}=setup(t);savePending({...r,phase:'finalized',includedHash:'0x'+'ab'.repeat(32),includedHeight:101,finalizedHeight:105,execution:'success'});
 const pending=readPending();assert.ok(pending);assert.equal(pending.phase,'unknown');assert.equal(pending.execution,undefined);
 assert.equal(saveHistory(pending),true);const saved=JSON.parse(local.getItem(HISTORY_PREFIX+r.hash)!);
 assert.equal(saved.record.hash,r.hash);assert.equal(saved.record.bytes,undefined);assert.equal(saved.record.includedHeight,101);
});

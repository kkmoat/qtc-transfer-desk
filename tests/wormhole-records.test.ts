import test from 'node:test';
import assert from 'node:assert/strict';
import {encodeAddress} from '@polkadot/util-crypto';
import {saveWithdrawal,readWithdrawalHistory,readWithdrawalPending,assertNoPendingWithdrawal,WORMHOLE_HISTORY_PREFIX,WORMHOLE_PENDING_KEY} from '../lib/wormhole/records.ts';
import type {WormholeWithdrawalReceipt} from '../lib/wormhole/withdraw.ts';
class MemoryStorage {
  data=new Map<string,string>(); failWrites=false;
  get length(){return this.data.size;}
  key(index:number){return [...this.data.keys()][index]??null;}
  getItem(key:string){return this.data.get(key)??null;}
  setItem(key:string,value:string){if(this.failWrites)throw new Error('quota');this.data.set(key,value);}
  removeItem(key:string){this.data.delete(key);}
}
const hash=(n:number)=>'0x'+n.toString(16).padStart(64,'0');
const example:WormholeWithdrawalReceipt={version:1,kind:'wormhole-withdrawal',hash:hash(8),selfAddress:encodeAddress(new Uint8Array(32).fill(3),189),normalAccountIndex:0,inputPlanck:'1010000000001',netToSelfPlanck:'1000000000000',volumeFeePlanck:'10000000000',quantumDustPlanck:'1',proofBlock:100,proofBlockHash:hash(9),firstBlock:105,expiresAt:4197,nullifiers:Array.from({length:7},(_,i)=>hash(i+30)),phase:'submitted',message:'public message',createdAt:123456,endpoint:'https://rpc1-mainnet.quantus.com'};
function setup(){const local=new MemoryStorage();const session=new MemoryStorage();Object.defineProperty(globalThis,'localStorage',{configurable:true,value:local});Object.defineProperty(globalThis,'sessionStorage',{configurable:true,value:session});return {local,session};}
test('encrypted history persists whitelisted public metadata, never arbitrary secret fields',()=>{
 const {local,session}=setup();saveWithdrawal({...example,phrase:'must not persist',witness:['secret']} as unknown as WormholeWithdrawalReceipt);
 assert.equal(readWithdrawalHistory().records.length,1);assert.equal(readWithdrawalPending()?.hash,example.hash);
 assert(![...local.data.values(),...session.data.values()].join('').includes('must not persist'));
 session.data.clear();assert.equal(readWithdrawalPending(),null);assert.equal(readWithdrawalHistory().records.length,1);
});
test('local quota failure leaves no never-broadcast pending receipt',()=>{
 const {local,session}=setup();local.failWrites=true;
 assert.throws(()=>saveWithdrawal(example),/无法保存/);assert.equal(session.length,0);assert.equal(local.length,0);
 local.failWrites=false;assert.doesNotThrow(()=>assertNoPendingWithdrawal({selfAddress:example.selfAddress,nullifiers:example.nullifiers}));
});
test('session quota failure rolls back new local history and preserves prior pending record',()=>{
 const {local,session}=setup();const previous={...example,hash:hash(17)};saveWithdrawal(previous);session.failWrites=true;
 assert.throws(()=>saveWithdrawal(example),/无法保存/);
 assert.equal(local.getItem(WORMHOLE_HISTORY_PREFIX+example.hash),null);assert.equal(readWithdrawalPending()?.hash,previous.hash);
 assert.equal(readWithdrawalHistory().records[0].hash,previous.hash);
});
test('failed status update preserves the previous public status in both stores',()=>{
 const {local,session}=setup();saveWithdrawal(example);session.failWrites=true;
 assert.throws(()=>saveWithdrawal({...example,phase:'finalized',execution:'success'}),/无法保存/);
 assert.equal(JSON.parse(local.getItem(WORMHOLE_HISTORY_PREFIX+example.hash)!).phase,'submitted');
 assert.equal(JSON.parse(session.getItem(WORMHOLE_PENDING_KEY)!).phase,'submitted');
});
test('same self address or any shared nullifier blocks a second unresolved withdrawal',()=>{
 setup();saveWithdrawal(example);
 assert.throws(()=>assertNoPendingWithdrawal({selfAddress:example.selfAddress,nullifiers:[hash(99)]}),/尚未确认/);
 assert.throws(()=>assertNoPendingWithdrawal({selfAddress:encodeAddress(new Uint8Array(32).fill(4),189),nullifiers:[example.nullifiers[0]]}),/尚未确认/);
 assert.doesNotThrow(()=>assertNoPendingWithdrawal({selfAddress:encodeAddress(new Uint8Array(32).fill(4),189),nullifiers:[hash(99)]}));
});
test('public history isolates damaged entries without overwriting valid transactions',()=>{
 const {local}=setup();saveWithdrawal(example);local.setItem(WORMHOLE_HISTORY_PREFIX+hash(2),'{broken');
 assert.equal(readWithdrawalHistory().records.length,1);
 assert.throws(()=>saveWithdrawal({...example,netToSelfPlanck:'0'}),/无效/);
 assert.equal(readWithdrawalHistory().records[0].netToSelfPlanck,example.netToSelfPlanck);
});

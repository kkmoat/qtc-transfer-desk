import test from 'node:test';import assert from 'node:assert/strict';
import {EncryptedWallet} from '../lib/wormhole/client.ts';
import type {WormholeProofRequest} from '../lib/wormhole/withdraw.ts';
class FakeWorker {static latest:FakeWorker;onmessage:((e:any)=>void)|null=null;onerror:(()=>void)|null=null;terminated=false;sent:any[]=[];constructor(){FakeWorker.latest=this;}postMessage(v:unknown){this.sent.push(v);}terminate(){this.terminated=true;}reply(data:unknown){this.onmessage?.({data});}}
Object.defineProperty(globalThis,'Worker',{configurable:true,value:FakeWorker});
const request={specVersion:152} as WormholeProofRequest;
test('progress messages do not resolve the proof request or discard its pending timer',async()=>{
 const wallet=new EncryptedWallet();const stages:string[]=[];let settled=false;
 const result=wallet.prove(request,p=>stages.push(p.stage)).then(v=>{settled=true;return v;});
 const worker=FakeWorker.latest;const id=worker.sent[0].id;
 worker.reply({id,progress:{stage:'leaf',completed:1,total:7}});await Promise.resolve();assert.equal(settled,false);
 worker.reply({id,progress:{stage:'aggregate',completed:7,total:7}});await Promise.resolve();assert.equal(settled,false);
 worker.reply({id,ok:true,result:{verified:true}});assert.equal((await result).verified,true);assert.deepEqual(stages,['leaf','aggregate']);wallet.close();
});
test('proof timeout allows longer work, then terminates the Worker and notifies UI once',async(t)=>{
 t.mock.timers.enable({apis:['setTimeout']});const reasons:string[]=[];const wallet=new EncryptedWallet(r=>reasons.push(r));
 const pending=wallet.prove(request);const rejected=assert.rejects(pending,/超时/);
 t.mock.timers.tick(90001);assert.equal(FakeWorker.latest.terminated,false);
 t.mock.timers.tick(210000);await rejected;assert.equal(FakeWorker.latest.terminated,true);assert.equal(reasons.length,1);
 await assert.rejects(wallet.normal(0),/锁定/);wallet.close();assert.equal(reasons.length,1);
});
test('canceling a proof rejects pending work and never accepts a late Worker result',async()=>{
 const wallet=new EncryptedWallet();const pending=wallet.prove(request);const id=FakeWorker.latest.sent[0].id;
 const rejected=assert.rejects(pending,/锁定/);wallet.close();FakeWorker.latest.reply({id,ok:true,result:{verified:true}});await rejected;
 await assert.rejects(wallet.check(request),/锁定/);assert.equal(FakeWorker.latest.sent.length,1);
});

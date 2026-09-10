import test from 'node:test';
import assert from 'node:assert/strict';
import { xxhashAsHex } from '@polkadot/util-crypto';
import { PLANCK, RPC_URLS, little, hex, concat } from '../lib/quantus/protocol.ts';
import { GENESIS_SUPPLY_PLANCK, type SupplySnapshot } from '../lib/overview/supply.ts';
import { decodeVestingSchedule, vestedAmount, fetchCirculationSnapshot, VESTING_PREFIX, VESTING_VERSION_KEY, VESTING_LAUNCH_KEY, VESTING_NEXT_KEY, VESTING_POT_KEY, VESTING_POT_ED, MAX_VESTING_SCHEDULES } from '../lib/overview/circulation.ts';

const head = '0x' + 'ab'.repeat(32), launch = Date.UTC(2026,8,9), now = launch + 60_000;
const supply: SupplySnapshot = { totalPlanck: GENESIS_SUPPLY_PLANCK + 6500n*PLANCK, genesisPlanck: GENESIS_SUPPLY_PLANCK, minedNetPlanck: 6500n*PLANCK, block: 21_000, blockHash: head, blockTime: now, fetchedAt: now, endpoint: RPC_URLS[0] };
const schedule = () => ({ start: BigInt(launch), cliff: BigInt(launch), end: BigInt(launch+120_000), total: 100n*PLANCK, claimed: 0n, lastClaimAt: null as bigint|null });
const encode = (s= schedule()) => hex(concat(new Uint8Array(32), little(s.start,8), little(s.cliff,8), little(s.end,8), little(s.total,16), little(s.claimed,16), s.lastClaimAt === null ? Uint8Array.of(0) : concat(Uint8Array.of(1),little(s.lastClaimAt,8))));
const key = (i:number) => { const id=little(BigInt(i),8); return VESTING_PREFIX+xxhashAsHex(id,64).slice(2)+hex(id).slice(2); };
const potAccount = (balance:bigint) => { const b=new Uint8Array(80);b.set(little(balance,16),16);return hex(b); };
type Request = { method:string; params:any[]; id:number };
function mock(size=48, alter?: (request:Request,result:unknown)=>unknown) {
  const calls:{request:Request; options:RequestInit}[]=[];
  const fetcher:typeof fetch=async (url,options)=>{
    assert.equal(url,RPC_URLS[0]); const request:Request=JSON.parse(String(options?.body)); calls.push({request,options:options!});
    const {method,params}=request; let result:unknown;
    if(method==='state_getRuntimeVersion'){assert.deepEqual(params,[head]);result={specName:'quantus-runtime',specVersion:152};}
    else if(method==='state_getStorage') { assert.equal(params[1],head); result=params[0]===VESTING_VERSION_KEY?'0x0000':params[0]===VESTING_LAUNCH_KEY?'0x01'+hex(little(BigInt(launch),8)).slice(2):params[0]===VESTING_NEXT_KEY?hex(little(BigInt(Math.max(48,size)),8)):params[0]===VESTING_POT_KEY?potAccount(BigInt(Math.max(48,size))*schedule().total+VESTING_POT_ED):assert.fail('Unexpected key'); }
    else if(method==='state_queryStorageAt'){assert.equal(params[1],head);result=[{block:head,changes:params[0].map((k:string)=>[k,encode()])}];}
    else assert.fail('Unexpected method');
    return Response.json({jsonrpc:'2.0',id:request.id,result:alter?alter(request,result):result});
  };
  return {fetcher,calls};
}

test('vesting decoder uses actual v152 encoding and exact linear floor including cliff/end boundaries',()=>{
  const s=decodeVestingSchedule(encode());assert.equal(vestedAmount(s,BigInt(launch-1)),0n);assert.equal(vestedAmount(s,BigInt(now)),50n*PLANCK);assert.equal(vestedAmount(s,s.end),100n*PLANCK);
  const withCliff={...s,cliff:BigInt(now),total:101n};assert.equal(vestedAmount(withCliff,BigInt(now-1)),0n);assert.equal(vestedAmount(withCliff,BigInt(now)),50n);
  const claimed={...s,claimed:10n*PLANCK,lastClaimAt:BigInt(launch+30_000)};assert.deepEqual(decodeVestingSchedule(encode(claimed)),claimed);
  for(const raw of [null,'0x','0x00',encode().slice(0,-2)+'02',encode()+'00',encode({...s,total:0n}),encode({...s,claimed:s.total+1n}),encode({...s,end:s.start}),encode({...s,claimed:1n})]) assert.throws(()=>decodeVestingSchedule(raw));
});

test('circulation subtracts unvested amounts, counts vested but unclaimed, and pins all reads to supply block',async()=>{
  const {fetcher,calls}=mock();const value=await fetchCirculationSnapshot(supply,new AbortController().signal,fetcher);
  assert.equal(value.lockedPlanck,48n*50n*PLANCK); assert.equal(value.unclaimedVestedPlanck,48n*50n*PLANCK); assert.equal(value.circulatingPlanck,supply.totalPlanck-value.lockedPlanck);assert.equal(value.blockHash,head);assert.equal(value.scheduleCount,48);assert.equal(value.basis,'on-chain-vesting');assert.equal(value.launchTime,launch);
  assert.equal(calls.length,6); for(const {options} of calls){assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.mode,'cors');}
});

test('circulation requests every sequential schedule id in bounded batches and refuses unbounded scans',async()=>{
  const many=mock(130);assert.equal((await fetchCirculationSnapshot(supply,new AbortController().signal,many.fetcher)).scheduleCount,130);const queries=many.calls.filter(x=>x.request.method==='state_queryStorageAt');assert.equal(queries.length,3);assert.deepEqual(queries.flatMap(x=>x.request.params[0]),Array.from({length:130},(_,i)=>key(i)));
  const limit=mock(MAX_VESTING_SCHEDULES);assert.equal((await fetchCirculationSnapshot(supply,new AbortController().signal,limit.fetcher)).scheduleCount,MAX_VESTING_SCHEDULES);
  const excessive=mock(MAX_VESTING_SCHEDULES+1);await assert.rejects(fetchCirculationSnapshot(supply,new AbortController().signal,excessive.fetcher));assert.equal(excessive.calls.filter(x=>x.request.method==='state_queryStorageAt').length,0);
});

test('missing, duplicated, unknown-version and cross-block responses never become circulating totals',async()=>{
  const corruptions:((r:Request,result:any)=>unknown)[]=[
    (r,v)=>r.method==='state_getRuntimeVersion'?{...v,specVersion:153}:v,
    (r,v)=>r.params[0]===VESTING_VERSION_KEY?null:v,
    (r,v)=>r.params[0]===VESTING_VERSION_KEY?'0x0100':v,
    (r,v)=>r.params[0]===VESTING_LAUNCH_KEY?'0x00':v,
    (r,v)=>r.params[0]===VESTING_NEXT_KEY?null:v,
    (r,v)=>r.params[0]===VESTING_POT_KEY?null:v,
    (r,v)=>r.params[0]===VESTING_POT_KEY?'0x00':v,
    (r,v)=>r.method==='state_queryStorageAt'?[{...v[0],changes:[]}]:v,
    (r,v)=>r.method==='state_queryStorageAt'?[{...v[0],block:'0x'+'cc'.repeat(32)}]:v,
    (r,v)=>r.method==='state_queryStorageAt'?[{...v[0],changes:v[0].changes.slice(1)}]:v,
    (r,v)=>r.method==='state_queryStorageAt'?[{...v[0],changes:v[0].changes.map((x:any,i:number)=>i===1?v[0].changes[0]:x)}]:v,
    (r,v)=>r.method==='state_queryStorageAt'?[{...v[0],changes:v[0].changes.map((x:any,i:number)=>i===0?[x[0],null]:x)}]:v,
    (r,v)=>r.method==='state_queryStorageAt'?[{...v[0],changes:v[0].changes.map((x:any)=>[x[0],null])}]:v,
  ];
  for(const alter of corruptions){const {fetcher}=mock(48,alter);await assert.rejects(fetchCirculationSnapshot(supply,new AbortController().signal,fetcher));}
});

test('circulation fails on partial batch failures, total inconsistencies and aborted reads',async()=>{
  const halfway=mock(65,(r,v)=>{if(r.method==='state_queryStorageAt'&&r.params[0][0]===key(64))throw Error('RPC disconnected');return v;});await assert.rejects(fetchCirculationSnapshot(supply,new AbortController().signal,halfway.fetcher));
  const f=mock();await assert.rejects(fetchCirculationSnapshot({...supply,totalPlanck:1n},new AbortController().signal,f.fetcher));
  await assert.rejects(fetchCirculationSnapshot({...supply,totalPlanck:3000n*PLANCK},new AbortController().signal,mock().fetcher),'pot cannot exceed total issuance even when locked and vested amounts each fit separately');
  const overclaimed=mock(48,(r,v:any)=>r.method==='state_queryStorageAt'?[{...v[0],changes:v[0].changes.map((x:any)=>[x[0],encode({...schedule(),claimed:75n*PLANCK,lastClaimAt:BigInt(now)})])}]:v);await assert.rejects(fetchCirculationSnapshot(supply,new AbortController().signal,overclaimed.fetcher));
  const noNetwork:typeof fetch=async()=>assert.fail('Should not fetch');await assert.rejects(fetchCirculationSnapshot({...supply,endpoint:'https://example.com'},new AbortController().signal,noNetwork));
  const controller=new AbortController();controller.abort();await assert.rejects(fetchCirculationSnapshot(supply,controller.signal,noNetwork),{name:'AbortError'});
});

test('removed schedules are accepted only when pot funds reconcile exactly; arbitrary extra deposits fail closed',async()=>{
 const ended=mock(48,(r,v:any)=>r.params[0]===VESTING_POT_KEY?potAccount(47n*schedule().total+VESTING_POT_ED):r.method==='state_queryStorageAt'?[{...v[0],changes:v[0].changes.map((x:any,i:number)=>i===0?[x[0],null]:x)}]:v);
 const result=await fetchCirculationSnapshot(supply,new AbortController().signal,ended.fetcher);assert.equal(result.scheduleCount,47);assert.equal(result.lockedPlanck,47n*50n*PLANCK);
 const empty=mock(48,(r,v:any)=>r.params[0]===VESTING_POT_KEY?potAccount(VESTING_POT_ED):r.method==='state_queryStorageAt'?[{...v[0],changes:v[0].changes.map((x:any)=>[x[0],null])}]:v);
 assert.equal((await fetchCirculationSnapshot(supply,new AbortController().signal,empty.fetcher)).lockedPlanck,0n);
 const extra=mock(48,(r,v)=>r.params[0]===VESTING_POT_KEY?potAccount(48n*schedule().total+VESTING_POT_ED+1n):v);await assert.rejects(fetchCirculationSnapshot(supply,new AbortController().signal,extra.fetcher));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {GENESIS, RPC_URLS, little, hex, PLANCK} from '../lib/quantus/protocol.ts';
import {decodeSupply,formatSupply,parseSupplySnapshot,fetchSupplySnapshot,GENESIS_SUPPLY_PLANCK,MAX_SUPPLY_PLANCK,ISSUANCE_KEY,TIMESTAMP_KEY} from '../lib/overview/supply.ts';
import {parsePriceResponse,fetchPriceSnapshot,PRICE_API_URL} from '../lib/overview/price.ts';
import {OVERVIEW_EN} from '../lib/i18n/overview-en.ts';
import {translate} from '../lib/i18n/core.ts';
const now=Date.now(),head='0x'+'ab'.repeat(32);
const fixtures=()=>({genesis:GENESIS,head,properties:{tokenDecimals:12,tokenSymbol:'QTC'},header:{number:'0x52ca'},issuance:hex(little(GENESIS_SUPPLY_PLANCK+6484n*PLANCK+123456789123n,16)),genesisIssuance:hex(little(GENESIS_SUPPLY_PLANCK,16)),timestamp:hex(little(BigInt(now-22*60_000),8))});
const sample=()=>({at:Math.floor(now/1000),ticker:{last:'50.00',high:'88',low:'20',price_change_percent:'+66.67%',amount:'14.36',volume:'482.35'}});
test('finalized net supply includes genesis initialization and preserves all 12 decimal places',()=>{
 const s=parseSupplySnapshot(fixtures(),now,RPC_URLS[0]);assert.equal(MAX_SUPPLY_PLANCK,21000000000000000000n);assert.equal(s.genesisPlanck,5670000001000000000n);assert.equal(s.minedNetPlanck,6484123456789123n);assert.equal(s.totalPlanck-s.genesisPlanck,s.minedNetPlanck);assert.equal(s.blockHash,head);assert.equal(s.blockTime,now-22*60_000);
 const burned=parseSupplySnapshot({...fixtures(),issuance:hex(little(GENESIS_SUPPLY_PLANCK-1n,16))},now,RPC_URLS[0]);assert.equal(burned.minedNetPlanck,-1n,'burns must not be hidden by clamping to zero');
});
test('supply rejects absent values, wrong network, precision and invalid genesis instead of guessing',()=>{
 for(const value of [null,'0x','0x00','0x'+'ff'.repeat(16),hex(little(0n,16))])assert.throws(()=>decodeSupply(value));
 for(const change of [{genesis:head},{properties:{tokenDecimals:18,tokenSymbol:'QTC'}},{genesisIssuance:hex(little(5670000n*PLANCK,16))},{head:'bad'},{header:{number:'oops'}},{timestamp:'0x00'},{timestamp:hex(little(BigInt(now+120000),8))}])assert.throws(()=>parseSupplySnapshot({...fixtures(),...change},now,RPC_URLS[0]));
 assert.equal(ISSUANCE_KEY,'0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80');assert.equal(TIMESTAMP_KEY,'0xf0c365c3cf59d671eb72da0e7a4113c49f1f0515f462cdcf84e0f1d6045dfcbb');
});
test('supply transport pins finalized storage reads to one hash and sends no wallet information',async()=>{
 const calls:{url:string;body:any;options:RequestInit}[]=[];const f=fixtures();
 const fetcher:typeof fetch=async(url,options)=>{
  const b=JSON.parse(String(options?.body));calls.push({url:String(url),body:b,options:options!});let result:unknown;
  if(b.method==='chain_getBlockHash')result=GENESIS;
  else if(b.method==='system_properties')result=f.properties;
  else if(b.method==='chain_getFinalizedHead')result=head;
  else if(b.method==='chain_getHeader'){assert.deepEqual(b.params,[head]);result=f.header;}
  else if(b.method==='state_getStorage'){assert.ok([head,GENESIS].includes(b.params[1]));result=b.params[0]===TIMESTAMP_KEY?f.timestamp:b.params[1]===GENESIS?f.genesisIssuance:f.issuance;}
  else throw new Error('Unexpected RPC method');
  return Response.json({id:b.id,jsonrpc:'2.0',result});
 };
 const s=await fetchSupplySnapshot(new AbortController().signal,fetcher);assert.equal(s.minedNetPlanck,6484123456789123n);assert.equal(calls.length,7);
 for(const {url,options} of calls){assert.equal(url,RPC_URLS[0]);assert.equal(options.credentials,'omit');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.redirect,'error');assert.equal(options.mode,'cors');}
});
test('supply failover stays on official endpoints and errors never become zero supply',async()=>{
 const seen:string[]=[];await assert.rejects(()=>fetchSupplySnapshot(new AbortController().signal,async url=>{seen.push(String(url));throw new Error('offline');}),/无法读取/);assert.deepEqual([...new Set(seen)],[...RPC_URLS]);
 const c=new AbortController();c.abort();await assert.rejects(()=>fetchSupplySnapshot(c.signal,async()=>{throw new Error('abort');}),{name:'AbortError'});
});
test('only the current Quantus QUANTUS ticker shape is accepted and quote/base volume units are not swapped',()=>{
 const p=parsePriceResponse(sample(),now);assert.equal(p.last,'50.00');assert.equal(p.volumeUsdt,'482.35');assert.equal(p.amountQuantus,'14.36');assert.equal(p.change,66.67);assert.equal(p.fetchedAt,now);
 const falling=sample();falling.ticker.price_change_percent='-12.50%';assert.equal(parsePriceResponse(falling,now).change,-12.5);
 const unchanged=sample();unchanged.ticker.price_change_percent='0%';assert.equal(parsePriceResponse(unchanged,now).change,0);
 const invalidChange=sample();invalidChange.ticker.price_change_percent='not available';assert.equal(parsePriceResponse(invalidChange,now).change,null);
 for(const last of ['0','NaN','-1','1e8','<script>','Infinity']){const s=sample();s.ticker.last=last;assert.throws(()=>parsePriceResponse(s,now));}
 for(const bad of [null,[],{},'ping'])assert.throws(()=>parsePriceResponse(bad,now));
 const numeric=sample();Object.assign(numeric.ticker,{last:50,volume:0});assert.equal(parsePriceResponse(numeric,now).last,'50');assert.equal(parsePriceResponse(numeric,now).volumeUsdt,'0');
 assert.throws(()=>parsePriceResponse({...sample(),at:Math.floor((now-6*60_000)/1000)},now));
 assert.throws(()=>parsePriceResponse({...sample(),at:Math.floor((now+2*60_000)/1000)},now));
});
test('public price fetch uses only the fixed same-origin price route without credentials',async()=>{
 let request:{url:string;options?:RequestInit}|undefined;
 const result=await fetchPriceSnapshot(new AbortController().signal,async(url,options)=>{request={url:String(url),options};return new Response(JSON.stringify({...sample(),at:Math.floor(Date.now()/1000)}),{status:200,headers:{'Content-Type':'application/json; charset=utf-8'}});});
 assert.equal(result.last,'50.00');assert.equal(request?.url,PRICE_API_URL);assert.equal(request?.options?.method,'GET');assert.equal(request?.options?.mode,undefined);assert.equal(request?.options?.credentials,'omit');assert.equal(request?.options?.cache,'no-store');assert.equal(request?.options?.redirect,'error');assert.equal(request?.options?.referrerPolicy,'no-referrer');assert.equal(request?.options?.body,undefined);
});
test('price HTTP, content-type, oversized data and cancellation fail closed',async()=>{
 const cases=[new Response('{}',{status:503,headers:{'Content-Type':'application/json'}}),new Response('{}',{status:200,headers:{'Content-Type':'text/html'}}),new Response('x'.repeat(32_001),{status:200,headers:{'Content-Type':'application/json'}})];
 for(const response of cases)await assert.rejects(()=>fetchPriceSnapshot(new AbortController().signal,async()=>response.clone()),/SafeTrade 行情暂不可用/);
 const controller=new AbortController();controller.abort();await assert.rejects(()=>fetchPriceSnapshot(controller.signal,async()=>{throw new Error('unused');}),{name:'AbortError'});
});
test('overview UI has English translations without changing units or data',()=>{
 for(const key of Object.keys(OVERVIEW_EN)){const en=translate(key,'en',['21,000,000','date']);assert.doesNotMatch(en,/[\u3400-\u9fff]/);}
 assert.match(translate('市场深度较小','en'),/Low market depth/);assert.match(translate('已挖出 · 净新增','en'),/Net increase/);
});

test('supply presentation rounds exact Planck without floating-point boundary errors',()=>{
 assert.equal(formatSupply(5676484000499999999n,'en-US'),'5,676,484');
 assert.equal(formatSupply(5676484000500000000n,'en-US'),'5,676,484.001');
 assert.equal(formatSupply(-1500000000n,'en-US'),'-0.002');
 assert.equal(formatSupply(5670000001000000000n,'en-US'),'5,670,000.001');
});

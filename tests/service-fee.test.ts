import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {SERVICE_FEE_ADDRESS,serviceFee,transferDebit,parseAmount,formatAmount,encodeCall,encodeTransferCall,verifyTransferCall,validateMetadata,concat,compact,assertFeeRecipientCanReceive,assertRecipientCanReceive,assertFunds,prepare,GENESIS,type Account,type Context} from '../lib/quantus/protocol.ts';
const metadata=JSON.parse(fs.readFileSync(new URL('./fixtures/mainnet-metadata.json',import.meta.url),'utf8')).result;
const {registry,ed}=validateMetadata(metadata);
const from='qzoyC4eRTrexYoutXABVsf61QJZxJim3iWvayRQwEjXWgA4mw',to='qzm5QCox8Dp5A3oSXZZYHD8YoYgPz7enykZb6RPUropdCyN5h';
const account=(address:string,free=0n,reserved=0n):Account=>({address,free,reserved,frozen:0n,nonce:0n,highSecurity:false,multisig:false});
test('fee is exactly 0.5% extra, never deducted from requested receipt',()=>{
 assert.equal(formatAmount(serviceFee(parseAmount('100'))),'0.5');
 assert.equal(formatAmount(transferDebit(parseAmount('100'))),'100.5');
 assert.equal(formatAmount(serviceFee(parseAmount('0.2'))),'0.001');
 assert.equal(formatAmount(serviceFee(parseAmount('0.01'))),'0.00005');
});
test('sub-unit fee rounds up by less than one Planck and uses no floating point',()=>{
 for(const n of [1n,199n,200n,201n,90071992547409931234567n,(1n<<128n)-1n]){
  const fee=serviceFee(n);assert.ok(fee*200n>=n);assert.ok(fee*200n<n+200n);
 }
 assert.equal(serviceFee(1n),1n);assert.equal(serviceFee(200n),1n);assert.equal(serviceFee(201n),2n);
 assert.throws(()=>serviceFee(0n));assert.throws(()=>serviceFee(-1n));assert.throws(()=>transferDebit((1n<<128n)-1n));
});
test('metadata decodes batch_all with exact main payment and designated fee recipient',()=>{
 const amount=parseAmount('100');assert.doesNotThrow(()=>verifyTransferCall(registry,encodeCall(to,amount),to,amount));
 const c=registry.createType('Call',encodeCall(to,amount));assert.equal(c.section,'utility');assert.equal(c.method,'batchAll');
 assert.match(c.toString(),new RegExp(SERVICE_FEE_ADDRESS));
});
test('missing, redirected, reordered, underpaid or inflated service fee is rejected',()=>{
 const amount=parseAmount('100');const batch=(calls:Uint8Array[])=>concat(Uint8Array.of(9,2),compact(BigInt(calls.length)),...calls);
 const main=encodeTransferCall(to,amount),fee=encodeTransferCall(SERVICE_FEE_ADDRESS,serviceFee(amount));
 for(const bad of [main,batch([main]),batch([main,encodeTransferCall(from,serviceFee(amount))]),batch([fee,main]),batch([main,encodeTransferCall(SERVICE_FEE_ADDRESS,serviceFee(amount)-1n)]),batch([main,encodeTransferCall(SERVICE_FEE_ADDRESS,serviceFee(amount)+1n)]),batch([main,fee,fee])])assert.throws(()=>verifyTransferCall(registry,bad,to,amount));
});
test('unfunded fee account rejects insufficient deposits without increasing the fee',()=>{
 const empty=account(SERVICE_FEE_ADDRESS);
 assert.throws(()=>assertFeeRecipientCanReceive(empty,to,parseAmount('0.01'),ed),/尚未激活/);
 assert.doesNotThrow(()=>assertFeeRecipientCanReceive(empty,to,parseAmount('0.2'),ed));
 assert.doesNotThrow(()=>assertFeeRecipientCanReceive(account(SERVICE_FEE_ADDRESS,ed),to,parseAmount('0.00001'),ed));
 assert.throws(()=>assertFeeRecipientCanReceive(account(SERVICE_FEE_ADDRESS,0n,ed),to,parseAmount('0.01'),ed));
 assert.equal(serviceFee(parseAmount('0.01')),50000000n);
});
test('main recipient can activate the fee account first, but cannot bypass its own ED check',()=>{
 const empty=account(SERVICE_FEE_ADDRESS);
 assert.doesNotThrow(()=>assertRecipientCanReceive(empty,ed,ed));
 assert.doesNotThrow(()=>assertFeeRecipientCanReceive(empty,SERVICE_FEE_ADDRESS,ed,ed));
 assert.throws(()=>assertRecipientCanReceive(empty,ed-1n,ed));
});
test('funds must cover main amount, service fee, network fee and retained minimum',()=>{
 const amount=parseAmount('100'),network=parseAmount('0.01');
 assert.throws(()=>assertFunds(account(from,amount+network+ed),transferDebit(amount),network,ed));
 assert.doesNotThrow(()=>assertFunds(account(from,transferDebit(amount)+network+ed),transferDebit(amount),network,ed));
});
const context:Context={genesis:GENESIS,spec:152,transactionVersion:6,block:100,blockHash:'0x'+'ab'.repeat(32),nonce:0n,eraBirth:100,eraBirthHash:'0x'+'ab'.repeat(32),metadataHex:metadata,endpoint:'https://rpc1-mainnet.quantus.com'};
test('preparation estimates the full batch, freezes fee details, and blocks self-fee payments',async()=>{
 const queried:string[]=[];let estimated='';const rpc={context:async()=>context,account:async(address:string)=>{queried.push(address);return account(address,parseAmount('1000'));},fee:async(tx:string)=>{estimated=tx;return parseAmount('0.01');}};
 const p=await prepare(rpc as never,from,to,parseAmount('100'),'ml-dsa-65');
 assert.equal(p.serviceFee,parseAmount('0.5'));assert.equal(p.serviceFeeAddress,SERVICE_FEE_ADDRESS);assert.ok(queried.includes(SERVICE_FEE_ADDRESS));assert.ok(queried.includes(to));assert.ok(estimated.length>10000);
 await assert.rejects(prepare(rpc as never,SERVICE_FEE_ADDRESS,to,1n,'ml-dsa-65'),/付款地址不能/);
});

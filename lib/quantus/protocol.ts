import { blake2AsU8a, blake2AsHex, decodeAddress, encodeAddress, xxhashAsHex } from '@polkadot/util-crypto';
import { TypeRegistry } from '@polkadot/types/create';
import { Metadata } from '@polkadot/types/metadata';
import { GenericChainProperties } from '@polkadot/types/generic';
import type { Call } from '@polkadot/types/interfaces';

export const GENESIS = '0xfb5487c0be6ae4ade2d41d16e50465129861636c2b8d61fa94d7a19631626fba';
export const METADATA_HASH = '0x7f43a45b1f415110f38541b3f5ede25375851b7ab197e34ee2cac3bf400f1f23';
export const RPC_URLS = ['https://rpc1-mainnet.quantus.com', 'https://rpc2-mainnet.quantus.com'] as const;
export const PLANCK = 1_000_000_000_000n;
export const SUPPORTED_SPEC = 152;
export const SERVICE_FEE_ADDRESS = 'qzp1rKcjGd8WWBiZv5kuWEL1jxHygtABcEgKURMpUwEPimXRV';
// 0.5%, rounded UP only to the chain's smallest unit (10^-12 QTC).
export function serviceFee(amount:bigint):bigint {
  if(amount<=0n||amount>=(1n<<128n))throw new Error('转账金额超出有效范围。');
  return (amount+199n)/200n;
}
export function transferDebit(amount:bigint):bigint {
  const total=amount+serviceFee(amount);
  if(total>=(1n<<128n))throw new Error('金额与服务费合计超出链上范围。');
  return total;
}
export type Scheme = 'ml-dsa-65' | 'ml-dsa-87';
export const SIZES = { 'ml-dsa-65': { variant: 1, signature: 3309, publicKey: 1952 }, 'ml-dsa-87': { variant: 0, signature: 4627, publicKey: 2592 } };
export const concat = (...arrays: Uint8Array[]) => { const out = new Uint8Array(arrays.reduce((n,a)=>n+a.length,0)); let offset=0; for(const a of arrays){out.set(a,offset);offset+=a.length;}return out; };
export const hex = (bytes: Uint8Array) => '0x' + Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export function unhex(value: string): Uint8Array { if(!/^0x(?:[0-9a-fA-F]{2})*$/.test(value))throw new Error('节点返回了无效编码。');return Uint8Array.from(value.slice(2).match(/../g)??[],x=>parseInt(x,16)); }
export function same(a: Uint8Array,b: Uint8Array){return a.length===b.length && a.every((v,i)=>v===b[i]);}
export function addressBytes(input: string): Uint8Array { const value=input.trim();if(!/^qz[1-9A-HJ-NP-Za-km-z]{40,62}$/.test(value))throw new Error('请填写完整的 Quantus qz… 地址。');let result:Uint8Array;try{result=decodeAddress(value,false,189);}catch{throw new Error('地址校验失败，请从钱包重新复制完整地址。');}if(result.length!==32||encodeAddress(result,189)!==value)throw new Error('地址格式不匹配。');return result; }
export function parseAmount(input: string): bigint { const s=input.trim();if(!/^(0|[1-9][0-9]*)(\.[0-9]{1,12})?$/.test(s))throw new Error('金额须为正数，最多 12 位小数，不支持科学计数法。');const [whole,fraction='']=s.split('.');const result=BigInt(whole)*PLANCK+BigInt(fraction.padEnd(12,'0'));if(result<=0n||result>=(1n<<128n))throw new Error('金额必须大于 0 且在链上允许范围内。');return result; }
export function formatAmount(value: bigint): string { const negative=value<0n;const v=negative?-value:value;const fraction=(v%PLANCK).toString().padStart(12,'0').replace(/0+$/,'');return `${negative?'-':''}${v/PLANCK}${fraction?'.'+fraction:''}`; }
export function little(value: bigint,size: number): Uint8Array {if(value<0n||value>=(1n<<BigInt(size*8)))throw new Error('编码数值越界。');const out=new Uint8Array(size);for(let i=0;i<size;i++){out[i]=Number(value&255n);value>>=8n;}return out;}
export function fromLittle(value: Uint8Array): bigint {return value.reduceRight((n,v)=>(n<<8n)+BigInt(v),0n);}
export function compact(value: bigint): Uint8Array {if(value<0n||value>=(1n<<128n))throw new Error('紧凑编码数值越界。');if(value<64n)return Uint8Array.of(Number(value<<2n));if(value<16384n)return little((value<<2n)|1n,2);if(value<1073741824n)return little((value<<2n)|2n,4);let n=4;while(value>=(1n<<BigInt(n*8)))n++;return concat(Uint8Array.of(((n-4)<<2)|3),little(value,n));}
export function readCompact(bytes: Uint8Array,offset=0): [bigint,number] {const first=bytes[offset];if(first===undefined)throw new Error('交易编码不完整。');const mode=first&3;const size=mode===0?1:mode===1?2:mode===2?4:(first>>2)+4;if(offset+size+(mode===3?1:0)>bytes.length)throw new Error('交易编码不完整。');const value=mode===3?fromLittle(bytes.slice(offset+1,offset+1+size)):fromLittle(bytes.slice(offset,offset+size))>>2n;const end=offset+size+(mode===3?1:0);if(!same(compact(value),bytes.slice(offset,end)))throw new Error('交易不是规范编码。');return [value,end];}
export const storagePrefix = (pallet: string,item: string)=>xxhashAsHex(pallet,128)+xxhashAsHex(item,128).slice(2);
export const accountKey = (pallet: string,item: string,address: string)=> storagePrefix(pallet,item)+hex(blake2AsU8a(addressBytes(address),128)).slice(2)+hex(addressBytes(address)).slice(2);
export interface Account {address:string;free:bigint;reserved:bigint;frozen:bigint;nonce:bigint;highSecurity:boolean;multisig:boolean;}
export function decodeAccount(address:string,raw:string|null): Omit<Account,'highSecurity'|'multisig'> { if(raw===null)return{address,free:0n,reserved:0n,frozen:0n,nonce:0n};const b=unhex(raw);if(b.length!==80)throw new Error('当前账户数据格式尚未支持，请使用官方钱包。');return{address,nonce:fromLittle(b.slice(0,4)),free:fromLittle(b.slice(16,32)),reserved:fromLittle(b.slice(32,48)),frozen:fromLittle(b.slice(48,64))}; }
export function transferable(account: Account,ed: bigint){const floor=account.frozen>ed?account.frozen:ed;return account.free>floor?account.free-floor:0n;}
export function assertFunds(account: Account,amount:bigint,fee:bigint,ed:bigint){if(account.highSecurity||account.multisig)throw new Error('这个账户需要特殊签名流程，请使用官方钱包。');if(fee<0n||amount<=0n||amount+fee>transferable(account,ed))throw new Error('余额不足：请为手续费、冻结资金和账户最低余额留出空间。');}

// QPoW events contain a SCALE U512. Its 64 fixed bytes must decode even when only transfer events are inspected.
export function validateMetadata(raw: string) {if(blake2AsHex(raw,256)!==METADATA_HASH)throw new Error('主网交易规则已变化，此版本暂时停止签名。请等待更新或使用官方钱包。');const registry=new TypeRegistry();registry.register({U512:'[u8;64]'});const metadata=new Metadata(registry,raw as `0x${string}`);if(metadata.version!==14)throw new Error('尚不支持该元数据版本。');registry.setMetadata(metadata,undefined,{ReversibleTransactionExtension:{extrinsic:{},payload:{}},WormholeProofRecorderExtension:{extrinsic:{},payload:{}}});registry.setChainProperties(new GenericChainProperties(registry,{ss58Format:189,tokenDecimals:12,tokenSymbol:'QTC'}));const balances=metadata.asLatest.pallets.find(p=>p.name.toString()==='Balances');const constant=balances?.constants.find(c=>c.name.toString()==='ExistentialDeposit');if(!constant)throw new Error('无法核实最低账户余额。');const ed=fromLittle(unhex(constant.value.toHex()));return{registry,metadata,ed};}
export interface Context {genesis:string;spec:number;transactionVersion:number;block:number;blockHash:string;nonce:bigint;eraBirth:number;eraBirthHash:string;metadataHex:string;endpoint:string;}
export function encodeTransferCall(to:string,amount:bigint){return concat(Uint8Array.of(2,3,0),addressBytes(to),compact(amount));}
export function encodeCall(to:string,amount:bigint){
  transferDebit(amount);
  return concat(Uint8Array.of(9,2),compact(2n),encodeTransferCall(to,amount),encodeTransferCall(SERVICE_FEE_ADDRESS,serviceFee(amount)));
}
export function verifyTransferCall(registry:TypeRegistry,encoded:Uint8Array,to:string,amount:bigint){
  const call=registry.createType('Call',encoded);
  if(call.section!=='utility'||call.method!=='batchAll')throw new Error('必须将转账与服务费一次性原子执行。');
  const calls=Array.from(call.args[0] as unknown as Iterable<Call>);
  const expected=[{to,amount},{to:SERVICE_FEE_ADDRESS,amount:serviceFee(amount)}];
  if(calls.length!==2)throw new Error('批量交易数量不正确。');
  for(let i=0;i<2;i++){
    const c=calls[i],e=expected[i];
    if(c.section!=='balances'||c.method!=='transferKeepAlive'||c.args[1].toString()!==e.amount.toString()||!same(c.args[0].toU8a(),concat(Uint8Array.of(0),addressBytes(e.to))))throw new Error('转账或服务费与确认内容不一致。');
  }
}
export function assertRecipientCanReceive(recipient:Account,amount:bigint,ed:bigint){
  if(recipient.free+amount<ed)throw new Error('收款钱包尚未激活，本次到账后余额不足 0.001 QTC，无法接收。请提高转账金额。');
  if(recipient.free+amount>=(1n<<128n))throw new Error('收款余额超出链上允许范围。');
}
export function assertFeeRecipientCanReceive(collector:Account,to:string,amount:bigint,ed:bigint){
  if(collector.address!==SERVICE_FEE_ADDRESS)throw new Error('服务费收款账户不匹配。');
  const available=collector.free+(to===SERVICE_FEE_ADDRESS?amount:0n);
  if(available+serviceFee(amount)<ed)throw new Error('服务费收款钱包尚未激活；本次服务费不足以创建账户。请由站点运营者先向服务费地址转入至少 0.001 QTC，或转账不少于 0.2 QTC。不会提高 0.5% 费率。');
}

export function mortalEra(block:number,period=64){if(!Number.isSafeInteger(block)||block<0||period!==64)throw new Error('无效的交易有效期。');const phase=block%period;return little(BigInt(5 | (phase<<4)),2);}
export function extra(ctx:Context){return concat(mortalEra(ctx.block),compact(ctx.nonce),compact(0n),Uint8Array.of(0));}
export function signingPayload(ctx:Context,to:string,amount:bigint){if(ctx.genesis!==GENESIS||ctx.spec!==152||ctx.transactionVersion!==6||ctx.eraBirth!==ctx.block)throw new Error('网络或签名版本不匹配。');return concat(encodeCall(to,amount),extra(ctx),little(BigInt(ctx.spec),4),little(BigInt(ctx.transactionVersion),4),unhex(ctx.genesis),unhex(ctx.eraBirthHash),Uint8Array.of(0));}
export function buildExtrinsic(ctx:Context,from:string,to:string,amount:bigint,scheme:Scheme,signature?:Uint8Array,publicKey?:Uint8Array){const sizes=SIZES[scheme];if(!sizes)throw new Error('签名方案不受支持。');const sig=signature??new Uint8Array(sizes.signature);const pub=publicKey??new Uint8Array(sizes.publicKey);if(sig.length!==sizes.signature||pub.length!==sizes.publicKey)throw new Error('签名长度不正确。');const body=concat(Uint8Array.of(0x84,0),addressBytes(from),Uint8Array.of(sizes.variant),sig,pub,extra(ctx),encodeCall(to,amount));return hex(concat(compact(BigInt(body.length)),body));}
export function verifyEnvelope(tx:string,ctx:Context,from:string,to:string,amount:bigint,scheme:Scheme,signature:Uint8Array,pub:Uint8Array){
  if(from===SERVICE_FEE_ADDRESS)throw new Error('付款地址不能与服务费收款地址相同，请通过官方钱包从此账户付款。');
  const bytes=unhex(tx);const[len,start]=readCompact(bytes);
  if(Number(len)!==bytes.length-start)throw new Error('交易长度不正确。');
  const expected=buildExtrinsic(ctx,from,to,amount,scheme,signature,pub);
  if(tx!==expected)throw new Error('签名交易与已确认内容不一致。');
  const callOffset=start+35+signature.length+pub.length+extra(ctx).length;
  verifyTransferCall(validateMetadata(ctx.metadataHex).registry,bytes.slice(callOffset),to,amount);
  return blake2AsHex(bytes,256);
}

const RPC_METHODS=new Set(['chain_getBlockHash','chain_getHeader','chain_getFinalizedHead','chain_getBlock','state_getRuntimeVersion','state_getMetadata','state_getStorage','system_properties','system_accountNextIndex','payment_queryInfo','state_call','author_submitExtrinsic']);
let requestId=1;
export class Rpc {
  public readonly endpoint:string;
  constructor(endpoint:string=RPC_URLS[0]){this.endpoint=endpoint;if(!RPC_URLS.includes(endpoint as typeof RPC_URLS[number]))throw new Error('只允许已配置的官方主网节点。');}
  async call<T=unknown>(method:string,params:unknown[]=[]):Promise<T>{if(!RPC_URLS.includes(this.endpoint as typeof RPC_URLS[number])||!RPC_METHODS.has(method))throw new Error('节点或 RPC 方法不在允许范围内。');const id=requestId++;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);try{const response=await fetch(this.endpoint,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer',redirect:'error'});if(!response.ok)throw new Error(`节点暂不可用（${response.status}）。`);const data=await response.json() as {id?:number;error?:{message?:string;code?:number};result?:T};if(!data||typeof data!=='object'||data.id!==id)throw new Error('节点响应不匹配。');if(data.error)throw new RpcError(String(data.error.message??'节点拒绝请求。'),data.error.code??-1);if(!('result' in data))throw new Error('节点未返回结果。');return data.result as T;}catch(e){if(e instanceof Error&&e.name==='AbortError')throw new Error('节点请求超时，请稍后重试。');throw e;}finally{clearTimeout(timeout);}}
  async identity(){const[g,version,props]=await Promise.all([this.call<string>('chain_getBlockHash',[0]),this.call<{specName:string;specVersion:number;transactionVersion:number}>('state_getRuntimeVersion'),this.call<{tokenDecimals:number;tokenSymbol:string}>('system_properties')]);if(g!==GENESIS||props.tokenDecimals!==12||props.tokenSymbol!=='QTC'||version.specName!=='quantus-runtime')throw new Error('节点身份校验失败，已停止操作。');return version;}
  async account(address:string,at?:string):Promise<Account>{addressBytes(address);const suffix=at?[at]:[];const[raw,hs,ms]=await Promise.all([this.call<string|null>('state_getStorage',[accountKey('System','Account',address),...suffix]),this.call<string|null>('state_getStorage',[accountKey('ReversibleTransfers','HighSecurityAccounts',address),...suffix]),this.call<string|null>('state_getStorage',[accountKey('Multisig','Multisigs',address),...suffix])]);return{...decodeAccount(address,raw),highSecurity:hs!==null,multisig:ms!==null};}
  async context(address:string):Promise<Context>{const version=await this.identity();if(version.specVersion!==152||version.transactionVersion!==6)throw new Error('当前主网已升级，此版本暂不开放签名。余额仍可查询。');const blockHash=await this.call<string>('chain_getBlockHash',[]);const[header,nonce,metadataHex,atVersion]=await Promise.all([this.call<{number:string}>('chain_getHeader',[blockHash]),this.call<number|string>('system_accountNextIndex',[address]),this.call<string>('state_getMetadata',[blockHash]),this.call<{specVersion:number;transactionVersion:number}>('state_getRuntimeVersion',[blockHash])]);if(atVersion.specVersion!==152||atVersion.transactionVersion!==6)throw new Error('准备交易时网络版本变化，请重试。');validateMetadata(metadataHex);const block=Number(BigInt(header.number));return{genesis:GENESIS,spec:152,transactionVersion:6,block,blockHash,nonce:BigInt(nonce),eraBirth:block,eraBirthHash:blockHash,metadataHex,endpoint:this.endpoint};}
  async fee(tx:string){const info=await this.call<{partialFee:string}>('payment_queryInfo',[tx]);if(!info||!/^\d+$/.test(String(info.partialFee)))throw new Error('无法取得有效手续费。');return BigInt(info.partialFee);}
}
export class RpcError extends Error{public code:number;constructor(message:string,code:number){super(message);this.code=code;this.name='RpcError';}}
export interface Prepared {context:Context;from:string;to:string;amount:bigint;serviceFee:bigint;serviceFeeAddress:string;fee:bigint;maxFee:bigint;scheme:Scheme;account:Account;createdAt:number;}
export async function prepare(rpc:Rpc,from:string,to:string,amount:bigint,scheme:Scheme):Promise<Prepared>{
  if(from===to)throw new Error('收款地址与付款地址相同，请核对。');
  if(from===SERVICE_FEE_ADDRESS)throw new Error('付款地址不能与服务费收款地址相同，请通过官方钱包从此账户付款。');
  addressBytes(from);addressBytes(to);addressBytes(SERVICE_FEE_ADDRESS);
  const context=await rpc.context(from);
  const [account,collector,recipient]=await Promise.all([rpc.account(from,context.blockHash),rpc.account(SERVICE_FEE_ADDRESS,context.blockHash),rpc.account(to,context.blockHash)]);
  const ed=validateMetadata(context.metadataHex).ed;
  assertRecipientCanReceive(recipient,amount,ed);
  assertFeeRecipientCanReceive(collector,to,amount,ed);
  const fee=await rpc.fee(buildExtrinsic(context,from,to,amount,scheme));const maxFee=fee+(fee/10n)+1n;
  assertFunds(account,transferDebit(amount),maxFee,ed);
  return{context,from,to,amount,serviceFee:serviceFee(amount),serviceFeeAddress:SERVICE_FEE_ADDRESS,fee,maxFee,scheme,account,createdAt:Date.now()};
}

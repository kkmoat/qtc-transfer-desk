"use client";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { ArrowUpRight, Wallet, ShieldCheck, LockKeyhole, ChevronRight, RefreshCw, Copy, Check, AlertCircle, LoaderCircle, LogOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectTrigger, SelectContent, SelectItem, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Rpc, RPC_URLS, addressBytes, formatAmount, parseAmount, transferable, prepare, validateMetadata, assertFunds, assertRecipientCanReceive, assertFeeRecipientCanReceive, serviceFee, transferDebit, SERVICE_FEE_ADDRESS, signingPayload, buildExtrinsic, verifyEnvelope, same, type Account, type Prepared } from '@/lib/quantus/protocol';
import { LocalSigner, type OpenWallet } from '@/lib/quantus/signer';
import {readHistory,saveHistory,mergeHistory,HISTORY_PREFIX,type TransferReceipt} from '@/lib/quantus/records';
import { readPending, savePending, submitOnce, trackTransfer, PENDING_KEY, type TransferRecord } from '@/lib/quantus/tracking';

const CONTACT_WECHAT='kk129182';
const complete = (r:TransferRecord|null)=>!!r&&['finalized','failed','expired'].includes(r.phase);
const receiptStatus=(r:TransferReceipt)=>({submitting:'提交中',submitted:'等待入块',included:r.execution==='failed'?'执行失败，等待确认':'已入块，等待确认',finalized:'已最终确认',failed:'未成功',unknown:'待查询',expired:'已过期'})[r.phase];
const historyDate=(time:number)=>new Date(time).toLocaleString('zh-CN',{hour12:false});
const short = (v:string)=>v.slice(0,10)+'…'+v.slice(-8);
const explorer = (address:string)=>'https://explorer.quantus.com/accounts/'+encodeURIComponent(address);
function message(e:unknown){return e instanceof Error?e.message:'操作未完成，请重试。';}

export default function Home(){
 const [endpoint,setEndpoint]=useState<string>(RPC_URLS[0]);
 const [account,setAccount]=useState<Account|null>(null);
 const [wallet,setWallet]=useState<OpenWallet|null>(null);
 const [recipient,setRecipient]=useState('');const [amount,setAmount]=useState('');
 const [busy,setBusy]=useState('');const [error,setError]=useState('');const [note,setNote]=useState('');
 const [modal,setModal]=useState<'open'|'watch'|null>(null);const [watchAddress,setWatchAddress]=useState('');
 const [expectedAddress,setExpectedAddress]=useState('');const [index,setIndex]=useState('0');
 const [prepared,setPrepared]=useState<Prepared|null>(null);const [ack,setAck]=useState(false);
 const [record,setRecord]=useState<TransferRecord|null>(null);const [tracking,setTracking]=useState(false);
 const [runtime,setRuntime]=useState<number|null>(null);const [copied,setCopied]=useState('');
 const [contactMessage,setContactMessage]=useState('');
 const [history,setHistory]=useState<TransferReceipt[]>([]);const [historyLimit,setHistoryLimit]=useState(10);
 const [historyWarning,setHistoryWarning]=useState('');const [historyDetailHash,setHistoryDetailHash]=useState<string|null>(null);
 const [historyTracking,setHistoryTracking]=useState<string|null>(null);const [historyError,setHistoryError]=useState('');
 const historyTracker=useRef<AbortController|null>(null);
 const historyDetail=history.find(r=>r.hash===historyDetailHash)??null;
 const signer=useRef<LocalSigner|null>(null);const phraseInput=useRef<HTMLTextAreaElement>(null);
 const activeAddress=useRef<string|null>(null);const balanceRequest=useRef(0);
 const inflight=useRef(false);const tracker=useRef<AbortController|null>(null);
 const blocked=!!busy||!!record&&!complete(record);
 const rpc=useCallback(()=>new Rpc(endpoint),[endpoint]);
 const lock=useCallback(()=>{signer.current?.close();signer.current=null;setWallet(null);setPrepared(null);if(phraseInput.current)phraseInput.current.value='';},[]);
 useEffect(()=>{if(!wallet)return;let timer:ReturnType<typeof setTimeout>;const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>{lock();setNote('长时间未操作，钱包已自动锁定。');},5*60_000);};reset();window.addEventListener('pointerdown',reset);window.addEventListener('keydown',reset);return()=>{clearTimeout(timer);window.removeEventListener('pointerdown',reset);window.removeEventListener('keydown',reset);};},[wallet,lock]);
 useEffect(()=>{const onPageHide=()=>lock();window.addEventListener('pagehide',onPageHide);return()=>window.removeEventListener('pagehide',onPageHide);},[lock]);
 const selectAddress=(address:string)=>{activeAddress.current=address;balanceRequest.current++;setAccount(null);setRuntime(null);};
 const refresh=async(address=activeAddress.current,queryEndpoint=endpoint)=>{if(!address)return;addressBytes(address);const request=++balanceRequest.current;const client=new Rpc(queryEndpoint);const identity=await client.identity();const data=await client.account(address);if(activeAddress.current===address&&balanceRequest.current===request){setRuntime(identity.specVersion);setAccount(data);}return data;};
 async function queryWatch(){if(inflight.current)return;inflight.current=true;setBusy('watch');setError('');try{const address=watchAddress.trim();addressBytes(address);lock();selectAddress(address);await refresh(address);setModal(null);}catch(e){setError(message(e));}finally{setBusy('');inflight.current=false;}}
 async function openWallet(){if(inflight.current)return;inflight.current=true;setBusy('open');setError('');let phrase='';let local:LocalSigner|null=null;try{const expected=expectedAddress.trim();addressBytes(expected);if(!/^\d{1,6}$/.test(index)||Number(index)>999999)throw new Error('账户序号须在 0–999999 之间。');phrase=(phraseInput.current?.value??'').trim().normalize('NFKD').replace(/\s+/g,' ');if(phraseInput.current)phraseInput.current.value='';if(![12,15,18,21,24].includes(phrase.split(' ').length))throw new Error('请填写完整助记词。');lock();selectAddress(expected);local=new LocalSigner();signer.current=local;const opening=local.open(phrase,'ml-dsa-65',Number(index),expected);phrase='';const w=await opening;setWallet(w);setModal(null);setNote('钱包已在本地打开，5 分钟未操作将自动锁定。');await refresh(w.address);}catch(e){local?.close();if(signer.current===local){signer.current=null;setWallet(null);}setError(message(e));}finally{phrase='';setBusy('');inflight.current=false;}}
 async function showReview(){if(inflight.current||blocked)return;inflight.current=true;setBusy('prepare');setError('');setNote('');try{if(!wallet||!signer.current)throw new Error('请先打开与付款地址对应的钱包。');const p=await prepare(rpc(),wallet.address,recipient.trim(),parseAmount(amount),wallet.scheme);setAccount(p.account);setPrepared(p);setAck(false);}catch(e){setError(message(e));}finally{setBusy('');inflight.current=false;}}
 const remember=useCallback((r:TransferReceipt)=>{
  if(!saveHistory(r))setHistoryWarning('浏览器未能保存本地记录（存储可能被禁用或已满）。离开页面后可能丢失，请保留交易哈希并通过区块浏览器查询。');
  setHistory(previous=>mergeHistory(previous,r));
 },[]);
 const updateRecord=useCallback((r:TransferRecord)=>{setRecord(r);savePending(r);remember(r);},[remember]);
 async function continueTracking(r:TransferRecord){
  if(tracker.current)return;
  const controller=new AbortController();tracker.current=controller;setTracking(true);
  const current=()=>tracker.current===controller&&!controller.signal.aborted;
  try{
   const final=await trackTransfer(new Rpc(r.endpoint),r,value=>{if(current())updateRecord(value);},controller.signal);
   if(current()&&complete(final)&&activeAddress.current===final.from){try{await refresh(final.from,final.endpoint);}catch{/* receipt is retained */}}
  }catch(e){if(current())setError(message(e));}
  finally{if(tracker.current===controller){tracker.current=null;setTracking(false);}}
 }
 const resumePending=useEffectEvent((pending:TransferRecord)=>{
  remember(pending);
  void continueTracking(pending);
  void refresh(pending.from,pending.endpoint).catch(()=>{});
 });
 // Restore public transaction data after hydration and immediately resume read-only tracking.
 useEffect(()=>{
  const saved=readHistory();
  // Local browser records are unavailable during server rendering.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  setHistory(saved.records);
  if(!saved.available)setHistoryWarning('当前浏览器不允许读取本地存储。记录可能无法保留，请通过区块浏览器查询。');
  const onStorage=(event:StorageEvent)=>{if(event.key===null||event.key.startsWith(HISTORY_PREFIX)){const latest=readHistory();setHistory(latest.records);}};
  window.addEventListener('storage',onStorage);
  const pending=readPending();
  // sessionStorage is available only after hydration.
  if(pending){setRecord(pending);setEndpoint(pending.endpoint);setWatchAddress(pending.from);activeAddress.current=pending.from;resumePending(pending);}
  return()=>{window.removeEventListener('storage',onStorage);signer.current?.close();tracker.current?.abort();tracker.current=null;historyTracker.current?.abort();historyTracker.current=null;activeAddress.current=null;};
 },[]);
 async function send(){if(!prepared||!ack||inflight.current||blocked)return;const p=prepared;inflight.current=true;setBusy('sign');setError('');try{if(!wallet||!signer.current||wallet.address!==p.from)throw new Error('钱包已锁定或账户已变化，请重新预览。');if(p.serviceFee!==serviceFee(p.amount)||p.serviceFeeAddress!==SERVICE_FEE_ADDRESS)throw new Error('服务费规则已变化，请重新预览。');if(Date.now()-p.createdAt>120000)throw new Error('预览已过期，请重新核对交易。');const client=new Rpc(p.context.endpoint);const current=await client.context(p.from);if(current.nonce!==p.context.nonce||current.spec!==p.context.spec||current.transactionVersion!==p.context.transactionVersion||current.block>=p.context.block+16)throw new Error('账户状态或区块已变化，请重新预览。');const canonical=await client.call<string>('chain_getBlockHash',[p.context.block]);if(canonical!==p.context.eraBirthHash)throw new Error('链发生重组，请重新预览。');const signed=await signer.current.sign(signingPayload(p.context,p.to,p.amount));const sig=Uint8Array.from(signed.signature);const pub=Uint8Array.from(signed.publicKey);if(!same(pub,Uint8Array.from(wallet.publicKey)))throw new Error('签名账户不匹配。');const tx=buildExtrinsic(p.context,p.from,p.to,p.amount,p.scheme,sig,pub);const hash=verifyEnvelope(tx,p.context,p.from,p.to,p.amount,p.scheme,sig,pub);const [fee,latest,collector,recipientAccount]=await Promise.all([client.fee(tx),client.account(p.from),client.account(SERVICE_FEE_ADDRESS),client.account(p.to)]);if(fee>p.maxFee)throw new Error('当前手续费超过预留值，请重新预览。');const ed=validateMetadata(p.context.metadataHex).ed;assertFunds(latest,transferDebit(p.amount),fee,ed);assertRecipientCanReceive(recipientAccount,p.amount,ed);assertFeeRecipientCanReceive(collector,p.to,p.amount,ed);const r:TransferRecord={hash,bytes:tx,from:p.from,to:p.to,amount:p.amount.toString(),serviceFee:p.serviceFee.toString(),serviceFeeAddress:p.serviceFeeAddress,estimatedNetworkFee:fee.toString(),endpoint:client.endpoint,firstBlock:p.context.block,expiresAt:p.context.block+64,phase:'submitting',message:'正在提交主网交易。',createdAt:Date.now()};updateRecord(r);setPrepared(null);const submitted=await submitOnce(client,r,updateRecord);setBusy('');if(submitted.phase!=='failed')void continueTracking(submitted);}catch(e){setError(message(e));setPrepared(null);}finally{setBusy('');inflight.current=false;}}
 async function queryHistory(r:TransferReceipt){
  if(historyTracker.current)return;
  if(record?.hash===r.hash){if(!tracking)void continueTracking(record);return;}
  const controller=new AbortController();historyTracker.current=controller;setHistoryTracking(r.hash);setHistoryError('');
  const current=()=>historyTracker.current===controller&&!controller.signal.aborted;
  try{
   const checking:TransferReceipt={...r,phase:'unknown',execution:undefined,finalizedHeight:undefined,message:'正在按原交易哈希重新核对链上结果。'};
   remember(checking);
   await trackTransfer(new Rpc(r.endpoint),checking,value=>{if(current())remember(value);},controller.signal);
  }catch(e){if(current())setHistoryError(message(e));}
  finally{if(historyTracker.current===controller){historyTracker.current=null;setHistoryTracking(null);}}
 }
 const closeHistory=()=>{historyTracker.current?.abort();historyTracker.current=null;setHistoryTracking(null);setHistoryDetailHash(null);setHistoryError('');};
 async function copyContact(){
  try{await navigator.clipboard.writeText(CONTACT_WECHAT);setContactMessage(`已复制微信号：${CONTACT_WECHAT}`);}
  catch{setContactMessage(`无法自动复制，请手动复制微信号：${CONTACT_WECHAT}`);}
 }
 async function copy(value:string){try{await navigator.clipboard.writeText(value);setCopied(value);setTimeout(()=>setCopied(''),1800);}catch{setError('无法自动复制，请手动选中复制。');}}
 const closeModal=(open:boolean)=>{if(!open&&!busy){if(phraseInput.current)phraseInput.current.value='';setModal(null);setError('');}};
 const resetTransaction=()=>{if(!complete(record)||tracking)return;sessionStorage.removeItem(PENDING_KEY);setRecord(null);setPrepared(null);setRecipient('');setAmount('');setError('');};
 const draftFee=(()=>{try{return serviceFee(parseAmount(amount));}catch{return null;}})();
 const statusTitle=record?({submitting:'正在提交',submitted:'等待入块',included:record.execution==='failed'?'执行失败，等待确认':'已入块，等待确认',finalized:'转账已确认',failed:'转账未成功',unknown:'结果待确认',expired:'交易已过期'})[record.phase]:'';

 useEffect(()=>{
  const ctx=(document as Document & {modelContext?:{registerTool:(tool:unknown,opts:unknown)=>unknown}}).modelContext;if(!ctx)return;
  const life=new AbortController();
  const tool={name:'query_qtc_balance',title:'查询 QTC 主网余额',description:'只查询公开地址的主网余额；不打开钱包、不签名、不发送交易。',inputSchema:{type:'object',properties:{address:{type:'string'}},required:['address'],additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute:async(input:unknown)=>{if(!input||typeof input!=='object'||typeof(input as {address?:unknown}).address!=='string')throw new Error('address required');const a=(input as {address:string}).address.trim();addressBytes(a);const client=new Rpc(endpoint);await client.identity();const data=await client.account(a);return{address:a,free:formatAmount(data.free),frozen:formatAmount(data.frozen),reserved:formatAmount(data.reserved),unit:'QTC'};}};
  try{void Promise.resolve(ctx.registerTool(tool,{signal:life.signal})).catch(()=>{});}catch{/* optional browser API */}return()=>life.abort();
 },[endpoint]);

 return <div className="desk"><header className="topbar"><a className="wordmark" href="/"><span className="brandmark">Q</span><span>QTC<span className="wordmark-light"> 转账台</span></span></a><div className="network"><span className="network-dot"/>Quantus Mainnet</div><a className="quiet-link" href="https://explorer.quantus.com" target="_blank" rel="noreferrer">区块浏览器 <ArrowUpRight size={16}/></a></header>
 <main className="workspace"><div className="page-heading"><div><span className="eyebrow">QUANTUS / TRANSFER</span><h1>QTC 主网转账</h1></div><div className="heading-links"><a className="author-link" href="https://x.com/kkmoat" target="_blank" rel="noopener noreferrer" aria-label="作者 X：@kkmoat，在新标签页打开">作者 X：<strong>@kkmoat</strong><ArrowUpRight size={17} aria-hidden="true"/></a><span className="session-label"><LockKeyhole size={16}/> 本地签名</span></div></div>
 {error&&!modal&&<div className="notice error" role="alert"><AlertCircle size={18}/><span>{error}</span></div>}{note&&<div className="notice" role="status"><ShieldCheck size={18}/><span>{note}</span></div>}
 <div className="desk-grid"><aside className="account-panel"><div className="panel-label"><span>{wallet?'已打开付款钱包':account?'公开地址查询':'付款账户'}</span><Wallet size={19}/></div><div className="balance-label">账户余额</div><div className="balance-number">{account?formatAmount(account.free):'—'}<span>QTC</span></div>
 {account?<div className="account-address"><span title={account.address}>{short(account.address)}</span><button aria-label="复制付款地址" onClick={()=>copy(account.address)}>{copied===account.address?<Check size={15}/>:<Copy size={15}/>}</button><a href={explorer(account.address)} target="_blank" rel="noreferrer" aria-label="在区块浏览器查看付款账户"><ArrowUpRight size={16}/></a></div>:<p className="subtle">打开钱包或查询公开地址，读取主网余额。</p>}
 {!wallet?<Button className="primary full" disabled={blocked} onClick={()=>{setExpectedAddress(account?.address??'');setModal('open');setError('');}}>打开已有钱包</Button>:<Button className="secondary full" disabled={!!busy} onClick={()=>{lock();setNote('钱包已锁定，仍可查询公开余额和交易结果。');}}><LogOut size={16}/> 锁定钱包</Button>}
 {!wallet&&<Button className="secondary full" disabled={blocked} onClick={()=>{setWatchAddress(account?.address??'');setModal('watch');setError('');}}>查询公开地址</Button>}
 {account&&<><div className="account-detail"><span>可支出上限*</span><strong>{formatAmount(transferable(account,1000000000n))} QTC</strong></div><div className="account-detail"><span>冻结 / 预留</span><strong>{formatAmount(account.frozen)} / {formatAmount(account.reserved)}</strong></div><p className="micro">* 已保留 0.001 QTC 最低账户余额，转账时另扣 0.5% 服务费和网络手续费。</p><Button className="text-button" disabled={!!busy} onClick={async()=>{setBusy('refresh');setError('');try{await refresh();}catch(e){setError(message(e));}finally{setBusy('');}}}><RefreshCw size={14} className={busy==='refresh'?'spin':''}/> 刷新余额</Button></>}
 {wallet&&<p className="micro wallet-path">{wallet.scheme.toUpperCase()}<br/>{wallet.path}</p>}
 <div className="node-select"><span>连接节点</span><Select value={endpoint} onValueChange={v=>{if(!blocked&&!prepared){balanceRequest.current++;setEndpoint(v);setRuntime(null);setNote('节点已切换，请刷新余额。');}}} disabled={blocked||!!prepared}><SelectTrigger aria-label="选择官方主网节点"><SelectValue/></SelectTrigger><SelectContent><SelectItem value={RPC_URLS[0]}>官方主节点</SelectItem><SelectItem value={RPC_URLS[1]}>官方备用节点</SelectItem></SelectContent></Select></div>
 {runtime!==null&&runtime!==152&&<p className="notice error">主网已升级至 {runtime}，当前版本暂时只提供余额查询。</p>}
 <div className="privacy-note"><ShieldCheck size={21}/><p>私钥只留在浏览器签名组件中。<br/>网站不保存助记词或私钥。</p></div></aside>
 <section className="transfer-panel"><div className="transfer-heading"><span className="section-icon"><ArrowUpRight size={25}/></span><div><h2>{record?'交易进度':'发送 QTC'}</h2><p>{record?'按原交易哈希持续查询主网结果。':'填写收款信息，下一步核对交易。'}</p></div></div><div className="steps"><span className={'step '+(!prepared&&!record?'active':'')}><b>1</b>填写信息</span><span className="step-line"/><span className={'step '+(prepared?'active':'')}><b>2</b>确认交易</span><span className="step-line"/><span className={'step '+(record?'active':'')}><b>3</b>链上结果</span></div>
 {record?<div className="receipt"><div className={'result-state '+(record.phase==='finalized'?'success':'')}>{record.phase==='finalized'?<Check size={27}/>:tracking?<LoaderCircle size={24} className="spin"/>:<AlertCircle size={25}/>}<h3>{statusTitle}</h3></div><p className="subtle">{record.message}</p><div className="receipt-amount">{formatAmount(BigInt(record.amount))} <span>QTC</span></div><dl><dt>收款地址</dt><dd>{record.to}</dd><dt>付款地址</dt><dd>{record.from}</dd>{record.serviceFee&&<><dt>服务费（0.5%，金额向上取整至最小单位）</dt><dd>{formatAmount(BigInt(record.serviceFee))} QTC</dd><dt>服务费收款地址</dt><dd>{record.serviceFeeAddress}</dd><dt>提交时预计网络费</dt><dd>{record.estimatedNetworkFee?formatAmount(BigInt(record.estimatedNetworkFee)):'—'} QTC</dd></>}<dt>交易哈希 <button onClick={()=>copy(record.hash)} aria-label="复制交易哈希">{copied===record.hash?<Check size={14}/>:<Copy size={14}/>}</button></dt><dd>{record.hash}</dd>{record.includedHeight!==undefined&&<><dt>入块高度</dt><dd>{record.includedHeight.toLocaleString()}</dd>{record.finalizedHeight!==undefined&&<><dt>主网最终确认高度</dt><dd>{record.finalizedHeight.toLocaleString()}{record.phase==='included'&&record.finalizedHeight<record.includedHeight?` · 还需推进 ${record.includedHeight-record.finalizedHeight} 块`:''}</dd></>}</>}</dl>{!complete(record)&&<Button className="secondary full" disabled={tracking} onClick={()=>void continueTracking(record)}>{tracking?'正在查询，保持页面打开':'继续查询这笔交易'} <RefreshCw size={15}/></Button>}{complete(record)&&<Button className="primary full" disabled={tracking} onClick={resetTransaction}>准备下一笔转账 <ChevronRight size={17}/></Button>}<a className="receipt-link" href={explorer(record.from)} target="_blank" rel="noreferrer">在区块浏览器查看账户 <ArrowUpRight size={15}/></a></div>:<>
 <label className="field-label" htmlFor="recipient">收款地址</label><Input id="recipient" className="address-input" placeholder="粘贴完整的 qz… 地址" autoComplete="off" spellCheck={false} value={recipient} disabled={!!busy} onChange={e=>{setRecipient(e.target.value);setPrepared(null);}}/><p className="field-help">仅支持 Quantus 主网普通账户转账。</p><div className="amount-label"><label className="field-label" htmlFor="amount">收款人到账金额</label><span>服务费与网络费另计</span></div><div className="amount-input"><Input id="amount" placeholder="0.00" inputMode="decimal" autoComplete="off" value={amount} disabled={!!busy} onChange={e=>{setAmount(e.target.value);setPrepared(null);}}/><span>QTC</span></div><div className="service-fee-summary"><div className="fee-line"><span>服务费 · 0.5%</span><strong>{draftFee!==null?formatAmount(draftFee)+' QTC':'输入金额后计算'}</strong></div><p>服务费额外收取，收款人收到上方完整金额。</p><span className="fee-recipient-label">服务费收款地址</span><a className="fee-recipient" href={explorer(SERVICE_FEE_ADDRESS)} target="_blank" rel="noreferrer">{SERVICE_FEE_ADDRESS} <ArrowUpRight size={13}/></a><p>费用向上取整至 0.000000000001 QTC。转账与服务费同时成功或同时回滚，链上失败仍可能产生网络费。</p></div><div className="fee-row"><span>预计网络手续费</span><strong>预览交易时从主网计算</strong></div><Button className="primary full review-button" disabled={blocked||!wallet||!recipient.trim()||!amount||runtime!==152} onClick={showReview}>{busy==='prepare'?<><LoaderCircle className="spin" size={18}/>正在计算手续费</>:<>{wallet?'预览并核对交易':'先打开付款钱包'}<ChevronRight size={18}/></>}</Button><div className="form-footnote"><LockKeyhole size={14}/><span>确认之前不会签名，也不会发送交易。</span></div>
 </>}
 </section></div>
 <section className="history-panel" aria-labelledby="history-heading">
  <div className="history-heading"><h2 id="history-heading">转账记录</h2><span>当前浏览器 · {history.length} 笔</span></div>
  <p className="history-notice"><ShieldCheck size={18}/><span>记录仅为本地缓存。<strong>清除网站数据（含本地存储）后，记录会丢失且本站无法恢复，需要通过区块浏览器查询。</strong>链上交易不受影响；记录不跨浏览器或设备同步。</span></p>
  {historyWarning&&<p className="notice error" role="status">{historyWarning}</p>}
  <p className="history-help">显示本浏览器保存的本站转账及上次查询结果。历史状态可能变化，可打开详情重新核对；更早未保存的交易请查询区块浏览器。</p>
  {history.length===0?<div className="history-empty"><p>暂无本地转账记录</p><span>通过本站发起转账后会自动保存到这里。</span><a href="https://explorer.quantus.com" target="_blank" rel="noreferrer">前往区块浏览器查询 <ArrowUpRight size={14}/></a></div>:<>
   <ul className="history-list">{history.slice(0,historyLimit).map(item=><li key={item.hash} className="history-row">
    <div className="history-primary"><strong>{formatAmount(BigInt(item.amount))} <span>QTC</span></strong><span className={'history-badge '+(item.phase==='finalized'?'confirmed':'')}>{receiptStatus(item)}</span></div>
    <div className="history-summary"><time dateTime={new Date(item.createdAt).toISOString()}>{historyDate(item.createdAt)}</time><span title={item.to}>收款：{short(item.to)}</span><span className="history-hash" title={item.hash}>{short(item.hash)}</span></div>
    <div className="history-actions"><button type="button" onClick={()=>{setHistoryDetailHash(item.hash);setHistoryError('');}}>查看详情 <ChevronRight size={14}/></button><a href={explorer(item.from)} target="_blank" rel="noreferrer">区块浏览器 <ArrowUpRight size={14}/></a></div>
   </li>)}</ul>
   {history.length>historyLimit&&<Button className="secondary history-more" onClick={()=>setHistoryLimit(n=>n+10)}>查看更多（已显示 {historyLimit} / {history.length} 笔）</Button>}
  </>}
 </section>
 <footer><span>独立社区工具 · 非 Quantus 官方产品 · 未经独立安全审计</span><div className="footer-links"><a href="https://github.com/kkmoat/qtc-transfer-desk" target="_blank" rel="noopener noreferrer">GitHub 开源</a><a href="/source/quantus-browser-crypto-source.zip" download>签名组件源码</a><a href="/source/LICENSE.txt" target="_blank">GPL-3.0</a><div className="footer-contact"><button type="button" className="contact-button" onClick={copyContact} aria-label={`联系我们，复制微信号 ${CONTACT_WECHAT}`} title={`点击复制微信号：${CONTACT_WECHAT}`}>联系我们 <Copy size={14} aria-hidden="true"/></button><span className="contact-status" role="status" aria-live="polite">{contactMessage}</span></div></div></footer></main>
 <Dialog open={historyDetailHash!==null} onOpenChange={open=>{if(!open)closeHistory();}}><DialogContent className="wallet-dialog history-dialog"><DialogHeader><DialogTitle>转账记录详情</DialogTitle><DialogDescription>这是本地保存的交易信息。重新查询只核对链上结果，不会再次付款。</DialogDescription></DialogHeader>
 {historyDetail?<><div className="receipt-amount">{formatAmount(BigInt(historyDetail.amount))} <span>QTC</span></div><p className="history-detail-state" role="status">{historyTracking===historyDetail.hash?'正在查询链上结果…':`上次查询结果：${receiptStatus(historyDetail)}`}</p><p className="micro">{historyDetail.message}</p>
 <dl><dt>发起时间（本机时区）</dt><dd>{historyDate(historyDetail.createdAt)}</dd><dt>付款地址</dt><dd>{historyDetail.from}</dd><dt>收款地址</dt><dd>{historyDetail.to}</dd><dt>交易哈希</dt><dd>{historyDetail.hash}</dd>
 {historyDetail.serviceFee&&<><dt>服务费（0.5%）</dt><dd>{formatAmount(BigInt(historyDetail.serviceFee))} QTC</dd><dt>服务费收款地址</dt><dd>{historyDetail.serviceFeeAddress}</dd></>}
 {historyDetail.estimatedNetworkFee&&<><dt>提交时预计网络费（实际以链上为准）</dt><dd>{formatAmount(BigInt(historyDetail.estimatedNetworkFee))} QTC</dd></>}
 {historyDetail.includedHeight!==undefined&&<><dt>入块高度</dt><dd>{historyDetail.includedHeight.toLocaleString()}</dd></>}{historyDetail.finalizedHeight!==undefined&&<><dt>上次查询的最终确认高度</dt><dd>{historyDetail.finalizedHeight.toLocaleString()}</dd></>}</dl>
 {historyError&&<p className="notice error" role="alert">{historyError}</p>}
 <Button className="secondary full" disabled={!!historyTracking||record?.hash===historyDetail.hash&&tracking} onClick={()=>void queryHistory(historyDetail)}><RefreshCw size={16} className={historyTracking?'spin':''}/>{record?.hash===historyDetail.hash&&tracking?'当前交易正在自动查询':historyTracking?'正在查询，关闭详情可停止':'重新查询链上结果'}</Button>
 <a className="receipt-link" href={explorer(historyDetail.from)} target="_blank" rel="noreferrer">在区块浏览器查看账户 <ArrowUpRight size={15}/></a></>:<p className="subtle">这条本地记录已不可用，请通过区块浏览器查询。</p>}
 </DialogContent></Dialog>
 <Dialog open={modal!==null} onOpenChange={closeModal}><DialogContent showCloseButton={!busy} className="wallet-dialog" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}><DialogHeader><DialogTitle>{modal==='watch'?'查询公开地址':'在本地打开已有钱包'}</DialogTitle><DialogDescription>{modal==='watch'?'只需公开收款地址，无需助记词。':'助记词只交给本页面的本地签名组件。请在可信设备上使用，先核对网站地址。'}</DialogDescription></DialogHeader>
 {error&&<div className="notice error" role="alert"><AlertCircle size={17}/><span>{error}</span></div>}
 {modal==='watch'?<><label className="field-label" htmlFor="watch">公开收款地址</label><Input id="watch" className="address-input" value={watchAddress} onChange={e=>setWatchAddress(e.target.value)} placeholder="qz…" autoComplete="off" disabled={!!busy}/><Button className="primary full" onClick={queryWatch} disabled={!!busy}>{busy?<LoaderCircle className="spin" size={17}/>:null}查询主网余额</Button></>:<>
 <label className="field-label" htmlFor="expected">已有钱包的收款地址</label><Input id="expected" className="address-input" value={expectedAddress} onChange={e=>setExpectedAddress(e.target.value)} placeholder="从官方钱包「接收」页面复制完整地址" autoComplete="off" disabled={!!busy}/><p className="micro">导入后必须与此地址完全一致，才会开放转账。</p>
 <label className="field-label" htmlFor="phrase">助记词</label><Textarea id="phrase" ref={phraseInput} className="seed-input" placeholder="在这里输入你的助记词，以空格分隔" autoComplete="off" autoCorrect="off" spellCheck={false} disabled={!!busy} data-1p-ignore data-lpignore="true"/><p className="micro">不会保存到浏览器存储。关闭钱包后需要重新输入。</p>
 <div className="import-options"><div><label className="field-label" htmlFor="signature-scheme">签名方案</label><Input id="signature-scheme" value="ML-DSA-65（新版账户）" readOnly/></div><div><label className="field-label" htmlFor="account-index">账户序号</label><Input id="account-index" type="text" inputMode="numeric" value={index} onChange={e=>setIndex(e.target.value)} disabled={!!busy}/></div></div><p className="micro">仅支持 ML-DSA-65 新版账户，第一个账户序号通常为 0。地址不匹配时，请检查助记词、收款地址及账户序号。本工具不支持额外 BIP39 密码及自定义派生路径。</p><Button className="primary full" onClick={openWallet} disabled={!!busy}>{busy?<><LoaderCircle className="spin" size={17}/>正在本地验证</>:'验证地址并打开钱包'}</Button></>}
 </DialogContent></Dialog>
 <Dialog open={!!prepared} onOpenChange={open=>{if(!open&&!busy){setPrepared(null);setAck(false);}}}><DialogContent showCloseButton={!busy} className="review-dialog" onEscapeKeyDown={e=>{if(busy)e.preventDefault();}} onPointerDownOutside={e=>{if(busy)e.preventDefault();}}><DialogHeader><DialogTitle>请核对这笔转账</DialogTitle><DialogDescription>这是普通转账，成功入块后不能通过本工具撤销。</DialogDescription></DialogHeader>{prepared&&<><div className="receipt-amount">{formatAmount(prepared.amount)} <span>QTC</span></div><dl className="review-details"><dt>收款地址</dt><dd>{prepared.to}</dd><dt>付款地址</dt><dd>{prepared.from}</dd><dt>服务费（0.5%，额外收取）</dt><dd>{formatAmount(prepared.serviceFee)} QTC</dd><dt>服务费收款地址</dt><dd>{prepared.serviceFeeAddress}</dd><dt>预计网络手续费</dt><dd>{formatAmount(prepared.fee)} QTC</dd><dt>预留手续费（估算 + 10%）</dt><dd>{formatAmount(prepared.maxFee)} QTC</dd><dt>预计总支出（到账金额 + 服务费 + 网络费）</dt><dd>{formatAmount(transferDebit(prepared.amount)+prepared.fee)} QTC</dd><dt>余额至少需预留（含网络费缓冲）</dt><dd>{formatAmount(transferDebit(prepared.amount)+prepared.maxFee)} QTC，另保留账户最低余额</dd><dt>网络</dt><dd>Quantus Mainnet</dd></dl><p className="micro">服务费按到账金额的 0.5% 计算，向上取整至最小单位。实际网络费由入块时状态计算。转账或收费失败时两者均回滚，网络费可能仍扣除。预览 2 分钟后失效。</p><label className="confirmation"><Checkbox checked={ack} onCheckedChange={v=>setAck(v===true)} disabled={!!busy}/><span>我已核对收款地址、到账金额，并同意支付上述 0.5% 服务费及网络手续费。</span></label><Button className="primary full" disabled={!ack||!!busy} onClick={send}>{busy?<><LoaderCircle size={18} className="spin"/>正在核对、签名并提交</>:<>确认签名并发送 <ArrowUpRight size={18}/></>}</Button></>}</DialogContent></Dialog>
 </div>;
}

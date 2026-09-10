import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, CheckCircle2, LoaderCircle, RefreshCw } from 'lucide-react';
import { t, useLanguage, locale } from '@/lib/i18n';
import { formatAmount } from '@/lib/quantus/protocol';
import type { EncryptedWallet, ProofProgress } from '@/lib/wormhole/client';
import type { WormholeBalanceSnapshot } from '@/lib/wormhole/data';
import { prepareWormholeWithdrawal, summarizeWormholeSelection, bindWormholeProof, submitWormholeWithdrawalOnce, WormholeRpc, WORMHOLE_QUANTUM, type PreparedWormholeWithdrawal, type WormholeWithdrawalReceipt } from '@/lib/wormhole/withdraw';
import { trackWormholeWithdrawal } from '@/lib/wormhole/withdraw-tracking';
import { assertNoPendingWithdrawal, saveWithdrawal, readWithdrawalHistory, readWithdrawalPending, WORMHOLE_HISTORY_PREFIX, withdrawalComplete } from '@/lib/wormhole/records';

interface Props {wallet:EncryptedWallet|null;snapshot:WormholeBalanceSnapshot|null;onLock:()=>void;onBusyChange:(busy:boolean)=>void;onContinue:(address:string,index:number)=>void}
const errorMessage=(e:unknown)=>e instanceof Error?e.message:'本地加密账户操作失败。';
const short=(s:string)=>s.slice(0,10)+'…'+s.slice(-8);
const status=(r:WormholeWithdrawalReceipt)=>({submitting:'提交中',submitted:'等待入块',included:r.execution==='failed'?'执行失败，等待确认':'已入块，等待确认',finalized:'已最终确认',failed:'未成功',unknown:'待查询',expired:'已过期'})[r.phase];
const amounts=(p:bigint|string)=>formatAmount(BigInt(p));
export function EncryptedWithdrawal({wallet,snapshot,onLock,onBusyChange,onContinue}:Props) {
  useLanguage();
  const [index,setIndex]=useState('0');const [self,setSelf]=useState('');
  const [selected,setSelected]=useState<string[]>([]);
  const [prepared,setPrepared]=useState<PreparedWormholeWithdrawal|null>(null);
  const [ack,setAck]=useState(false);const [busy,setBusy]=useState('');
  const [error,setError]=useState('');const [storageWarning,setStorageWarning]=useState('');
  const [progress,setProgress]=useState<ProofProgress|null>(null);
  const [receipt,setReceipt]=useState<WormholeWithdrawalReceipt|null>(null);
  const [history,setHistory]=useState<WormholeWithdrawalReceipt[]>([]);
  const [tracking,setTracking]=useState(false);const [verifiedFinal,setVerifiedFinal]=useState(false);
  const [showAll,setShowAll]=useState(false);const [historyLimit,setHistoryLimit]=useState(10);
  const operation=useRef<AbortController|null>(null);const tracker=useRef<AbortController|null>(null);
  const walletRef=useRef(wallet);walletRef.current=wallet;
  const phaseRef=useRef('');const mounted=useRef(true);
  const update=useCallback((r:WormholeWithdrawalReceipt,strict=false)=>{
    // The submitting notification must persist successfully before the RPC is sent.
    if(strict)saveWithdrawal(r);else try{saveWithdrawal(r);}catch(e){if(mounted.current)setStorageWarning(errorMessage(e));}
    if(!mounted.current)return;
    setReceipt(r);setHistory(old=>[r,...old.filter(x=>x.hash!==r.hash)].sort((a,b)=>b.createdAt-a.createdAt));
  },[]);
  const query=useCallback(async(r:WormholeWithdrawalReceipt)=>{
    if(tracker.current)return;
    const controller=new AbortController();tracker.current=controller;
    setTracking(true);setVerifiedFinal(false);setError('');
    const checking:WormholeWithdrawalReceipt={...r,phase:'unknown',execution:undefined,finalizedHeight:undefined,message:'正在按原交易哈希重新核对链上结果。'};
    update(checking);
    try {
      const result=await trackWormholeWithdrawal(new WormholeRpc({endpoint:r.endpoint,signal:controller.signal}),checking,next=>{if(!controller.signal.aborted)update(next);},controller.signal);
      if(!controller.signal.aborted&&mounted.current)setVerifiedFinal(result.phase==='finalized'&&result.execution==='success');
    } catch(e){if(!controller.signal.aborted&&mounted.current)setError(errorMessage(e));}
    finally{if(tracker.current===controller){tracker.current=null;if(mounted.current)setTracking(false);}}
  },[update]);
  useEffect(()=>{
    mounted.current=true;
    const saved=readWithdrawalHistory();setHistory(saved.records);
    if(!saved.available)setStorageWarning('浏览器存储不可用，不能安全记录加密转出。');
    const pending=readWithdrawalPending();const resume=pending??saved.records.find(r=>!withdrawalComplete(r));
    if(resume)void query(resume);
    const changed=(event:StorageEvent)=>{if(event.key===null||event.key.startsWith(WORMHOLE_HISTORY_PREFIX)){const latest=readWithdrawalHistory();setHistory(latest.records);}};
    window.addEventListener('storage',changed);
    return()=>{mounted.current=false;operation.current?.abort();tracker.current?.abort();tracker.current=null;window.removeEventListener('storage',changed);};
  },[query]);
  useEffect(()=>{
    setPrepared(null);setAck(false);setSelf('');
    if(phaseRef.current!=='submit')operation.current?.abort();
    setSelected(snapshot?[...snapshot.utxos].filter(u=>u.amountPlanck>=WORMHOLE_QUANTUM).sort((a,b)=>a.amountPlanck>b.amountPlanck?-1:a.amountPlanck<b.amountPlanck?1:0).slice(0,7).map(u=>u.id):[]);
  },[wallet,snapshot]);
  const working=(stage:string)=>{phaseRef.current=stage;setBusy(stage);onBusyChange(!!stage);};
  function invalidate(){setPrepared(null);setAck(false);setError('');}
  async function derive(){
    if(!wallet||operation.current)return;
    const local=wallet;const controller=new AbortController();operation.current=controller;working('derive');invalidate();
    try {
      if(!/^\d{1,6}$/.test(index)||Number(index)>999999)throw new Error('账户序号须在 0–999999 之间。');
      const normal=await local.normal(Number(index));
      if(!controller.signal.aborted&&walletRef.current===local)setSelf(normal.address);
    }catch(e){if(!controller.signal.aborted)setError(errorMessage(e));}
    finally{if(operation.current===controller){operation.current=null;working('');}}
  }
  async function preview(){
    if(!wallet||!snapshot||!self||operation.current)return;
    const local=wallet;const controller=new AbortController();operation.current=controller;working('prepare');invalidate();
    try {
      const p=await prepareWormholeWithdrawal({snapshot,selectedIds:selected,selfAddress:self,normalAccountIndex:Number(index),signal:controller.signal,computeNullifiers:inputs=>local.computeNullifiers(inputs),checkProofRequest:request=>local.check(request)});
      if(!controller.signal.aborted&&walletRef.current===local){assertNoPendingWithdrawal({selfAddress:self,nullifiers:p.realNullifiers});setPrepared(p);}
    }catch(e){if(!controller.signal.aborted)setError(errorMessage(e));}
    finally{if(operation.current===controller){operation.current=null;working('');}}
  }
  async function confirm(){
    if(!wallet||!prepared||!ack||operation.current)return;
    const local=wallet;const p=prepared;const controller=new AbortController();operation.current=controller;working('proof');setError('');setProgress(null);
    let broadcastStarted=false;
    try {
      if(!navigator.locks)throw new Error('此浏览器不支持安全的多标签页转出锁。请使用最新版 Chrome 或 Safari。');
      await navigator.locks.request('qtc-wormhole-withdrawal-v1',{mode:'exclusive',ifAvailable:true},async lock=>{
        if(!lock)throw new Error('另一个标签页正在处理加密转出，请等待其完成。');
        const current=()=>{if(controller.signal.aborted||walletRef.current!==local)throw new Error('钱包已锁定，请重新打开。');};
        current();assertNoPendingWithdrawal({selfAddress:p.proofRequest.expectedNormalAddress,nullifiers:p.realNullifiers});
        const proof=await local.prove(p.proofRequest,next=>{if(!controller.signal.aborted)setProgress(next);});
        current();const ready=bindWormholeProof(p,proof);
        assertNoPendingWithdrawal({selfAddress:p.proofRequest.expectedNormalAddress,nullifiers:p.realNullifiers});
        working('submit');
        const submitted=await submitWormholeWithdrawalOnce(ready,r=>{
          if(r.phase==='submitting'){current();update(r,true);broadcastStarted=true;setPrepared(null);setAck(false);}
          else update(r);
        },{signal:controller.signal});
        setVerifiedFinal(false);onLock();
        void query(submitted);
      });
    }catch(e){
      if(mounted.current&&(!controller.signal.aborted||broadcastStarted))setError(errorMessage(e));
      setPrepared(null);setAck(false);
    }finally{if(operation.current===controller){operation.current=null;working('');setProgress(null);}}
  }
  function cancel(){if(phaseRef.current==='submit')return;operation.current?.abort();onLock();setPrepared(null);setAck(false);setError('已停止本地操作并锁定钱包，尚未提交新交易。');}
  let summary:ReturnType<typeof summarizeWormholeSelection>|null=null;
  try{if(snapshot&&selected.length)summary=summarizeWormholeSelection(snapshot.utxos,selected);}catch{/* Invalid selection has no preview. */}
  const selection=prepared?.selection;
  const unresolved=receipt&&!withdrawalComplete(receipt);
  const ordered=snapshot?[...snapshot.utxos].sort((a,b)=>a.amountPlanck>b.amountPlanck?-1:a.amountPlanck<b.amountPlanck?1:0):[];
  const visible=showAll?ordered:[...ordered.filter(u=>selected.includes(u.id)),...ordered.filter(u=>!selected.includes(u.id))].slice(0,20);
  return <section className="encrypted-withdrawal" aria-label={t('加密账户转出')}>
    <div className="withdraw-heading"><span className="step-badge">1</span><div><h2>{t('转到本人普通账户')}</h2><p>{t('先退出加密账户，确认到账后再进行普通转账。')}</p></div></div>
    <p className="notice">{t('第一步不收本站服务费，仅扣除链上 Wormhole 费用和量化零头。第二步普通转账另收 0.5% 服务费及网络费，需再次确认。')}</p>
    {error&&<p className="notice error" role="alert">{t(error)}</p>}
    {storageWarning&&<p className="notice error" role="alert">{t(storageWarning)}</p>}
    {wallet&&snapshot?<>
      <div className="withdraw-destination"><div><label className="field-label" htmlFor="withdraw-index">{t('本人普通账户序号（ML-DSA-65）')}</label><input id="withdraw-index" inputMode="numeric" value={index} disabled={!!busy||!!unresolved} onChange={e=>{setIndex(e.target.value);setSelf('');invalidate();}}/></div><button className="secondary" disabled={!!busy||!!unresolved} onClick={()=>void derive()}>{busy==='derive'?<LoaderCircle className="spin" size={16}/>:null}{t('派生并核对本人地址')}</button></div>
      {self&&<><label className="field-label">{t('本次到账的普通账户地址')}</label><code className="withdraw-address">{self}</code><p className="micro">{t('地址由同一助记词在本地派生，不可改为他人地址。第一步完成后会锁定钱包；第二步需重新输入助记词打开这个普通账户。')}</p></>}
      <div className="withdraw-selection-title"><h3>{t('选择本次转出的入账记录')}</h3><span>{selected.length} / 7</span></div>
      <p className="micro">{t('每次最多选择 7 笔，所选记录扣费后全部转出，不保留找零；未选记录继续留在加密账户。每笔不足 0.01 QTC 的零头会被舍弃。')}</p>
      {!snapshot.utxos.length?<p className="subtle">{t('没有可选的未花费入账记录。')}</p>:<div className="withdraw-inputs">{visible.map(u=><label key={u.id} className="withdraw-input"><input type="checkbox" checked={selected.includes(u.id)} disabled={!!busy||!!unresolved||u.amountPlanck<WORMHOLE_QUANTUM||!selected.includes(u.id)&&selected.length>=7} onChange={e=>{setSelected(old=>e.target.checked?[...old,u.id]:old.filter(id=>id!==u.id));invalidate();}}/><span><strong>{amounts(u.amountPlanck)} QTC</strong><small>{t('区块')} {u.blockHeight.toLocaleString(locale())} · {t(u.branch===0?'收款':'找零')} #{u.index} · {short(u.address)}</small></span></label>)}</div>}
      {snapshot.utxos.length>20&&<button className="text-button" onClick={()=>setShowAll(v=>!v)}>{t(showAll?'收起记录':'显示全部记录')}</button>}
      {summary&&<dl className="encrypted-stats"><div><dt>{t('所选总额')}</dt><dd>{amounts(summary.inputPlanck)} QTC</dd></div><div><dt>{t('未选记录余额')}</dt><dd>{amounts(summary.remainingPlanck)} QTC</dd></div></dl>}
      {!prepared&&<button className="primary" disabled={!!busy||!!unresolved||!self||!summary} onClick={()=>void preview()}>{busy==='prepare'?<LoaderCircle className="spin" size={16}/>:null}{t('查询链上费用并预览')}</button>}
      {prepared&&selection&&<div className="withdraw-review"><h3>{t('确认第一步转出')}</h3><code className="withdraw-address">{prepared.proofRequest.expectedNormalAddress}</code><dl className="encrypted-stats"><div><dt>{t('所选总额')}</dt><dd>{amounts(selection.inputPlanck)} QTC</dd></div><div><dt>{t('Wormhole 链上费用（含量化取整）')}</dt><dd>{amounts(selection.volumeFeePlanck)} QTC</dd></div><div><dt>{t('入账记录零头损失')}</dt><dd>{amounts(selection.quantumDustPlanck)} QTC</dd></div><div><dt>{t('第一步本站服务费')}</dt><dd>0 QTC</dd></div><div className="withdraw-net"><dt>{t('本人普通账户实际到账')}</dt><dd>{amounts(selection.netToSelfPlanck)} QTC</dd></div></dl>
        <p className="micro">{t('链上费率为 {0}%，按 0.01 QTC 量化取整，因此小额转出的实际费率可能更高。',prepared.context.volumeFeeBps/100)}</p>
        <label className="encrypted-consent"><input type="checkbox" checked={ack} disabled={!!busy} onChange={e=>setAck(e.target.checked)}/><span>{t('我已核对本人普通账户地址、实际到账金额及零头损失。我了解证明仅在本机生成，可能使用约 1 GB 内存，请保持页面打开；不会自动开始第二步转账。')}</span></label>
        <button className="primary" disabled={!!busy||!ack||!!unresolved} onClick={()=>void confirm()}>{busy==='proof'||busy==='submit'?<LoaderCircle className="spin" size={16}/>:<ArrowRight size={16}/>} {t(busy==='submit'?'正在提交':busy==='proof'?'正在本地生成证明':'确认并生成证明，提交第一步')}</button>
        {!busy&&<button className="text-button" onClick={()=>{setPrepared(null);setAck(false);}}>{t('返回修改')}</button>}
      </div>}
      {busy&&<p className="micro" role="status">{t(busy==='proof'?(progress?.stage==='aggregate'?'正在本地聚合并验证证明…':'正在本地生成并验证零知识证明…'):busy==='submit'?'正在提交主网交易。':'正在核对链上数据…')} {progress?.completed!==undefined?`${progress.completed} / ${progress.total??7}`:''}</p>}
      {busy&&busy!=='submit'&&<button className="secondary" onClick={cancel}>{t('取消并锁定钱包')}</button>}
    </>:<p className="subtle">{t('恢复并扫描加密账户后，可以选择记录并预览转出。')}</p>}
    {receipt&&<div className="withdraw-receipt" aria-live="polite"><div className="withdraw-heading">{verifiedFinal?<CheckCircle2 size={22}/>:<RefreshCw size={20} className={tracking?'spin':''}/>}<h3>{t(status(receipt))}</h3></div><p>{t(receipt.message)}</p><dl className="encrypted-stats"><div><dt>{t(verifiedFinal?'本人普通账户实际到账':'本次计划到账（以链上结果为准）')}</dt><dd>{amounts(receipt.netToSelfPlanck)} QTC</dd></div></dl><label className="field-label">{t('本次到账的普通账户地址')}</label><code className="withdraw-address">{receipt.selfAddress}</code><label className="field-label">{t('交易哈希')}</label><code className="withdraw-address">{receipt.hash}</code><p className="micro">{t('提交后锁定钱包不会撤销交易。结果不确定时只查询这笔交易，请勿在其他设备重复转出相同记录。')}</p>
      <div className="encrypted-actions"><button className="secondary" disabled={tracking||!!busy} onClick={()=>void query(receipt)}>{tracking?<LoaderCircle className="spin" size={16}/>:<RefreshCw size={16}/>} {t('继续查询这笔交易')}</button>{verifiedFinal&&<button className="primary" disabled={!!busy} onClick={()=>{onLock();onContinue(receipt.selfAddress,receipt.normalAccountIndex);}}>{t('第二步：打开普通账户转账')} <ArrowRight size={16}/></button>}</div><a className="quiet-link" href={'https://explorer.quantus.com/accounts/'+encodeURIComponent(receipt.selfAddress)} target="_blank" rel="noopener noreferrer">{t('在区块浏览器查看账户')} <ArrowUpRight size={14}/></a>
    </div>}
    <details className="encrypted-details"><summary>{t('本地加密转出记录')} ({history.length})</summary><p className="micro">{t('仅在此浏览器保存公开交易记录。清除网站数据或更换设备会丢失记录；请保留交易哈希，并通过区块浏览器查询。助记词与证明秘密不会保存。')}</p>{history.slice(0,historyLimit).map(r=><div className="withdraw-history-row" key={r.hash}><span><strong>{amounts(r.netToSelfPlanck)} QTC</strong><small>{new Date(r.createdAt).toLocaleString(locale(),{hour12:false})} · {t(status(r))}</small><code>{short(r.hash)}</code></span><button className="secondary" disabled={tracking||!!busy} onClick={()=>void query(r)}>{t('查询')}</button></div>)}{history.length>historyLimit&&<button className="secondary" onClick={()=>setHistoryLimit(n=>n+10)}>{t('查看更多（已显示')}{historyLimit} / {history.length} {t('笔）')}</button>}</details>
  </section>;
}

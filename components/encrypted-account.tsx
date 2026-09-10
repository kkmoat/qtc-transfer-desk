import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, Copy, LockKeyhole, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { t, useLanguage, locale } from '@/lib/i18n';
import { EncryptedWallet } from '@/lib/wormhole/client';
import { scanWormholeBalance, type WormholeBalanceSnapshot, type WormholeScanProgress } from '@/lib/wormhole/data';
import { addressBytes, formatAmount } from '@/lib/quantus/protocol';
const explorer = (address:string) => 'https://explorer.quantus.com/accounts/'+encodeURIComponent(address);
export function EncryptedAccount({active,onUnlock}:{active:boolean;onUnlock:()=>void}) {
  useLanguage();
  const [expected,setExpected] = useState('');
  const [consent,setConsent] = useState(false);
  const [opened,setOpened] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState('');
  const [note,setNote] = useState('');
  const [copied,setCopied] = useState('');
  const [progress,setProgress] = useState<WormholeScanProgress|null>(null);
  const [balance,setBalance] = useState<WormholeBalanceSnapshot|null>(null);
  const [receive,setReceive] = useState('');
  const [showAddresses,setShowAddresses] = useState(false);
  const phrase = useRef<HTMLTextAreaElement>(null);
  const wallet = useRef<EncryptedWallet|null>(null);
  const scan = useRef<AbortController|null>(null);
  const generation = useRef(0);
  const lock = useCallback(() => {
    generation.current++;
    scan.current?.abort(); scan.current=null;
    wallet.current?.close(); wallet.current=null;
    if(phrase.current)phrase.current.value='';
    setOpened(false); setBusy(false); setProgress(null); setBalance(null); setReceive('');setShowAddresses(false);
  },[]);
  useEffect(()=>{if(!active)lock();},[active,lock]);
  useEffect(()=>{
    const hide=()=>lock(); window.addEventListener('pagehide',hide);
    return()=>{window.removeEventListener('pagehide',hide);generation.current++;scan.current?.abort();wallet.current?.close();};
  },[lock]);
  useEffect(()=>{
    if(!opened)return;
    let timer:ReturnType<typeof setTimeout>;
    const reset=()=>{clearTimeout(timer);timer=setTimeout(()=>{lock();setNote('长时间未操作，钱包已自动锁定。');},5*60_000);};
    reset();window.addEventListener('pointerdown',reset);window.addEventListener('keydown',reset);
    return()=>{clearTimeout(timer);window.removeEventListener('pointerdown',reset);window.removeEventListener('keydown',reset);};
  },[opened,lock]);
  async function restore(existing=false) {
    if(scan.current)return;
    setError('');setNote('');setBalance(null);setReceive('');
    let local=wallet.current;
    let words='';
    let controller:AbortController|null=null;
    let current=()=>false;
    try {
      const address=expected.trim();addressBytes(address);
      if(!existing){
        if(!consent)throw new Error('请先阅读并同意公开地址查询说明。');
        words=(phrase.current?.value??'').trim().normalize('NFKD').replace(/\s+/g,' ');
        if(phrase.current)phrase.current.value='';
        if(![12,15,18,21,24].includes(words.split(' ').length))throw new Error('请填写完整助记词。');
        lock();onUnlock();local=new EncryptedWallet(reason=>{if(wallet.current===local){lock();setError(reason);}});wallet.current=local;
      }
      if(!local)throw new Error('钱包已锁定，请重新打开。');
      const epoch=generation.current;
      controller=new AbortController();scan.current=controller;
      const abortSignal=controller.signal;
      current=()=>generation.current===epoch&&wallet.current===local&&!abortSignal.aborted;
      setBusy(true);setProgress({stage:'network'});
      if(!existing){const opening=local.open(words);words='';await opening;if(!current())return;setOpened(true);}
      const result=await scanWormholeBalance({deriveAddresses:(branch,start,count)=>local!.deriveAddresses(branch,start,count),computeNullifiers:inputs=>local!.computeNullifiers(inputs),signal:abortSignal,onProgress:p=>{if(current())setProgress(p);}});
      if(!current())return;
      if(!result.addresses.some(item=>item.address===address))throw new Error('扫描范围内未找到你填写的加密收款地址。请核对助记词与官方钱包的 Encrypted Account 接收地址；不会改用普通账户。');
      const [next]=await local.deriveAddresses(0,result.branches[0].nextIndex,1);
      if(!current())return;
      setBalance(result);setReceive(next);setNote('已恢复加密账户，收款地址归属已核对。');
    } catch(e) {
      if(current()||!controller){setError(e instanceof Error?e.message:'本地加密账户操作失败。');if(!existing)lock();}
    } finally {words='';if(scan.current===controller){scan.current=null;setBusy(false);setProgress(null);}}
  }
  async function copy(value:string){try{await navigator.clipboard.writeText(value);setCopied(value);}catch{setError('无法自动复制，请手动选中复制。');}}
  const progressText=progress?.stage==='network'?'正在核对主网与索引器…':progress?.stage==='addresses'?'正在扫描收款和找零地址…':progress?.stage==='transfers'?'正在核对转入记录…':'正在核对已花费标记…';
  return <section className="encrypted-account" aria-label={t('加密账户')}>
    <div className="encrypted-intro"><LockKeyhole size={22}/><div><h2>{t('Encrypted Account · 加密账户')}</h2><p>{t('使用与官方钱包相同的助记词，自动恢复收款和找零地址，无需填写普通账户序号。')}</p></div></div>
    <div className="notice"><ShieldCheck size={18}/><span>{t('此入口支持本地恢复、收款地址和余额查询。加密账户转出需要独立的零知识证明；浏览器转出尚未开放，请通过官方钱包发送。')}</span></div>
    {error&&<p className="notice error" role="alert">{t(error)}</p>}
    {note&&<p className="notice" role="status">{t(note)}</p>}
    <div className="encrypted-grid"><section className="encrypted-card">
      <h3>{t(opened?'加密账户已在本地打开':'恢复已有加密账户')}</h3>
      <label className="field-label" htmlFor="encrypted-expected">{t('官方钱包的加密收款地址')}</label>
      <input id="encrypted-expected" className="address-input" value={expected} onChange={e=>setExpected(e.target.value)} disabled={busy||opened} placeholder={t('在 Encrypted Account 的接收页面复制 qz… 地址')} autoComplete="off"/>
      {!opened&&<><label className="field-label" htmlFor="encrypted-phrase">{t('助记词')}</label><textarea id="encrypted-phrase" ref={phrase} className="seed-input" placeholder={t('在这里输入你的助记词，以空格分隔')} disabled={busy} autoComplete="off" autoCorrect="off" spellCheck={false} data-1p-ignore data-lpignore="true"/><p className="micro">{t('助记词和加密秘密仅在本地 Worker 中处理，不保存到浏览器存储。不支持额外 BIP39 密码。')}</p>
      <label className="encrypted-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)} disabled={busy}/><span>{t('我了解：查询会向 Quantus 官方索引器发送派生的公开地址，向官方节点查询花费标记；服务方可能关联这些请求与我的 IP。助记词不会发送。')}</span></label></>}
      <div className="encrypted-actions">{!opened?<button className="primary full" type="button" disabled={busy||!consent||!expected.trim()} onClick={()=>void restore()}>{busy?<LoaderCircle size={17} className="spin"/>:<LockKeyhole size={17}/>} {t(busy?'正在本地恢复':'恢复并扫描加密账户')}</button>:<button className="secondary full" type="button" disabled={busy} onClick={()=>void restore(true)}><RefreshCw size={16}/> {t('重新扫描余额')}</button>}
      {(opened||busy)&&<button className="secondary full" type="button" onClick={()=>{lock();setNote('钱包已锁定。');}}>{t(busy?'停止扫描并锁定':'锁定钱包')}</button>}</div>
      {busy&&<p className="micro" role="status">{t(progressText)} {progress?.scannedCount??progress?.transferCount??''}</p>}
      <p className="micro">{t('5 分钟未操作、离开加密账户页面或关闭网页时会锁定。语言切换不会改变账户。')}</p>
    </section><section className="encrypted-card">
      <span className="balance-label">{t('已核对的加密余额（费用与零头扣除前）')}</span>
      <div className="balance-number">{balance?formatAmount(balance.balancePlanck):'—'}<span>QTC</span></div>
      {!balance?<p className="subtle">{t('先恢复并完成扫描。查询失败或数据不完整时不显示为 0。')}</p>:<>
        <p className="micro">{t('最终确认区块上的余额，近期转入和转出可能尚未反映。此数值不能视为当前可转出的金额。')}</p><dl className="encrypted-stats"><div><dt>{t('最终确认区块')}</dt><dd>{balance.snapshot.blockHeight.toLocaleString(locale())}</dd></div><div><dt>{t('未花费转入记录')}</dt><dd>{balance.utxos.length}</dd></div><div><dt>{t('已扫描地址')}</dt><dd>{balance.addresses.length}</dd></div><div><dt>{t('查询时间')}</dt><dd>{new Date(balance.snapshot.checkedAt).toLocaleString(locale(),{hour12:false})}</dd></div></dl>
        <label className="field-label">{t('下一个加密收款地址')}</label><div className="encrypted-address"><code>{receive}</code><button type="button" aria-label={t('复制加密收款地址')} onClick={()=>void copy(receive)}>{copied===receive?<Check size={16}/>:<Copy size={16}/>}</button></div>
        <p className="micro">{t('复制前请与官方钱包核对。新收款或其他设备转出后，请重新扫描。')}</p>
        <a className="quiet-link" href={explorer(receive)} target="_blank" rel="noopener noreferrer">{t('在区块浏览器查看账户')} <ArrowUpRight size={15}/></a>
        <button type="button" className="text-button" onClick={()=>setShowAddresses(v=>!v)}>{t(showAddresses?'收起派生地址':'查看已扫描的派生地址')}</button>
        {showAddresses&&<ul className="encrypted-addresses">{balance.addresses.map(item=><li key={`${item.branch}-${item.index}`}><span>{t(item.branch===0?'收款':'找零')} #{item.index}</span><code>{item.address}</code></li>)}</ul>}
      </>}
      <p className="micro">{t('余额合并收款与找零两个序列的未花费记录，不等于某一个地址的普通余额。按每个分支连续 20 个未使用地址停止发现；跳过更大空隙的自定义账户可能无法恢复。')}</p>
    </section></div>
    <details className="encrypted-details"><summary>{t('恢复规则与支持范围')}</summary><p>{t('与官方 Encrypted Account 路径一致：收款 m/44\'/189189189\'/0\'/0\'/n\'，找零 m/44\'/189189189\'/0\'/1\'/n\'。默认每个分支最多扫描 1000 个地址；达到上限或索引记录缺失会停止并提示，不展示不完整余额。')}</p><p>{t('此处不收取查询费用，不签名、不广播交易。当前加密账户转出请使用官方 Quantus 钱包；普通账户转账功能不适用于该账户。')}</p><a href="https://docs.quantus.com/deep-dives/wormhole/" target="_blank" rel="noopener noreferrer">{t('了解官方 Wormhole 机制')} <ArrowUpRight size={14}/></a></details>
  </section>;
}

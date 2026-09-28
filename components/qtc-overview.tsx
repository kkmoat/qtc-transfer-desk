import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,ChartNoAxesCombined,RefreshCw,TriangleAlert} from 'lucide-react';
import {t,useLanguage,locale} from '@/lib/i18n';
import {fetchSupplySnapshot,formatSupply,MAX_SUPPLY_PLANCK,SUPPLY_SOURCE,OVERVIEW_MAX_AGE_MS,type SupplySnapshot} from '@/lib/overview/supply';
import {fetchPriceSnapshot,type PriceSnapshot} from '@/lib/overview/price';
import {CEX_HOLDER_ADDRESS,fetchHoldersSummary,PROJECT_HOLDER_ADDRESS,QUANPOOL_HOLDER_ADDRESS,type HoldersSummarySnapshot} from '@/lib/holders';
import {valuationCents,formatValuation} from '@/lib/overview/valuation';
const number=(n:number,digits=3)=>n.toLocaleString(locale(),{maximumFractionDigits:digits});
const qtc=(n:bigint|undefined)=>n===undefined?'—':formatSupply(n,locale());
const when=(n:number)=>new Date(n).toLocaleString(locale(),{hour12:false});
const marketNumber=(value:string|null|undefined)=>value==null?'—':number(Number(value),8);

export function QtcOverview({active}:{active:boolean}){
 useLanguage();
 const [supply,setSupply]=useState<SupplySnapshot|null>(null),[price,setPrice]=useState<PriceSnapshot|null>(null);
 const [holders,setHolders]=useState<HoldersSummarySnapshot|null>(null);
 const [supplyError,setSupplyError]=useState(''),[priceError,setPriceError]=useState(''),[holdersError,setHoldersError]=useState(''),[loading,setLoading]=useState(false),[now,setNow]=useState(Date.now());
 const request=useRef<AbortController|null>(null);
 async function refresh(){
  if(request.current)return;
  const controller=new AbortController();request.current=controller;setLoading(true);
  const update=async<T,>(get:(signal:AbortSignal)=>Promise<T>,set:(value:T)=>void,error:(value:string)=>void)=>{
   try{const data=await get(controller.signal);if(!controller.signal.aborted){set(data);error('');setNow(Date.now());}}
   catch(e){if(!controller.signal.aborted)error(e instanceof Error?e.message:'数据暂不可用，请稍后刷新。');}
  };
  await Promise.all([
   update(fetchSupplySnapshot,setSupply,setSupplyError),
   update(fetchPriceSnapshot,setPrice,setPriceError),
   update(fetchHoldersSummary,setHolders,setHoldersError),
  ]);
  if(request.current===controller){request.current=null;setLoading(false);}
 }
 useEffect(()=>{
  if(!active)return;void refresh();
  const interval=setInterval(()=>{setNow(Date.now());if(document.visibilityState==='visible')void refresh();},60_000);
  const tick=setInterval(()=>setNow(Date.now()),10_000);
  const visible=()=>{if(document.visibilityState==='visible'){setNow(Date.now());void refresh();}};
  document.addEventListener('visibilitychange',visible);
  return()=>{clearInterval(interval);clearInterval(tick);document.removeEventListener('visibilitychange',visible);request.current?.abort();request.current=null;setLoading(false);};
 },[active]);
 const supplyOld=!!supply&&(!!supplyError||Math.max(now,Date.now())-supply.fetchedAt>OVERVIEW_MAX_AGE_MS);
 const priceOld=!!price&&(!!priceError||Math.max(now,Date.now())-price.fetchedAt>OVERVIEW_MAX_AGE_MS);
 const holdersOld=!!holders&&(!!holdersError||Math.max(now,Date.now())-holders.sourceTime>OVERVIEW_MAX_AGE_MS);
 const mc=valuationCents(holders?.totalBalancePlanck,price?.last),fdv=valuationCents(MAX_SUPPLY_PLANCK,price?.last);
 const excludingProjectMc=valuationCents(holders?.excludingProjectPlanck,price?.last);
 const excludingProjectFdv=valuationCents(holders?MAX_SUPPLY_PLANCK-holders.projectBalancePlanck:undefined,price?.last);
 const issuedPercent=supply?Number(supply.totalPlanck*100_000n/MAX_SUPPLY_PLANCK)/1000:null;
 const top=(address:string)=>holders?.topAccounts.find(account=>account.address===address);
 const rank=(address:string)=>{const index=holders?.topAccounts.findIndex(account=>account.address===address)??-1;return index<0?'—':'#'+(index+1)};
 const topBalance=(address:string)=>{const account=top(address);return account?account.free+account.reserved:undefined;};
 const explorerAccount=(address:string)=>'https://explorer.quantus.com/accounts/'+encodeURIComponent(address);
 return <section className="overview" aria-label={t('QTC 总览')}>
  <div className="overview-toolbar"><span><ChartNoAxesCombined size={17}/>{t('公开数据 · 每分钟刷新')}</span><button onClick={()=>void refresh()} disabled={loading} className="overview-refresh"><RefreshCw size={16} className={loading?'spin':''}/>{loading?t('正在刷新…'):t('刷新数据')}</button></div>
  <div className="overview-supply-grid overview-valuation-grid">
   <article className="overview-card overview-circulating"><p className="overview-label">{t('当前流通量（地址余额合计）')}{holdersOld&&<span className="overview-status">{t('上次数据')}</span>}</p><strong className="overview-value">{qtc(holders?.totalBalancePlanck)} <small>QTC</small></strong><p className="overview-help">{t('官方区块浏览器统计的全部地址可用余额与预留余额合计。')}</p></article>
   <article className="overview-card"><p className="overview-label">{t('总流通市值 MC（估算）')}{mc!==null&&(holdersOld||priceOld)&&<span className="overview-status">{t('上次数据 · 非实时')}</span>}</p><strong className="overview-value">{formatValuation(mc,locale())} <small>USDT</small></strong><p className="overview-help">{t('地址余额合计 × 最近成交价。')}</p></article>
   <article className="overview-card"><p className="overview-label">{t('完全稀释估值 FDV')}{fdv!==null&&priceOld&&<span className="overview-status">{t('上次数据 · 非实时')}</span>}</p><strong className="overview-value">{formatValuation(fdv,locale())} <small>USDT</small></strong><p className="overview-help">{t('2,100 万枚供应上限 × 最近成交价。')}</p></article>
  </div>
  <div className="overview-data-note" aria-live="polite">{holdersError&&<p role="status">{t(holdersError)}</p>}{holders?<><p>{t('共汇总 {0} 个链上账户；冻结余额是可用余额中的限制部分，不重复相加。',holders.totalCount.toLocaleString(locale()))}{holdersOld&&<> · {t('上次数据')}</>}</p><p>{t('区块浏览器索引高度 #{0}（最终确认 #{1}）· 区块时间 {2}',holders.blockHeight.toLocaleString(locale()),holders.finalizedBlockHeight.toLocaleString(locale()),when(holders.sourceTime))}</p></>:<p>{loading?t('正在汇总持币地址余额…'):t('地址余额暂不可用，MC 不作推算。')}</p>}<p>{t('地址余额合计直接复现区块浏览器索引统计，可能与协议总发行量不同；其中包含项目方、矿池和交易所账户。')}</p></div>
  <div className="overview-supply-grid overview-valuation-grid overview-adjusted-grid">
   <article className="overview-card overview-adjusted"><p className="overview-label">{t('去除项目方后的流通量')}{holdersOld&&<span className="overview-status">{t('上次数据')}</span>}</p><strong className="overview-value">{qtc(holders?.excludingProjectPlanck)} <small>QTC</small></strong><p className="overview-help">{t('地址余额合计减去项目方锁仓资金池的实时余额。')}</p>{holders&&<p className="overview-foot">{t('已扣除项目方持有：{0} QTC',qtc(holders.projectBalancePlanck))}</p>}</article>
   <article className="overview-card"><p className="overview-label">{t('去除项目方后的 MC（估算）')}{excludingProjectMc!==null&&(holdersOld||priceOld)&&<span className="overview-status">{t('上次数据 · 非实时')}</span>}</p><strong className="overview-value">{formatValuation(excludingProjectMc,locale())} <small>USDT</small></strong><p className="overview-help">{t('去除项目方后的流通量 × 最近成交价。')}</p></article>
   <article className="overview-card"><p className="overview-label">{t('去除项目方后的 FDV（估算）')}{excludingProjectFdv!==null&&(holdersOld||priceOld)&&<span className="overview-status">{t('上次数据 · 非实时')}</span>}</p><strong className="overview-value">{formatValuation(excludingProjectFdv,locale())} <small>USDT</small></strong><p className="overview-help">{t('（供应上限 − 项目方地址余额）× 最近成交价。')}</p></article>
  </div>
  <div className="overview-holder-notes" aria-label={t('大额地址说明')}>
   <a href={explorerAccount(PROJECT_HOLDER_ADDRESS)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><strong>{rank(PROJECT_HOLDER_ADDRESS)} · {t('项目方锁仓资金池')}</strong><span>{holders?.projectLastUpdated===0?t('余额 {0} QTC；创世后未更新，按非流通量处理。',qtc(holders.projectBalancePlanck)):t('余额 {0} QTC；按非流通量处理。',qtc(holders?.projectBalancePlanck))}</span><ArrowUpRight size={14}/></a>
   <a href={explorerAccount(QUANPOOL_HOLDER_ADDRESS)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><strong>{rank(QUANPOOL_HOLDER_ADDRESS)} · {t('Quanpool 矿池')}</strong><span>{t('余额 {0} QTC；由多名矿工组成，并非单一持有者。',qtc(topBalance(QUANPOOL_HOLDER_ADDRESS)))}</span><ArrowUpRight size={14}/></a>
   <a href={explorerAccount(CEX_HOLDER_ADDRESS)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"><strong>{rank(CEX_HOLDER_ADDRESS)} · CEX</strong><span>{t('余额 {0} QTC；由交易所用户组成，并非单一用户持有。',qtc(topBalance(CEX_HOLDER_ADDRESS)))}</span><ArrowUpRight size={14}/></a>
  </div>
  <div className="overview-supply-grid">
   <article className="overview-card"><p className="overview-label">{t('总供应上限')}</p><strong className="overview-value">21,000,000 <small>QTC</small></strong><p className="overview-help">{t('官方货币政策规定的最大供应量。')}</p><a href={SUPPLY_SOURCE} target="_blank" rel="noopener noreferrer">{t('官方白皮书')}<ArrowUpRight size={14}/></a></article>
   <article className="overview-card"><p className="overview-label">{t('当前净发行量')}{supplyOld&&<span className="overview-status">{t('上次数据')}</span>}</p><strong className="overview-value">{qtc(supply?.totalPlanck)} <small>QTC</small></strong><p className="overview-help">{t('已发行、尚未销毁，包含创世分配与加密账户资金。')}</p>{supply&&<p className="overview-foot">{t('占供应上限 {0}%',number(issuedPercent!,3))}</p>}</article>
   <article className="overview-card"><p className="overview-label">{t('已挖出 · 净新增')}{supplyOld&&<span className="overview-status">{t('上次数据')}</span>}</p><strong className="overview-value">{qtc(supply?.minedNetPlanck)} <small>QTC</small></strong><p className="overview-help">{t('当前发行量减去创世发行量；受销毁影响，不等于累计矿工奖励。')}</p>{supply&&<p className="overview-foot">{t('创世发行：{0} QTC',qtc(supply.genesisPlanck))}</p>}</article>
  </div>
  <div className="overview-data-note" aria-live="polite">{supplyError&&<p role="status">{t(supplyError)}</p>}{supply?<><p>{t('最终确认区块 #{0} · 区块时间 {1}',number(supply.block,0),when(supply.blockTime))}</p><p>{t('读取时间 {0}，最终确认可能落后于最新出块。',when(supply.fetchedAt))}</p></>:<p>{loading&&!supplyError?t('正在读取官方主网…'):t('主网供应数据暂不可用。')}</p>}</div>
  <article className="overview-market-card">
   <div className="overview-market-heading"><div><p className="eyebrow">SAFETRADE / QUANTUS–USDT</p><h2>{t('市场参考价格')}</h2><p className="overview-help">{t('Quantus 在 SafeTrade 使用 QUANTUS 代码。')}</p></div><span className="overview-depth"><TriangleAlert size={16}/>{t('市场深度较小')}</span></div>
   <div className="overview-market-body"><div><p className="overview-label">{t('最近成交价')}{priceOld&&<span className="overview-status">{t('上次报价 · 非实时')}</span>}</p><strong className="overview-price">{marketNumber(price?.last)} <small>USDT</small></strong><p className="overview-help">{t('每 1 QUANTUS（QTC），以 USDT 计价。')}</p>{price?.change!=null&&<span className={price.change>=0?'overview-up':'overview-down'}>{price.change>0?'+':''}{number(price.change,2)}% <span>{t('24 小时')}</span></span>}</div>
    <dl className="overview-market-stats"><div><dt>{t('24h 最高 / 最低')}</dt><dd>{marketNumber(price?.high)} / {marketNumber(price?.low)} <small>USDT</small></dd></div><div><dt>{t('24h 成交额')}</dt><dd>{marketNumber(price?.volumeUsdt)} <small>USDT</small></dd></div><div><dt>{t('24h 成交量')}</dt><dd>{marketNumber(price?.amountQuantus)} <small>QUANTUS</small></dd></div></dl>
   </div>
   <p className="overview-warning">{t('市场深度较小，买卖价差和滑点可能较大。最近成交价仅供参考，不代表可按此价格买卖，也不等同于美元报价。')}</p>
   <div className="overview-market-footer"><div aria-live="polite">{priceError&&<p className="overview-feed-error">{t(priceError)}</p>}{price?<p>{t('报价获取时间：{0}；不是最近成交发生时间。',when(price.fetchedAt))}</p>:<p>{loading&&!priceError?t('正在连接 SafeTrade 公开行情…'):t('暂未取得可验证报价。')}</p>}</div></div>
  </article>
  <p className="overview-disclaimer">{t('本总览无需打开钱包，不发送钱包资料。供应来自官方主网，行情来自 SafeTrade 公开数据；接口受限时不显示猜测价格。')}</p>
 </section>;
}

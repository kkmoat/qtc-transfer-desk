import {useEffect,useRef,useState} from 'react';
import {fetchPriceSnapshot,type PriceSnapshot} from '@/lib/overview/price';
import {locale,t,useLanguage} from '@/lib/i18n';

const REFRESH_INTERVAL_MS=60_000;

function priceNumber(value:string){
 return Number(value).toLocaleString(locale(),{minimumFractionDigits:2,maximumFractionDigits:8});
}

function changeNumber(value:number){
 return value.toLocaleString(locale(),{minimumFractionDigits:2,maximumFractionDigits:2});
}

export function QtcLivePrice(){
 useLanguage();
 const [price,setPrice]=useState<PriceSnapshot|null>(null),[failed,setFailed]=useState(false);
 const request=useRef<AbortController|null>(null);
 useEffect(()=>{
  let active=true;
  async function refresh(){
   if(request.current)return;
   const controller=new AbortController();request.current=controller;
   try{
   const next=await fetchPriceSnapshot(controller.signal);
   if(active&&!controller.signal.aborted){setPrice(next);setFailed(false);}
   }catch(error){
    if(active&&!(error instanceof DOMException&&error.name==='AbortError')){setPrice(null);setFailed(true);}
   }finally{
    if(request.current===controller)request.current=null;
   }
  }
  void refresh();
  const interval=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},REFRESH_INTERVAL_MS);
  const visible=()=>{if(document.visibilityState==='visible')void refresh();};
  document.addEventListener('visibilitychange',visible);
  return()=>{active=false;window.clearInterval(interval);document.removeEventListener('visibilitychange',visible);request.current?.abort();request.current=null;};
 },[]);
 const change=price?.change;
 const changeText=change==null?'—':`${change>0?'+':''}${changeNumber(change)}%`;
 const label=price
  ?t('QTC 实时价格 {0} USDT，24 小时涨幅 {1}',priceNumber(price.last),changeText)
  :failed?t('QTC 实时价格暂不可用'):t('正在读取 QTC 实时价格');
 return <span className="headline-price" aria-label={label} title={label} aria-live="polite">
 <span className="headline-price-label">{t('QTC 实时')}</span>
 <strong>{price?priceNumber(price.last):'—'} <small>USDT</small></strong>
  <span className={change==null||change===0?'headline-change':change>0?'headline-change positive':'headline-change negative'}>24h {changeText}</span>
 </span>;
}

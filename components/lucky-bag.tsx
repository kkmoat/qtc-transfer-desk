import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AlertCircle, ArrowUpRight, CheckCircle2, Clock3, Gift, LoaderCircle, Sparkles, X } from 'lucide-react';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DIRECTORY_CATEGORIES } from '@/lib/directory';
import { useLanguage } from '@/lib/i18n';
import { addressBytes } from '@/lib/quantus/protocol';
import { claimLuckyBag, dismissLuckyBag, enterLuckyBag, LuckyBagApiError, releaseLuckyBag, type LuckyBagClaim, type LuckyBagState } from '@/lib/lucky-bag';

const qr = DIRECTORY_CATEGORIES.flatMap(category => category.links).find(link => link.action === 'wechat')?.href ?? '/images/quantus-wechat.jpg';
const wallet = 'https://www.quantus.com/wallet/';
const external = { target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' } as const;
type Reservation = { id: string; expiresAt: number };

const TEXT = {
  zh: {
    title: 'Quantus 幸运福袋', formTitle: '打开你的 QTC 福袋', receiptTitle: 'QTC 领奖凭证',
    invitation: '你因为打开 qtc123 导航栏，从而被 Quantus（QTC）礼包砸中啦！',
    introduction: '完成下面 3 步，登记你的领奖资料。', open: '打开福袋', close: '关闭福袋',
    reservation: '名额为你预留', remaining: '剩余', expired: '预留已到期，正在更新活动状态。',
    scan: '扫码添加 kk 微信', scanHelp: '用微信扫一扫，添加 kk 为好友，方便工作人员核验和发放奖励。', original: '查看二维码原图', qrAlt: '添加 kk 微信的二维码',
    address: '填写 Quantus 收款地址', addressPlaceholder: '粘贴完整的 qz… 收款地址', walletHelp: '不知道 Quantus 地址？', walletLink: '打开官方钱包',
    wechat: '填写你的微信号', wechatPlaceholder: '填写微信号，方便核验好友关系',
    consent: '我同意本活动记录 IP、访问及提交时间，并保存我提交的 Quantus 地址和微信号，用于人工核验与发奖。',
    manual: '这是领奖凭证。添加 kk 微信后，工作人员将核验好友关系并发放奖励。',
    submit: '提交领奖登记', submitting: '正在提交登记…', amount: '本次登记奖励', number: '登记编号', time: '提交时间',
    pending: '待核验 · 尚未转账', verified: '核验通过 · 待人工发放', paid: '工作人员已标记发放', rejected: '未通过核验',
    noTransfer: '登记成功并不代表已转账。本页面不会自动发放 QTC。', paidNote: '工作人员已将登记标记为已发放，请在钱包中核对。本页面不执行转账。', rejectedNote: '此登记未通过工作人员核验，请联系 kk 了解详情。',
    viewReceipt: '查看领奖凭证', finish: '完成', invalidAddress: '请从官方钱包复制完整、有效的 Quantus qz… 收款地址。',
    invalidWechat: '微信号需为 3–64 个字符，不能包含空格、控制字符或尖括号。', consentRequired: '请先勾选同意登记资料用于人工核验。',
    requestFailed: '暂未确认登记结果，请稍后重试。重复提交不会重复领取。', unavailable: '活动状态已变化，请稍候更新。',
  },
  en: {
    title: 'A lucky Quantus gift', formTitle: 'Open your QTC lucky bag', receiptTitle: 'QTC claim receipt',
    invitation: 'You opened the qtc123 directory and a Quantus (QTC) gift landed in your lap!',
    introduction: 'Complete these 3 steps to register your reward claim.', open: 'Open lucky bag', close: 'Close lucky bag',
    reservation: 'Your place is reserved', remaining: 'Time left', expired: 'Your reservation has expired. Updating the campaign status.',
    scan: 'Add kk on WeChat', scanHelp: 'Scan with WeChat and add kk as a friend so staff can verify your claim and arrange the reward.', original: 'View the original QR image', qrAlt: 'QR code for adding kk on WeChat',
    address: 'Enter your Quantus receiving address', addressPlaceholder: 'Paste your full qz… receiving address', walletHelp: 'Need a Quantus address?', walletLink: 'Open the official wallet',
    wechat: 'Enter your WeChat ID', wechatPlaceholder: 'Your WeChat ID for friend verification',
    consent: 'I agree that this campaign records my IP, visit and submission times, and stores my submitted Quantus address and WeChat ID for manual verification and reward distribution.',
    manual: 'This is a claim receipt. After you add kk on WeChat, staff will verify the friendship and distribute the reward.',
    submit: 'Register my claim', submitting: 'Submitting your registration…', amount: 'Registered reward', number: 'Registration ID', time: 'Submitted',
    pending: 'Pending verification · Not transferred', verified: 'Verified · Awaiting manual payment', paid: 'Staff marked this as paid', rejected: 'Verification declined',
    noTransfer: 'A successful registration does not mean a transfer has occurred. This page does not send QTC automatically.', paidNote: 'Staff marked this registration as paid. Please check your wallet. This page does not execute transfers.', rejectedNote: 'Staff declined this registration. Please contact kk for details.',
    viewReceipt: 'View claim receipt', finish: 'Done', invalidAddress: 'Copy a full, valid Quantus qz… receiving address from the official wallet.',
    invalidWechat: 'Use a WeChat ID of 3–64 characters, without spaces, control characters or angle brackets.', consentRequired: 'Please agree to the use of your registration details for manual verification.',
    requestFailed: 'Your registration could not be confirmed. Please retry shortly. Retrying cannot claim another reward.', unavailable: 'The campaign state has changed. Please wait for an update.',
  },
};

export function LuckyBag({ active }: { active: boolean }) {
  const language = useLanguage(), text = TEXT[language], id = useId();
  const [open, setOpen] = useState(false);
  const [stage, setStage] = useState<'gift' | 'form'>('gift');
  const [reservation, setReservation] = useState<Reservation | null>(null);
  const [claim, setClaim] = useState<LuckyBagClaim | null>(null);
  const [address, setAddress] = useState(''), [wechat, setWechat] = useState('');
  const [consent, setConsent] = useState(false), [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | Error>(''), [now, setNow] = useState(Date.now);
  const reservationRef = useRef<Reservation | null>(null), claimRef = useRef<LuckyBagClaim | null>(null);
  const activeRef = useRef(active), mounted = useRef(false), opened = useRef(false), submittingRef = useRef(false);
  const closedReservations = useRef(new Set<string>()), releaseAfterClaim = useRef(false), userClosed = useRef(false);
  const focusBeforeOpen = useRef<HTMLElement | null>(null);
  activeRef.current = active;

  const showDialog = useCallback(() => {
    if (!opened.current && document.activeElement instanceof HTMLElement) focusBeforeOpen.current = document.activeElement;
    opened.current = true; setOpen(true);
  }, []);
  const clearForm = useCallback(() => { setAddress(''); setWechat(''); setConsent(false); setError(''); }, []);
  const updateReservation = useCallback((value: Reservation | null) => { reservationRef.current = value; setReservation(value); }, []);
  const dismiss = useCallback((keepalive = false) => {
    const current = reservationRef.current;
    if (!current) return;
    closedReservations.current.add(current.id); updateReservation(null); clearForm();
    void dismissLuckyBag(current.id, keepalive).catch(() => { /* the fixed server expiry still releases the place */ });
  }, [clearForm, updateReservation]);
  const relinquish = useCallback((keepalive = false) => {
    const current = reservationRef.current;
    if (!current) return;
    updateReservation(null); clearForm();
    void releaseLuckyBag(current.id, keepalive).catch(() => { /* fixed expiry remains the final fallback */ });
  }, [clearForm, updateReservation]);
  const close = useCallback(() => {
    opened.current = false; userClosed.current = true; setOpen(false);
    if (submittingRef.current) releaseAfterClaim.current = true;
    else dismiss();
  }, [dismiss]);
  const acceptState = useCallback((result: LuckyBagState) => {
    if (result.state === 'reserved' && result.reservationId && result.expiresAt) {
      if (!activeRef.current || closedReservations.current.has(result.reservationId)) {
        void dismissLuckyBag(result.reservationId).catch(() => {}); return;
      }
      if (reservationRef.current?.id !== result.reservationId) {
        updateReservation({ id: result.reservationId, expiresAt: result.expiresAt });
        claimRef.current = null; setClaim(null); clearForm(); setStage('gift');
        userClosed.current = false; releaseAfterClaim.current = false; setNow(Date.now()); showDialog();
      }
      return;
    }
    if (result.state === 'claimed' && result.claim) {
      if (reservationRef.current) closedReservations.current.add(reservationRef.current.id);
      updateReservation(null); claimRef.current = result.claim; setClaim(result.claim); clearForm();
      return;
    }
    updateReservation(null);
    if (!claimRef.current) { opened.current = false; setOpen(false); clearForm(); }
  }, [clearForm, showDialog, updateReservation]);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!active) { close(); return; }
    let live = true, polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!live || polling || document.visibilityState === 'hidden') return;
      polling = true;
      try {
        const result = await enterLuckyBag();
        if (!live) {
          if ((!mounted.current || !activeRef.current) && result.state === 'reserved' && result.reservationId) void releaseLuckyBag(result.reservationId, true).catch(() => {});
          return;
        }
        if (document.hidden && result.state === 'reserved' && result.reservationId) {
          await releaseLuckyBag(result.reservationId, true).catch(() => {});
          return;
        }
        acceptState(result);
      } catch { /* no campaign popup is shown without a validated server reservation */ }
      finally {
        polling = false;
        if (live && !document.hidden) timer = setTimeout(poll, 15_000);
      }
    };
    const resume = () => { clearTimeout(timer); if (document.visibilityState !== 'hidden') void poll(); };
    // Delaying the first request one task lets StrictMode replay cancel its first setup.
    timer = setTimeout(poll, 0);
    document.addEventListener('visibilitychange', resume); window.addEventListener('pageshow', resume);
    return () => { live = false; clearTimeout(timer); document.removeEventListener('visibilitychange', resume); window.removeEventListener('pageshow', resume); };
  }, [acceptState, active, close]);
  useEffect(() => {
    const leave = () => { opened.current = false; setOpen(false); relinquish(true); };
    window.addEventListener('pagehide', leave);
    return () => window.removeEventListener('pagehide', leave);
  }, [relinquish]);
  useEffect(() => {
    if (!open || !reservation) return;
    const tick = () => { if (document.visibilityState !== 'hidden') setNow(Date.now()); };
    tick(); const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', tick); };
  }, [open, reservation]);

  const seconds = reservation ? Math.max(0, Math.ceil((reservation.expiresAt - now) / 1000)) : 0;
  const countdown = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  const errorText = typeof error === 'string' ? (error ? text[error as keyof typeof text] ?? error : '')
    : language === 'zh' && error instanceof LuckyBagApiError && error.message !== 'REQUEST_FAILED' ? error.message : text.requestFailed;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    const current = reservationRef.current;
    if (!current || current.expiresAt <= Date.now() || !activeRef.current) { setError('unavailable'); return; }
    const recipient = address.trim(), account = wechat.trim();
    try { addressBytes(recipient); } catch { setError('invalidAddress'); document.getElementById(id + '-address')?.focus(); return; }
    if (account.length < 3 || account.length > 64 || /[\s\u0000-\u001f\u007f<>]/u.test(account)) { setError('invalidWechat'); document.getElementById(id + '-wechat')?.focus(); return; }
    if (!consent) { setError('consentRequired'); document.getElementById(id + '-consent')?.focus(); return; }
    submittingRef.current = true; setSubmitting(true); setError('');
    try {
      const result = await claimLuckyBag(current.id, recipient, account);
      closedReservations.current.add(current.id);
      if (!mounted.current) return;
      acceptState(result);
      if (!userClosed.current && activeRef.current) showDialog();
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason : new Error('REQUEST_FAILED'));
      // An uncertain reply may already have committed. Poll the same visitor before retrying.
      if (mounted.current && activeRef.current && document.visibilityState !== 'hidden') {
        try { acceptState(await enterLuckyBag()); }
        catch { /* preserve the reservation and inputs so the idempotent claim can be retried */ }
      }
    } finally {
      submittingRef.current = false;
      if (mounted.current) setSubmitting(false);
      if (releaseAfterClaim.current) { releaseAfterClaim.current = false; dismiss(); }
    }
  }

  const receiptStatus = claim ? text[claim.status] : '';
  return <>
    {claim && !open && <button type="button" className="lucky-bag-launcher" onClick={showDialog}><Gift size={18} aria-hidden="true"/>{text.viewReceipt}</button>}
    <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
      <DialogContent className="lucky-bag-dialog" showCloseButton={false} onCloseAutoFocus={event => { event.preventDefault(); if (focusBeforeOpen.current?.isConnected) focusBeforeOpen.current.focus(); }}>
        <DialogClose asChild><button type="button" className="lucky-bag-close" aria-label={text.close} title={text.close}><X size={20} aria-hidden="true"/></button></DialogClose>
        <DialogHeader className="lucky-bag-header">
          <p className="lucky-bag-kicker"><Sparkles size={14} aria-hidden="true"/> QUANTUS · QTC</p>
          <DialogTitle>{claim ? text.receiptTitle : stage === 'gift' ? text.title : text.formTitle}</DialogTitle>
          <DialogDescription>{claim ? text.manual : stage === 'gift' ? text.reservation : text.introduction}</DialogDescription>
        </DialogHeader>
        {claim ? <div className="lucky-bag-receipt" role="status">
          <div className="lucky-bag-receipt-amount"><span>{text.amount}</span><strong>{claim.amount} <small>QTC</small></strong><div className="lucky-bag-pending"><CheckCircle2 size={14} aria-hidden="true"/>{receiptStatus}</div></div>
          <dl><div><dt>{text.number}</dt><dd className="lucky-bag-receipt-identity">#{claim.id}</dd></div><div><dt>{text.time}</dt><dd>{new Date(claim.submittedAt).toLocaleString(language === 'en' ? 'en-US' : 'zh-CN')}</dd></div></dl>
          <p className="lucky-bag-note">{claim.status === 'paid' ? text.paidNote : claim.status === 'rejected' ? text.rejectedNote : text.noTransfer}</p>
          <button type="button" className="lucky-bag-secondary" onClick={close}>{text.finish}</button>
        </div> : stage === 'gift' ? <>
          <div className="lucky-bag-visual" aria-hidden="true"><Sparkles className="lucky-bag-sparkle first" size={23}/><div className="lucky-bag-emblem"><Gift size={58}/><strong>QTC</strong></div><Sparkles className="lucky-bag-sparkle second" size={18}/></div>
          <p className="lucky-bag-invitation">{text.invitation}</p>
          <button type="button" className="lucky-bag-primary" disabled={!reservation || seconds === 0} onClick={() => setStage('form')}><Gift size={18} aria-hidden="true"/>{text.open}</button>
          <p className="lucky-bag-timing"><Clock3 size={14} aria-hidden="true"/>{seconds > 0 ? text.remaining + ' ' + countdown : text.expired}</p>
        </> : <form className="lucky-bag-form" onSubmit={submit} noValidate aria-busy={submitting}>
          <div className="lucky-bag-step"><span className="lucky-bag-step-number" aria-hidden="true">1</span><div className="lucky-bag-step-body"><h3>{text.scan}</h3><div className="lucky-bag-qr-row"><a href={qr} {...external} aria-label={text.original}><img className="lucky-bag-qr" src={qr} width={1194} height={1575} alt={text.qrAlt}/></a><div className="lucky-bag-qr-help"><p>{text.scanHelp}</p><a href={qr} {...external}>{text.original}<ArrowUpRight size={13} aria-hidden="true"/></a></div></div></div></div>
          <div className="lucky-bag-step"><span className="lucky-bag-step-number" aria-hidden="true">2</span><div className="lucky-bag-step-body"><label htmlFor={id + '-address'}>{text.address}</label><input id={id + '-address'} name="quantus-address" type="text" value={address} onChange={event => setAddress(event.target.value)} disabled={submitting} maxLength={80} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={text.addressPlaceholder} aria-describedby={id + '-wallet-help'}/><p className="lucky-bag-wallet-help" id={id + '-wallet-help'}><a href={wallet} {...external}>{text.walletHelp} {text.walletLink}<ArrowUpRight size={13} aria-hidden="true"/></a></p></div></div>
          <div className="lucky-bag-step"><span className="lucky-bag-step-number" aria-hidden="true">3</span><div className="lucky-bag-step-body"><label htmlFor={id + '-wechat'}>{text.wechat}</label><input id={id + '-wechat'} name="wechat-id" type="text" value={wechat} onChange={event => setWechat(event.target.value)} disabled={submitting} maxLength={64} autoComplete="off" autoCapitalize="off" spellCheck={false} placeholder={text.wechatPlaceholder}/></div></div>
          <label className="lucky-bag-consent" htmlFor={id + '-consent'}><input id={id + '-consent'} type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={submitting}/><span>{text.consent}</span></label>
          <p className="lucky-bag-note">{text.manual}</p>
          {errorText && <div className="lucky-bag-error" role="alert"><AlertCircle size={16} aria-hidden="true"/><span>{errorText}</span></div>}
          <button type="submit" className="lucky-bag-primary" disabled={submitting || !reservation || seconds === 0}>{submitting ? <LoaderCircle size={17} className="spin" aria-hidden="true"/> : <Gift size={17} aria-hidden="true"/>}{submitting ? text.submitting : text.submit}</button>
          <p className="lucky-bag-timing"><Clock3 size={14} aria-hidden="true"/>{seconds > 0 ? text.remaining + ' ' + countdown : text.expired}</p>
        </form>}
      </DialogContent>
    </Dialog>
  </>;
}

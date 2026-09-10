import { ArrowUpRight, Gift } from 'lucide-react';

const REFERRAL_URL = 'https://accounts.usnbweb.red/zh-CN/register?ref=HA6EW1HC';

export function ReferralBanner() {
  return <aside className="referral-banner" aria-label="邀请推广">
    <a href={REFERRAL_URL} target="_blank" rel="sponsored noopener noreferrer" referrerPolicy="no-referrer"
      aria-label="打开注册链接（币安邀请推广），前往 accounts.usnbweb.red（新标签页）">
      <span className="referral-icon" aria-hidden="true"><Gift size={25} /></span>
      <div className="referral-content">
        <div className="referral-title"><strong>BINANCE 币安邀请</strong><span className="referral-label">推广</span></div>
        <p>通过作者邀请链接注册 <span className="referral-code">邀请码 <b>HA6EW1HC</b></span></p>
        <span className="referral-domain">跳转至 accounts.usnbweb.red</span>
      </div>
      <span className="referral-cta">打开注册链接 <ArrowUpRight size={17} aria-hidden="true" /></span>
    </a>
  </aside>;
}

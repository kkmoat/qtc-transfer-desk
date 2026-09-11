import { ArrowUpRight, BookOpen, CodeXml, Cpu, FileText, Fingerprint, Globe, MessageCircle, Network, Send, ShieldCheck, Wallet } from 'lucide-react';
import { t, useLanguage } from '@/lib/i18n';

const external = { target: '_blank', rel: 'noopener noreferrer', referrerPolicy: 'no-referrer' } as const;
const features = [
  {
    icon: ShieldCheck,
    title: '后量子密码学',
    description: '采用 ML-DSA 后量子数字签名，将应对量子计算威胁纳入网络的基础设计。ML-DSA 已纳入 NIST FIPS 204 标准。',
    href: 'https://www.quantus.com/whitepaper/',
    link: '阅读密码学设计',
  },
  {
    icon: Cpu,
    title: '工作量证明 QPoW',
    description: '矿工通过计算参与区块生产。QPoW 使用 Poseidon2 哈希，便于在零知识证明中验证计算过程；QTC 的挖矿发行受供应上限约束。',
    href: 'https://docs.quantus.com/deep-dives/qpow/',
    link: '了解共识与挖矿',
  },
  {
    icon: Fingerprint,
    title: '加密账户与零知识证明',
    description: 'Wormhole 是 Quantus 的加密账户机制，通过零知识证明验证资金归属，并以证明聚合设计减少链上验证的数据负担。',
    href: 'https://www.quantus.com/whitepaper/',
    link: '了解加密账户设计',
  },
];
const resources = [
  { icon: Globe, title: 'Quantus 官网', description: '项目动态与生态入口', href: 'https://www.quantus.com/' },
  { icon: BookOpen, title: '官方技术文档', description: '网络架构、节点与挖矿指南', href: 'https://docs.quantus.com/' },
  { icon: FileText, title: '项目白皮书', description: '协议设计、密码学与经济模型', href: 'https://www.quantus.com/whitepaper/' },
  { icon: Network, title: '主网区块浏览器', description: '查看区块、账户与链上交易', href: 'https://explorer.quantus.com/' },
  { icon: CodeXml, title: '官方 GitHub', description: '查看开源代码与开发进展', href: 'https://github.com/Quantus-Network' },
  { icon: Wallet, title: '官方钱包', description: '通过官网获取钱包下载入口', href: 'https://www.quantus.com/wallet/' },
  { icon: MessageCircle, title: '官方 X（推特）', description: '关注 @QuantusNetwork，获取项目动态', href: 'https://x.com/QuantusNetwork' },
  { icon: Send, title: '官方 Telegram', description: '加入 Quantus 官方社区讨论', href: 'https://t.me/quantusnetwork' },
];

export function QuantusIntroduction() {
  useLanguage();
  return <article className="quantus-intro" aria-label={t('Quantus 项目介绍')}>
    <section className="intro-hero" aria-labelledby="intro-hero-title">
      <div>
        <span className="intro-kicker"><Network size={16} aria-hidden="true"/> QUANTUS NETWORK</span>
        <h2 id="intro-hero-title">{t('面向后量子时代的 Layer 1 网络')}</h2>
        <p className="intro-summary">{t('Quantus 是以数字货币为核心的独立区块链，结合后量子密码学、工作量证明和零知识证明。QTC 是网络原生币，用于链上价值转移；项目围绕量子计算威胁、交易隐私与可扩展性进行设计。')}</p>
        <div className="intro-actions">
          <a href="https://www.quantus.com/" {...external}>{t('访问 Quantus 官网')}<ArrowUpRight size={16} aria-hidden="true"/></a>
          <a href="/overview/">{t('查看 QTC 总览')}<ArrowUpRight size={16} aria-hidden="true"/></a>
        </div>
      </div>
      <dl className="intro-facts">
        <div><dt>{t('网络原生币')}</dt><dd>QTC</dd></div>
        <div><dt>{t('供应上限')}</dt><dd>21,000,000 <small>QTC</small></dd></div>
        <div><dt>{t('共识机制')}</dt><dd>Proof of Work</dd></div>
      </dl>
    </section>
    <section aria-labelledby="intro-features-title">
      <div className="intro-section-heading"><h2 id="intro-features-title">{t('核心技术')}</h2><p>{t('从签名、共识到加密账户')}</p></div>
      <div className="intro-features">{features.map(({ icon: Icon, title, description, href, link }) => <section className="intro-feature" key={title}>
        <span className="intro-feature-icon"><Icon size={22} aria-hidden="true"/></span>
        <h3>{t(title)}</h3><p>{t(description)}</p>
        <a href={href} {...external}>{t(link)}<ArrowUpRight size={14} aria-hidden="true"/></a>
      </section>)}</div>
    </section>
    <section className="intro-resources" aria-labelledby="intro-resources-title">
      <div className="intro-section-heading"><h2 id="intro-resources-title">{t('官方资料与工具')}</h2><p>{t('从官方渠道继续了解 Quantus')}</p></div>
      <div className="intro-resource-grid">{resources.map(({ icon: Icon, title, description, href }) => <a className="intro-resource" key={title} href={href} {...external}>
        <Icon size={21} aria-hidden="true"/><span><strong>{t(title)}</strong><small>{t(description)}</small></span><ArrowUpRight aria-hidden="true"/>
      </a>)}</div>
    </section>
    <p className="intro-source-note">{t('本页依据 Quantus 官方资料整理，更新于 2026-09-11。')} <a href="https://www.quantus.com/whitepaper/" {...external}>{t('查阅最新白皮书')}<ArrowUpRight size={12} aria-hidden="true" style={{ display: 'inline', verticalAlign: 'middle' }}/></a></p>
  </article>;
}

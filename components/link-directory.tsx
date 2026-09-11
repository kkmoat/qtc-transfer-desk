import { ArrowUpRight } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { DIRECTORY_CATEGORIES, type DirectoryLink } from '@/lib/directory';
import { t, useLanguage } from '@/lib/i18n';

function DirectoryItem({ link }: { link: DirectoryLink }) {
  if (link.action === 'wechat') return <li><Dialog>
    <DialogTrigger asChild><button type="button" className="directory-qr-trigger">{t(link.label)}</button></DialogTrigger>
    <DialogContent className="wechat-qr-dialog">
      <DialogHeader>
        <DialogTitle>{t('微信交流群')}</DialogTitle>
        <DialogDescription>{t('使用微信扫一扫，联系作者加入交流群。')}</DialogDescription>
      </DialogHeader>
      <img className="wechat-qr-image" src={link.href} width={1194} height={1575} alt={t('微信联系二维码（kkmoat）')}/>
      <a className="wechat-qr-original" href={link.href} target="_blank" rel="noopener noreferrer">{t('查看二维码原图')}<ArrowUpRight size={16} aria-hidden="true"/></a>
    </DialogContent>
  </Dialog></li>;
  const external = link.href.startsWith('https://');
  return <li><a href={link.href}
    target={external ? '_blank' : undefined}
    rel={external ? (link.sponsored ? 'sponsored noopener noreferrer' : 'noopener noreferrer') : undefined}
    referrerPolicy={external ? 'no-referrer' : undefined}>{t(link.label)}</a></li>;
}

export function LinkDirectory() {
  useLanguage();
  return <section className="link-directory" aria-label={t('加密货币网址导航')}>
    <div className="directory-caption"><p>{t('Quantus 与加密货币常用网址，按分类直达。')}</p><span><ArrowUpRight size={14} aria-hidden="true"/>{t('外部网站在新标签页打开')}</span></div>
    <div className="directory-table">{DIRECTORY_CATEGORIES.map(category => <section className="directory-category" key={category.id} aria-labelledby={'directory-title-' + category.id}>
      <div className="directory-row">
        <h2 id={'directory-title-' + category.id}>{t(category.title)}</h2>
        <ul className="directory-links" aria-labelledby={'directory-title-' + category.id}>{category.links.map(link => <DirectoryItem key={link.label} link={link}/>)}</ul>
      </div>
    </section>)}</div>
  </section>;
}

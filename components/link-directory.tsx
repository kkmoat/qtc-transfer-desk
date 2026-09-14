import { ArrowUpRight } from 'lucide-react';
import { DIRECTORY_CATEGORIES, type DirectoryLink } from '@/lib/directory';
import { t, useLanguage } from '@/lib/i18n';

function DirectoryItem({ link }: { link: DirectoryLink }) {
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

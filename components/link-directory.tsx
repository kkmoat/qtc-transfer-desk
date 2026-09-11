import { ArrowUpRight, ChevronDown } from 'lucide-react';
import { Collapsible } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { DIRECTORY_CATEGORIES, type DirectoryLink } from '@/lib/directory';
import { t, useLanguage } from '@/lib/i18n';

function DirectoryItem({ link }: { link: DirectoryLink }) {
  const external = link.href.startsWith('https://');
  return <li><a href={link.href}
    target={external ? '_blank' : undefined}
    rel={external ? 'noopener noreferrer' : undefined}
    referrerPolicy={external ? 'no-referrer' : undefined}>{t(link.label)}</a></li>;
}

export function LinkDirectory() {
  useLanguage();
  return <section className="link-directory" aria-label={t('加密货币网址导航')}>
    <div className="directory-caption"><p>{t('Quantus 与加密货币常用网址，按分类直达。')}</p><span><ArrowUpRight size={14} aria-hidden="true"/>{t('外部网站在新标签页打开')}</span></div>
    <div className="directory-table">{DIRECTORY_CATEGORIES.map(category => <Collapsible.Root className="directory-category" key={category.id}>
      <div className="directory-row">
        <h2 id={'directory-title-' + category.id}>{t(category.title)}</h2>
        <ul className="directory-links" aria-labelledby={'directory-title-' + category.id}>{category.links.slice(0, 4).map(link => <DirectoryItem key={link.href} link={link}/>)}</ul>
        {category.links.length > 4 && <Collapsible.Trigger asChild>
          <Button type="button" variant="ghost" size="icon" className="directory-expand" aria-label={t('展开或收起{0}分类', t(category.title))}>
            <ChevronDown size={19} aria-hidden="true"/>
          </Button>
        </Collapsible.Trigger>}
      </div>
      {category.links.length > 4 && <Collapsible.Content className="directory-more">
        <ul className="directory-links" aria-label={t('{0}分类的更多网址', t(category.title))}>{category.links.slice(4).map(link => <DirectoryItem key={link.href} link={link}/>)}</ul>
      </Collapsible.Content>}
    </Collapsible.Root>)}</div>
    <p className="directory-hint">{t('点击每行右侧箭头，展开更多网址。')}</p>
  </section>;
}

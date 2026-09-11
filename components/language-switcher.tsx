import { Languages } from 'lucide-react';
import { setLanguage, useLanguage } from '@/lib/i18n';
export function LanguageSwitcher() {
  const language = useLanguage();
  return <div className="language-switcher" role="group" aria-label={language === 'en' ? 'Language' : '语言'}>
    <Languages size={15} aria-hidden="true"/>
    <button type="button" lang="zh-CN" aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
    <span aria-hidden="true">/</span>
    <button type="button" lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>English</button>
  </div>;
}

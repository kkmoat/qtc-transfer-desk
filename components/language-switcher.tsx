import { useEffect } from 'react';
import { Languages } from 'lucide-react';
import { setLanguage, useLanguage } from '@/lib/i18n';
export function LanguageSwitcher() {
  const language = useLanguage();
  useEffect(() => {
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    document.title = language === 'en' ? 'QTC Transfer Desk · Quantus Mainnet' : 'QTC 转账台 · Quantus 主网';
    document.querySelector('meta[name="description"]')?.setAttribute('content', language === 'en'
      ? 'Community Quantus mainnet transfer tool with browser-local signing, transfer history, and a mining cost calculator.'
      : 'Quantus 主网社区转账工具，提供浏览器本地签名、转账记录和挖矿成本计算器。');
  }, [language]);
  return <div className="language-switcher" role="group" aria-label={language === 'en' ? 'Language' : '语言'}>
    <Languages size={15} aria-hidden="true"/>
    <button type="button" lang="zh-CN" aria-pressed={language === 'zh'} onClick={() => setLanguage('zh')}>中文</button>
    <span aria-hidden="true">/</span>
    <button type="button" lang="en" aria-pressed={language === 'en'} onClick={() => setLanguage('en')}>English</button>
  </div>;
}

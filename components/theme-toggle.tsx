import { Moon, Sun } from 'lucide-react';
import { setTheme, useTheme } from '@/lib/theme';
import { t, useLanguage } from '@/lib/i18n';

export function ThemeToggle() {
  useLanguage();
  const theme = useTheme();
  const label = t(theme === 'dark' ? '切换为白色模式' : '切换为深色模式');
  return <button type="button" className="theme-toggle" aria-label={label} title={label} aria-pressed={theme === 'light'}
    onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
    {theme === 'dark' ? <Sun size={17} aria-hidden="true"/> : <Moon size={17} aria-hidden="true"/>}
    <span>{t(theme === 'dark' ? '白色模式' : '深色模式')}</span>
  </button>;
}

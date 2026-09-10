import { useSyncExternalStore } from 'react';
import { LANGUAGE_KEY, parseLanguage, translate, type Language } from './core.ts';
export type { Language } from './core.ts';
const listeners = new Set<() => void>();
let language: Language = 'zh';
try { if (typeof localStorage !== 'undefined') language = parseLanguage(localStorage.getItem(LANGUAGE_KEY)); } catch { /* language switching also works without storage */ }
function emit() { for (const listener of listeners) listener(); }
export function setLanguage(value: Language) {
  language = parseLanguage(value);
  try { localStorage.setItem(LANGUAGE_KEY, language); } catch { /* optional preference only */ }
  emit();
}
if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === LANGUAGE_KEY || event.key === null) { language = parseLanguage(event.newValue); emit(); }
});
export function useLanguage() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => language, () => 'zh' as Language);
}
export const locale = () => language === 'en' ? 'en-US' : 'zh-CN';
export const t = (text: string, ...values: unknown[]) => translate(text, language, values);

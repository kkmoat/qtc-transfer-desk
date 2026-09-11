import { useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
export const THEME_KEY = 'qtc-theme-v1';
const parseTheme = (value: unknown): Theme => value === 'light' ? 'light' : 'dark';
const listeners = new Set<() => void>();
let theme: Theme = typeof document === 'undefined' ? 'dark' : parseTheme(document.documentElement.dataset.theme);

function applyTheme(value: Theme) {
  theme = value;
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = value;
  for (const listener of listeners) listener();
}

export function setTheme(value: Theme) {
  const next = parseTheme(value);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* switching also works without storage */ }
  applyTheme(next);
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key === THEME_KEY || event.key === null) applyTheme(parseTheme(event.newValue));
});

export function useTheme() {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => theme, () => 'dark' as Theme);
}

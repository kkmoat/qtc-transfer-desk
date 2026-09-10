import { EN } from './en.ts';
export type Language = 'zh' | 'en';
export const LANGUAGE_KEY = 'qtc-language-v1';
export function parseLanguage(value: unknown): Language { return value === 'en' ? 'en' : 'zh'; }
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const literals = Object.entries(EN).filter(([key]) => !/\{\d+\}/.test(key)).sort((a, b) => b[0].length - a[0].length);
const reverse = new Map(literals.map(([zh, en]) => [en, zh]));
const patterns = Object.entries(EN).filter(([key]) => /\{\d+\}/.test(key)).map(([zh,en]) => ({zh,en,regex:new RegExp('^'+zh.split(/\{\d+\}/).map(escape).join('(.*?)')+'$'), reverseRegex:new RegExp('^'+en.split(/\{\d+\}/).map(escape).join('(.*?)')+'$')}));
const fill = (text: string, values: readonly unknown[]) => text.replace(/\{(\d+)\}/g, (_, index: string) => String(values[Number(index)] ?? ''));
/** UI labels/messages only. Never pass wallet phrases, private keys, or transaction bytes. */
export function translate(text: string, language: Language, values: readonly unknown[] = [], depth = 0): string {
  if (values.length) return fill(language === 'en' ? EN[text] ?? text : text, values);
  if (language === 'zh') {
    if (reverse.has(text)) return reverse.get(text)!;
    if (depth <= 4) for (const pattern of patterns) {
      const match = pattern.reverseRegex.exec(text);
      if (match) return fill(pattern.zh, match.slice(1).map(value => translate(value, language, [], depth + 1)));
    }
    return text;
  }
  if (EN[text] !== undefined) return EN[text];
  if (!/[\u3400-\u9fff]/.test(text) || depth > 4) return text;
  for (const pattern of patterns) {
    const match = pattern.regex.exec(text);
    if (match) return fill(pattern.en, match.slice(1).map(value => translate(value, language, [], depth + 1)));
  }
  let result = text;
  for (const [zh,en] of literals) result = result.split(zh).join(en);
  return result;
}

import { useEffect, useState } from 'react';
import { canonicalUrl, pageMetadata, viewFromLocation, viewFromPath, viewPath, VIEWS, type DeskView } from './site.ts';

export function navigateToView(view: DeskView) {
  const next = viewPath(view) + window.location.search + (view === 'directory' ? '#directory' : '');
  if (next !== window.location.pathname + window.location.search + window.location.hash) {
    window.history.pushState(window.history.state, '', next);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useDeskNavigation(initialView: DeskView) {
  const [view, setView] = useState<DeskView>(() => typeof window === 'undefined'
    ? initialView : viewFromLocation(window.location.pathname, window.location.hash));
  useEffect(() => {
    const changed = () => {
      const next = viewFromLocation(window.location.pathname, window.location.hash);
      const legacy = VIEWS.some(value => window.location.hash === `#${value}`);
      // Keep old bookmarks working, but give every view one crawlable URL.
      if (legacy || window.location.pathname === '/' && !window.location.hash) {
        window.history.replaceState(window.history.state, '', viewPath(next) + window.location.search + (next === 'directory' ? '#directory' : ''));
      }
      setView(next);
    };
    const click = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor || anchor.hasAttribute('download') || anchor.target && anchor.target !== '_self') return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin || url.hash) return;
      const target = viewFromPath(url.pathname);
      if (!target || url.search && url.search !== window.location.search) return;
      event.preventDefault();
      navigateToView(target);
    };
    changed();
    window.addEventListener('hashchange', changed);
    window.addEventListener('popstate', changed);
    document.addEventListener('click', click);
    return () => {
      window.removeEventListener('hashchange', changed);
      window.removeEventListener('popstate', changed);
      document.removeEventListener('click', click);
    };
  }, []);
  return view;
}

export function usePageMetadata(view: DeskView, language: 'zh' | 'en') {
  useEffect(() => {
    const { title, description } = pageMetadata(view, language);
    document.title = title;
    document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
    const values: Record<string, string> = {
      'meta[name="description"]': description,
      'meta[property="og:title"]': title,
      'meta[property="og:description"]': description,
      'meta[property="og:url"]': canonicalUrl(view),
      'meta[property="og:locale"]': language === 'en' ? 'en_US' : 'zh_CN',
      'meta[name="twitter:title"]': title,
      'meta[name="twitter:description"]': description,
    };
    for (const [selector, value] of Object.entries(values)) document.querySelector(selector)?.setAttribute('content', value);
    document.querySelector('link[rel="canonical"]')?.setAttribute('href', canonicalUrl(view));
  }, [view, language]);
}

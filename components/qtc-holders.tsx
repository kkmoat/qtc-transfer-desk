import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, ArrowUpRight, RefreshCw, UsersRound } from 'lucide-react';
import { t, useLanguage, locale } from '@/lib/i18n';
import { fetchHoldersPage, formatPlanckQtc, HOLDERS_EXPLORER_URL, HOLDERS_PAGE_SIZE, type HoldersSnapshot } from '@/lib/holders';

const explorerAccount = (address: string) => 'https://explorer.quantus.com/accounts/' + encodeURIComponent(address);
const when = (value: number) => new Date(value).toLocaleString(locale(), { hour12: false });

export function QtcHolders({ active }: { active: boolean }) {
  useLanguage();
  const [page, setPage] = useState(1);
  const [snapshot, setSnapshot] = useState<HoldersSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    try {
      const result = await fetchHoldersPage(page, controller.signal);
      if (!controller.signal.aborted) { setSnapshot(result); setError(''); }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '暂时无法读取持币地址，请稍后刷新。');
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }, [page]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(interval); document.removeEventListener('visibilitychange', visible);
      request.current?.abort(); request.current = null; setLoading(false);
    };
  }, [active, refresh]);

  const current = snapshot?.page === page ? snapshot : null;
  const totalPages = current ? Math.max(1, Math.ceil(current.totalCount / HOLDERS_PAGE_SIZE)) : null;
  const firstRank = (page - 1) * HOLDERS_PAGE_SIZE + 1;
  const lastRank = current ? firstRank + current.accounts.length - 1 : firstRank + HOLDERS_PAGE_SIZE - 1;
  const changePage = (next: number) => { if (next >= 1 && (!totalPages || next <= totalPages)) { setError(''); setPage(next); } };

  return <section className="holders" aria-label={t('QTC 持币地址')}>
    <div className="holders-toolbar">
      <span><UsersRound size={17} aria-hidden="true" />{t('官方链上账户 · 每分钟刷新')}</span>
      <button type="button" onClick={() => void refresh()} disabled={loading} className="holders-refresh"><RefreshCw size={16} className={loading ? 'spin' : ''} aria-hidden="true" />{loading ? t('正在刷新…') : t('刷新数据')}</button>
    </div>
    <div className="holders-summary">
      <article><span>{t('账户总数')}</span><strong>{current ? current.totalCount.toLocaleString(locale()) : '—'}</strong></article>
      <article><span>{t('当前显示')}</span><strong>{current?.accounts.length ? t('第 {0}–{1} 名', firstRank.toLocaleString(locale()), lastRank.toLocaleString(locale())) : '—'}</strong></article>
      <article><span>{t('排序方式')}</span><strong>{t('可用余额从高到低')}</strong></article>
    </div>
    {error && <div className="holders-error" role="status">{t(error)}{current && <> · {t('继续显示上次成功读取的数据')}</>}</div>}
    <div className="holders-table-wrap">
      <table className="holders-table">
        <thead><tr><th scope="col">{t('排名')}</th><th scope="col">{t('地址')}</th><th scope="col">{t('可用余额')}</th><th scope="col">{t('冻结')}</th><th scope="col">{t('预留')}</th></tr></thead>
        <tbody>{current?.accounts.map((account, index) => <tr key={account.address}>
          <td className="holders-rank">#{firstRank + index}</td>
          <td><a className="holders-address" href={explorerAccount(account.address)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" aria-label={t('在官方区块浏览器打开地址 {0}', account.address)}>{account.address}<ArrowUpRight size={13} aria-hidden="true" /></a></td>
          <td className="holders-amount"><strong>{formatPlanckQtc(account.free, locale())}</strong> <small>QTC</small></td>
          <td className="holders-amount">{formatPlanckQtc(account.frozen, locale())} <small>QTC</small></td>
          <td className="holders-amount">{formatPlanckQtc(account.reserved, locale())} <small>QTC</small></td>
        </tr>) ?? null}</tbody>
      </table>
      {!current && <div className="holders-empty">{loading ? t('正在读取官方账户数据…') : t('官方账户数据暂不可用。')}</div>}
    </div>
    <div className="holders-pagination">
      <button type="button" disabled={page <= 1 || loading} onClick={() => changePage(page - 1)}><ArrowLeft size={15} aria-hidden="true" />{t('上一页')}</button>
      <span>{totalPages ? t('第 {0} / {1} 页', page.toLocaleString(locale()), totalPages.toLocaleString(locale())) : t('第 {0} 页', page.toLocaleString(locale()))}</span>
      <button type="button" disabled={loading || !current || !totalPages || page >= totalPages} onClick={() => changePage(page + 1)}>{t('下一页')}<ArrowRight size={15} aria-hidden="true" /></button>
    </div>
    <div className="holders-source">
      <p>{current ? t('读取时间：{0}。', when(current.fetchedAt)) : t('等待官方数据。')} {t('余额来自 Quantus 官方区块浏览器使用的公开 GraphQL 接口。')}</p>
      <a href={HOLDERS_EXPLORER_URL} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{t('在官方区块浏览器查看账户榜')}<ArrowUpRight size={14} aria-hidden="true" /></a>
    </div>
    <p className="holders-note">{t('这里按账户可用余额排序。地址可能属于个人、团队、交易所、矿池、系统模块或多签账户；一个地址不等于一个自然人，也不代表可立即出售的数量。')}</p>
  </section>;
}

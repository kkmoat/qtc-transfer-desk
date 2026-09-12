import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Clock3, Gauge, Pickaxe, RefreshCw, UsersRound } from 'lucide-react';
import { locale, t, useLanguage } from '@/lib/i18n';
import { fetchPoolLive, formatHashrate, POOL_REFRESH_MS, type PoolLiveSnapshot } from '@/lib/pool-live';

const number = (value: number | bigint) => value.toLocaleString(locale(), { maximumFractionDigits: 2 });
const percent = (value: number) => `${value.toLocaleString(locale(), { maximumFractionDigits: 2 })}%`;
const time = (seconds: number) => {
  if (seconds < 90) return t('{0}秒', Math.max(1, Math.round(seconds)));
  if (seconds < 90 * 60) return t('{0}分钟', Math.round(seconds / 60));
  if (seconds < 48 * 3600) return t('{0}小时', (seconds / 3600).toLocaleString(locale(), { maximumFractionDigits: 1 }));
  return t('{0}天', (seconds / 86400).toLocaleString(locale(), { maximumFractionDigits: 1 }));
};
const ago = (value: number, now: number) => {
  const seconds = Math.max(0, (now - value) / 1000);
  if (seconds < 10) return t('刚刚');
  if (seconds < 60) return t('{0}秒前', Math.round(seconds));
  if (seconds < 3600) return t('{0}分钟前', Math.round(seconds / 60));
  if (seconds < 86400) return t('{0}小时前', Math.round(seconds / 3600));
  return t('{0}天前', Math.round(seconds / 86400));
};

export function PoolHashrate({ active }: { active: boolean }) {
  useLanguage();
  const [snapshot, setSnapshot] = useState<PoolLiveSnapshot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [now, setNow] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const result = await fetchPoolLive(controller.signal);
      if (!controller.signal.aborted) { setSnapshot(result); setError(''); setNow(Date.now()); }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '矿池实时数据暂不可用。');
    } finally {
      if (request.current === controller) { request.current = null; setLoading(false); }
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const interval = setInterval(() => { setNow(Date.now()); if (document.visibilityState === 'visible') void refresh(); }, POOL_REFRESH_MS);
    const visible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(interval); document.removeEventListener('visibilitychange', visible); request.current?.abort(); request.current = null; setLoading(false); };
  }, [active, refresh]);

  return <section className="pool-live" aria-label={t('QTC 矿池实时算力')}>
    <div className="pool-toolbar"><span><Activity size={17} aria-hidden="true" />{t('Quanpool 公开数据 · 每30秒刷新')}</span><button type="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''} aria-hidden="true" />{loading ? t('正在刷新…') : t('刷新数据')}</button></div>
    {error && <div className="pool-error" role="status">{t(error)}{snapshot && <> · {t('继续显示上次成功读取的数据')}</>}</div>}
    <div className="pool-hero">
      <article><span><Pickaxe size={16} />{t('矿池算力（近1小时）')}</span><strong>{snapshot ? formatHashrate(snapshot.poolHashrateHs, locale()) : '—'}</strong></article>
      <article><span><Gauge size={16} />{t('全网估算算力')}</span><strong>{snapshot ? formatHashrate(snapshot.networkHashrateHs, locale()) : '—'}</strong></article>
      <article><span><Activity size={16} />{t('矿池占全网')}</span><strong>{snapshot ? percent(snapshot.poolSharePercent) : '—'}</strong><i><b style={{ width: `${Math.min(100, snapshot?.poolSharePercent ?? 0)}%` }} /></i></article>
    </div>
    <div className="pool-panels">
      <article className="pool-panel"><h2><Gauge size={19} />{t('网络概况')}</h2><dl>
        <div><dt>{t('全网难度')}</dt><dd>{snapshot ? number(snapshot.difficulty) : '—'}</dd></div><div><dt>{t('区块高度')}</dt><dd>{snapshot ? number(snapshot.height) : '—'}</dd></div><div><dt>{t('平均区块时间')}</dt><dd>{snapshot ? t('{0}秒', snapshot.blockSeconds.toLocaleString(locale(), { maximumFractionDigits: 2 })) : '—'}</dd></div><div><dt>{t('区块奖励')}</dt><dd>{snapshot ? `${number(snapshot.blockRewardQtc)} QTC` : '—'}</dd></div><div><dt>{t('全网矿工')}</dt><dd>{snapshot?.networkMiners != null ? number(snapshot.networkMiners) : '—'}</dd></div>
      </dl></article>
      <article className="pool-panel"><h2><Pickaxe size={19} />{t('矿池概况')}</h2><dl>
        <div><dt>{snapshot ? t('幸运值（近{0}块）', snapshot.luckBlocks) : t('幸运值（近{0}块）', '—')}</dt><dd>{snapshot ? percent(snapshot.luckPercent) : '—'}</dd></div><div><dt>{t('当前轮次进度')}</dt><dd>{snapshot ? percent(snapshot.roundEffortPercent) : '—'}</dd></div><div><dt>{t('预计出块时间')}</dt><dd>{snapshot ? time(snapshot.etaSeconds) : '—'}</dd></div><div><dt>{t('最近出块')}</dt><dd>{snapshot ? ago(snapshot.lastBlockAt, now) : '—'}</dd></div><div><dt>{t('活跃矿工')}</dt><dd>{snapshot ? number(snapshot.poolMiners) : '—'}</dd></div><div><dt>{t('矿机数量')}</dt><dd>{snapshot ? number(snapshot.poolWorkers) : '—'}</dd></div><div><dt>{t('累计出块')}</dt><dd>{snapshot ? number(snapshot.blocksFound) : '—'}</dd></div><div><dt>{t('24小时出块')}</dt><dd>{snapshot ? number(snapshot.blocks24h) : '—'}</dd></div><div><dt>{t('最佳份额')}</dt><dd>{snapshot ? number(snapshot.bestShare) : '—'}</dd></div><div><dt>{t('近1小时份额')}</dt><dd>{snapshot ? number(snapshot.shares1h) : '—'}</dd></div>
      </dl></article>
    </div>
    <div className="pool-ranking"><div className="pool-ranking-title"><div><h2>{t('1小时算力排行')}</h2><p>{t('矿工地址（已脱敏）')}</p></div><UsersRound size={22} /></div><div className="pool-table-wrap"><table><thead><tr><th>{t('排名')}</th><th>{t('矿工地址（已脱敏）')}</th><th>{t('矿机')}</th><th>{t('1小时算力')}</th><th>{t('每小时份额')}</th><th>{t('模式')}</th></tr></thead><tbody>{snapshot?.topMiners.map((miner, index) => <tr key={miner.address}><td className="pool-rank">#{index + 1}</td><td className="pool-address">{miner.address}</td><td>{number(miner.workers)}</td><td><strong>{formatHashrate(miner.hashrate1h, locale())}</strong></td><td>{number(miner.shares1h)}</td><td><span className={miner.solo ? 'pool-mode solo' : 'pool-mode'}>{miner.solo ? 'Solo' : t('普通')}</span></td></tr>)}</tbody></table>{!snapshot && <div className="pool-empty">{loading ? t('正在读取 Quanpool 实时数据…') : t('矿池实时数据暂不可用。')}</div>}</div></div>
    <div className="pool-source"><p><Clock3 size={15} />{snapshot ? t('数据时间：{0}。', new Date(snapshot.sourceAt).toLocaleString(locale(), { hour12: false })) : t('等待矿池数据。')}</p></div>
    <p className="pool-note">{t('矿池算力按 Quanpool 最近1小时接受的工作量计算，包含 Solo 矿机。全网算力按网络难度和实测平均区块时间估算。')} {t('矿池数据受统计窗口、难度调整和网络延迟影响，仅供实时观察。')}</p>
  </section>;
}

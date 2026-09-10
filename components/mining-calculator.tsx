import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Calculator, Cpu, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { fetchPoolSnapshot, MAX_DATA_AGE_MS, type PoolSnapshot } from '@/lib/mining/data';
import { calculateMining, toHashRate, type HashRateUnit, type MiningResult, type MiningInput } from '@/lib/mining/math';

type Device = { id: number; model: string; count: string; hash: string; unit: HashRateUnit };
const number = (value: string, label: string, max = 1e12) => {
  if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim())) throw new Error(`请填写有效的${label}。`);
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > max) throw new Error(`${label}超出有效范围。`);
  return n;
};
const fmt = (n: number | null | undefined, digits = 4) => n == null ? '—' : n > 0 && n < 10 ** -digits ? `< ${10 ** -digits}` : n.toLocaleString('zh-CN', { maximumFractionDigits: digits });
const usd = (n: number | null | undefined) => n == null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
const hashText = (n: number) => n >= 1e12 ? `${fmt(n / 1e12, 3)} TH/s` : n >= 1e9 ? `${fmt(n / 1e9, 3)} GH/s` : `${fmt(n / 1e6, 3)} MH/s`;
const shortDevice = (s: string) => s.replace(/^NVIDIA GeForce /, '');
function Numeric({ id, label, value, onChange, suffix, placeholder = '0' }: { id: string; label: string; value: string; onChange: (s: string) => void; suffix?: string; placeholder?: string }) {
  return <label className="mining-field" htmlFor={id}><span>{label}</span><div className="mining-input-unit"><input id={id} inputMode="decimal" autoComplete="off" value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} />{suffix && <span>{suffix}</span>}</div></label>;
}

export function MiningCalculator({ active }: { active: boolean }) {
  const [data, setData] = useState<PoolSnapshot | null>(null);
  const [loading, setLoading] = useState(false), [fetchError, setFetchError] = useState('');
  const [now, setNow] = useState(Date.now());
  const request = useRef<AbortController | null>(null);
  const nextId = useRef(2);
  const [devices, setDevices] = useState<Device[]>([{ id: 1, model: 'NVIDIA GeForce RTX 5090', count: '1', hash: '', unit: 'GH/s' }]);
  const [inputMode, setInputMode] = useState<'devices' | 'hash'>('devices');
  const [build, setBuild] = useState<'ours' | 'stock'>('ours');
  const [hashBasis, setHashBasis] = useState<'gross' | 'effective'>('gross');
  const [networkBasis, setNetworkBasis] = useState<'additional' | 'included'>('additional');
  const [totalHash, setTotalHash] = useState(''), [hashUnit, setHashUnit] = useState<HashRateUnit>('GH/s');
  const [uptime, setUptime] = useState('100');
  const [costMode, setCostMode] = useState<'rental' | 'owned'>('rental');
  const [rent, setRent] = useState(''), [rentUnit, setRentUnit] = useState<'day' | 'hour'>('day');
  const [watts, setWatts] = useState(''), [tariff, setTariff] = useState('');
  const [hardware, setHardware] = useState(''), [amortization, setAmortization] = useState('730');
  const [otherCost, setOtherCost] = useState(''), [price, setPrice] = useState('');
  async function refresh() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller; setLoading(true);
    try {
      const snapshot = await fetchPoolSnapshot(controller.signal);
      if (!controller.signal.aborted) { setData(snapshot); setFetchError(''); setNow(Date.now()); }
    } catch (e) {
      if (!controller.signal.aborted) setFetchError(e instanceof Error ? e.message : '无法连接 Quanpool，请稍后刷新。');
    } finally { if (request.current === controller) { request.current = null; setLoading(false); } }
  }
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 60_000);
    const clock = setInterval(() => setNow(Date.now()), 10_000);
    const visible = () => { if (document.visibilityState === 'visible') { setNow(Date.now()); void refresh(); } };
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); clearInterval(clock); document.removeEventListener('visibilitychange', visible); request.current?.abort(); request.current = null; setLoading(false); };
  }, [active]);

  const stale = !!data && Math.max(now, Date.now()) - data.sourceAt > MAX_DATA_AGE_MS;
  const updateDevice = (id: number, change: Partial<Device>) => setDevices(old => old.map(row => row.id === id ? { ...row, ...change } : row));
  let totalHs = 0, gpuCount = 0, inputError = '', costError = '', priceError = '';
  let dailyCost: number | null = null, priceUsd: number | null = null, result: MiningResult | null = null;
  let energyCost = 0, depreciationCost = 0;
  let miningInput: MiningInput | null = null;
  try {
    const online = number(uptime, '在线率', 100);
    if (inputMode === 'hash') totalHs = toHashRate(number(totalHash, '总算力'), hashUnit);
    else {
      for (const row of devices) {
        const count = number(row.count, '显卡数量', 100000);
        if (!Number.isInteger(count)) throw new Error('显卡数量必须是整数。');
        gpuCount += count;
        if (!count) continue;
        const benchmark = data?.benchmarks.find(b => b.device === row.model);
        const perGpu = row.model === 'custom' ? toHashRate(number(row.hash, '单卡算力'), row.unit) : benchmark?.[build];
        if (perGpu == null) { if (data) throw new Error('所选显卡暂无基准，请选择其他型号或填写自定义算力。'); continue; }
        totalHs += perGpu * count;
      }
    }
    if (data && !stale) { miningInput = {
      hashRateHs: totalHs, networkHashRateHs: data.networkHashRateHs,
      blockRewardQtc: data.blockRewardQtc, blockTimeSeconds: data.blockTimeSeconds,
      poolFeePercent: data.poolFeePercent, minerFeePercent: build === 'ours' ? data.minerFeePercent : 0,
      hashBasis, networkBasis, uptimePercent: online, dailyCostUsd: 0,
    }; result = calculateMining(miningInput); }
  } catch (e) { inputError = e instanceof Error ? e.message : '请检查算力输入。'; }
  try {
    const extras = otherCost.trim() ? number(otherCost, '其他每日成本') : 0;
    if (costMode === 'rental') {
      if (rent.trim()) dailyCost = number(rent, '总租金') * (rentUnit === 'hour' ? 24 : 1) + extras;
    } else if (watts.trim() && tariff.trim()) {
      energyCost = number(watts, '整套设备功率', 1e9) / 1000 * 24 * number(uptime, '在线率', 100) / 100 * number(tariff, '电价', 1e6);
      const purchase = hardware.trim() ? number(hardware, '设备购置总价') : 0;
      const days = purchase > 0 ? number(amortization, '摊销天数', 100000) : 1;
      if (days < 1) throw new Error('摊销天数至少为 1 天。');
      depreciationCost = purchase / days;
      dailyCost = energyCost + depreciationCost + extras;
    }
    if (dailyCost != null && (!Number.isFinite(dailyCost) || dailyCost > Number.MAX_SAFE_INTEGER)) throw new Error('每日成本超出有效范围。');
  } catch (e) { dailyCost = null; costError = e instanceof Error ? e.message : '请检查成本输入。'; }
  try { if (price.trim()) { priceUsd = number(price, 'QTC 价格'); if (priceUsd === 0) throw new Error('QTC 价格须大于 0。'); } }
  catch (e) { priceUsd = null; priceError = e instanceof Error ? e.message : '请检查价格。'; }
  const dailyQtc = result?.dailyQtc ?? null;
  let financials: MiningResult | null = null;
  if (result && miningInput) {
    try { financials = calculateMining({ ...miningInput, dailyCostUsd: dailyCost ?? 0, priceUsd }); }
    catch (e) { costError = e instanceof Error ? e.message : '金额超出可可靠估算的范围。'; }
  }
  const costPerQtc = dailyCost != null ? financials?.costPerQtc ?? null : null;
  const revenue = financials?.dailyRevenueUsd ?? null;
  const profit = dailyCost != null ? financials?.dailyProfitUsd ?? null : null;
  const time = data ? new Date(data.fetchedAt).toLocaleString('zh-CN', { hour12: false }) : '';

  return <section className="mining-calculator" aria-label="挖矿成本计算器">
    <div className="mining-source-bar"><div><span className={'mining-status-dot ' + (!data || stale || fetchError ? 'warning' : '')} /><span>{loading ? '正在获取 Quanpool 数据…' : stale ? '数据已过期，暂停估算' : data ? 'Quanpool 主网数据' : '等待矿池数据'}</span>{data && <small>读取于 {time} · 每分钟刷新</small>}</div><button className="mining-refresh" type="button" disabled={loading} onClick={() => void refresh()}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新数据</button></div>
    {(fetchError || stale) && <p className="notice error" role="status">{fetchError || '上次数据已超过 5 分钟，请刷新后再计算。'}{data && !stale ? ' 当前使用上次成功读取的数据；超过 5 分钟后停止估算。' : ''}</p>}
    <div className="mining-layout"><div className="mining-inputs">
      <section className="mining-card"><div className="mining-card-heading"><span className="mining-step">01</span><h2>你的挖矿设备</h2><Cpu size={19} /></div>
        <div className="mining-segment" aria-label="算力输入方式"><button type="button" aria-pressed={inputMode === 'devices'} onClick={() => setInputMode('devices')}>按显卡配置</button><button type="button" aria-pressed={inputMode === 'hash'} onClick={() => setInputMode('hash')}>直接输入总算力</button></div>
        <label className="mining-field"><span>矿工软件</span><select value={build} onChange={e => setBuild(e.target.value as typeof build)}><option value="ours">quanpool-miner · 优化版{data ? ` ${data.minerVersion}` : ''}</option><option value="stock">quantus-miner · 原版</option></select></label>
        {inputMode === 'devices' ? <div className="mining-devices">{devices.map((row, i) => {
          const benchmark = data?.benchmarks.find(b => b.device === row.model);
          return <div className="mining-device" key={row.id}><div className="mining-device-title"><span>设备 {i + 1}</span><button type="button" aria-label={`移除设备 ${i + 1}`} disabled={devices.length === 1} onClick={() => setDevices(old => old.filter(d => d.id !== row.id))}><Trash2 size={15} /></button></div>
            <div className="mining-device-fields"><label className="mining-field"><span>显卡型号</span><select aria-label={`设备 ${i + 1} 显卡型号`} value={row.model} onChange={e => updateDevice(row.id, { model: e.target.value })}>{!data && <option value="NVIDIA GeForce RTX 5090">RTX 5090（等待基准数据）</option>}{data && !data.benchmarks.some(b => b.device === row.model) && row.model !== 'custom' && <option value={row.model}>{shortDevice(row.model)}（暂无数据）</option>}{data?.benchmarks.map(b => <option key={b.device} value={b.device}>{shortDevice(b.device)}</option>)}<option value="custom">自定义 / 实测显卡</option></select></label><Numeric id={`gpu-count-${row.id}`} label="数量（张）" value={row.count} onChange={count => updateDevice(row.id, { count })} /></div>
            {row.model === 'custom' ? <div className="mining-two-fields"><Numeric id={`gpu-hash-${row.id}`} label="单张显卡算力" value={row.hash} onChange={hash => updateDevice(row.id, { hash })} /><label className="mining-field"><span>算力单位</span><select value={row.unit} onChange={e => updateDevice(row.id, { unit: e.target.value as HashRateUnit })}>{['MH/s', 'GH/s', 'TH/s'].map(u => <option key={u}>{u}</option>)}</select></label></div> : <p className="mining-hint">单卡基准 <strong>{benchmark ? hashText(benchmark[build]) : '等待获取'}</strong><span>来源：Quanpool GPU 测试</span></p>}
          </div>;
        })}<button type="button" className="mining-add" disabled={devices.length >= 20} onClick={() => setDevices(old => [...old, { id: nextId.current++, model: data?.benchmarks[0]?.device ?? 'custom', count: '1', hash: '', unit: 'GH/s' }])}><Plus size={16} />添加另一种设备</button></div> : <div className="mining-two-fields"><Numeric id="total-hash" label="所有设备合计算力" value={totalHash} onChange={setTotalHash} /><label className="mining-field"><span>算力单位</span><select value={hashUnit} onChange={e => setHashUnit(e.target.value as HashRateUnit)}>{['MH/s', 'GH/s', 'TH/s'].map(u => <option key={u}>{u}</option>)}</select></label></div>}
        <div className="mining-total"><span>{inputMode === 'devices' ? `${gpuCount} 张 GPU · 合计算力` : '合计算力'}</span><strong>{inputError ? '—' : data || inputMode === 'hash' ? hashText(totalHs) : '等待获取'}</strong></div>
        <div className="mining-two-fields"><Numeric id="mining-uptime" label="每日在线率" value={uptime} onChange={setUptime} suffix="%" /><label className="mining-field"><span>算力口径</span><select value={hashBasis} onChange={e => setHashBasis(e.target.value as typeof hashBasis)}><option value="gross">原始算力 · 需扣矿工费</option><option value="effective">有效算力 · 已扣矿工费</option></select></label></div>
        <p className="mining-hint">基准受功耗、散热及超频影响；Quanpool 未说明基准是否已扣矿工费，默认按原始算力保守估算。如果输入已扣费的矿池有效算力，请切换口径。</p>
        {inputError && <p className="mining-validation" role="status">{inputError}</p>}
      </section>

      <section className="mining-card"><div className="mining-card-heading"><span className="mining-step">02</span><h2>成本与 QTC 价格</h2><Calculator size={19} /></div>
        <div className="mining-segment" aria-label="设备成本方式"><button type="button" aria-pressed={costMode === 'rental'} onClick={() => setCostMode('rental')}>租用设备</button><button type="button" aria-pressed={costMode === 'owned'} onClick={() => setCostMode('owned')}>自有设备</button></div>
        {costMode === 'rental' ? <><div className="mining-two-fields"><Numeric id="mining-rent" label="所有设备总租金" value={rent} onChange={setRent} suffix="USD" placeholder="例如 60" /><label className="mining-field"><span>计费单位</span><select value={rentUnit} onChange={e => setRentUnit(e.target.value as typeof rentUnit)}><option value="day">每天</option><option value="hour">每小时</option></select></label></div><p className="mining-hint">填写整套设备的租金，不是单卡价格。按全天 24 小时计费，在线率降低不会自动减少租金；已含电费时无需重复计算。</p></> : <><div className="mining-two-fields"><Numeric id="mining-watts" label="整套设备运行功率" value={watts} onChange={setWatts} suffix="W" /><Numeric id="mining-tariff" label="电价" value={tariff} onChange={setTariff} suffix="USD/kWh" /></div><div className="mining-two-fields"><Numeric id="mining-hardware" label="设备购置总价（可选）" value={hardware} onChange={setHardware} suffix="USD" /><Numeric id="mining-amortization" label="摊销周期" value={amortization} onChange={setAmortization} suffix="天" /></div><p className="mining-hint">功率含显卡、主机和散热。电费按在线时长估算，停机耗电可计入其他成本；购置价按日摊销，未填写则不含折旧。</p></>}
        <Numeric id="mining-other-cost" label="其他每日成本（可选）" value={otherCost} onChange={setOtherCost} suffix="USD/天" />
        <div className="mining-price"><Numeric id="mining-price" label="你预期的 QTC 单价" value={price} onChange={setPrice} suffix="USD/QTC" placeholder="输入自己的估价" /><p className="mining-hint">此价格由你设定，用于模拟收入与盈亏。每枚挖矿成本由费用和产量决定，不随填入的币价改变。</p></div>
        {(costError || priceError) && <p className="mining-validation" role="status">{costError || priceError}</p>}
      </section>
    </div>

    <aside className="mining-results" aria-label="模拟结果"><section className="mining-result-card"><div className="mining-result-heading"><span>预计挖矿成本</span><span className="mining-tag">本地计算</span></div><div className="mining-cost" data-testid="cost-per-qtc">{usd(costPerQtc)}<span>/ QTC</span></div><p className="mining-hint">{dailyCost == null ? '先填写租金或电费，即可计算每枚成本。' : dailyQtc === 0 ? '当前预计产量为 0，无法计算每枚成本。' : !result ? '等待有效的算力与主网数据。' : '达到此 QTC 单价时，预计覆盖已填写的成本。'}</p>
      <div className="mining-result-stats"><div><span>预计每日净产量</span><strong data-testid="daily-qtc">{fmt(dailyQtc, 6)} <small>QTC</small></strong></div><div><span>每日总成本</span><strong data-testid="daily-cost">{usd(dailyCost)}</strong></div><div><span>预计每日收入</span><strong data-testid="daily-revenue">{usd(revenue)}</strong></div><div className="mining-profit"><span>预计每日盈亏</span><strong className={profit == null ? '' : profit >= 0 ? 'positive' : 'negative'} data-testid="daily-profit">{usd(profit)}</strong></div></div>
      {priceUsd == null && <p className="mining-hint">输入 QTC 单价后显示预计收入和盈亏。</p>}
      <div className="mining-periods"><div><span>7 天净产量</span><strong>{fmt(dailyQtc == null ? null : dailyQtc * 7, 5)} <small>QTC</small></strong></div><div><span>30 天净产量</span><strong>{fmt(dailyQtc == null ? null : dailyQtc * 30, 5)} <small>QTC</small></strong></div><div><span>30 天总成本</span><strong>{usd(dailyCost == null ? null : dailyCost * 30)}</strong></div><div><span>30 天预计盈亏</span><strong className={profit == null ? '' : profit >= 0 ? 'positive' : 'negative'}>{usd(profit == null ? null : profit * 30)}</strong></div></div>
      {costMode === 'owned' && dailyCost != null && <p className="mining-hint">每日电费 {usd(energyCost)} · 设备摊销 {usd(depreciationCost)} · 其他 {usd(Number(otherCost) || 0)}</p>}
      <p className="mining-assumption">按当前难度和奖励推算，非保证收益。PPLNS 的幸运值、难度变化、拒绝份额及离线都会影响实际产量；预测未计未填写的成本、卖出手续费及税费。</p>
    </section>

    <section className="mining-card mining-network"><div className="mining-card-heading"><h2>计算依据</h2><a href="https://quanpool.com/" target="_blank" rel="noopener noreferrer">Quanpool <ArrowUpRight size={14} /></a></div>
      <dl><div><dt>全网算力（难度 ÷ 区块时间）</dt><dd>{data ? hashText(data.networkHashRateHs) : '—'}</dd></div><div><dt>全网难度</dt><dd>{data ? `${fmt(data.difficulty / 1e12, 3)} T` : '—'}</dd></div><div><dt>区块奖励</dt><dd>{data ? fmt(data.blockRewardQtc, 8) + ' QTC' : '—'}</dd></div><div><dt>平均区块时间</dt><dd>{data ? fmt(data.blockTimeSeconds, 2) + ' 秒' : '—'}</dd></div><div><dt>矿池手续费</dt><dd>{data ? fmt(data.poolFeePercent, 2) + '%' : '—'}</dd></div><div><dt>本次另扣矿工软件费</dt><dd>{hashBasis === 'effective' ? '已含在有效算力中' : data ? fmt(build === 'ours' ? data.minerFeePercent : 0, 2) + '%' : '—'}</dd></div><div><dt>预计全网份额（扣费前）</dt><dd>{result ? fmt(result.networkSharePercent, 6) + '%' : '—'}</dd></div><div><dt>主网高度</dt><dd>{data ? data.height.toLocaleString() : '—'}</dd></div></dl>
      <label className="mining-field"><span>全网算力口径</span><select value={networkBasis} onChange={e => setNetworkBasis(e.target.value as typeof networkBasis)}><option value="additional">模拟新增设备（与 Quanpool 一致）</option><option value="included">已有设备（已计入当前全网）</option></select></label>
      <details className="mining-method"><summary>查看计算方法与数据来源</summary><p>日净产量 = 算力份额 × 86400 ÷ 区块时间 × 区块奖励 × 在线率 × 矿工费保留比例 × 矿池费保留比例。</p><p>{networkBasis === 'additional' ? '新增模拟的份额 = 设备算力 ÷（当前全网算力 + 设备算力），沿用 Quanpool 计算器的分母。' : '已有设备的份额 = 设备算力 ÷ 当前全网算力，不再次增加全网算力。'}</p><p>原始算力扣除矿工费后再扣矿池费；有效算力不重复扣矿工费。Quanpool 原计算器只扣矿池费，本工具默认额外考虑优化版矿工费，结果可能略低。</p><p>每枚成本 = 每日总成本 ÷ 每日净产量。每日收入 = 净产量 × 你输入的 QTC 价格；每日盈亏 = 收入 − 成本。月度按 30 天估算。</p><p>区块奖励采用矿池返回的最近一条奖励记录，列表为空时使用其条款值；这不是对未来区块奖励的承诺。</p><p>公开接口：<a href="https://quanpool.com/api/terms" target="_blank" rel="noreferrer">基准与费用</a>、<a href="https://quanpool.com/api/stats/mainnet" target="_blank" rel="noreferrer">主网难度</a>、<a href="https://quanpool.com/api/luck/mainnet" target="_blank" rel="noreferrer">区块时间</a>、<a href="https://quanpool.com/api/rounds/mainnet" target="_blank" rel="noreferrer">奖励记录</a>。</p></details>
    </section></aside></div>
    <p className="mining-privacy">计算免费，无需打开钱包。设备、成本和价格只在当前页面内计算，不上传、不保存；刷新页面将重置输入。浏览器仅向 Quanpool 请求公开数据。</p>
  </section>;
}

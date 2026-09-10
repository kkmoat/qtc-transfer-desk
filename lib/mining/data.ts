// Public, read-only pool data. Never pass wallet data or calculator inputs here.
export const POOL_DATA_URLS = [
  'https://quanpool.com/api/terms',
  'https://quanpool.com/api/stats/mainnet',
  'https://quanpool.com/api/luck/mainnet',
  'https://quanpool.com/api/rounds/mainnet',
  'https://quanpool.com/api/chains',
] as const;
export const MAX_DATA_AGE_MS = 5 * 60_000;
export type Benchmark = { device: string; ours: number; stock: number };
export type PoolSnapshot = {
  benchmarks: Benchmark[]; networkHashRateHs: number; difficulty: number;
  blockRewardQtc: number; blockTimeSeconds: number; poolFeePercent: number;
  minerFeePercent: number; minerVersion: string; height: number;
  fetchedAt: number; sourceAt: number; rewardSource: 'round' | 'terms';
};
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('矿池数据格式不符，请稍后刷新。');
  return value as Record<string, unknown>;
}
function numeric(value: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(\.\d+)?$/.test(value))) throw new Error(`${label}数据缺失。`);
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) throw new Error(`${label}数据异常。`);
  return number;
}
function reward(value: unknown): number {
  // Quantus uses 12 decimal places. Reject malformed integer base units.
  if (typeof value !== 'string' || !/^\d{1,24}$/.test(value)) throw new Error('区块奖励数据异常。');
  const qtc = Number(BigInt(value)) / 1e12;
  return numeric(qtc, '区块奖励', Number.MIN_VALUE, 1e9);
}
export function parsePoolSnapshot(payloads: unknown[], fetchedAt: number, sourceDate: number): PoolSnapshot {
  const [termsRaw, statsRaw, luckRaw, roundsRaw, chainsRaw] = payloads;
  const terms = object(termsRaw), stats = object(statsRaw), luck = object(luckRaw);
  if (!Array.isArray(chainsRaw) || !chainsRaw.some(c => c && c.name === 'mainnet' && c.mainnet === true)) throw new Error('矿池未提供已确认的主网数据。');
  if (object(stats.node).is_syncing !== false) throw new Error('矿池节点正在同步，暂不估算产量。');
  const age = numeric(stats.age_seconds, '数据更新时间', 0, 300);
  if (!Number.isFinite(sourceDate) || sourceDate > fetchedAt + 60_000 || fetchedAt - sourceDate > MAX_DATA_AGE_MS) throw new Error('矿池响应已过期，请重新获取。');
  const sourceAt = Math.min(sourceDate, fetchedAt) - age * 1000;
  if (fetchedAt - sourceAt > MAX_DATA_AGE_MS) throw new Error('矿池数据已过期，请重新获取。');
  const difficulty = numeric(object(stats.stats).network_difficulty, '全网难度', 1);
  const blockTimeSeconds = numeric(luck.block_seconds, '区块时间', 0.01, 86400);
  const networkHashRateHs = numeric(difficulty / blockTimeSeconds, '全网算力', 1);
  if (!Array.isArray(roundsRaw)) throw new Error('区块奖励列表格式不符。');
  const latest = roundsRaw.length ? object(roundsRaw[0]) : null;
  const blockRewardQtc = reward(latest?.reward ?? terms.block_reward_planck);
  if (!Array.isArray(terms.benchmarks)) throw new Error('显卡基准数据缺失。');
  const benchmarks = terms.benchmarks.slice(0, 100).map(raw => {
    const row = object(raw);
    if (typeof row.device !== 'string' || !row.device.trim() || row.device.length > 100) throw new Error('显卡型号数据异常。');
    return { device: row.device, ours: numeric(row.ours, '优化版算力', 1), stock: numeric(row.stock, '原版算力', 1) };
  });
  if (new Set(benchmarks.map(b => b.device)).size !== benchmarks.length) throw new Error('显卡型号重复，请刷新矿池数据。');
  return {
    benchmarks, networkHashRateHs, difficulty, blockRewardQtc, blockTimeSeconds,
    poolFeePercent: numeric(terms.fee_percent, '矿池费率', 0, 99.99),
    minerFeePercent: numeric(terms.miner_dev_fee_percent, '矿工费率', 0, 99.99),
    minerVersion: typeof terms.miner_version === 'string' ? terms.miner_version.slice(0, 30) : '未知版本',
    height: numeric(stats.tip_height, '区块高度', 1), fetchedAt, sourceAt,
    rewardSource: latest?.reward != null ? 'round' : 'terms',
  };
}
export async function fetchPoolSnapshot(signal: AbortSignal): Promise<PoolSnapshot> {
  const responses = await Promise.all(POOL_DATA_URLS.map(async url => {
    const response = await fetch(url, {
      method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
      referrerPolicy: 'no-referrer', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok) throw new Error(`矿池接口暂不可用（HTTP ${response.status}），请稍后刷新。`);
    const date = Date.parse(response.headers.get('date') ?? '');
    if (!Number.isFinite(date) || Date.now() - date > MAX_DATA_AGE_MS || date > Date.now() + 60_000) throw new Error('矿池响应时间缺失或已过期。');
    const body = await response.text();
    if (body.length > 1_000_000) throw new Error('矿池响应超出预期大小。');
    return { data: JSON.parse(body) as unknown, date };
  }));
  return parsePoolSnapshot(responses.map(r => r.data), Date.now(), Math.min(...responses.map(r => r.date)));
}

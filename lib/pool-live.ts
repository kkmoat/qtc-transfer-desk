export const POOL_LIVE_URLS = [
  'https://quanpool.com/api/stats/mainnet',
  'https://quanpool.com/api/luck/mainnet',
  'https://quanpool.com/api/terms',
  'https://quanpool.com/api/miners/mainnet',
  'https://quanpool.com/api/chains',
] as const;
export const POOL_REFRESH_MS = 30_000;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_DATA_AGE_MS = 5 * 60_000;

export type PoolMiner = {
  address: string;
  workers: number;
  hashrate1h: number;
  shares1h: number;
  solo: boolean;
};

export type PoolLiveSnapshot = {
  poolHashrateHs: number;
  networkHashrateHs: number;
  poolSharePercent: number;
  difficulty: number;
  height: number;
  blockSeconds: number;
  blockRewardQtc: number;
  networkMiners: number;
  poolMiners: number;
  poolWorkers: number;
  blocksFound: number;
  blocks24h: number;
  bestShare: bigint;
  shares1h: number;
  luckBlocks: number;
  luckPercent: number;
  roundEffortPercent: number;
  etaSeconds: number;
  lastBlockAt: number;
  sourceAt: number;
  fetchedAt: number;
  topMiners: PoolMiner[];
};

const invalid = (_detail = '') => new Error('矿池实时数据暂不可用。');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('格式异常');
  return value as Record<string, unknown>;
};
const numeric = (value: unknown, detail: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) throw invalid(detail);
  const result = Number(value);
  if (!Number.isFinite(result) || result < min || result > max) throw invalid(detail);
  return result;
};
const integer = (value: unknown, detail: string, min = 0, max = Number.MAX_SAFE_INTEGER) => {
  const result = numeric(value, detail, min, max);
  if (!Number.isSafeInteger(result)) throw invalid(detail);
  return result;
};
const planckQtc = (value: unknown) => {
  if (typeof value !== 'string' || !/^\d{1,24}$/.test(value)) throw invalid('区块奖励异常');
  return numeric(Number(BigInt(value)) / 1e12, '区块奖励异常', Number.MIN_VALUE, 1e9);
};
const maskedAddress = (value: unknown) => {
  if (typeof value !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{8,16}…[1-9A-HJ-NP-Za-km-z]{5,12}$/.test(value)) throw invalid('矿工地址异常');
  return value;
};

export function parsePoolLive(payloads: unknown[], fetchedAt: number, sourceDate: number): PoolLiveSnapshot {
  if (payloads.length !== POOL_LIVE_URLS.length || !Number.isSafeInteger(fetchedAt) || fetchedAt < 1) throw invalid('响应不完整');
  const [statsRaw, luckRaw, termsRaw, minersRaw, chainsRaw] = payloads;
  const stats = object(statsRaw), luck = object(luckRaw), terms = object(termsRaw), detail = object(stats.stats);
  if (!Array.isArray(chainsRaw) || !chainsRaw.some(chain => chain && typeof chain === 'object' && (chain as Record<string, unknown>).name === 'mainnet' && (chain as Record<string, unknown>).mainnet === true)) throw invalid('主网未确认');
  if (object(stats.node).is_syncing !== false) throw invalid('节点正在同步');
  const ageSeconds = numeric(stats.age_seconds, '更新时间异常', 0, 300);
  if (!Number.isFinite(sourceDate) || sourceDate > fetchedAt + 60_000 || fetchedAt - sourceDate > MAX_DATA_AGE_MS) throw invalid('响应已过期');
  const sourceAt = Math.min(fetchedAt, sourceDate) - ageSeconds * 1000;
  if (fetchedAt - sourceAt > MAX_DATA_AGE_MS) throw invalid('数据已过期');

  const difficulty = numeric(detail.network_difficulty, '全网难度异常', 1);
  const blockSeconds = numeric(luck.block_seconds, '区块时间异常', 0.01, 86_400);
  const networkHashrateHs = numeric(difficulty / blockSeconds, '全网算力异常', 1);
  const windows = stats.hashrate_windows;
  if (!Array.isArray(windows)) throw invalid('矿池算力异常');
  const workFallback = numeric(detail.work_last_hour, '矿池工作量异常', 1, Number.MAX_VALUE) / 3600;
  const poolHashrateHs = numeric(typeof windows[1] === 'number' && windows[1] > 0 ? windows[1] : workFallback, '矿池算力异常', 1);
  const poolSharePercent = Math.min(poolHashrateHs / networkHashrateHs, 1) * 100;

  const luckWindows = luck.windows;
  if (!Array.isArray(luckWindows) || !luckWindows.length) throw invalid('幸运值异常');
  const luckWindow = object(luckWindows.find(row => row && typeof row === 'object' && (row as Record<string, unknown>).blocks === 50) ?? luckWindows[0]);
  const lastBlockAt = Date.parse(String(detail.last_block_at ?? ''));
  if (!Number.isFinite(lastBlockAt) || lastBlockAt > fetchedAt + 60_000 || fetchedAt - lastBlockAt > 365 * 24 * 3600_000) throw invalid('最近出块时间异常');
  if (!Array.isArray(minersRaw) || minersRaw.length > 2_000) throw invalid('矿工列表异常');
  const topMiners = minersRaw.map(raw => {
    const miner = object(raw);
    const lastSeen = Date.parse(String(miner.last_seen ?? ''));
    if (!Number.isFinite(lastSeen) || lastSeen > fetchedAt + 60_000 || fetchedAt - lastSeen > 30 * 24 * 3600_000) throw invalid('矿工时间异常');
    if (typeof miner.solo !== 'boolean') throw invalid('矿工模式异常');
    return {
      address: maskedAddress(miner.payout_addr),
      workers: integer(miner.workers, '矿机数量异常', 0, 1_000_000),
      hashrate1h: numeric(miner.hashrate_1h, '矿工算力异常', 0),
      shares1h: integer(miner.shares_last_hour, '份额数量异常', 0),
      solo: miner.solo,
    };
  }).filter(miner => miner.hashrate1h > 0).sort((a, b) => b.hashrate1h - a.hashrate1h).slice(0, 20);

  return {
    poolHashrateHs, networkHashrateHs, poolSharePercent, difficulty,
    height: integer(stats.tip_height, '区块高度异常', 1), blockSeconds,
    blockRewardQtc: planckQtc(terms.block_reward_planck),
    networkMiners: integer(stats.network_miners, '全网矿工数异常', 0, 10_000_000),
    poolMiners: integer(detail.miners_active, '矿池矿工数异常', 0, 10_000_000),
    poolWorkers: integer(detail.workers_total, '矿机数异常', 0, 100_000_000),
    blocksFound: integer(detail.blocks_found, '累计出块异常', 0),
    blocks24h: integer(stats.blocks_24h, '24小时出块异常', 0),
    bestShare: typeof detail.best_share === 'string' && /^\d{1,40}$/.test(detail.best_share) ? BigInt(detail.best_share) : (() => { throw invalid('最佳份额异常'); })(),
    shares1h: integer(detail.shares_last_hour, '每小时份额异常', 0),
    luckBlocks: integer(luckWindow.blocks, '幸运值区间异常', 1, 100_000),
    luckPercent: numeric(luckWindow.luck_percent, '幸运值异常', 0, 10_000),
    roundEffortPercent: numeric(luck.round_progress_percent, '当前轮次异常', 0, 100_000),
    etaSeconds: numeric(difficulty / poolHashrateHs, '预计出块时间异常', 0, 365 * 24 * 3600),
    lastBlockAt, sourceAt, fetchedAt, topMiners,
  };
}

export async function fetchPoolLive(signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<PoolLiveSnapshot> {
  try {
    const responses = await Promise.all(POOL_LIVE_URLS.map(async url => {
      const response = await fetcher(url, {
        method: 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
        referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      });
      if (!response.ok) throw invalid(`HTTP ${response.status}`);
      const date = Date.parse(response.headers.get('date') ?? '');
      if (!Number.isFinite(date)) throw invalid('响应时间缺失');
      const body = await response.text();
      if (!body.length || body.length > MAX_RESPONSE_BYTES) throw invalid('响应大小异常');
      return { value: JSON.parse(body) as unknown, date };
    }));
    return parsePoolLive(responses.map(response => response.value), Date.now(), Math.min(...responses.map(response => response.date)));
  } catch (error) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    if (error instanceof Error && error.message.startsWith('矿池实时数据')) throw error;
    throw invalid();
  }
}

export function formatHashrate(value: number, language = 'zh-CN'): string {
  if (!Number.isFinite(value) || value < 0) return '—';
  const units = ['H/s', 'kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s'];
  let scaled = value, index = 0;
  while (scaled >= 1000 && index < units.length - 1) { scaled /= 1000; index++; }
  const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toLocaleString(language, { maximumFractionDigits: digits })} ${units[index]}`;
}

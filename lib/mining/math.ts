export type HashRateUnit = 'MH/s' | 'GH/s' | 'TH/s';
export type HashBasis = 'gross' | 'effective';
export type NetworkBasis = 'additional' | 'included';

export interface MiningInput {
  hashRateHs: number;
  networkHashRateHs: number;
  blockRewardQtc: number;
  blockTimeSeconds: number;
  poolFeePercent: number;
  minerFeePercent: number;
  /** effective 表示算力已扣除矿工软件费，不再重复扣费。 */
  hashBasis: HashBasis;
  /** additional 模拟新增算力；included 表示个人算力已计入全网。 */
  networkBasis?: NetworkBasis;
  uptimePercent: number;
  dailyCostUsd: number;
  priceUsd?: number | null;
}

export interface MiningResult {
  dailyQtc: number;
  /** 已计入在线率、尚未扣除矿工软件费和矿池费的理论日产量。 */
  grossDailyQtc: number;
  dailyCostUsd: number;
  costPerQtc: number | null;
  dailyRevenueUsd: number | null;
  dailyProfitUsd: number | null;
  networkSharePercent: number;
}

// 收益属于浮点估算；限制输入和输出规模，避免将溢出当作有效估算展示。
const MAX_VALUE = Number.MAX_SAFE_INTEGER;
const SECONDS_PER_DAY = 86_400;

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}必须是有限数字。`);
  }
  if (value < 0 || value > MAX_VALUE) {
    throw new Error(`${label}必须在 0 到 ${MAX_VALUE} 之间。`);
  }
  return value === 0 ? 0 : value;
}

function positive(value: unknown, label: string): number {
  const result = nonnegative(value, label);
  if (result === 0) throw new Error(`${label}必须大于 0。`);
  return result;
}

function fee(value: unknown, label: string): number {
  const result = nonnegative(value, label);
  if (result >= 100) throw new Error(`${label}必须大于等于 0 且小于 100%。`);
  return result;
}

function finiteResult(value: number, label: string): number {
  if (!Number.isFinite(value) || Math.abs(value) > MAX_VALUE) {
    throw new Error(`${label}超出可可靠计算的范围，请调整输入数值。`);
  }
  return value === 0 ? 0 : value;
}

export function toHashRate(value: number, unit: HashRateUnit): number {
  const amount = nonnegative(value, '算力');
  let multiplier: number;
  switch (unit) {
    case 'MH/s': multiplier = 1_000_000; break;
    case 'GH/s': multiplier = 1_000_000_000; break;
    case 'TH/s': multiplier = 1_000_000_000_000; break;
    default: throw new Error('算力单位必须是 MH/s、GH/s 或 TH/s。');
  }
  return nonnegative(amount * multiplier, '换算后的算力');
}

export function calculateMining(input: MiningInput): MiningResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('请提供完整的挖矿计算参数。');
  }
  const hashRateHs = nonnegative(input.hashRateHs, '个人算力');
  const networkHashRateHs = positive(input.networkHashRateHs, '全网算力');
  const blockRewardQtc = positive(input.blockRewardQtc, '区块奖励');
  const blockTimeSeconds = positive(input.blockTimeSeconds, '出块时间');
  const poolFeePercent = fee(input.poolFeePercent, '矿池费率');
  const minerFeePercent = fee(input.minerFeePercent, '矿工软件费率');
  const uptimePercent = nonnegative(input.uptimePercent, '在线率');
  if (uptimePercent > 100) throw new Error('在线率必须在 0 到 100% 之间。');
  const dailyCostUsd = nonnegative(input.dailyCostUsd, '每日成本');
  const priceUsd = input.priceUsd == null ? null : nonnegative(input.priceUsd, 'QTC 单价');
  if (input.hashBasis !== 'gross' && input.hashBasis !== 'effective') {
    throw new Error('算力口径必须选择原始算力或已扣矿工软件费的有效算力。');
  }
  const networkBasis = input.networkBasis === undefined ? 'additional' : input.networkBasis;
  if (networkBasis !== 'additional' && networkBasis !== 'included') {
    throw new Error('全网算力口径必须选择新增算力或已计入全网的已有算力。');
  }
  if (networkBasis === 'included' && hashRateHs > networkHashRateHs) {
    throw new Error('已有个人算力不能超过全网算力。');
  }

  const totalHashRateHs = networkBasis === 'additional'
    ? networkHashRateHs + hashRateHs
    : networkHashRateHs;
  const share = hashRateHs / totalHashRateHs;
  const grossDailyQtc = hashRateHs === 0 || uptimePercent === 0
    ? 0
    : finiteResult(
      share * SECONDS_PER_DAY / blockTimeSeconds * blockRewardQtc * (uptimePercent / 100),
      '理论日产量',
    );
  const minerMultiplier = input.hashBasis === 'gross' ? 1 - minerFeePercent / 100 : 1;
  const dailyQtc = finiteResult(grossDailyQtc * minerMultiplier * (1 - poolFeePercent / 100), '净日产量');
  if (hashRateHs > 0 && uptimePercent > 0 && dailyQtc === 0) {
    throw new Error('预计产量过小，无法可靠计算，请调整输入数值。');
  }
  const costPerQtc = dailyQtc > 0 ? finiteResult(dailyCostUsd / dailyQtc, '每 QTC 成本') : null;
  const dailyRevenueUsd = priceUsd !== null && priceUsd > 0
    ? finiteResult(dailyQtc * priceUsd, '每日收入')
    : null;
  const dailyProfitUsd = dailyRevenueUsd === null
    ? null
    : finiteResult(dailyRevenueUsd - dailyCostUsd, '每日利润');

  return {
    dailyQtc,
    grossDailyQtc,
    dailyCostUsd,
    costPerQtc,
    dailyRevenueUsd,
    dailyProfitUsd,
    networkSharePercent: finiteResult(share * 100, '全网算力占比'),
  };
}

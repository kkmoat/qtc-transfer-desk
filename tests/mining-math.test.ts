import test from 'node:test';
import assert from 'node:assert/strict';
import {calculateMining, toHashRate, type MiningInput, type HashRateUnit} from '../lib/mining/math.ts';

const sample: MiningInput = {
  hashRateHs: 1.12e9,
  networkHashRateHs: 12.20e12,
  blockRewardQtc: 0.2979,
  blockTimeSeconds: 12.5,
  poolFeePercent: 1,
  minerFeePercent: 5,
  hashBasis: 'gross',
  uptimePercent: 100,
  dailyCostUsd: 3,
};

function close(actual: number | null, expected: number): void {
  assert.notEqual(actual, null);
  assert.ok(Math.abs(actual! - expected) <= Math.max(1e-15, Math.abs(expected) * 1e-12), `${actual} != ${expected}`);
}

test('1.12 GH/s sample matches independent decimal reference values for added hashrate', () => {
  const result = calculateMining(sample);
  close(result.networkSharePercent, 0.009179485162017913);
  close(result.grossDailyQtc, 0.189013383689366222);
  close(result.dailyQtc, 0.177767087359848932);
  close(result.costPerQtc, 16.8760148155388522);
  assert.equal(result.dailyCostUsd, 3);
  assert.equal(result.dailyRevenueUsd, null);
  assert.equal(result.dailyProfitUsd, null);
});

test('included hashrate uses the existing network, while additional hashrate expands it', () => {
  const result = calculateMining({...sample, networkBasis: 'included'});
  close(result.networkSharePercent, 0.009180327868852459);
  close(result.grossDailyQtc, 0.189030735737704918);
  close(result.dailyQtc, 0.177783406961311475);
  const wholeNetwork = {...sample, hashRateHs: 1, networkHashRateHs: 1};
  assert.equal(calculateMining({...wholeNetwork, networkBasis: 'included'}).networkSharePercent, 100);
  assert.equal(calculateMining({...wholeNetwork, networkBasis: 'additional'}).networkSharePercent, 50);
  assert.throws(() => calculateMining({...wholeNetwork, hashRateHs: 2, networkBasis: 'included'}), /个人算力不能超过全网/);
  close(calculateMining({...wholeNetwork, hashRateHs: 2, networkBasis: 'additional'}).networkSharePercent, 200 / 3);
});

test('coin price changes revenue and profit but never QTC production or cost per QTC', () => {
  const low = calculateMining({...sample, priceUsd: 10});
  const high = calculateMining({...sample, priceUsd: 20});
  assert.equal(low.dailyQtc, high.dailyQtc);
  assert.equal(low.costPerQtc, high.costPerQtc);
  close(low.dailyRevenueUsd, 1.77767087359848932);
  close(low.dailyProfitUsd, -1.22232912640151068);
  close(high.dailyRevenueUsd, 3.55534174719697864);
  close(high.dailyProfitUsd, 0.55534174719697864);
  for (const priceUsd of [undefined, null, 0]) {
    const result = calculateMining({...sample, priceUsd});
    assert.equal(result.dailyRevenueUsd, null);
    assert.equal(result.dailyProfitUsd, null);
    assert.equal(result.costPerQtc, low.costPerQtc);
  }
});

test('effective hashrate does not pay the miner software fee twice; pool fee still applies', () => {
  const result = calculateMining({...sample, hashBasis: 'effective'});
  close(result.dailyQtc, 0.187123249852472560);
  assert.deepEqual(result, calculateMining({...sample, hashBasis: 'effective', minerFeePercent: 99}));
  assert.ok(result.dailyQtc > calculateMining(sample).dailyQtc);
  close(calculateMining({...sample, hashBasis: 'effective', poolFeePercent: 0}).dailyQtc, result.grossDailyQtc);
});

test('uptime scales production and cost per QTC, without changing hashrate share', () => {
  const full = calculateMining(sample);
  const half = calculateMining({...sample, uptimePercent: 50});
  close(half.dailyQtc, full.dailyQtc / 2);
  close(half.grossDailyQtc, full.grossDailyQtc / 2);
  close(half.costPerQtc, full.costPerQtc! * 2);
  assert.equal(half.networkSharePercent, full.networkSharePercent);
});

test('zero cost is valid, and zero production has no cost-per-coin denominator', () => {
  const free = calculateMining({...sample, dailyCostUsd: 0, priceUsd: 20});
  assert.equal(free.costPerQtc, 0);
  assert.equal(free.dailyProfitUsd, free.dailyRevenueUsd);
  for (const patch of [{hashRateHs: 0}, {uptimePercent: 0}]) {
    const result = calculateMining({...sample, ...patch, priceUsd: 20});
    assert.equal(result.dailyQtc, 0);
    assert.equal(result.grossDailyQtc, 0);
    assert.equal(result.costPerQtc, null);
    assert.equal(result.dailyRevenueUsd, 0);
    assert.equal(result.dailyProfitUsd, -3);
  }
  assert.equal(calculateMining({...sample, hashRateHs: 0, dailyCostUsd: 0}).costPerQtc, null);
  assert.equal(calculateMining({...sample, uptimePercent: 0, blockTimeSeconds: Number.MIN_VALUE}).dailyQtc, 0);
});

test('MH/s, GH/s and TH/s convert using decimal SI multipliers', () => {
  assert.equal(toHashRate(1.12, 'GH/s'), 1_120_000_000);
  assert.equal(toHashRate(1120, 'MH/s'), toHashRate(1.12, 'GH/s'));
  assert.equal(toHashRate(12.20, 'TH/s'), 12_200_000_000_000);
  assert.equal(toHashRate(0, 'MH/s'), 0);
  for (const value of [-1, NaN, Infinity, -Infinity, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => toHashRate(value, 'TH/s'), /算力/);
  }
  assert.throws(() => toHashRate(1, 'KH/s' as HashRateUnit), /算力单位/);
  assert.throws(() => toHashRate('1' as unknown as number, 'GH/s'), /有限数字/);
});

test('numeric inputs reject non-finite, negative and excessive values', () => {
  const fields = [
    'hashRateHs', 'networkHashRateHs', 'blockRewardQtc', 'blockTimeSeconds',
    'poolFeePercent', 'minerFeePercent', 'uptimePercent', 'dailyCostUsd', 'priceUsd',
  ] as const;
  for (const field of fields) {
    for (const value of [NaN, Infinity, -Infinity, -1, Number.MAX_VALUE, Number.MAX_SAFE_INTEGER + 1, '1']) {
      assert.throws(() => calculateMining({...sample, [field]: value} as MiningInput), /必须/, `${field}=${value}`);
    }
  }
  for (const field of ['networkHashRateHs', 'blockRewardQtc', 'blockTimeSeconds'] as const) {
    assert.throws(() => calculateMining({...sample, [field]: 0}), /必须大于 0/);
  }
  for (const field of ['poolFeePercent', 'minerFeePercent'] as const) {
    assert.throws(() => calculateMining({...sample, [field]: 100}), /小于 100/);
    assert.doesNotThrow(() => calculateMining({...sample, [field]: 0}));
  }
  assert.throws(() => calculateMining({...sample, uptimePercent: 100.1}), /在线率/);
  assert.throws(() => calculateMining({...sample, hashBasis: 'other'} as unknown as MiningInput), /算力口径/);
  assert.throws(() => calculateMining({...sample, networkBasis: 'other'} as unknown as MiningInput), /全网算力口径/);
  assert.throws(() => calculateMining(null as unknown as MiningInput), /完整的挖矿计算参数/);
});

test('overflow and underflow cannot escape as misleading estimates', () => {
  assert.throws(() => calculateMining({...sample, blockTimeSeconds: Number.MIN_VALUE}), /理论日产量.*范围/);
  assert.throws(() => calculateMining({...sample, hashRateHs: sample.networkHashRateHs, blockRewardQtc: Number.MAX_SAFE_INTEGER}), /理论日产量.*范围/);
  assert.throws(() => calculateMining({...sample, dailyCostUsd: Number.MAX_SAFE_INTEGER}), /每 QTC 成本.*范围/);
  assert.throws(() => calculateMining({...sample, hashRateHs: sample.networkHashRateHs, priceUsd: Number.MAX_SAFE_INTEGER}), /每日收入.*范围/);
  assert.throws(() => calculateMining({...sample, hashRateHs: Number.MIN_VALUE}), /预计产量过小/);
});

test('calculation is pure and does not mutate its input', () => {
  const input = Object.freeze({...sample});
  const before = JSON.stringify(input);
  assert.deepEqual(calculateMining(input), calculateMining(input));
  assert.equal(JSON.stringify(input), before);
});

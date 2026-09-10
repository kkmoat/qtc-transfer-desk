import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_DATA_AGE_MS, POOL_DATA_URLS, fetchPoolSnapshot, parsePoolSnapshot } from '../lib/mining/data.ts';

// Synthetic public-schema fixtures. No wallet addresses or live miner records.
const NOW = Date.UTC(2026, 8, 10, 4, 0, 0);
type Row = Record<string, unknown>;
function fixtures(): unknown[] {
  return [
    { fee_percent: 1, miner_dev_fee_percent: 5, miner_version: '6.0.0', block_reward_planck: '300000000000', benchmarks: [{ device: 'Example GPU', ours: 1_500_000_000, stock: 300_000_000 }] },
    { age_seconds: 2, tip_height: 100, node: { is_syncing: false }, stats: { network_difficulty: '120000000000000' }, hashrate_windows: [1, 2, 3] },
    { block_seconds: 12 },
    [{ reward: '250000000000', height: 90, status: 'confirmed', found_at: '2026-09-10T03:30:00Z' }],
    [{ name: 'mainnet', mainnet: true }],
  ];
}
function row(payloads: unknown[], index: number): Row { return payloads[index] as Row; }
function parse(payloads = fixtures(), fetchedAt = NOW, sourceDate = NOW) { return parsePoolSnapshot(payloads, fetchedAt, sourceDate); }
function jsonResponse(value: unknown, date = NOW, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { date: new Date(date).toUTCString(), 'content-type': 'application/json' } });
}

test('real response shape converts 12-place rewards and derives network hashrate from difficulty/time', () => {
  const result = parse();
  assert.equal(result.blockRewardQtc, 0.25);
  assert.equal(result.difficulty, 120_000_000_000_000);
  assert.equal(result.blockTimeSeconds, 12);
  assert.equal(result.networkHashRateHs, 10_000_000_000_000);
  assert.notEqual(result.networkHashRateHs, 2, 'pool window is not network hashrate');
  assert.equal(result.benchmarks[0].ours, 1_500_000_000, 'benchmark units remain H/s');
  assert.equal(result.poolFeePercent, 1);
  assert.equal(result.minerFeePercent, 5);
  assert.equal(result.height, 100);
  assert.equal(result.rewardSource, 'round');
  assert.equal(result.sourceAt, NOW - 2000);
  assert.equal(result.fetchedAt, NOW);
});

test('a single planck is 0.000000000001 QTC, not zero or one QTC', () => {
  const p = fixtures(); p[3] = [{ reward: '1' }];
  assert.equal(parse(p).blockRewardQtc, 1e-12);
});

test('latest confirmed round reward wins, but empty or missing reward falls back to terms', () => {
  const p = fixtures();
  p[3] = [{ reward: '200000000000' }, { reward: '900000000000' }];
  assert.equal(parse(p).blockRewardQtc, 0.2);
  for (const rounds of [[], [{}], [{ reward: null }]]) {
    p[3] = rounds;
    assert.equal(parse(p).blockRewardQtc, 0.3);
    assert.equal(parse(p).rewardSource, 'terms');
  }
});

test('old confirmed-round timestamps do not imply that the current network snapshot is stale', () => {
  const p = fixtures(); p[3] = [{ reward: '250000000000', found_at: '2000-01-01T00:00:00Z' }];
  assert.equal(parse(p).blockRewardQtc, 0.25);
  assert.equal(parse(p).sourceAt, NOW - 2000);
});

test('malformed round reward fails closed instead of silently using a different reward', () => {
  for (const value of ['0', 250000000000, '', '-1', '1.5', '1e12', ' 250000000000', '9'.repeat(25), '999999999999999999999999']) {
    const p = fixtures(); p[3] = [{ reward: value }];
    assert.throws(() => parse(p), /奖励/);
  }
  for (const rounds of [null, {}, 'rounds', [null]]) {
    const p = fixtures(); p[3] = rounds;
    assert.throws(() => parse(p));
  }
  const missing = fixtures(); missing[3] = []; delete row(missing, 0).block_reward_planck;
  assert.throws(() => parse(missing), /奖励/);
});

test('difficulty and measured block time are required positive finite values', () => {
  for (const value of [undefined, null, 0, '0', -1, NaN, Infinity, '', '1e14', 'NaN', {}, Number.MAX_SAFE_INTEGER + 1]) {
    const p = fixtures(); (row(p, 1).stats as Row).network_difficulty = value;
    assert.throws(() => parse(p), /难度/);
  }
  for (const value of [undefined, null, 0, '0', -1, NaN, Infinity, 86401, 'bad']) {
    const p = fixtures(); row(p, 2).block_seconds = value;
    assert.throws(() => parse(p), /区块时间/);
  }
  const p = fixtures(); (row(p, 1).stats as Row).network_difficulty = '1'; row(p, 2).block_seconds = 12;
  assert.throws(() => parse(p), /全网算力/);
});

test('fees cannot disappear, become negative, exceed 100%, or silently default to zero', () => {
  for (const field of ['fee_percent', 'miner_dev_fee_percent']) {
    for (const value of [undefined, null, '', -1, 100, NaN, Infinity, 'bad']) {
      const p = fixtures(); row(p, 0)[field] = value;
      assert.throws(() => parse(p), /费率/);
    }
  }
  const p = fixtures(); row(p, 0).fee_percent = 0; row(p, 0).miner_dev_fee_percent = 0;
  assert.equal(parse(p).poolFeePercent, 0);
  assert.equal(parse(p).minerFeePercent, 0);
});

test('missing top-level payloads, nested stats, and invalid heights are rejected', () => {
  for (const index of [0, 1, 2]) {
    for (const value of [undefined, null, [], 'bad']) {
      const p = fixtures(); p[index] = value;
      assert.throws(() => parse(p));
    }
  }
  const p = fixtures(); row(p, 1).stats = null;
  assert.throws(() => parse(p));
  for (const value of [undefined, 0, -1, NaN, Infinity, 'bad']) {
    const p = fixtures(); row(p, 1).tip_height = value;
    assert.throws(() => parse(p), /高度/);
  }
});

test('only explicitly identified mainnet data is accepted', () => {
  for (const chains of [undefined, null, {}, [], [{ name: 'planck', mainnet: false }], [{ name: 'mainnet', mainnet: false }], [{ name: 'mainnet', mainnet: 'true' }], [{ mainnet: true }]]) {
    const p = fixtures(); p[4] = chains;
    assert.throws(() => parse(p), /主网/);
  }
  const p = fixtures(); p[4] = [null, { name: 'planck', mainnet: false }, { name: 'mainnet', mainnet: true }];
  assert.equal(parse(p).height, 100);
});

test('syncing, missing or ambiguous node health cannot produce a live estimate', () => {
  for (const value of [true, undefined, null, 'false', 0]) {
    const p = fixtures(); row(p, 1).node = { is_syncing: value };
    assert.throws(() => parse(p), /同步/);
  }
  const p = fixtures(); delete row(p, 1).node;
  assert.throws(() => parse(p));
});

test('snapshot age combines cache response Date with the source age and accepts the exact boundary', () => {
  const p = fixtures(); row(p, 1).age_seconds = 300;
  assert.equal(parse(p).sourceAt, NOW - MAX_DATA_AGE_MS);
  assert.throws(() => parse(p, NOW, NOW - 1), /过期/);
  row(p, 1).age_seconds = 10;
  assert.equal(parse(p, NOW, NOW - 20_000).sourceAt, NOW - 30_000);
  assert.equal(parse(p, NOW, NOW + 60_000).sourceAt, NOW - 10_000, 'allowed server clock skew never makes data newer than fetchedAt');
});

test('missing age, stale response times and excessive future clock skew fail closed', () => {
  for (const value of [undefined, null, -1, 300.001, NaN, Infinity, 'bad']) {
    const p = fixtures(); row(p, 1).age_seconds = value;
    assert.throws(() => parse(p), /更新时间/);
  }
  for (const sourceDate of [NaN, Infinity, NOW + 60_001, NOW - MAX_DATA_AGE_MS - 1]) {
    assert.throws(() => parse(fixtures(), NOW, sourceDate), /过期/);
  }
});

test('malformed, duplicate or nonpositive GPU benchmark rows are rejected', () => {
  for (const value of [undefined, null, {}, 'benchmarks', [null], [{ device: '', ours: 1, stock: 1 }], [{ device: '  ', ours: 1, stock: 1 }], [{ device: 'x'.repeat(101), ours: 1, stock: 1 }], [{ device: 123, ours: 1, stock: 1 }]]) {
    const p = fixtures(); row(p, 0).benchmarks = value;
    assert.throws(() => parse(p));
  }
  for (const field of ['ours', 'stock']) {
    for (const value of [undefined, 0, -1, NaN, Infinity, 'bad']) {
      const p = fixtures(); row(p, 0).benchmarks = [{ device: 'Example GPU', ours: 1, stock: 1, [field]: value }];
      assert.throws(() => parse(p), /算力/);
    }
  }
  const p = fixtures(); row(p, 0).benchmarks = [{ device: 'Example GPU', ours: 1, stock: 1 }, { device: 'Example GPU', ours: 2, stock: 2 }];
  assert.throws(() => parse(p), /重复/);
  row(p, 0).benchmarks = [];
  assert.deepEqual(parse(p).benchmarks, [], 'no GPU presets still permits manual hashrate');
});

test('parsing leaves caller-owned fixtures untouched and returns only public fields', () => {
  const p = fixtures(), before = JSON.stringify(p);
  const result = parse(p);
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(Object.keys(result).sort(), ['benchmarks','blockRewardQtc','blockTimeSeconds','difficulty','fetchedAt','height','minerFeePercent','minerVersion','networkHashRateHs','poolFeePercent','rewardSource','sourceAt'].sort());
});

test('browser fetch uses only fixed public URLs with CORS, no cookies, referrer, body or redirect', async t => {
  t.mock.method(Date, 'now', () => NOW);
  const payloads = fixtures();
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const index = POOL_DATA_URLS.indexOf(String(url) as typeof POOL_DATA_URLS[number]);
    assert.ok(index >= 0);
    calls.push(String(url));
    assert.equal(init?.method, 'GET'); assert.equal(init?.mode, 'cors');
    assert.equal(init?.credentials, 'omit'); assert.equal(init?.referrerPolicy, 'no-referrer');
    assert.equal(init?.redirect, 'error'); assert.equal(init?.cache, 'no-store');
    assert.equal(init?.body, undefined); assert.equal(init?.headers, undefined);
    assert.ok(init?.signal instanceof AbortSignal);
    return jsonResponse(payloads[index], index === 0 ? NOW - 1000 : NOW);
  });
  const result = await fetchPoolSnapshot(new AbortController().signal);
  assert.deepEqual(calls.sort(), [...POOL_DATA_URLS].sort());
  assert.equal(result.blockRewardQtc, 0.25);
  assert.equal(result.sourceAt, NOW - 3000, 'oldest response Date and snapshot age are both included');
});

test('HTTP failures and non-JSON challenge pages never become calculator data', async t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const status of [400, 403, 429, 500]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('Public API unavailable', { status }));
    await assert.rejects(fetchPoolSnapshot(new AbortController().signal), new RegExp(`HTTP ${status}`));
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>challenge page</html>', { headers: { date: new Date(NOW).toUTCString() } }));
  await assert.rejects(fetchPoolSnapshot(new AbortController().signal), SyntaxError);
});

test('missing/unexposed Date, stale dates and excessive response bodies are rejected', async t => {
  t.mock.method(Date, 'now', () => NOW);
  for (const date of [null, 'not a date', new Date(NOW - MAX_DATA_AGE_MS - 1000).toUTCString(), new Date(NOW + 61_000).toUTCString()]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('{}', { headers: date === null ? {} : { date } }));
    await assert.rejects(fetchPoolSnapshot(new AbortController().signal), /响应时间/);
  }
  t.mock.method(globalThis, 'fetch', async () => new Response(' '.repeat(1_000_001), { headers: { date: new Date(NOW).toUTCString() } }));
  await assert.rejects(fetchPoolSnapshot(new AbortController().signal), /大小/);
});

test('CORS-like fetch rejection propagates without a network fallback or wallet request', async t => {
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    calls.push(String(url)); throw new TypeError('Failed to fetch');
  });
  await assert.rejects(fetchPoolSnapshot(new AbortController().signal), /Failed to fetch/);
  assert.deepEqual(calls.sort(), [...POOL_DATA_URLS].sort());
});

test('caller abort reaches every in-flight public request', async t => {
  const controller = new AbortController(); controller.abort();
  t.mock.method(globalThis, 'fetch', async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.signal?.aborted, true);
    throw new DOMException('Aborted', 'AbortError');
  });
  await assert.rejects(fetchPoolSnapshot(controller.signal), { name: 'AbortError' });
});

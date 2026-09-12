import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchPoolLive, formatHashrate, parsePoolLive, POOL_LIVE_URLS } from '../lib/pool-live.ts';

const NOW = Date.parse('2026-09-12T09:00:00Z');
const fixtures = () => [
  {
    age_seconds: 5,
    blocks_24h: 3600,
    hashrate_windows: [5.9e12, 6.3e12, 6.4e12],
    network_miners: 26,
    node: { is_syncing: false },
    stats: { best_share: '2997203350054647254', blocks_found: 26451, last_block_at: '2026-09-12T08:59:20Z', miners_active: 465, network_difficulty: '154315150195623', shares_last_hour: 2310708, work_last_hour: '21655945462611968', workers_total: 4404 },
    tip_height: 31276,
  },
  { block_seconds: 18.4, round_progress_percent: 126.4, windows: [{ blocks: 10, luck_percent: 96.1 }, { blocks: 50, luck_percent: 98.4 }] },
  { block_reward_planck: '299551239200' },
  [
    { payout_addr: 'qzmJgtA2…j1Fchr', last_seen: '2026-09-12T08:59:40Z', shares_last_hour: 300, work_last_hour: '1000', workers: 10, hashrate_1h: 2e12, solo: false },
    { payout_addr: 'qzoqfcqa…dww2Sh', last_seen: '2026-09-12T08:59:30Z', shares_last_hour: 200, work_last_hour: '900', workers: 2, hashrate_1h: 3e12, solo: true },
  ],
  [{ name: 'mainnet', mainnet: true }],
];

test('parses live pool metrics and sorts the one-hour miner ranking', () => {
  const result = parsePoolLive(fixtures(), NOW, NOW);
  assert.equal(result.poolHashrateHs, 6.3e12);
  assert.equal(result.networkHashrateHs, 154315150195623 / 18.4);
  assert.equal(result.luckBlocks, 50);
  assert.equal(result.blockRewardQtc, 0.2995512392);
  assert.equal(result.topMiners[0].address, 'qzoqfcqa…dww2Sh');
  assert.equal(result.topMiners[0].solo, true);
  assert.equal(result.topMiners[1].workers, 10);
});

test('falls back to accepted hourly work when the displayed window is zero', () => {
  const data = fixtures();
  (data[0] as { hashrate_windows: number[] }).hashrate_windows[1] = 0;
  assert.equal(parsePoolLive(data, NOW, NOW).poolHashrateHs, 21655945462611968 / 3600);
});

test('rejects unconfirmed, syncing, stale, malformed, or unmasked data', () => {
  const cases: unknown[][] = [];
  for (const mutate of [
    (d: unknown[]) => { (d[4] as object[]) = []; },
    (d: unknown[]) => { ((d[0] as { node: { is_syncing: boolean } }).node.is_syncing) = true; },
    (d: unknown[]) => { ((d[0] as { stats: { network_difficulty: string } }).stats.network_difficulty) = 'bad'; },
    (d: unknown[]) => { ((d[3] as Array<{ payout_addr: string }>)[0].payout_addr) = 'qzFullAddressMustNotAppear'; },
  ]) { const data = fixtures(); mutate(data); cases.push(data); }
  for (const data of cases) assert.throws(() => parsePoolLive(data, NOW, NOW), /矿池实时数据暂不可用/);
  assert.throws(() => parsePoolLive(fixtures(), NOW, NOW - 6 * 60_000), /矿池实时数据暂不可用/);
});

test('fetches only fixed public endpoints without credentials', async () => {
  const payloads = fixtures();
  const seen: Array<{ input: string; init?: RequestInit }> = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input); seen.push({ input: url, init });
    const index = POOL_LIVE_URLS.indexOf(url as typeof POOL_LIVE_URLS[number]);
    return new Response(JSON.stringify(payloads[index]), { status: 200, headers: { date: new Date(NOW).toUTCString() } });
  };
  const originalNow = Date.now;
  Date.now = () => NOW;
  try { await fetchPoolLive(new AbortController().signal, fetcher as typeof fetch); } finally { Date.now = originalNow; }
  assert.deepEqual(seen.map(item => item.input), [...POOL_LIVE_URLS]);
  for (const item of seen) {
    assert.equal(item.init?.method, 'GET'); assert.equal(item.init?.credentials, 'omit'); assert.equal(item.init?.redirect, 'error'); assert.equal(item.init?.referrerPolicy, 'no-referrer'); assert.equal(item.init?.cache, 'no-store');
  }
});

test('formats hashrate using readable units', () => {
  assert.equal(formatHashrate(6.3e12, 'zh-CN'), '6.3 TH/s');
  assert.equal(formatHashrate(420e9, 'zh-CN'), '420 GH/s');
  assert.equal(formatHashrate(Number.NaN), '—');
});

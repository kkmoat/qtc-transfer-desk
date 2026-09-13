import assert from 'node:assert/strict';
import test from 'node:test';
import { CEX_HOLDER_ADDRESS, fetchHoldersPage, fetchHoldersSummary, formatPlanckQtc, HOLDERS_API_URL, HOLDERS_PAGE_SIZE, knownHolderRole, parseHoldersResponse, parseHoldersSummary, PROJECT_HOLDER_ADDRESS, QUANPOOL_HOLDER_ADDRESS } from '../lib/holders.ts';

const rows = [
  { id: 'qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7', free: '5669940001000000000', frozen: '0', reserved: '0' },
  { id: 'qzowWAgbzjc2XfHY4vyEo2eVLKbknTESUFoXnisQuUh1x1koo', free: '8481980000000000', frozen: '1000000000000', reserved: '5' },
];
const payload = { data: { accounts: rows, meta: { totalCount: 2358 } } };
const summaryFetchedAt = Date.UTC(2026, 8, 13, 5);
const summaryPayload = { data: {
  aggregate: { aggregate: { count: 2358, sum: { free: '5682404387555532269', reserved: '5' } } },
  meta: { total_accounts: 2358, block_height: 35648, finalized_block_height: 35548 },
  latest: [{ height: 35648, timestamp: new Date(summaryFetchedAt - 30_000).toISOString() }],
  leaders: [
    rows[0],
    rows[1],
    { id: CEX_HOLDER_ADDRESS, free: '3195335355532269', frozen: '0', reserved: '0' },
  ],
  project: { ...rows[0], last_updated: 0 },
} };

test('holder response validates addresses, exact balances, ordering and account total', () => {
  const snapshot = parseHoldersResponse(payload, 1, 1_700_000_000_000);
  assert.equal(snapshot.totalCount, 2358);
  assert.equal(snapshot.accounts[0].free, 5_669_940_001_000_000_000n);
  assert.equal(snapshot.accounts[1].reserved, 5n);
  assert.equal(formatPlanckQtc(snapshot.accounts[0].free, 'en-US'), '5,669,940.001');
  assert.equal(formatPlanckQtc(2_404_205_599_074_517n, 'en-US'), '2,404.205599074517');
});

test('holder response fails closed on malformed, impossible or unsorted data', () => {
  const invalid = [
    { data: { accounts: [...rows].reverse(), meta: { totalCount: 2358 } } },
    { data: { accounts: [{ ...rows[0], id: '<script>' }], meta: { totalCount: 1 } } },
    { data: { accounts: [{ ...rows[0], free: '-1' }], meta: { totalCount: 1 } } },
    { data: { accounts: rows, meta: { totalCount: 1 } } },
    { errors: [{ message: 'indexer unavailable' }], data: { accounts: rows, meta: { totalCount: 2358 } } },
  ];
  for (const value of invalid) assert.throws(() => parseHoldersResponse(value, 1));
});

test('holder fetch uses only the fixed official endpoint and a bounded public query', async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = { input: String(input), init };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const result = await fetchHoldersPage(2, new AbortController().signal, fetcher);
  assert.equal(result.page, 2);
  assert.equal(request?.input, HOLDERS_API_URL);
  assert.equal(request?.init?.method, 'POST');
  assert.equal(request?.init?.credentials, 'omit');
  assert.equal(request?.init?.cache, 'no-store');
  assert.equal(request?.init?.redirect, 'error');
  assert.equal(request?.init?.referrerPolicy, 'no-referrer');
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body.variables, { limit: HOLDERS_PAGE_SIZE, offset: HOLDERS_PAGE_SIZE, orderBy: { free: 'desc' } });
  assert.match(body.query, /chain_stats_by_pk/);
});

test('holder summary uses the aggregate address balances and subtracts the live project balance', () => {
  const snapshot = parseHoldersSummary(summaryPayload, summaryFetchedAt);
  assert.equal(snapshot.totalCount, 2358);
  assert.equal(snapshot.totalBalancePlanck, 5_682_404_387_555_532_274n);
  assert.equal(snapshot.projectBalancePlanck, 5_669_940_001_000_000_000n);
  assert.equal(snapshot.excludingProjectPlanck, 12_464_386_555_532_274n);
  assert.equal(snapshot.blockHeight, 35648);
  assert.equal(snapshot.finalizedBlockHeight, 35548);
  assert.equal(snapshot.projectLastUpdated, 0);
  assert.equal(snapshot.sourceTime, summaryFetchedAt - 30_000);
  assert.equal(snapshot.topAccounts.length, 3);
  assert.equal(knownHolderRole(PROJECT_HOLDER_ADDRESS), 'project');
  assert.equal(knownHolderRole(QUANPOOL_HOLDER_ADDRESS), 'quanpool');
  assert.equal(knownHolderRole(CEX_HOLDER_ADDRESS), 'cex');
  assert.equal(knownHolderRole('unknown'), null);
});

test('holder summary rejects missing project data and impossible aggregates', () => {
  assert.throws(() => parseHoldersSummary({ data: { ...summaryPayload.data, project: null } }));
  assert.throws(() => parseHoldersSummary({ data: { ...summaryPayload.data, project: { ...rows[0], id: QUANPOOL_HOLDER_ADDRESS, last_updated: 0 } } }));
  assert.throws(() => parseHoldersSummary({ data: { ...summaryPayload.data, aggregate: { aggregate: { count: 2358, sum: { free: '21000000000000000000', reserved: '1' } } } } }));
  assert.throws(() => parseHoldersSummary({ data: { ...summaryPayload.data, meta: { ...summaryPayload.data.meta, total_accounts: 2357 } } }));
  assert.throws(() => parseHoldersSummary({ data: { ...summaryPayload.data, latest: [{ ...summaryPayload.data.latest[0], height: 35647 }] } }, summaryFetchedAt));
  assert.throws(() => parseHoldersSummary({ data: { ...summaryPayload.data, latest: [{ ...summaryPayload.data.latest[0], timestamp: new Date(summaryFetchedAt - 5 * 60_000 - 1).toISOString() }] } }, summaryFetchedAt));
});

test('holder summary fetch sends one bounded aggregate query with the pinned project address', async () => {
  let request: { input: string; init?: RequestInit } | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    request = { input: String(input), init };
    return Response.json({ data: { ...summaryPayload.data, latest: [{ ...summaryPayload.data.latest[0], timestamp: new Date().toISOString() }] } });
  };
  const result = await fetchHoldersSummary(new AbortController().signal, fetcher);
  assert.equal(result.totalCount, 2358);
  assert.equal(request?.input, HOLDERS_API_URL);
  const body = JSON.parse(String(request?.init?.body));
  assert.deepEqual(body.variables, { project: PROJECT_HOLDER_ADDRESS });
  assert.match(body.query, /account_aggregate/);
  assert.match(body.query, /account_by_pk/);
});

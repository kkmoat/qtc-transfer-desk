import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchHoldersPage, formatPlanckQtc, HOLDERS_API_URL, HOLDERS_PAGE_SIZE, parseHoldersResponse } from '../lib/holders.ts';

const rows = [
  { id: 'qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7', free: '5669940001000000000', frozen: '0', reserved: '0' },
  { id: 'qzowWAgbzjc2XfHY4vyEo2eVLKbknTESUFoXnisQuUh1x1koo', free: '8481980000000000', frozen: '1000000000000', reserved: '5' },
];
const payload = { data: { accounts: rows, meta: { totalCount: 2358 } } };

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

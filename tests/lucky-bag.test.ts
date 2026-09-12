import assert from 'node:assert/strict';
import test from 'node:test';
import { enterLuckyBag, parseLuckyBagState, reserveLuckyBag } from '../lib/lucky-bag.ts';

const campaign = { id: 7, title: 'Test campaign', totalCount: 10, totalAmount: '0.1000', remainingCount: 10, claimedCount: 0 };

test('lucky bag POST preserves a real Origin under the site no-referrer policy', async () => {
  const originalFetch = globalThis.fetch;
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  globalThis.fetch = async (input, init) => {
    requestUrl = String(input);
    requestInit = init;
    return new Response(JSON.stringify({ state: 'off', campaign: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    assert.deepEqual(await enterLuckyBag(), { state: 'off', campaign: null });
    assert.equal(requestUrl, '/api/lucky-bag/enter');
    assert.equal(requestInit?.method, 'POST');
    assert.equal(requestInit?.credentials, 'same-origin');
    assert.equal(requestInit?.mode, undefined);
    assert.equal(requestInit?.redirect, 'error');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('available state advertises a campaign without creating a reservation', () => {
  assert.deepEqual(parseLuckyBagState({ state: 'available', campaign }), { state: 'available', campaign });
  assert.throws(() => parseLuckyBagState({ state: 'available', campaign: null }), /INVALID_RESPONSE/);
});

test('reserve starts only after an explicit campaign request and shares rapid double clicks', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0, requestUrl = '', requestInit: RequestInit | undefined;
  let releaseResponse!: () => void;
  const responseGate = new Promise<void>(resolve => { releaseResponse = resolve; });
  globalThis.fetch = async (input, init) => {
    calls += 1; requestUrl = String(input); requestInit = init;
    await responseGate;
    return new Response(JSON.stringify({ state: 'reserved', campaign, reservationId: 'reservation-token', expiresAt: 1_800_000 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const first = reserveLuckyBag(campaign.id), second = reserveLuckyBag(campaign.id);
    assert.strictEqual(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(requestUrl, '/api/lucky-bag/reserve');
    assert.deepEqual(JSON.parse(String(requestInit?.body)), { campaignId: campaign.id });
    releaseResponse();
    assert.deepEqual(await first, { state: 'reserved', campaign, reservationId: 'reservation-token', expiresAt: 1_800_000 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { PLANCK } from '../lib/quantus/protocol.ts';
import { valuationCents, formatValuation } from '../lib/overview/valuation.ts';

test('FDV uses the maximum supply while MC uses only the supplied circulating amount', () => {
  assert.equal(valuationCents(21_000_000n * PLANCK, '49'), 102_900_000_000n);
  assert.equal(valuationCents(216_561n * PLANCK, '49'), 1_061_148_900n);
  assert.equal(formatValuation(1_061_148_900n, 'en-US'), '10,611,489.00');
});
test('valuations preserve decimal and Planck precision across rounding boundaries', () => {
  assert.equal(valuationCents(PLANCK - 1n, '0.005'), 0n);
  assert.equal(valuationCents(PLANCK, '0.005'), 1n);
  assert.equal(valuationCents(PLANCK, '0.004999999999999999'), 0n);
  assert.equal(formatValuation(valuationCents(21_000_000n * PLANCK, '999999999999999.99'), 'en-US'), '20,999,999,999,999,999,790,000.00');
});
test('unavailable or malformed inputs never become a fabricated zero market cap', () => {
  assert.equal(valuationCents(undefined, '49'), null);
  for (const p of [undefined, '0', '-1', 'NaN', '1e8', '0.0000000000000000001']) assert.equal(valuationCents(PLANCK, p), null);
  assert.equal(valuationCents(-1n, '49'), null);
  assert.equal(valuationCents(0n, '49'), 0n);
  assert.equal(formatValuation(null), '—');
});

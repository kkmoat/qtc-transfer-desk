import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCOUNT_INDEX_RANGE_ERROR, MAX_ACCOUNT_INDEX, parseAccountIndex } from '../lib/quantus/account-index.ts';
import { translate } from '../lib/i18n/core.ts';

test('account index accepts the complete hardened BIP44 child range', () => {
  assert.equal(MAX_ACCOUNT_INDEX, 2_147_483_647);
  for (const value of ['0', '999999', '1000000', '999999999', '1000000000', '2147483647']) {
    assert.equal(parseAccountIndex(value), Number(value));
  }
  assert.equal(parseAccountIndex('0000000001'), 1);
});

test('account index rejects values that would wrap or alias in the WASM boundary', () => {
  for (const value of ['', '-1', '1.5', '1e9', ' 1', '1 ', '2147483648', '4294967296', '9999999999', '10000000000']) {
    assert.throws(() => parseAccountIndex(value), { name: 'RangeError', message: ACCOUNT_INDEX_RANGE_ERROR });
  }
});

test('account index range error is translated without changing the protocol boundary', () => {
  assert.equal(ACCOUNT_INDEX_RANGE_ERROR, '账户序号须在 0–2147483647 之间。');
  assert.equal(translate(ACCOUNT_INDEX_RANGE_ERROR, 'en'), 'The account index must be between 0 and 2147483647.');
});

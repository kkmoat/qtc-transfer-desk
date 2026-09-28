import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECTORY_CATEGORIES, UNIQTC_URL } from '../lib/directory.ts';

test('QTC market links use the current UniQTC destination', () => {
  assert.equal(UNIQTC_URL, 'https://www.uniqtc.xyz/');
  const markets = DIRECTORY_CATEGORIES.find(category => category.id === 'markets');
  assert.ok(markets);
  for (const label of ['场外OTC订单', 'QTC网站挂单']) {
    assert.equal(markets.links.find(link => link.label === label)?.href, UNIQTC_URL);
  }
  assert.equal(JSON.stringify(DIRECTORY_CATEGORIES).includes('docs.google.com/spreadsheets'), false);
});

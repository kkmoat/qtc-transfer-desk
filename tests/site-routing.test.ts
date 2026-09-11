import test from 'node:test';
import assert from 'node:assert/strict';
import { VIEWS, viewPath, viewFromPath, viewFromLocation, canonicalUrl, pageMetadata } from '../lib/site.ts';

test('root stays a directory while every tool has a directly accessible URL', () => {
  assert.equal(viewFromLocation('/'), 'directory');
  for (const view of VIEWS) {
    assert.equal(viewFromPath(viewPath(view)), view);
    assert.equal(viewFromLocation(viewPath(view)), view);
    assert(!canonicalUrl(view).includes('#'));
  }
  assert.equal(viewFromPath('/transfer'), 'transfer');
  assert.equal(viewFromPath('/missing/'), undefined);
  assert.equal(viewFromPath('/source/LICENSE.txt'), undefined);
});

test('legacy hashes work at the root and override an old page path', () => {
  for (const view of VIEWS) {
    assert.equal(viewFromLocation('/', `#${view}`), view);
    assert.equal(viewFromLocation('/intro/', `#${view}`), view);
  }
  assert.equal(viewFromLocation('/transfer/', '#unknown-section'), 'transfer');
});

test('each page has distinct metadata in both UI languages', () => {
  for (const language of ['zh', 'en'] as const) {
    assert.equal(new Set(VIEWS.map(view => pageMetadata(view, language).title)).size, VIEWS.length);
    assert.equal(new Set(VIEWS.map(view => pageMetadata(view, language).description)).size, VIEWS.length);
    for (const view of VIEWS) assert(pageMetadata(view, language).title.includes('QTC'));
  }
});

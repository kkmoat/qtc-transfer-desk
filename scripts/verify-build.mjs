import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DOCUMENT_CSP, META_CSP, WORKER_CSP, SECURITY_HEADERS } from './security-policy.mjs';
import { VIEWS, viewPath, canonicalUrl, pageMetadata } from '../lib/site.ts';
import { verifyCrypto } from './verify-crypto.mjs';

for (const view of VIEWS) {
  const html = await readFile('dist' + viewPath(view) + 'index.html', 'utf8');
  const htmlDecoded = html.replaceAll('&#39;', "'").replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  assert(htmlDecoded.includes(META_CSP), 'Production HTML must contain the intended CSP');
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert(scripts.some(([, attrs]) => /src="\/assets\/[^"]+\.js"/.test(attrs)), 'Expected an external application script');
  assert.equal(scripts.filter(([, attrs]) => /src="\/theme-init\.js"/.test(attrs)).length, 1, 'Expected one early theme bootstrap');
  assert(html.indexOf('/theme-init.js') < html.indexOf('<body>'), 'Theme must initialize before page content');
  for (const [, attributes, body] of scripts) {
    assert(/\bsrc="(?:\/assets\/[^"<>]+\.js|\/theme-init\.js)"/.test(attributes), 'Only bundled scripts and the same-origin theme bootstrap are allowed');
    assert.equal(body.trim(), '', 'Inline JavaScript is not allowed');
  }
  assert(!/\bon\w+\s*=/i.test(html), 'Inline event handlers are not allowed');
  assert.equal([...html.matchAll(/<h1[ >]/g)].length, 1, 'Each page needs one visible main heading');
  assert.equal([...html.matchAll(/class="desk-view"/g)].length, 1, 'Only the active view should be prerendered');
  assert(html.includes('<title>' + pageMetadata(view).title + '</title>'));
  assert.equal([...html.matchAll(/rel="canonical"/g)].length, 1);
  assert(html.includes('<link rel="canonical" href="' + canonicalUrl(view) + '"'));
  assert(html.includes('<link rel="icon" href="/favicon.png" type="image/png" sizes="64x64"'));
  assert(html.includes('<link rel="apple-touch-icon" href="/images/qtc123-logo.png" sizes="180x180"'));
  assert.equal([...html.matchAll(/class="brand-logo"/g)].length, 1, 'Expected one navigation logo');
  assert(html.includes('<img class="brand-logo" src="/images/qtc123-logo.png" width="180" height="180" alt="QTC123 Quantus"'));
  assert(!html.includes('class="author-link"'), 'Header author X link must be removed');
  assert(html.includes('免翻墙网址：www.bi86.com'), 'Expected the current Binance VPN-free URL subtitle');
  assert(!html.includes('免翻墙网址注册币安'), 'Legacy Binance subtitle must be removed');
  assert(html.includes('href="https://www.bi86.com/go/8.html"'), 'Binance referral destination must remain unchanged');
  assert.equal([...html.matchAll(/href="https:\/\/t\.me\/QTC123COM"/g)].length, view === 'directory' ? 2 : 1, 'Expected the current Chinese Telegram destination');
  assert(!html.includes('https://t.me/QuantusCN'), 'Legacy Chinese Telegram destination must be removed');
  const footer = html.match(/<footer>[\s\S]*?<\/footer>/)?.[0];
  assert(footer, 'Expected one footer');
  assert.equal([...footer.matchAll(/href="https:\/\/x\.com\/QTC123_COM"/g)].length, 1, 'Expected one footer contact link');
  assert(footer.includes('<a href="https://x.com/QTC123_COM" target="_blank" rel="noopener noreferrer">联系我们'));
  assert(!footer.includes('kk129182'));
  assert(!footer.includes('contact-button'));
  assert(!footer.includes('contact-status'));
  assert(html.includes('itemType="https://schema.org/WebSite"') || html.includes('itemtype="https://schema.org/WebSite"'));
  for (const route of VIEWS) assert(html.includes('href="' + viewPath(route) + '"'), 'Missing crawlable internal route');
  assert(!html.includes('href="#'), 'Internal view links must use paths');
  if (view === 'directory') {
    assert(!html.includes('>微信交流群<'), 'WeChat community directory item must be removed');
    assert(!html.includes('>作者X<'), 'Creator X directory item must be removed');
    assert(!html.includes('href="https://x.com/kkmoat"'), 'Creator X destination must be removed from the directory');
    assert(!html.includes('class="directory-qr-trigger"'), 'Removed WeChat item must not retain a QR trigger');
  }
}
const sitemap = await readFile('dist/sitemap.xml', 'utf8');
assert.equal([...sitemap.matchAll(/<loc>/g)].length, VIEWS.length);
for (const view of VIEWS) assert(sitemap.includes('<loc>' + canonicalUrl(view) + '</loc>'));
assert(!sitemap.includes('#'));
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function pngSize(data) {
  assert(data.subarray(0, 8).equals(pngSignature), 'Logo asset must be PNG');
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}
const favicon = await readFile('dist/favicon.png');
const navigationLogo = await readFile('dist/images/qtc123-logo.png');
assert.deepEqual(pngSize(favicon), { width: 64, height: 64 });
assert.deepEqual(pngSize(navigationLogo), { width: 180, height: 180 });
assert(favicon.length < 20 * 1024, 'Favicon is unexpectedly large');
assert(navigationLogo.length < 100 * 1024, 'Navigation logo is unexpectedly large');
assert((await readFile('dist/robots.txt', 'utf8')).includes('Sitemap: https://www.qtc123.com/sitemap.xml'));
assert(!DOCUMENT_CSP.includes("script-src 'self' 'unsafe-inline'"));
assert(!DOCUMENT_CSP.includes("'unsafe-eval'"));
const config = JSON.parse(await readFile('vercel.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
assert.equal(lock.version, '1.0.0');
for (const [path, dependency] of Object.entries(lock.packages)) {
  assert(path === '' || path.startsWith('node_modules/'), `Nonportable dependency path: ${path}`);
  if (dependency.resolved) assert(dependency.resolved.startsWith('https://registry.npmjs.org/'), `Unexpected dependency source: ${path}`);
}
assert.equal(config.framework, 'vite');
assert.equal(config.outputDirectory, 'dist');
assert(!config.functions && !config.rewrites && !config.routes, 'Deployment must remain static');
assert.deepEqual(config.headers.find(rule => rule.source === '/(.*)').headers, SECURITY_HEADERS);
const workerHeaders = config.headers.find(rule => rule.source === '/crypto/worker.js').headers;
assert(workerHeaders.some(header => header.key === 'Content-Security-Policy' && header.value === WORKER_CSP));

async function auditFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    assert(!entry.name.startsWith('.'), `Hidden deployment artifact: ${entry.name}`);
    assert(!/\.(map|pem|key|log)$/i.test(entry.name), `Unexpected deployment artifact: ${entry.name}`);
    assert(!['node_modules', 'api', 'functions', 'server'].includes(entry.name), `Unexpected server artifact: ${entry.name}`);
    if (entry.isDirectory()) await auditFiles(join(directory, entry.name));
  }
}
await auditFiles('dist');
await verifyCrypto('dist');
assert.equal(await readFile('dist/theme-init.js', 'utf8'), await readFile('public/theme-init.js', 'utf8'));
assert.equal(await readFile('dist/crypto/worker.js', 'utf8'), await readFile('public/crypto/worker.js', 'utf8'));
console.log('Static production build verified: external scripts, CSP, isolated Worker policy, crypto checksums and no server/secret artifacts.');

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'vite';
import { SITE_NAME, SITE_ORIGIN, VIEWS, viewPath, canonicalUrl, pageMetadata } from '../lib/site.ts';

const escape = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const template = await readFile('dist/index.html', 'utf8');
const server = await createServer({ server: { middlewareMode: true, hmr: false, ws: false, watch: null, preTransformRequests: false }, optimizeDeps: { noDiscovery: true, include: [] }, appType: 'custom' });
try {
  const { render } = await server.ssrLoadModule('/src/prerender.tsx');
  for (const view of VIEWS) {
    const { title, description } = pageMetadata(view);
    const url = canonicalUrl(view);
    const head = [
      `<link rel="canonical" href="${url}" />`,
      '<meta name="robots" content="index, follow, max-image-preview:large" />',
      `<meta property="og:site_name" content="${SITE_NAME}" />`,
      '<meta property="og:type" content="website" />',
      '<meta property="og:locale" content="zh_CN" />',
      `<meta property="og:title" content="${escape(title)}" />`,
      `<meta property="og:description" content="${escape(description)}" />`,
      `<meta property="og:url" content="${url}" />`,
      '<meta name="twitter:card" content="summary" />',
      `<meta name="twitter:title" content="${escape(title)}" />`,
      `<meta name="twitter:description" content="${escape(description)}" />`,
    ].join('\n    ');
    const body = render(view);
    assert(body.includes('<h1'), `Missing content for ${view}`);
    const html = template
      .replace(/<title>.*?<\/title>/, `<title>${escape(title)}</title>`)
      .replace(/<meta name="description" content="[^"]*"\s*\/>/, `<meta name="description" content="${escape(description)}" />`)
      .replace('</head>', `    ${head}\n  </head>`)
      .replace('<div id="root"></div>', () => `<div id="root">${body}</div>`);
    const directory = 'dist' + viewPath(view);
    await mkdir(directory, { recursive: true });
    await writeFile(directory + 'index.html', html);
  }
  await writeFile('dist/robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`);
  await writeFile('dist/sitemap.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + VIEWS.map(view => `  <url><loc>${canonicalUrl(view)}</loc></url>`).join('\n') + '\n</urlset>\n');
  console.log(`Prerendered ${VIEWS.length} public pages with metadata, canonical URLs, robots.txt and sitemap.xml.`);
} finally {
  await server.close();
}

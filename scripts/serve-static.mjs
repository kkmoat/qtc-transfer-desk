// Local production preview: serve the exact static build with its security headers.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { SECURITY_HEADERS, WORKER_CSP } from './security-policy.mjs';

const root = resolve('dist');
const port = Number(process.env.PORT ?? 5174);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.zip': 'application/zip', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = createServer(async (request, response) => {
  for (const { key, value } of SECURITY_HEADERS) response.setHeader(key, value);
  response.setHeader('Cache-Control', 'no-cache, must-revalidate');
  if (!['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(405, { Allow: 'GET, HEAD' }); response.end(); return;
  }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (relative.split('/').some(part => part.startsWith('.')) || relative.includes('\\') || relative.includes('\0')) throw new Error('Invalid path');
    const path = resolve(root, relative);
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('Not found');
    if (pathname === '/crypto/worker.js') response.setHeader('Content-Security-Policy', WORKER_CSP);
    response.setHeader('Content-Type', mime[extname(path)] ?? 'application/octet-stream');
    const data = await readFile(path);
    response.setHeader('Content-Length', data.length);
    response.writeHead(200);
    response.end(request.method === 'HEAD' ? undefined : data);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); response.end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Static production preview: http://127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));

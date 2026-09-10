import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const CRYPTO_PINS = {
  'crypto/quantus_browser_crypto.d.ts': 'be80289e967f71044240fe7701eb1f7aa8a9bba168bcc56d180f820cc6fe0783',
  'crypto/quantus_browser_crypto.js': '33c927b772fb748b7aec53f900641a8423e397c3043b6a6539af4560ea16d758',
  'crypto/quantus_browser_crypto_bg.wasm': '2429d540a27d986c4a02b2be5972ac6a0c6c9fbb616bc62f594195523b18578a',
  'crypto/worker.js': '5a18496138e307350b1eb966ae145bb521b23d07f13c5da85fa058910c635ae8',
  'source/quantus-browser-crypto-source.zip': 'edf9fdfd18a3cbfa11f99b917088dbfe2bd757b633d52c025d95b13c44f0701d',
};

export async function verifyCrypto(directory = 'public') {
  for (const [path, expected] of Object.entries(CRYPTO_PINS)) {
    const bytes = await readFile(resolve(directory, path));
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== expected) throw new Error(`Crypto checksum mismatch: ${path}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await verifyCrypto();
  console.log('Crypto WASM, glue, declarations and corresponding source archive match pinned SHA-256 checksums.');
}

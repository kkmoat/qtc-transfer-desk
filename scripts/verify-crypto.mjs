import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const CRYPTO_PINS = {
  'crypto/quantus_browser_crypto.d.ts': 'be80289e967f71044240fe7701eb1f7aa8a9bba168bcc56d180f820cc6fe0783',
  'crypto/quantus_browser_crypto.js': '33c927b772fb748b7aec53f900641a8423e397c3043b6a6539af4560ea16d758',
  'crypto/quantus_browser_crypto_bg.wasm': '392bc7c4dd9b0618e9811ec8f50cc1abe0b54edea41a347a534f32a9a289cef4',
  'crypto/quantus_wormhole_crypto.d.ts': '2914b6b5c249597796a605833f6f23e1944bbc9ad4349ab9d26adea5cf74cc74',
  'crypto/quantus_wormhole_crypto.js': '7e7d017c944128a57921454b2393edfff66010348251d25cc763d35d73d88630',
  'crypto/quantus_wormhole_crypto_bg.wasm': 'eac89eb72c61b82f945d8bb2c6cc3d691b559bcc7cc0ac2622c750411bb0d492',
  'crypto/worker.js': '0e2815788266697d844d542cab96bef08d343b4efb135715cd7111a7a175e514',
  'source/quantus-browser-crypto-source.zip': '5e257eb65833b4aa9e2b2cae291fe10792c0cb4c179981bb858ba575b95677fc',
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

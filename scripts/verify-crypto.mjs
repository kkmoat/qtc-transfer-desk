import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const CRYPTO_PINS = {
  'crypto/quantus_browser_crypto_bg.wasm': '073d795f8d4a6c8cb95fa038bcd4bfff313de7906d6461800f756a4445fc4d48',
  'crypto/quantus_browser_crypto.js': 'e1a99429b629b9e3f5714a7b595bf0ffa5ad26f76c98aeb0e5cdb1c76b9421c7',
  'crypto/quantus_browser_crypto.d.ts': '0afda85e284d295342897db26163b45282fb76a70a0a0ce6e31f538cee886bf5',
  'source/quantus-browser-crypto-source.zip': 'c33aa09f461f578cc07d7d573d7101d6314e424884c6dbf3067ea672e27e531d',
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

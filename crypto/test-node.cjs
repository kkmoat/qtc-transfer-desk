const assert = require('node:assert/strict');
const { deriveAccount, deriveAccountAtPath, verifyPayload } = require('./pkg-node/quantus_browser_crypto.js');
// Public, deliberately compromised official wallet fixture. Never fund it.
const phrase = 'orchard answer curve patient visual flower maze noise retreat penalty cage small earth domain scan pitch bottom crunch theme club client swap slice raven';
const cases = [
  ['ml-dsa-65', 'qzoyC4eRTrexYoutXABVsf61QJZxJim3iWvayRQwEjXWgA4mw', 1952, 3309],
  ['ml-dsa-87', 'qzm5QCox8Dp5A3oSXZZYHD8YoYgPz7enykZb6RPUropdCyN5h', 2592, 4627],
];
for (const [scheme, address, publicLen, signatureLen] of cases) {
  const h = deriveAccount(phrase, scheme, 0);
  assert.equal(h.address, address);
  assert.equal(h.publicKey.length, publicLen);
  assert.equal(h.accountId.length, 32);
  assert.equal(h.cleared, false);
  assert.equal('secretKey' in h, false);
  assert.equal('mnemonic' in h, false);
  const explicit = deriveAccountAtPath(phrase, scheme, h.path);
  assert.equal(explicit.address, address);
  explicit.clear(); explicit.free();
  for (const size of [140, 256, 257, 300]) {
    const payload = new Uint8Array(size).fill(7);
    const signature = h.signPayload(payload, 152);
    assert.equal(signature.length, signatureLen);
    assert.deepEqual(h.signPayload(payload, 152), signature);
    assert.equal(verifyPayload(h.publicKey, payload, signature, scheme, 152), true);
    payload[0] ^= 1;
    assert.equal(verifyPayload(h.publicKey, payload, signature, scheme, 152), false);
    payload[0] ^= 1;
    signature[3] ^= 1;
    assert.equal(verifyPayload(h.publicKey, payload, signature, scheme, 152), false);
  }
  assert.throws(() => h.signPayload(new Uint8Array(20), 151), /Unsupported runtime/);
  assert.throws(() => h.signPayload(new Uint8Array(0), 152), /Invalid signing payload/);
  h.clear(); h.clear();
  assert.equal(h.cleared, true);
  assert.throws(() => h.signPayload(new Uint8Array(20), 152), /cleared/);
  h.free();
}
const second = deriveAccount(phrase, 'ml-dsa-87', 1);
assert.equal(second.address, 'qzmufPopkLKAwDmTzR5uXg8GMp5sUP48CqafJLUz3fPMSSGSh');
second.clear(); second.free();
assert.throws(() => deriveAccount('not a real secret', 'ml-dsa-65', 0), /Invalid mnemonic or derivation path/);
assert.throws(() => deriveAccount(phrase, 'bad', 0), /Expected ml-dsa/);
assert.equal(verifyPayload(new Uint8Array(3), new Uint8Array(30), new Uint8Array(3), 'ml-dsa-65', 152), false);
console.log('PASS: browser-compiled WASM node checks, both official HD vectors, four payload sizes, tamper/context/runtime rejection, clear/free.');

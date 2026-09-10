const assert = require('node:assert/strict');
const { deriveAccount, deriveAccountAtPath, verifyPayload, openWormhole } = require(process.env.QUANTUS_CRYPTO_NODE_MODULE || './pkg-node/quantus_browser_crypto.js');
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

const encrypted = openWormhole(phrase);
const encryptedVectors = [
  [0, 'qzpWh4AEtsgCyEbv4WBgFWnB9bcdF2L2jVDuyjXP9mSTyBaeU', '2cbb73e7f9fad1070f8e729eb8e2b55d05d844dfea6622e12a7884eec1fe5bdc'],
  [1, 'qzpzPxvmRfsZEQDdnwQgMqd8hCNxA3xVAw7mM2isRZhMScZ5M', '8674c2c2042bbd4cda5021d2ad55cab5ad052651424f1fc35f64fc3901235bb7'],
];
for (const [branch, address, nullifier] of encryptedVectors) {
  assert.equal(encrypted.deriveAddress(0, branch), address);
  assert.equal(encrypted.accountId(0, branch).length, 32);
  assert.equal(Buffer.from(encrypted.computeNullifier(0, branch, '0', address)).toString('hex'), nullifier);
  assert.notEqual(Buffer.from(encrypted.computeNullifier(0, branch, '18446744073709551615', address)).toString('hex'), nullifier);
  assert.notEqual(encrypted.deriveAddress(1, branch), address);
  assert.throws(() => encrypted.computeNullifier(1, branch, '0', address), /mismatch/);
  for (const invalid of ['', '-1', '1e3', '18446744073709551616']) assert.throws(() => encrypted.computeNullifier(0, branch, invalid, address), /transfer count/);
}
for (const field of ['secret', 'secretHex', 'firstHash', 'first_hash', 'seed', 'mnemonic']) assert.equal(field in encrypted, false);
assert.throws(() => encrypted.deriveAddress(0, 2), /branch or index/);
assert.throws(() => encrypted.deriveAddress(2147483648, 0), /branch or index/);
encrypted.clear(); encrypted.clear();
assert.equal(encrypted.cleared, true);
assert.throws(() => encrypted.deriveAddress(0, 0), /locked/);
encrypted.free();
assert.throws(() => openWormhole('not a mnemonic'), /Invalid encrypted-account mnemonic/);
console.log('PASS: encrypted two-branch HD vectors, u64 nullifiers, ownership/range checks, no secret getters, clear/free.');

// Optional full prover module: use only this public, deliberately compromised fixture.
if (process.env.QUANTUS_WORMHOLE_NODE_MODULE) {
  const proofModule = require(process.env.QUANTUS_WORMHOLE_NODE_MODULE);
  const fixture = require('./test-fixtures/withdrawal-public.json');
  const session = proofModule.openWormhole(phrase);
  const normal = JSON.parse(session.normalInfo(0));
  assert.equal(normal.address, fixture.expectedNormalAddress);
  assert.equal(normal.publicKey.length, 1952);
  const job = session.prepareWithdrawal(JSON.stringify(fixture));
  const summary = JSON.parse(job.summary());
  assert.equal(summary.feePlanck, '10000000123');
  for (const mutate of [r => r.codeHash = '0x00', r => r.expected.netPlanck = '1', r => r.normalAccountIndex = 1, r => r.inputs[0].leafHash = '0x00']) {
    const bad = structuredClone(fixture); mutate(bad);
    assert.throws(() => session.prepareWithdrawal(JSON.stringify(bad)));
  }
  job.proveNextLeaf();
  const proof = job.aggregate();
  const result = JSON.parse(proof.summary());
  assert.equal(result.verified, true);
  assert.equal(result.publicInputs.length, 162);
  assert(proof.proofBytes.length > 100000);
  const tail = Buffer.from(proof.proofBytes).subarray(-162 * 8);
  assert.deepEqual(Array.from({length:162}, (_, i) => tail.readBigUInt64LE(i * 8).toString()), result.publicInputs);
  assert.throws(() => job.aggregate());
  proof.free(); job.free(); session.clear();
  assert.throws(() => session.normalInfo(0));
  session.free();
  console.log('PASS: full canonical 7-slot proof, exact outgoing bytes/PI binding, public self-address, amount/header/runtime rejections, one-shot/clear.');
}

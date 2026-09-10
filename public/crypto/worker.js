import init, { deriveAccount, verifyPayload, openWormhole } from './quantus_browser_crypto.js';
let handle = null;
let wormhole = null;
const ready = init();
function release() {
  if (handle) { handle.clear(); handle.free(); handle = null; }
  if (wormhole) { wormhole.clear(); wormhole.free(); wormhole = null; }
}
function index(value) { return Number.isInteger(value) && value >= 0 && value < 2147483648; }
function branch(value) { return value === 0 || value === 1; }
function hex(bytes) { return '0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''); }
self.onmessage = async (event) => {
  const data = event.data;
  const id = data.id;
  try {
    await ready;
    let result;
    if (data.type === 'open') {
      release();
      if (data.scheme !== 'ml-dsa-65' || !index(data.accountIndex)) throw new Error('unsupported-scheme');
      let phrase = data.phrase;
      delete data.phrase;
      try {
        if (typeof phrase !== 'string' || phrase.length > 1024) throw new Error('invalid-phrase');
        handle = deriveAccount(phrase, data.scheme, data.accountIndex);
      } finally { phrase = ''; }
      if (handle.address !== data.expectedAddress) { release(); throw new Error('derived-address-mismatch'); }
      result = { address: handle.address, accountId: Array.from(handle.accountId), publicKey: Array.from(handle.publicKey), scheme: handle.scheme, path: handle.path };
    } else if (data.type === 'sign') {
      if (!handle) throw new Error('locked');
      const payload = new Uint8Array(data.payload);
      if (payload.length > 4096 || payload.length < 80 || data.spec !== 152) throw new Error('invalid-payload');
      const signature = handle.signPayload(payload, 152);
      if (!verifyPayload(handle.publicKey, payload, signature, handle.scheme, 152)) throw new Error('verification-failed');
      result = { signature: Array.from(signature), publicKey: Array.from(handle.publicKey) };
    } else if (data.type === 'wormhole-open') {
      release();
      let phrase = data.phrase;
      delete data.phrase;
      try {
        if (typeof phrase !== 'string' || phrase.length > 1024) throw new Error('invalid-phrase');
        wormhole = openWormhole(phrase);
      } finally { phrase = ''; }
      result = { address: wormhole.deriveAddress(0, 0), accountId: Array.from(wormhole.accountId(0, 0)), path: "m/44'/189189189'/0'/0'/0'", proofSupported: false };
    } else if (data.type === 'wormhole-derive') {
      if (!wormhole) throw new Error('locked');
      if (!branch(data.branch) || !index(data.startIndex) || !Number.isInteger(data.count) || data.count < 1 || data.count > 100 || !index(data.startIndex + data.count - 1)) throw new Error('invalid-range');
      result = Array.from({ length: data.count }, (_, i) => wormhole.deriveAddress(data.startIndex + i, data.branch));
    } else if (data.type === 'wormhole-nullifiers') {
      if (!wormhole) throw new Error('locked');
      if (!Array.isArray(data.inputs) || data.inputs.length > 256) throw new Error('invalid-range');
      result = data.inputs.map(input => {
        if (!input || !branch(input.branch) || !index(input.index) || typeof input.address !== 'string' || input.address.length > 64 || typeof input.transferCount !== 'string' || !/^(0|[1-9][0-9]{0,19})$/.test(input.transferCount)) throw new Error('invalid-input');
        return hex(wormhole.computeNullifier(input.index, input.branch, input.transferCount, input.address));
      });
    } else if (data.type === 'wormhole-prove') {
      throw new Error('proof-unavailable');
    } else if (data.type === 'close') {
      release(); result = null;
    } else { throw new Error('unknown-request'); }
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    self.postMessage({ id, ok: false, code: ['derived-address-mismatch', 'locked', 'proof-unavailable'].includes(code) ? code : 'local-crypto-failed', error: code === 'derived-address-mismatch' ? '导入后地址不一致。本页仅支持 ML-DSA-65 新版账户，请核对助记词、收款地址及账户序号。' : code === 'proof-unavailable' ? '本地 Wormhole 证明功能尚未通过浏览器验证，当前禁止转出。' : '本地操作失败。请检查输入或重新打开钱包。' });
  }
};

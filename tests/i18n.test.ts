import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGUAGE_KEY, parseLanguage, translate } from '../lib/i18n/core.ts';
import { parseAmount, serviceFee, formatAmount } from '../lib/quantus/protocol.ts';
const noChinese = (text: string) => assert.doesNotMatch(text, /[\u3400-\u9fff]/);

test('language preference accepts only known locale values and uses a separate public preference key', () => {
  assert.equal(parseLanguage('en'), 'en');
  for (const value of ['zh', 'EN', 'en-US', '', null, undefined, {}, '__proto__']) assert.equal(parseLanguage(value), 'zh');
  assert.equal(LANGUAGE_KEY, 'qtc-language-v1');
});

test('legacy and current success receipts translate with empty or present service-fee clause', () => {
  for (const clause of ['', '及服务费']) {
    const result = translate(`已入块，0.000000000001 QTC 转账${clause}执行成功。等待最终确认。`, 'en');
    noChinese(result);
    assert.ok(result.includes('0.000000000001 QTC'));
    assert.match(result, /executed successfully/);
    assert.match(result, /finality/);
    assert.equal(result.includes('service fee'), clause !== '');
  }
});

test('concatenated on-chain failure retains the error identifier and fee/finality meaning', () => {
  const result = translate('链上执行失败：Balances.InsufficientBalance 转账和服务费均已回滚，网络费可能已扣除。 等待区块最终确认。', 'en');
  noChinese(result);
  assert.ok(result.includes('Balances.InsufficientBalance'));
  assert.match(result, /reverted/);
  assert.match(result, /network fee may have been charged/i);
  assert.match(result, /finality/);
});

test('runtime protocol errors and parameterized data errors translate without replacing numeric values', () => {
  let error = '';
  try { parseAmount('1e12'); } catch (value) { error = (value as Error).message; }
  noChinese(translate(error, 'en'));
  const bounds = translate('每日成本必须在 0 到 9007199254740991 之间。', 'en');
  noChinese(bounds);
  assert.ok(bounds.includes('9007199254740991'));
  const missing = translate('全网算力数据缺失。', 'en');
  noChinese(missing);
  assert.match(missing, /Missing/);
});

test('stored English dynamic messages switch back to Chinese without losing parameters', () => {
  for (const text of ['已复制微信号：kk129182', '节点暂不可用（503）。']) {
    const english = translate(text, 'en');
    noChinese(english);
    assert.equal(translate(english, 'zh'), text);
  }
});

test('placeholders preserve punctuation, quantities and repeated rendering without changing user inputs', () => {
  assert.equal(translate('移除设备 {0}', 'en', [0]), 'Remove device 0');
  assert.equal(translate('移除设备 {0}', 'zh', [21]), '移除设备 21');
  const amount = '123456789.123456789123';
  assert.equal(translate(amount, 'en'), amount);
  assert.equal(translate(amount, 'zh'), amount);
  const bytes = '0x0123456789abcdef';
  assert.equal(translate(bytes, 'en'), bytes);
});

test('fee language preserves 0.5% and atomic precision; translation does not change calculation', () => {
  const input = '0.000000000001';
  const amount = parseAmount(input);
  const before = formatAmount(serviceFee(amount));
  noChinese(translate('服务费（0.5%，金额向上取整至最小单位）', 'en'));
  assert.match(translate('服务费（0.5%，金额向上取整至最小单位）', 'en'), /0\.5%/);
  const explanation = translate('费用向上取整至 0.000000000001 QTC。转账与服务费同时成功或同时回滚，链上失败仍可能产生网络费。', 'en');
  noChinese(explanation);
  assert.ok(explanation.includes('0.000000000001 QTC'));
  assert.equal(formatAmount(serviceFee(parseAmount(input))), before);
});

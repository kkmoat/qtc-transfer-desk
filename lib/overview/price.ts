// The production server exposes only the current SafeTrade QUANTUS/USDT ticker
// through this fixed, read-only same-origin route. QUAN is the former market
// name. QTC/USDT is an unrelated currency and is never a fallback.
export const PRICE_API_URL = '/api/quantus/price';
export type PriceSnapshot = { last: string; high: string | null; low: string | null; change: number | null; volumeUsdt: string | null; amountQuantus: string | null; fetchedAt: number };

const MAX_RESPONSE_BYTES = 32_000;
const MAX_SOURCE_AGE_MS = 5 * 60_000;

function decimal(value: unknown, positive = false): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e15) value = value.toFixed(18).replace(/\.?0+$/, '');
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,18})?$/.test(value)) return null;
  if (!Number.isFinite(Number(value)) || (positive && Number(value) <= 0)) return null;
  return value;
}

export function parsePriceResponse(raw: unknown, fetchedAt: number): PriceSnapshot {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Number.isSafeInteger(fetchedAt) || fetchedAt < 1) throw new Error('SafeTrade 报价格式异常。');
  const root = raw as Record<string, unknown>;
  const sourceTime = typeof root.at === 'number' && Number.isSafeInteger(root.at) ? root.at * 1000 : NaN;
  if (!Number.isSafeInteger(sourceTime) || sourceTime < Date.UTC(2025, 0, 1) || sourceTime > fetchedAt + 60_000 || fetchedAt - sourceTime > MAX_SOURCE_AGE_MS) throw new Error('SafeTrade 报价格式异常。');
  const ticker = root.ticker;
  if (!ticker || typeof ticker !== 'object' || Array.isArray(ticker)) throw new Error('SafeTrade 报价格式异常。');
  const row = ticker as Record<string, unknown>, last = decimal(row.last, true);
  if (!last) throw new Error('SafeTrade 报价格式异常。');
  const change = typeof row.price_change_percent === 'string' && /^[+-]?\d+(\.\d+)?%$/.test(row.price_change_percent) ? Number(row.price_change_percent.slice(0, -1)) : null;
  return {
    last,
    high: decimal(row.high),
    low: decimal(row.low),
    change: change !== null && Number.isFinite(change) && change >= -100 ? change : null,
    volumeUsdt: decimal(row.volume),
    amountQuantus: decimal(row.amount),
    fetchedAt,
  };
}

export async function fetchPriceSnapshot(signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<PriceSnapshot> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetcher(PRICE_API_URL, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: requestSignal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error();
    const contentType = response.headers.get('Content-Type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') throw new Error();
    const text = await response.text();
    if (!text.length || text.length > MAX_RESPONSE_BYTES) throw new Error();
    return parsePriceResponse(JSON.parse(text), Date.now());
  } catch {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('SafeTrade 行情暂不可用，请稍后刷新。');
  }
}

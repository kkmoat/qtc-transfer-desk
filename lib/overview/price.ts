// Official public feed: github.com/safetrade-exchange/example-client (ws.py, manager.py).
// QUANTUS is Quantus on SafeTrade; the former QUAN market is not used. QTC/USDT is an unrelated currency and is never a fallback.
export const SAFETRADE_MARKET = 'quantususdt';
export const SAFETRADE_WS = 'wss://safe.trade/api/v2/websocket/public';
export type PriceSnapshot = { last: string; high: string | null; low: string | null; change: number | null; volumeUsdt: string | null; amountQuantus: string | null; fetchedAt: number };
function decimal(value: unknown, positive = false): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 1e15) value = value.toFixed(18).replace(/\.?0+$/, '');
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,18})?$/.test(value)) return null;
  if (!Number.isFinite(Number(value)) || (positive && Number(value) <= 0)) return null;
  return value;
}
export function parsePriceMessage(raw: unknown, fetchedAt: number): PriceSnapshot | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const all = (raw as Record<string, unknown>)['global.tickers'];
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
  const ticker = (all as Record<string, unknown>)[SAFETRADE_MARKET];
  if (!ticker || typeof ticker !== 'object' || Array.isArray(ticker)) return null;
  const row = ticker as Record<string, unknown>, last = decimal(row.last, true);
  if (!last) throw new Error('SafeTrade 报价格式异常。');
  const change = typeof row.price_change_percent === 'string' && /^[+-]?\d+(\.\d+)?%$/.test(row.price_change_percent) ? Number(row.price_change_percent.slice(0,-1)) : null;
  return { last, high: decimal(row.high), low: decimal(row.low), change: change !== null && Number.isFinite(change) && change >= -100 ? change : null, volumeUsdt: decimal(row.volume), amountQuantus: decimal(row.amount), fetchedAt };
}
export function fetchPriceSnapshot(signal: AbortSignal, makeSocket: (url: string) => WebSocket = url => new WebSocket(url)): Promise<PriceSnapshot> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException('Aborted','AbortError')); return; }
    let done = false, socket: WebSocket | undefined;
    const finish = (result?: PriceSnapshot, error = new Error('SafeTrade 行情暂不可用，请稍后刷新。')) => {
      if (done) return; done = true; clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (socket) { socket.onopen = null; socket.onmessage = null; socket.onerror = null; socket.onclose = null; try { socket.close(); } catch { /* cleanup must not keep the request pending */ } }
      if (result) resolve(result); else reject(error);
    };
    const abort = () => finish(undefined, new DOMException('Aborted','AbortError'));
    const timer = setTimeout(() => finish(), 15_000);
    signal.addEventListener('abort', abort, { once: true });
    try {
      socket = makeSocket(SAFETRADE_WS);
      socket.onopen = () => { try { socket?.send(JSON.stringify({ event: 'subscribe', streams: ['global.tickers'] })); } catch { finish(); } };
      socket.onmessage = event => {
        if (typeof event.data !== 'string' || event.data.length > 1_000_000) { finish(); return; }
        try { const parsed = parsePriceMessage(JSON.parse(event.data), Date.now()); if (parsed) finish(parsed); } catch { finish(undefined, new Error('SafeTrade 报价格式异常。')); }
      };
      socket.onerror = () => finish(); socket.onclose = () => finish();
    } catch { finish(); }
  });
}

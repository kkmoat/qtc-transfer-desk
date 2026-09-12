export type LuckyBagClaim = { id: number; amount: string; status: 'pending' | 'verified' | 'paid' | 'rejected'; submittedAt: number };
export type LuckyBagCampaign = { id: number; title: string; totalCount: number; totalAmount: string; remainingCount: number; claimedCount: number };
export type LuckyBagState = {
  state: 'off' | 'available' | 'waiting' | 'reserved' | 'claimed' | 'dismissed' | 'expired' | 'finished';
  campaign: LuckyBagCampaign | null;
  reservationId?: string;
  expiresAt?: number;
  position?: number;
  claim?: LuckyBagClaim;
};

export class LuckyBagApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) { super(message); this.name = 'LuckyBagApiError'; this.status = status; this.code = code; }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const amount = (value: unknown): value is string => typeof value === 'string' && /^\d{1,12}\.\d{4}$/.test(value) && /[1-9]/.test(value);

export function parseLuckyBagState(value: unknown): LuckyBagState {
  const row = object(value);
  if (!row || !['off', 'available', 'waiting', 'reserved', 'claimed', 'dismissed', 'expired', 'finished'].includes(String(row.state))) throw new Error('INVALID_RESPONSE');
  let campaign: LuckyBagCampaign | null = null;
  if (row.campaign != null) {
    const c = object(row.campaign);
    if (!c || !integer(c.id) || c.id < 1 || typeof c.title !== 'string' || c.title.length > 300 || !integer(c.totalCount) || !amount(c.totalAmount) || !integer(c.remainingCount) || !integer(c.claimedCount)) throw new Error('INVALID_RESPONSE');
    campaign = { id: c.id, title: c.title, totalCount: c.totalCount, totalAmount: c.totalAmount, remainingCount: c.remainingCount, claimedCount: c.claimedCount };
  }
  const result: LuckyBagState = { state: row.state as LuckyBagState['state'], campaign };
  if (row.state === 'available' && !campaign) throw new Error('INVALID_RESPONSE');
  if (row.state === 'reserved') {
    if (!campaign || typeof row.reservationId !== 'string' || !row.reservationId.length || row.reservationId.length > 200 || !integer(row.expiresAt) || row.expiresAt < 1) throw new Error('INVALID_RESPONSE');
    result.reservationId = row.reservationId;
    result.expiresAt = row.expiresAt;
  }
  if (row.state === 'claimed') {
    const c = object(row.claim);
    if (!c || !integer(c.id) || c.id < 1 || !amount(c.amount) || !integer(c.submittedAt) || !['pending', 'verified', 'paid', 'rejected'].includes(String(c.status))) throw new Error('INVALID_RESPONSE');
    result.claim = { id: c.id, amount: c.amount, status: c.status as LuckyBagClaim['status'], submittedAt: c.submittedAt };
  }
  if (integer(row.position)) result.position = row.position;
  return result;
}

async function post(path: string, body: Record<string, unknown>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const response = await fetch('/api/lucky-bag/' + path, {
      // Keep Fetch's default CORS mode. With Referrer-Policy: no-referrer,
      // Firefox/WebKit serialize Origin as `null` for mode: same-origin POSTs,
      // while the default mode preserves the real same-origin value.
      method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal,
    });
    const text = await response.text();
    if (text.length > 20_000) throw new Error('INVALID_RESPONSE');
    let data: unknown;
    try { data = JSON.parse(text); } catch { throw new Error('INVALID_RESPONSE'); }
    if (!response.ok) {
      const error = object(data);
      throw new LuckyBagApiError(typeof error?.error === 'string' && error.error.length <= 300 ? error.error : 'REQUEST_FAILED', response.status, typeof error?.code === 'string' ? error.code : undefined);
    }
    return data;
  } finally { clearTimeout(timer); }
}

// A single in-flight status request is shared across React StrictMode effect replay.
// Identity and claim idempotency are enforced by the server's HttpOnly cookie.
let entering: Promise<LuckyBagState> | null = null;
export function enterLuckyBag(): Promise<LuckyBagState> {
  if (!entering) entering = post('enter', {}).then(parseLuckyBagState).finally(() => { entering = null; });
  return entering;
}

// Sharing one request per campaign makes a rapid double click idempotent even before
// the server can return the visitor's existing reservation.
const reserving = new Map<number, Promise<LuckyBagState>>();
export function reserveLuckyBag(campaignId: number): Promise<LuckyBagState> {
  if (!Number.isSafeInteger(campaignId) || campaignId < 1) return Promise.reject(new Error('INVALID_CAMPAIGN'));
  const current = reserving.get(campaignId);
  if (current) return current;
  const request = post('reserve', { campaignId }).then(parseLuckyBagState).finally(() => {
    if (reserving.get(campaignId) === request) reserving.delete(campaignId);
  });
  reserving.set(campaignId, request);
  return request;
}
export async function claimLuckyBag(reservationId: string, address: string, wechat: string): Promise<LuckyBagState> {
  const result = parseLuckyBagState(await post('claim', { reservationId, address, wechat, consent: true }));
  if (result.state !== 'claimed' || !result.claim) throw new Error('CLAIM_NOT_CONFIRMED');
  return result;
}

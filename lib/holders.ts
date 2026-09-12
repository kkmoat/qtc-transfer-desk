import { addressBytes } from './quantus/protocol.ts';

export const HOLDERS_API_URL = 'https://sqm.quantus.com/v1/graphql';
export const HOLDERS_EXPLORER_URL = 'https://explorer.quantus.com/accounts?order_by=free%3Adesc';
export const HOLDERS_PAGE_SIZE = 25;
export const HOLDERS_QUERY = `query GetAccounts($limit: Int, $offset: Int, $orderBy: [account_order_by!]) {
  accounts: account(limit: $limit, offset: $offset, order_by: $orderBy) {
    id
    free
    frozen
    reserved
  }
  meta: chain_stats_by_pk(id: "global") {
    totalCount: total_accounts
  }
}`;

const PLANCKS_PER_QTC = 1_000_000_000_000n;
const MAX_SUPPLY_PLANCK = 21_000_000n * PLANCKS_PER_QTC;
const MAX_RESPONSE_BYTES = 300_000;

export type HolderAccount = {
  address: string;
  free: bigint;
  frozen: bigint;
  reserved: bigint;
};

export type HoldersSnapshot = {
  accounts: HolderAccount[];
  totalCount: number;
  page: number;
  fetchedAt: number;
};

const invalid = () => new Error('暂时无法读取持币地址，请稍后刷新。');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const balance = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^\d{1,39}$/.test(value)) throw invalid();
  const result = BigInt(value);
  if (result > MAX_SUPPLY_PLANCK) throw invalid();
  return result;
};

export function parseHoldersResponse(value: unknown, page: number, fetchedAt = Date.now()): HoldersSnapshot {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(fetchedAt) || fetchedAt < 1) throw invalid();
  const root = object(value);
  if ('errors' in root) throw invalid();
  const data = object(root.data);
  const rows = data.accounts;
  const meta = object(data.meta);
  if (!Array.isArray(rows) || rows.length > HOLDERS_PAGE_SIZE || !Number.isSafeInteger(meta.totalCount) || Number(meta.totalCount) < 0) throw invalid();
  const accounts = rows.map(row => {
    const account = object(row);
    if (typeof account.id !== 'string') throw invalid();
    try { addressBytes(account.id); } catch { throw invalid(); }
    return { address: account.id, free: balance(account.free), frozen: balance(account.frozen), reserved: balance(account.reserved) };
  });
  for (let index = 1; index < accounts.length; index++) {
    if (accounts[index - 1].free < accounts[index].free) throw invalid();
  }
  const totalCount = Number(meta.totalCount);
  const offset = (page - 1) * HOLDERS_PAGE_SIZE;
  if (accounts.length && totalCount < offset + accounts.length) throw invalid();
  return { accounts, totalCount, page, fetchedAt };
}

export async function fetchHoldersPage(page: number, signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<HoldersSnapshot> {
  if (!Number.isSafeInteger(page) || page < 1) throw invalid();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetcher(HOLDERS_API_URL, {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: requestSignal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: HOLDERS_QUERY, variables: { limit: HOLDERS_PAGE_SIZE, offset: (page - 1) * HOLDERS_PAGE_SIZE, orderBy: { free: 'desc' } } }),
    });
    if (!response.ok) throw invalid();
    const text = await response.text();
    if (!text.length || text.length > MAX_RESPONSE_BYTES) throw invalid();
    return parseHoldersResponse(JSON.parse(text), page);
  } catch {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw invalid();
  }
}

export function formatPlanckQtc(value: bigint, language = 'zh-CN'): string {
  if (value < 0n) throw invalid();
  const whole = value / PLANCKS_PER_QTC;
  const fraction = String(value % PLANCKS_PER_QTC).padStart(12, '0').replace(/0+$/, '');
  return whole.toLocaleString(language) + (fraction ? '.' + fraction : '');
}

import { addressBytes } from './quantus/protocol.ts';

export const HOLDERS_API_URL = '/api/quantus/holders';
export const HOLDERS_SUMMARY_API_URL = '/api/quantus/summary';
export const HOLDERS_EXPLORER_URL = 'https://explorer.quantus.com/accounts?order_by=free%3Adesc';
export const HOLDERS_PAGE_SIZE = 25;
export const HOLDERS_SUMMARY_LEADER_LIMIT = 25;
export const PROJECT_HOLDER_ADDRESS = 'qzmviwoPJR19XovVwUYUoUKb2MoBygYgwYAevj5Br8JeunxW7';
export const QUANPOOL_HOLDER_ADDRESS = 'qzowWAgbzjc2XfHY4vyEo2eVLKbknTESUFoXnisQuUh1x1koo';
export const CEX_HOLDER_ADDRESS = 'qzomrwjTJf49jqYsyBpEZpVdEcAN3A4fdNJAV1xV9SA4Tm8rF';
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

export type HoldersSummarySnapshot = {
  totalBalancePlanck: bigint;
  projectBalancePlanck: bigint;
  excludingProjectPlanck: bigint;
  totalCount: number;
  blockHeight: number;
  finalizedBlockHeight: number;
  sourceTime: number;
  projectLastUpdated: number;
  topAccounts: HolderAccount[];
  fetchedAt: number;
};

export type KnownHolderRole = 'project' | 'quanpool' | 'cex';

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
const account = (value: unknown): HolderAccount => {
  const row = object(value);
  if (typeof row.id !== 'string') throw invalid();
  try { addressBytes(row.id); } catch { throw invalid(); }
  const result = { address: row.id, free: balance(row.free), frozen: balance(row.frozen), reserved: balance(row.reserved) };
  if (result.frozen > result.free || result.free + result.reserved > MAX_SUPPLY_PLANCK) throw invalid();
  return result;
};
const ordered = (accounts: readonly HolderAccount[]) => {
  const addresses = new Set<string>();
  for (let index = 0; index < accounts.length; index++) {
    const current = accounts[index];
    if (addresses.has(current.address) || index > 0 && accounts[index - 1].free < current.free) throw invalid();
    addresses.add(current.address);
  }
};

export function parseHoldersResponse(value: unknown, page: number, fetchedAt = Date.now()): HoldersSnapshot {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(fetchedAt) || fetchedAt < 1) throw invalid();
  const root = object(value);
  if ('errors' in root) throw invalid();
  const data = object(root.data);
  const rows = data.accounts;
  const meta = object(data.meta);
  if (!Array.isArray(rows) || rows.length > HOLDERS_PAGE_SIZE || !Number.isSafeInteger(meta.totalCount) || Number(meta.totalCount) < 0) throw invalid();
  const accounts = rows.map(account);
  ordered(accounts);
  const totalCount = Number(meta.totalCount);
  const offset = (page - 1) * HOLDERS_PAGE_SIZE;
  if (accounts.length && totalCount < offset + accounts.length) throw invalid();
  return { accounts, totalCount, page, fetchedAt };
}

export function parseHoldersSummary(value: unknown, fetchedAt = Date.now()): HoldersSummarySnapshot {
  if (!Number.isSafeInteger(fetchedAt) || fetchedAt < 1) throw invalid();
  const root = object(value);
  if ('errors' in root) throw invalid();
  const data = object(root.data);
  const aggregateRoot = object(data.aggregate);
  const aggregate = object(aggregateRoot.aggregate);
  const sums = object(aggregate.sum);
  const meta = object(data.meta);
  if (!Array.isArray(data.latest) || data.latest.length !== 1) throw invalid();
  const latest = object(data.latest[0]);
  const totalCount = Number(aggregate.count);
  const metaTotalCount = Number(meta.total_accounts), blockHeight = Number(meta.block_height), finalizedBlockHeight = Number(meta.finalized_block_height);
  if (!Number.isSafeInteger(totalCount) || totalCount < 1 || metaTotalCount !== totalCount || !Number.isSafeInteger(blockHeight) || blockHeight < 1 || !Number.isSafeInteger(finalizedBlockHeight) || finalizedBlockHeight < 1 || finalizedBlockHeight > blockHeight) throw invalid();
  const latestHeight = Number(latest.height), sourceTime = typeof latest.timestamp === 'string' ? Date.parse(latest.timestamp) : NaN;
  if (latestHeight !== blockHeight || !Number.isSafeInteger(sourceTime) || sourceTime < Date.UTC(2025,0,1) || sourceTime > fetchedAt + 60_000 || fetchedAt - sourceTime > 5 * 60_000) throw invalid();
  const free = balance(sums.free), reserved = balance(sums.reserved);
  const totalBalancePlanck = free + reserved;
  if (totalBalancePlanck <= 0n || totalBalancePlanck > MAX_SUPPLY_PLANCK) throw invalid();
  if (!Array.isArray(data.leaders) || data.leaders.length !== Math.min(HOLDERS_SUMMARY_LEADER_LIMIT, totalCount)) throw invalid();
  const topAccounts = data.leaders.map(account);
  ordered(topAccounts);
  const projectRow = object(data.project);
  const project = account(projectRow);
  if (project.address !== PROJECT_HOLDER_ADDRESS) throw invalid();
  const projectLastUpdated = Number(projectRow.last_updated);
  if (!Number.isSafeInteger(projectLastUpdated) || projectLastUpdated < 0 || projectLastUpdated > blockHeight) throw invalid();
  const projectBalancePlanck = project.free + project.reserved;
  if (projectBalancePlanck > totalBalancePlanck) throw invalid();
  return {
    totalBalancePlanck,
    projectBalancePlanck,
    excludingProjectPlanck: totalBalancePlanck - projectBalancePlanck,
    totalCount,
    blockHeight,
    finalizedBlockHeight,
    sourceTime,
    projectLastUpdated,
    topAccounts,
    fetchedAt,
  };
}

export async function fetchHoldersPage(page: number, signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<HoldersSnapshot> {
  if (!Number.isSafeInteger(page) || page < 1) throw invalid();
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetcher(`${HOLDERS_API_URL}?page=${page}`, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: requestSignal,
      headers: { Accept: 'application/json' },
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

export async function fetchHoldersSummary(signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<HoldersSummarySnapshot> {
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  try {
    const response = await fetcher(HOLDERS_SUMMARY_API_URL, {
      method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: requestSignal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw invalid();
    const text = await response.text();
    if (!text.length || text.length > MAX_RESPONSE_BYTES) throw invalid();
    return parseHoldersSummary(JSON.parse(text));
  } catch {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    throw invalid();
  }
}

export function knownHolderRole(address: string): KnownHolderRole | null {
  if (address === PROJECT_HOLDER_ADDRESS) return 'project';
  if (address === QUANPOOL_HOLDER_ADDRESS) return 'quanpool';
  if (address === CEX_HOLDER_ADDRESS) return 'cex';
  return null;
}

export function formatPlanckQtc(value: bigint, language = 'zh-CN'): string {
  if (value < 0n) throw invalid();
  const whole = value / PLANCKS_PER_QTC;
  const fraction = String(value % PLANCKS_PER_QTC).padStart(12, '0').replace(/0+$/, '');
  return whole.toLocaleString(language) + (fraction ? '.' + fraction : '');
}

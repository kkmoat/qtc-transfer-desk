import { GENESIS, RPC_URLS, PLANCK, storagePrefix, fromLittle, unhex } from '../quantus/protocol.ts';

// Quantus whitepaper v0.4.1; exact genesis balance also includes 0.001 QTC initialization.
export const MAX_SUPPLY_PLANCK = 21_000_000n * PLANCK;
export const GENESIS_SUPPLY_PLANCK = 5_670_000n * PLANCK + 1_000_000_000n;
export const SUPPLY_SOURCE = 'https://www.quantus.com/whitepaper/v0.4.1/';
export const OVERVIEW_MAX_AGE_MS = 5 * 60_000;
export const ISSUANCE_KEY = storagePrefix('Balances', 'TotalIssuance');
export const TIMESTAMP_KEY = storagePrefix('Timestamp', 'Now');
// Round Planck before formatting so binary floating point cannot cross a decimal boundary.
export function formatSupply(value: bigint, locale = 'zh-CN'): string {
  const negative = value < 0n, absolute = negative ? -value : value;
  const rounded = (absolute + 500_000_000n) / 1_000_000_000n;
  const fraction = (rounded % 1000n).toString().padStart(3, '0').replace(/0+$/, '');
  return (negative && rounded > 0n ? '-' : '') + (rounded / 1000n).toLocaleString(locale) + (fraction ? '.' + fraction : '');
}
export type SupplySnapshot = {
  totalPlanck: bigint; genesisPlanck: bigint; minedNetPlanck: bigint;
  block: number; blockHash: string; blockTime: number; fetchedAt: number; endpoint: string;
};
const hash = (s: unknown): s is string => typeof s === 'string' && /^0x[0-9a-f]{64}$/.test(s);
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('供应数据格式异常。');
  return value as Record<string, unknown>;
}
export function decodeSupply(value: unknown): bigint {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{32}$/.test(value)) throw new Error('供应数据缺失或编码无效。');
  const total = fromLittle(unhex(value));
  if (total === 0n || total > MAX_SUPPLY_PLANCK) throw new Error('供应数据超出主网上限。');
  return total;
}
export function parseSupplySnapshot(values: { genesis: unknown; properties: unknown; head: unknown; header: unknown; issuance: unknown; genesisIssuance: unknown; timestamp: unknown }, fetchedAt: number, endpoint: string): SupplySnapshot {
  const properties = object(values.properties), header = object(values.header);
  if (values.genesis !== GENESIS || properties.tokenDecimals !== 12 || !['QTC','QUAN'].includes(String(properties.tokenSymbol)) || !hash(values.head)) throw new Error('无法验证 Quantus 主网供应数据。');
  if (typeof header.number !== 'string' || !/^0x[0-9a-fA-F]{1,10}$/.test(header.number)) throw new Error('供应快照区块无效。');
  if (typeof values.timestamp !== 'string' || !/^0x[0-9a-fA-F]{16}$/.test(values.timestamp)) throw new Error('供应快照时间缺失。');
  const blockTime = Number(fromLittle(unhex(values.timestamp)));
  if (!Number.isSafeInteger(blockTime) || blockTime < Date.UTC(2025,0,1) || blockTime > fetchedAt + 60_000) throw new Error('供应快照时间异常。');
  const totalPlanck = decodeSupply(values.issuance), genesisPlanck = decodeSupply(values.genesisIssuance);
  if (genesisPlanck !== GENESIS_SUPPLY_PLANCK) throw new Error('创世供应量与主网记录不一致。');
  return { totalPlanck, genesisPlanck, minedNetPlanck: totalPlanck - genesisPlanck, block: Number(BigInt(header.number)), blockHash: values.head, blockTime, fetchedAt, endpoint };
}
let nextId = 1;
export async function fetchSupplySnapshot(signal: AbortSignal, fetcher: typeof fetch = (input, init) => fetch(input, init)): Promise<SupplySnapshot> {
  for (const endpoint of RPC_URLS) {
    try {
      const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(18_000)]);
      const call = async (method: string, params: unknown[] = []): Promise<unknown> => {
        const id = nextId++;
        const response = await fetcher(endpoint, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store', signal: requestSignal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
        if (!response.ok) throw new Error('供应节点暂不可用。');
        const text = await response.text(); if (text.length > 100_000) throw new Error('供应响应过大。');
        const data = object(JSON.parse(text)); if (data.id !== id || data.error || !('result' in data)) throw new Error('供应节点返回错误。');
        return data.result;
      };
      const [genesis, properties, head] = await Promise.all([call('chain_getBlockHash', [0]), call('system_properties'), call('chain_getFinalizedHead')]);
      if (genesis !== GENESIS || !hash(head)) throw new Error('无法验证 Quantus 主网供应数据。');
      const [header, issuance, genesisIssuance, timestamp] = await Promise.all([call('chain_getHeader', [head]), call('state_getStorage', [ISSUANCE_KEY, head]), call('state_getStorage', [ISSUANCE_KEY, GENESIS]), call('state_getStorage', [TIMESTAMP_KEY, head])]);
      return parseSupplySnapshot({ genesis, properties, head, header, issuance, genesisIssuance, timestamp }, Date.now(), endpoint);
    } catch {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    }
  }
  throw new Error('暂时无法读取官方主网供应数据，请稍后刷新。');
}

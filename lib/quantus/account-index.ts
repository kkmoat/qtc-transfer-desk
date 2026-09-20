export const MAX_ACCOUNT_INDEX = 0x7fffffff;
export const ACCOUNT_INDEX_RANGE_ERROR = `账户序号须在 0–${MAX_ACCOUNT_INDEX} 之间。`;

/** Parses a hardened BIP44 account child before it enters the u32 WASM boundary. */
export function parseAccountIndex(value: string): number {
  if (!/^\d{1,10}$/.test(value)) throw new RangeError(ACCOUNT_INDEX_RANGE_ERROR);
  const accountIndex = Number(value);
  if (!Number.isSafeInteger(accountIndex) || accountIndex > MAX_ACCOUNT_INDEX) throw new RangeError(ACCOUNT_INDEX_RANGE_ERROR);
  return accountIndex;
}

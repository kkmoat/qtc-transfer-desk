import { PLANCK } from '../quantus/protocol.ts';

// Preserve the exchange's decimal price and chain's integer precision, rounding only to cents.
export function valuationCents(supplyPlanck: bigint | undefined, price: string | undefined): bigint | null {
  if (supplyPlanck === undefined || supplyPlanck < 0n || typeof price !== 'string' || !/^(0|[1-9][0-9]{0,14})(\.[0-9]{1,18})?$/.test(price)) return null;
  const [whole, fraction = ''] = price.split('.');
  const scaledPrice = BigInt(whole + fraction);
  if (scaledPrice <= 0n) return null;
  const denominator = PLANCK * 10n ** BigInt(fraction.length);
  return (supplyPlanck * scaledPrice * 100n + denominator / 2n) / denominator;
}

export function formatValuation(cents: bigint | null, locale = 'zh-CN'): string {
  if (cents === null) return '—';
  return (cents / 100n).toLocaleString(locale) + '.' + (cents % 100n).toString().padStart(2, '0');
}

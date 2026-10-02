// Small formatting helpers shared across the e2e script's console/manifest
// output. mUSDC uses 6 decimals; MON (like ETH) uses 18.
export const MUSDC_DECIMALS = 6;
export const MON_DECIMALS = 18;

export function formatUnitsDecimal(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  // Apply the sign once, on the magnitude — otherwise a negative `raw` makes
  // BOTH the whole and fractional parts negative (e.g. -4975.-492544).
  const sign = raw < 0n ? "-" : "";
  const abs = raw < 0n ? -raw : raw;
  const whole = abs / base;
  const frac = abs % base;
  return `${sign}${whole}.${frac.toString().padStart(decimals, "0")}`;
}

export function formatMUSDC(raw: bigint): string {
  return formatUnitsDecimal(raw, MUSDC_DECIMALS);
}

export function formatMON(raw: bigint): string {
  return formatUnitsDecimal(raw, MON_DECIMALS);
}

import { formatUnits } from "viem";

/**
 * Formats a raw token amount (bigint, smallest unit) using the token's
 * decimals: thousands-grouped, and capped to at most 2 fraction digits once
 * the whole-number part reaches ~1000 (four decimals of noise on a 5-digit
 * balance reads as "80079.9999", not as a balance). Below that threshold,
 * up to `maxFractionDigits` are kept.
 *
 * The fraction is always truncated, never rounded up — this was already
 * true before (`.slice`, not `.toFixed`) and stays true here: a token
 * figure is never displayed larger than its exact on-chain value, so this
 * can never overstate an available/spendable balance.
 */
export function formatTokenAmount(raw: bigint, decimals: number, maxFractionDigits = 4): string {
  const formatted = formatUnits(raw, decimals);
  const negative = formatted.startsWith("-");
  const unsigned = negative ? formatted.slice(1) : formatted;
  const [whole, fraction = ""] = unsigned.split(".");

  const effectiveDigits = whole.length >= 4 ? Math.min(maxFractionDigits, 2) : maxFractionDigits;
  const truncatedFraction = fraction.slice(0, effectiveDigits).replace(/0+$/, "");

  const groupedWhole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = negative ? "-" : "";
  return truncatedFraction.length > 0 ? `${sign}${groupedWhole}.${truncatedFraction}` : `${sign}${groupedWhole}`;
}

/**
 * Same as formatTokenAmount, but prefixes a "+" for positive values so a
 * profit/loss figure reads as signed rather than looking like a plain
 * balance. formatUnits already renders negative bigints with a leading "-",
 * so only the positive case needs help; zero is left unsigned.
 */
export function formatSignedTokenAmount(raw: bigint, decimals: number, maxFractionDigits = 4): string {
  const formatted = formatTokenAmount(raw, decimals, maxFractionDigits);
  return raw > 0n ? `+${formatted}` : formatted;
}

/**
 * Same display rule as formatTokenAmount (thousands-grouped, capped to 2
 * fraction digits once the whole part reaches ~1000) but for a value that
 * is already a plain JS number in display units rather than a raw bigint —
 * e.g. useMarkToMarket's mark-to-market P&L, computed client-side rather
 * than read from the chain. Rounds to the nearest unit (toLocaleString),
 * not floored: this is a live estimate, not a spendable balance, so
 * formatTokenAmount's "never overstate an available figure" floor doesn't
 * apply. Prefixed "+"/"−" (U+2212, aligns with digits) so a P&L figure
 * always reads as signed rather than looking like a plain balance; zero is
 * left unsigned.
 */
export function formatSignedNumber(value: number, maxFractionDigits = 4): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const digits = abs >= 1000 ? Math.min(maxFractionDigits, 2) : maxFractionDigits;
  const formatted = abs.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: digits });
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}${formatted}`;
}

/** Formats a bigint as a plain integer string with thousands separators. */
export function formatInt(raw: bigint): string {
  return raw.toLocaleString("en-US");
}

/** Formats a bps value (0-10000) as a percentage string, e.g. 8000 -> "80%". */
export function formatBps(bps: number | bigint): string {
  const value = Number(bps) / 100;
  return `${value}%`;
}

/**
 * Formats an already-descaled USD price with thousands separators.
 *
 * Decimals scale with the price, because a fixed 2 is wrong at both ends: it
 * is noise on BTC and destroys a sub-dollar asset outright — every MON strike
 * around $0.0229 would render as "0.02", making three distinct ladder rungs
 * look identical. Below $1 this keeps roughly five significant figures,
 * capped at 8 because that is the on-chain price resolution (PRICE_SCALE).
 */
export function formatUsdPrice(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value) >= 1 ? 0 : Math.floor(Math.log10(Math.abs(value) || 1));
  const decimals = Math.abs(value) >= 1000 ? 3 : Math.abs(value) >= 1 ? 4 : Math.min(8, Math.max(2, 4 - magnitude));
  return value.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Exact 1e8-scaled settlement threshold, for labels with strict >/< rules. */
export function formatExactStrike(value: bigint | number): string {
  if (typeof value === "number" && (!Number.isFinite(value) || !Number.isSafeInteger(Math.round(value * 1e8)))) return "—";
  const raw = typeof value === "bigint" ? value : BigInt(Math.round(value * 1e8));
  const [whole, fraction = ""] = formatUnits(raw, 8).split(".");
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

/** Formats a fractional change as a signed percentage, e.g. 0.0042 -> "+0.42%". */
export function formatSignedPercent(fraction: number, fractionDigits = 2): string {
  if (!Number.isFinite(fraction)) return "—";
  const percent = fraction * 100;
  // U+2212 minus for the negative sign — it aligns with digits, unlike a hyphen.
  const sign = percent > 0 ? "+" : percent < 0 ? "−" : "";
  return `${sign}${Math.abs(percent).toFixed(fractionDigits)}%`;
}

export function shortenAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function bytes32ToUtf8(hex: string): string {
  // Series `symbol` and similar bytes32 fields are stored as UTF-8 padded
  // with trailing zero bytes.
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = clean.match(/.{1,2}/g) ?? [];
  const chars = bytes
    .map((byte) => parseInt(byte, 16))
    .filter((code) => code !== 0)
    .map((code) => String.fromCharCode(code));
  return chars.join("") || "(empty)";
}

export function formatTimestamp(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toLocaleString();
}

/** Formats a unix-seconds timestamp as a short "x ago" string relative to `nowSeconds`. */
export function formatAgo(unixSeconds: number, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const delta = nowSeconds - unixSeconds;
  if (!Number.isFinite(delta)) return "—";
  // A clock skew between the browser and the publisher shouldn't read as "-3s ago".
  if (delta <= 0) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
}

/**
 * Fractional 24h change: live spot against the oldest close in a Benchmarks
 * history window. Single source of truth for this formula so the price panel
 * and the market selector (both showing a 24h badge for the same feed) can
 * never quietly drift apart. Undefined whenever either input is missing or
 * the reference close is non-positive — never zeroed, since "no data" and "no
 * change" are different facts.
 */
export function compute24hChange(spotPrice: number | undefined, firstClose: number | undefined): number | undefined {
  if (spotPrice === undefined || firstClose === undefined || firstClose <= 0) return undefined;
  return (spotPrice - firstClose) / firstClose;
}

/**
 * Coarse time-to-expiry, e.g. "1h 12m", "3d 4h", "42s" or "expired" — traders
 * think in time-to-expiry, not raw timestamps, so this is what's shown
 * front-and-center wherever an expiry appears; the exact timestamp (via
 * `formatTimestamp`) stays one hover away rather than disappearing. Minute
 * granularity above a minute; second granularity only in the last minute,
 * where it actually matters.
 */
export function formatCountdown(expirySeconds: bigint | number, nowSeconds: number): string {
  const expiry = Number(expirySeconds);
  if (!Number.isFinite(expiry)) return "—";
  const delta = Math.floor(expiry - nowSeconds);
  if (delta <= 0) return "expired";
  if (delta < 60) return `${delta}s`;

  const totalMinutes = Math.floor(delta / 60);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * "4.5%" from a probability in [0, 1] — unsigned, since a chance of finishing
 * in the money is never a directional delta. Clamped, because a probability
 * is never anything else.
 */
export function formatProbabilityPercent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "—";
  const clamped = Math.min(1, Math.max(0, fraction));
  return `${(clamped * 100).toFixed(1)}%`;
}

/** Keep the fixed payout tier legible: 1.5×, 2×, or 3×. */
export function formatMultiple(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "—";
  return Number.isInteger(value) ? value.toString() : value.toFixed(1);
}

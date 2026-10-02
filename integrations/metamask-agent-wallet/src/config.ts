import { getAddress, type Address, type Hex } from "viem";

export const CHAIN_ID = 10_143;
export const VAULT = getAddress("0x179496c12efabb8131b16a3affeaf6cb5547b105");
export const FACTORY = getAddress("0x26d889747684ccd6bcab5ac165976b870dc91b9a");
export const SETTLEMENT_TOKEN = getAddress("0x2c1c01b4830148d0b17ae4ee74fdd082c2e7d850");
export const DEFAULT_API_ORIGIN = "https://monad.usetend.xyz";
export const MAX_POSITION_SCAN = 250n;
export const MAX_QUOTE_TTL_SECONDS = 90n;
export const MAX_MULTIPLE = 4;
export const MAX_PREMIUM_RAW = 100_000_000n; // 100 mUSDC (6 decimals)

export const UNDERLYINGS: readonly { symbol: string; feedId: Hex }[] = [
  { symbol: "BTC", feedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { symbol: "ETH", feedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  { symbol: "MON", feedId: "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1" },
];
export const TENORS = [
  { id: "15m", leadSeconds: 900n, ladderSize: 20 },
  { id: "1h", leadSeconds: 3_600n, ladderSize: 5 },
  { id: "12h", leadSeconds: 43_200n, ladderSize: 1 },
] as const;

export function apiOrigin(value?: string): string {
  const url = new URL(value?.trim() || DEFAULT_API_ORIGIN);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("API origin must use HTTPS (HTTP is allowed only for localhost development).");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("API origin must be a bare origin without credentials, path, query, or fragment.");
  return url.origin;
}

export function address(value: unknown, label: string): Address {
  if (typeof value !== "string") throw new Error(`${label} is not an address.`);
  try { return getAddress(value); } catch { throw new Error(`${label} is not a valid EVM address.`); }
}

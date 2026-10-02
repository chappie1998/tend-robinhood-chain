import { EXPIRY_ROUND_SECONDS, type TenorConfig } from "./seriesParams.js";

export function pastBucketsFor(tenor: Pick<TenorConfig, "leadSeconds">): bigint {
  return tenor.leadSeconds / EXPIRY_ROUND_SECONDS + 2n;
}

export function futureBucketsFor(tenor: Pick<TenorConfig, "leadSeconds" | "ladderSize">): bigint {
  // The keeper rounds UP to the tenor's own grid before adding rung lead.
  // Include that extra phase offset: a 12h rung can be almost 24h from now.
  return BigInt(tenor.ladderSize) * (tenor.leadSeconds / EXPIRY_ROUND_SECONDS) + 2n;
}

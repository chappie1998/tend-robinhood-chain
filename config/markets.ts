// Single source of truth for which markets the Monad demo seeds and keeps
// alive. Both scripts/lib/e2e/seed-series.ts (the shared creation/authorize
// routine) and its two callers — scripts/bootstrap-monad.ts and
// scripts/keeper-monad.ts — iterate this list instead of hardcoding a single
// symbol/feed id. Adding a third market is a one-line addition here; nothing
// else needs to change.
//
// Every entry is a chain-agnostic Pyth Hermes feed id (they identify a price
// stream on Pyth's network, not an on-chain account — see
// scripts/lib/e2e/seed-series.ts for the on-chain vs. off-chain distinction).
// All trade 24/7, matching Tend's always-on product direction — no "market
// hours" gating anywhere.
import type { Hex } from "viem";

export interface MarketConfig {
  /**
   * Encoded on-chain as bytes32 via stringToHex(symbol, { size: 32 }), so it
   * must fit in 31 ASCII bytes (32 minus the implicit null terminator viem's
   * stringToHex doesn't actually add, but keep it short regardless).
   */
  symbol: string;
  /** Pyth's canonical price feed id for this market's underlying, on Hermes. */
  pythFeedId: Hex;
}

export const MARKETS = [
  { symbol: "BTC", pythFeedId: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43" },
  { symbol: "ETH", pythFeedId: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace" },
  // Monad's own token, on the chain this deploys to. Trades around \/bin/zsh.02, which
  // is why the strike tick floors at the on-chain price resolution rather than
  // a cent (see strikeTick in quote-service/strikeLadder.ts) and why
  // formatUsdPrice scales its decimals — a 2-decimal price renders every MON
  // strike as "0.02".
  { symbol: "MON", pythFeedId: "0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1" },
] as const satisfies readonly MarketConfig[];

// Single source of truth for the `baseFork` Hardhat network: a forked copy of
// Base mainnet used ONLY by scripts/pyth-fork-settlement.ts to prove
// `TendSeriesFactory.publishSettlement` against a REAL canonical Pyth
// receiver (real Wormhole VAA verification, real update fee) — a code path
// that has never executed anywhere else in this repo, because Monad
// testnet's canonical receiver reverts `InvalidWormholeVaa` (see
// config/monad.ts and scripts/diagnose-pyth.mjs).
//
// The receiver address below was NOT taken on faith from docs or memory: it
// was verified empirically (2026-08-03) against `https://mainnet.base.org`
// by (1) confirming `eth_getCode` returns non-empty bytecode identical in
// size to the same address on Arbitrum One and Ethereum mainnet (a shared
// EIP-1967-style proxy), (2) calling `getUpdateFee(bytes[])` with an empty
// array and getting a valid `uint256` response, and (3) calling
// `getPriceUnsafe(BTC_USD_FEED_ID)` and getting back a real, economically
// sane BTC/USD price (~$63,236 with an ~8-decimal exponent and a recent
// on-chain publishTime) — i.e. this is genuinely Pyth's live BTC/USD feed,
// not just any contract at a plausible-looking address.
export const BASE_FORK = {
  name: "baseFork",
  chainId: 8453,
  rpcUrl: "https://mainnet.base.org",
  /// Pinned for reproducibility. Chosen 2026-08-03: block 49469358, timestamp
  /// 1785728063 (2026-08-03T03:34:23Z) — about 5 hours before the block used
  /// to first verify the receiver above, comfortably inside the "3-6 hours in
  /// the past" window the timing trick in
  /// scripts/pyth-fork-settlement.ts needs: the series created against this
  /// fork expires shortly after this timestamp, and Hermes is asked for a
  /// REAL historical VAA published inside that expiry window, hours before
  /// the real wall-clock "now" the test actually runs at.
  blockNumber: 49_469_358,
  blockTimestamp: 1_785_728_063,
  /// Pyth's canonical EVM receiver, currently deployed at the same address
  /// on Base, Arbitrum One, and Ethereum mainnet (verified above). Pyth's
  /// docs additionally reference an "upgraded" address slated to take over
  /// automatically; this fork test intentionally pins the CURRENT address
  /// since that is what is live at `blockNumber`.
  pythAddress: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
} as const;

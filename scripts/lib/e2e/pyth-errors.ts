// Pyth's own custom errors (from @pythnetwork/pyth-sdk-solidity/PythErrors.sol),
// so viem can decode reverts that bubble up from the underlying Pyth
// receiver contract (MockPyth on Monad testnet, see the header comment in
// scripts/e2e-monad.ts for why) through TendSeriesFactory.publishSettlement
// — that call path reverts with the *Pyth* contract's own errors, which are
// not declared in TendSeriesFactory's ABI, so decoding needs this merged in
// separately. Selectors are copied verbatim from PythErrors.sol's own
// comments. The Wormhole-specific selectors (InvalidWormholeVaa and
// friends) are kept even though MockPyth never triggers them, since they
// only ever came from Monad testnet's *canonical* Pyth receiver, which this
// e2e proof no longer calls.
// Selector -> name, straight from the comments in PythErrors.sol, so a bare
// "reverted with signature 0x..." (which is all viem can print when the
// erroring contract's ABI isn't the one supplied to the call) can still be
// attributed to a specific, well-known Pyth error without guessing.
export const PYTH_ERROR_SELECTORS: Record<string, string> = {
  "0xa9cb9e0d": "InvalidArgument",
  "0xe60dce71": "InvalidUpdateDataSource",
  "0xe69ffece": "InvalidUpdateData",
  "0x025dbdd4": "InsufficientFee",
  "0xde2c57fa": "NoFreshUpdate",
  "0x45805f5d": "PriceFeedNotFoundWithinRange",
  "0x14aebe68": "PriceFeedNotFound",
  "0x19abf40e": "StalePrice",
  "0x2acbe915": "InvalidWormholeVaa",
  "0x97363b35": "InvalidGovernanceMessage",
  "0x63daeb77": "InvalidGovernanceTarget",
  "0x360f2d87": "InvalidGovernanceDataSource",
  "0x88d1b847": "OldGovernanceMessage",
  "0x13d3ed82": "InvalidWormholeAddressToSet",
};

/// Extracts a known Pyth error selector from a raw viem error message (viem
/// prints the unrecognized selector verbatim when the call's own ABI doesn't
/// declare it — which is always true here, since these errors belong to the
/// nested Pyth contract call, not TendSeriesFactory). Returns the error name
/// if recognized.
export function matchPythErrorSelector(message: string): string | undefined {
  for (const [selector, name] of Object.entries(PYTH_ERROR_SELECTORS)) {
    if (message.includes(selector)) return name;
  }
  return undefined;
}

export const PYTH_ERRORS_ABI = [
  { type: "error", name: "InvalidArgument", inputs: [] }, // 0xa9cb9e0d
  { type: "error", name: "InvalidUpdateDataSource", inputs: [] }, // 0xe60dce71
  { type: "error", name: "InvalidUpdateData", inputs: [] }, // 0xe69ffece
  { type: "error", name: "InsufficientFee", inputs: [] }, // 0x025dbdd4
  { type: "error", name: "NoFreshUpdate", inputs: [] }, // 0xde2c57fa
  { type: "error", name: "PriceFeedNotFoundWithinRange", inputs: [] }, // 0x45805f5d
  { type: "error", name: "PriceFeedNotFound", inputs: [] }, // 0x14aebe68
  { type: "error", name: "StalePrice", inputs: [] }, // 0x19abf40e
  { type: "error", name: "InvalidWormholeVaa", inputs: [] }, // 0x2acbe915
  { type: "error", name: "InvalidGovernanceMessage", inputs: [] }, // 0x97363b35
  { type: "error", name: "InvalidGovernanceTarget", inputs: [] }, // 0x63daeb77
  { type: "error", name: "InvalidGovernanceDataSource", inputs: [] }, // 0x360f2d87
  { type: "error", name: "OldGovernanceMessage", inputs: [] }, // 0x88d1b847
  { type: "error", name: "InvalidWormholeAddressToSet", inputs: [] }, // 0x13d3ed82
] as const;

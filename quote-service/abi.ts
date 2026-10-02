// Minimal ABI fragments for the read-only getters the quote service calls.
// Kept inline (rather than importing the full hardhat artifact) so the service
// is self-contained and does not depend on `artifacts/` having been compiled.
// Shapes were confirmed against contracts/TendPoolVault.sol,
// contracts/TendSeriesFactory.sol and the generated artifact ABIs:
//   - vault.seriesAuth(bytes32) -> (bool enabled, uint64 lastTradeAt)
//   - factory.getSeries(bytes32) -> Series tuple (object in viem)

export const FACTORY_ABI = [
  {
    type: "function",
    name: "seriesExists",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "isTradable",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getSeries",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "creator", type: "address" },
          { name: "pythFeedId", type: "bytes32" },
          { name: "settlementToken", type: "address" },
          { name: "expiry", type: "uint64" },
          { name: "observationWindow", type: "uint32" },
          { name: "settlementGrace", type: "uint32" },
          { name: "maxConfidenceBps", type: "uint16" },
          { name: "symbol", type: "bytes32" },
          { name: "enabled", type: "bool" },
        ],
      },
    ],
  },
] as const;

export const VAULT_ABI = [
  {
    type: "function",
    name: "quoteAuthority",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "maxPositionBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "maxUtilizationBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "totalAssets",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "lockedCollateral",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "feeBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint16" }],
  },
  {
    type: "function",
    name: "MIN_TRADE_LEAD",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    // Read back an open position so a close quote can be priced from what the
    // chain actually holds — never from what the caller claims it holds.
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "positionId", type: "uint256" }],
    outputs: [
      { name: "buyer", type: "address" },
      { name: "seriesId", type: "bytes32" },
      { name: "direction", type: "uint8" },
      { name: "strike", type: "uint128" },
      { name: "width", type: "uint128" },
      { name: "premium", type: "uint128" },
      { name: "maxPayout", type: "uint128" },
      { name: "feeBps", type: "uint16" },
      { name: "settled", type: "bool" },
      { name: "closed", type: "bool" },
      { name: "closeBid", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "seriesAuth",
    stateMutability: "view",
    inputs: [{ name: "seriesId", type: "bytes32" }],
    outputs: [
      { name: "enabled", type: "bool" },
      { name: "lastTradeAt", type: "uint64" },
    ],
  },
] as const;

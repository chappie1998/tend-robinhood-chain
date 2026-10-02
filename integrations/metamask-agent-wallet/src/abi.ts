export const vaultAbi = [
  { type: "function", name: "nextPositionId", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "seriesAuth", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ name: "enabled", type: "bool" }, { name: "lastTradeAt", type: "uint64" }] },
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [
    { name: "buyer", type: "address" }, { name: "seriesId", type: "bytes32" }, { name: "direction", type: "uint8" },
    { name: "strike", type: "uint128" }, { name: "width", type: "uint128" }, { name: "premium", type: "uint128" },
    { name: "maxPayout", type: "uint128" }, { name: "feeBps", type: "uint16" }, { name: "settled", type: "bool" },
    { name: "closed", type: "bool" }, { name: "closeBid", type: "uint128" }
  ] },
  { type: "function", name: "fillPoolQuote", stateMutability: "nonpayable", inputs: [
    { name: "quote", type: "tuple", components: [
      { name: "nonce", type: "uint256" }, { name: "direction", type: "uint8" }, { name: "strike", type: "uint128" },
      { name: "width", type: "uint128" }, { name: "premium", type: "uint128" }, { name: "maxPayout", type: "uint128" },
      { name: "quoteExpiry", type: "uint64" }, { name: "seriesId", type: "bytes32" }, { name: "buyer", type: "address" }
    ] }, { name: "signature", type: "bytes" }
  ], outputs: [{ type: "uint256" }] },
  { type: "function", name: "closePosition", stateMutability: "nonpayable", inputs: [
    { name: "quote", type: "tuple", components: [
      { name: "nonce", type: "uint256" }, { name: "positionId", type: "uint256" }, { name: "bid", type: "uint128" },
      { name: "quoteExpiry", type: "uint64" }, { name: "seller", type: "address" }
    ] }, { name: "signature", type: "bytes" }
  ], outputs: [{ type: "uint256" }] }
] as const;

export const erc20Abi = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }
] as const;

export const factoryAbi = [
  { type: "function", name: "deriveSeriesId", stateMutability: "pure", inputs: [{ name: "params", type: "tuple", components: [
    { name: "pythFeedId", type: "bytes32" }, { name: "settlementToken", type: "address" }, { name: "expiry", type: "uint64" },
    { name: "observationWindow", type: "uint32" }, { name: "settlementGrace", type: "uint32" },
    { name: "maxConfidenceBps", type: "uint16" }, { name: "symbol", type: "bytes32" }
  ] }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "getSeries", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
    { name: "creator", type: "address" }, { name: "pythFeedId", type: "bytes32" }, { name: "settlementToken", type: "address" },
    { name: "expiry", type: "uint64" }, { name: "observationWindow", type: "uint32" }, { name: "settlementGrace", type: "uint32" },
    { name: "maxConfidenceBps", type: "uint16" }, { name: "symbol", type: "bytes32" }, { name: "enabled", type: "bool" }
  ] }] },
  { type: "function", name: "isTradable", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] }
] as const;

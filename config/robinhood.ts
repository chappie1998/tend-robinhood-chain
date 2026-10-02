// Single source of truth for Robinhood Chain network parameters, used by both
// hardhat.config.ts (network wiring) and scripts/deploy.ts (deployment +
// manifest). Mirrors config/monad.ts — no other file should hardcode a
// Robinhood RPC URL, chain id or Pyth address.
//
// Verified against the live RPC on 2026-09-18: eth_chainId returns 0xb626
// (46630), Multicall3 IS deployed at the standard address (so viem/wagmi
// batched reads work unmodified), and gas prices at 0.01 gwei — four orders
// of magnitude below Monad testnet's 102 gwei.
//
// NO CANONICAL PYTH RECEIVER. All three of Pyth's usual addresses were probed
// on this chain: two hold no code, and the third (0x2880aB15…) has code but
// reverts on both getValidTimePeriod() and getPriceUnsafe(), so it is not an
// IPyth receiver. Settlement therefore runs through MockPyth here, exactly as
// it does on Monad testnet, and carries the same disclosure: MockPyth does
// not authenticate the attestation. `pythAddress` below is the address that
// WOULD be canonical if one is deployed later; it is deliberately not used
// while deployMocks is true.

export const ROBINHOOD_TESTNET = {
  name: "robinhoodTestnet",
  chainId: 46630,
  rpcUrl: "https://rpc.testnet.chain.robinhood.com",
  explorer: "https://explorer.testnet.chain.robinhood.com",
  /// No public faucet found at the time of writing; the deployer was funded
  /// directly. Update this when Robinhood publishes one.
  faucet: "",
  nativeCurrency: "ETH",
  /// Pyth's canonical receiver address on most chains. NOT deployed here yet
  /// (see the header) — kept for the day it is, so the switch is one flag.
  pythAddress: "0x4305FB66699C3B2702D4d05CF36551390A4c69C6",
} as const;

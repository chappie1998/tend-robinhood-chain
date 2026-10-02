// Single source of truth for Monad network parameters used by both
// hardhat.config.ts (network wiring) and scripts/deploy.ts (deployment +
// manifest). When Tend eventually targets Monad mainnet, only this file
// needs a new entry — no other file should hardcode a Monad RPC URL,
// chain id, or Pyth address.
//
// Values below are sourced from Monad's public testnet docs (July 2026):
//   https://docs.monad.xyz — Network Information
//   https://docs.pyth.network — Monad testnet contract addresses

export const MONAD_TESTNET = {
  name: "monadTestnet",
  chainId: 10143,
  rpcUrl: "https://testnet-rpc.monad.xyz",
  explorer: "https://testnet.monadscan.com",
  faucet: "https://faucet.monad.xyz",
  nativeCurrency: "MON",
  /// IPyth contract address on Monad testnet.
  pythAddress: "0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379",
} as const;

// Monad testnet chain definition for viem clients constructed outside
// Hardhat's own network connection. The e2e proof needs a second signer (the
// "buyer") distinct from the configured MONAD_DEPLOYER_KEY account, so it
// builds its own plain viem WalletClient rather than pulling from
// `viem.getWalletClients()` (which only ever returns accounts wired up in
// hardhat.config.ts). This is the single place that shape is defined so it
// stays consistent with config/monad.ts.
import { defineChain } from "viem";
import { selectChain } from "../../../config/chain-selection.mjs";
import { MONAD_TESTNET } from "../../../config/monad.js";
import { ROBINHOOD_TESTNET } from "../../../config/robinhood.js";

export const monadTestnetChain = defineChain({
  id: MONAD_TESTNET.chainId,
  name: "Monad Testnet",
  nativeCurrency: { name: "Monad", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [MONAD_TESTNET.rpcUrl] } },
  blockExplorers: {
    default: { name: "Monadscan", url: MONAD_TESTNET.explorer },
  },
});

export const robinhoodTestnetChain = defineChain({
  id: ROBINHOOD_TESTNET.chainId,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ROBINHOOD_TESTNET.rpcUrl] } },
  blockExplorers: {
    default: { name: "Robinhood Explorer", url: ROBINHOOD_TESTNET.explorer },
  },
});

/**
 * The chain the server-side functions run against, selected at deploy time by
 * TEND_CHAIN (see config/activeChain.ts). Scripts that target one chain
 * explicitly should keep using the named exports above.
 */
export const activeChain =
  selectChain(process.env.TEND_CHAIN) === "robinhood" ? robinhoodTestnetChain : monadTestnetChain;

export function explorerTx(hash: string, chainId = activeChain.id): string {
  const explorer = chainId === ROBINHOOD_TESTNET.chainId ? ROBINHOOD_TESTNET.explorer
    : chainId === MONAD_TESTNET.chainId ? MONAD_TESTNET.explorer : undefined;
  if (!explorer) return hash; // local/private chains have no configured explorer
  return `${explorer}/tx/${hash}`;
}

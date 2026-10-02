import { defineChain, type Chain } from "viem";
import { selectChain } from "../../config/chain-selection.mjs";

// The chain this build talks to, selected at BUILD time by VITE_CHAIN.
//
// One repo, one codebase, two deployments: monad.usetend.xyz and
// robinhood.usetend.xyz. The chain is a module-level constant rather than a
// runtime toggle on purpose — every contract read in this app pins an explicit
// chainId, the deployment manifest is fetched per build, and a build that
// could silently change chains underneath those reads would be far harder to
// reason about than two builds that each know exactly one chain.
//
// Values mirror config/monad.ts and config/robinhood.ts at the worktree root —
// kept in sync by hand, since web/ is a separate package with its own
// dependency graph. Do not hardcode chain values anywhere else in web/.

const CHAIN_KEY = selectChain(import.meta.env.VITE_CHAIN, "VITE_CHAIN");

const MONAD_TESTNET = defineChain({
  id: 10_143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: ["https://testnet-rpc.monad.xyz"] } },
  blockExplorers: { default: { name: "Monad Explorer", url: "https://testnet.monadscan.com" } },
  contracts: {
    // Standard Multicall3. viem's built-in chains get this automatically; a
    // custom defineChain does not, and without it every batched read throws
    // "client chain not configured. multicallAddress is required."
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
  testnet: true,
});

const ROBINHOOD_TESTNET = defineChain({
  id: 46_630,
  name: "Robinhood Chain Testnet",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: { default: { name: "Robinhood Explorer", url: "https://explorer.testnet.chain.robinhood.com" } },
  // Verified deployed at the standard address on this chain (2026-09-18).
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
  testnet: true,
});

/**
 * The active chain. Named `monadTestnet` for now because ~50 call sites import
 * it under that name; it is whichever chain VITE_CHAIN selected.
 *
 * Typed as a single Chain rather than the union of both. A union here would
 * force wagmi's `transports` to cover every chain this file *could* return,
 * including the one this build never talks to — the value is fixed at build
 * time, so the type should be too.
 */
export const monadTestnet: Chain = CHAIN_KEY === "robinhood" ? ROBINHOOD_TESTNET : MONAD_TESTNET;

/** Which manifest this build reads — one file per chain, never shared. */
export const MANIFEST_FILE =
  CHAIN_KEY === "robinhood" ? "robinhood-testnet.json" : "monad-testnet.json";

/**
 * Block explorer base URL for the active chain. Exported as a plain string
 * because viem's `Chain` type makes `blockExplorers` optional — both chains
 * here always define one, and this keeps a dozen call sites from carrying
 * optional-chaining for a value that is never actually absent.
 */
export const EXPLORER_URL = (CHAIN_KEY === "robinhood" ? ROBINHOOD_TESTNET : MONAD_TESTNET)
  .blockExplorers.default.url;

/**
 * Short name of the active chain, for copy that would otherwise hardcode
 * "Monad" — "Monad testnet" on a Robinhood build is simply false, and this
 * app now ships as two deployments from one codebase.
 */
export const CHAIN_LABEL = CHAIN_KEY === "robinhood" ? "Robinhood Chain testnet" : "Monad testnet";

/** Just the network's brand, for the network pill. */
export const CHAIN_BRAND = CHAIN_KEY === "robinhood" ? "Robinhood" : "Monad";

/** The gas token a user needs, for copy that would otherwise hardcode "MON". */
export const GAS_TOKEN = monadTestnet.nativeCurrency.symbol;

/** Faucet for the active chain's gas token, or undefined where none is published. */
export const GAS_FAUCET_URL = CHAIN_KEY === "robinhood" ? undefined : "https://faucet.monad.xyz";

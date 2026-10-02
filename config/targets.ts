// The deployment targets Tend knows how to deploy to.
//
// `monadTestnet` is the live demo: it deploys its own mock settlement token
// and a MockPyth oracle, and collapses every role onto the deployer, because
// nothing there is at stake.
//
// `monadMainnet` is the template for a real deployment. It is deliberately
// left with placeholder addresses and `isProduction: true`, so
// `assertDeploymentTarget` refuses to deploy it until someone has actually
// filled in the settlement token, the canonical Pyth receiver, and — most
// importantly — a quote-signing key that is NOT the deployer or the manager.

import type { Hex } from "viem";
import { MONAD_TESTNET } from "./monad.js";
import { ROBINHOOD_TESTNET } from "./robinhood.js";
import { DEPLOYER_SENTINEL, type DeploymentTarget } from "./deployment-target.js";

const SENTINEL = DEPLOYER_SENTINEL as Hex;

export const TARGETS: Record<string, DeploymentTarget> = {
  /// Hardhat's in-memory chain. Lets `npx hardhat run scripts/deploy.ts` (no
  /// --network) exercise the full deploy + wiring against a throwaway chain,
  /// which is how the script is validated without touching a real network.
  /// Hardhat 3 names this connection "default".
  default: {
    network: "default",
    chainId: 31337,
    rpcUrl: "",
    explorer: "",
    deployMocks: true,
    roles: {
      owner: SENTINEL,
      emergencyAdmin: SENTINEL,
      manager: SENTINEL,
      quoteAuthority: SENTINEL,
      feeRecipient: SENTINEL,
    },
    pool: { maxUtilizationBps: 8_000, maxPositionBps: 2_500, feeBps: 0 },
    isProduction: false,
  },

  /// The live demo. Mocks are correct here: there is no real USDC on Monad
  /// testnet, and Monad testnet's canonical Pyth receiver reverts
  /// InvalidWormholeVaa (stale on-chain Wormhole guardian set), so settlement
  /// runs through MockPyth fed with real Hermes prices.
  monadTestnet: {
    network: MONAD_TESTNET.name,
    chainId: MONAD_TESTNET.chainId,
    rpcUrl: MONAD_TESTNET.rpcUrl,
    explorer: MONAD_TESTNET.explorer,
    deployMocks: true,
    roles: {
      owner: SENTINEL,
      emergencyAdmin: SENTINEL,
      manager: SENTINEL,
      quoteAuthority: SENTINEL,
      feeRecipient: SENTINEL,
    },
    pool: { maxUtilizationBps: 8_000, maxPositionBps: 2_500, feeBps: 0 },
    isProduction: false,
  },

  /// Robinhood Chain testnet. Same shape as the Monad demo and for the same
  /// reason: there is no real USDC here and no working Pyth receiver (see
  /// config/robinhood.ts), so it deploys its own mock settlement token and a
  /// MockPyth, and collapses every role onto the deployer. Nothing is at
  /// stake on a testnet.
  robinhoodTestnet: {
    network: ROBINHOOD_TESTNET.name,
    chainId: ROBINHOOD_TESTNET.chainId,
    rpcUrl: ROBINHOOD_TESTNET.rpcUrl,
    explorer: ROBINHOOD_TESTNET.explorer,
    deployMocks: true,
    roles: {
      owner: SENTINEL,
      emergencyAdmin: SENTINEL,
      manager: SENTINEL,
      quoteAuthority: SENTINEL,
      feeRecipient: SENTINEL,
    },
    pool: { maxUtilizationBps: 8_000, maxPositionBps: 2_500, feeBps: 0 },
    isProduction: false,
  },

  /// Template for a real deployment. Fill in every `0x0…0` before use — the
  /// validator will reject it otherwise, by design.
  monadMainnet: {
    network: "monadMainnet",
    chainId: 143,
    rpcUrl: "https://rpc.monad.xyz",
    explorer: "https://monadscan.com",
    deployMocks: false,
    /// Real USDC (or USDT) on the target chain. Decimals are read from the
    /// token at deploy time, not assumed.
    settlementToken: SENTINEL,
    /// Canonical IPyth receiver for the target chain — see
    /// https://docs.pyth.network for the per-chain address.
    pythAddress: SENTINEL,
    roles: {
      owner: SENTINEL, // multisig
      emergencyAdmin: SENTINEL, // break-glass key, separate from owner
      manager: SENTINEL, // multisig
      quoteAuthority: SENTINEL, // server-held signing key — MUST be distinct
      feeRecipient: SENTINEL,
    },
    pool: { maxUtilizationBps: 8_000, maxPositionBps: 2_500, feeBps: 0 },
    isProduction: true,
  },
};

export function resolveTarget(network: string): DeploymentTarget {
  const target = TARGETS[network];
  if (target === undefined) {
    throw new Error(
      `No deployment target for network "${network}". Known targets: ${Object.keys(TARGETS).join(", ")}. ` +
        `Add one to config/targets.ts.`,
    );
  }
  return target;
}

import { defineConfig, configVariable } from "hardhat/config";
import hardhatViem from "@nomicfoundation/hardhat-viem";
import { MONAD_TESTNET } from "./config/monad.js";
import { ROBINHOOD_TESTNET } from "./config/robinhood.js";
import { BASE_FORK } from "./config/base-fork.js";

// The deployer key is never hardcoded. It is read lazily (only when a script
// actually connects to `monadTestnet`) from the MONAD_DEPLOYER_KEY env var,
// so `compile`/`test` keep working in environments where it isn't set.
const monadDeployerAccounts = process.env.MONAD_DEPLOYER_KEY
  ? [configVariable("MONAD_DEPLOYER_KEY")]
  : [];

export default defineConfig({
  plugins: [hardhatViem],
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: { enabled: true, runs: 500 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  // Hardhat knows Base (chainId 8453) as an OP-stack chain by default, but
  // ships no `hardforkHistory` for it, so EDR cannot tell which ruleset
  // applied at ANY historical block when forking it and refuses every call
  // with "No known hardfork for execution on historical block ...". This
  // override reclassifies it as a plain L1-rules chain with "cancun" active
  // from genesis (matching this repo's own `solidity.evmVersion`), which is
  // all `baseFork` (below) needs: a working EVM at the pinned fork block, not
  // OP-stack-specific behaviour (L1 data fees, deposit transactions, etc.).
  chainDescriptors: {
    8453: {
      name: "Base",
      chainType: "l1",
      hardforkHistory: { cancun: { blockNumber: 0 } },
    },
  },
  networks: {
    monadTestnet: {
      type: "http",
      chainId: MONAD_TESTNET.chainId,
      url: MONAD_TESTNET.rpcUrl,
      accounts: monadDeployerAccounts,
    },
    // Same deployer key as Monad — one testnet identity across both chains,
    // which is also why the manifests must stay per-chain (see
    // deployments/). Gas here is 0.01 gwei, so the same balance goes about
    // four orders of magnitude further.
    robinhoodTestnet: {
      type: "http",
      chainId: ROBINHOOD_TESTNET.chainId,
      url: ROBINHOOD_TESTNET.rpcUrl,
      accounts: monadDeployerAccounts,
    },
    // A forked copy of Base mainnet, used ONLY by
    // scripts/pyth-fork-settlement.ts (run on demand via `npm run
    // test:pyth-fork`, never by the default `test`/`test:contracts` suite —
    // it needs real network access to a public RPC and to Hermes). Proves
    // `publishSettlement` against Pyth's REAL canonical receiver, since
    // Monad testnet's canonical receiver reverts `InvalidWormholeVaa` and
    // every other test/live-run in this repo has only ever exercised
    // MockPyth. Pinned at a fixed historical block for reproducibility; see
    // config/base-fork.ts for how the receiver address and block were
    // chosen and verified.
    baseFork: {
      type: "edr-simulated",
      chainId: BASE_FORK.chainId,
      forking: {
        url: BASE_FORK.rpcUrl,
        blockNumber: BASE_FORK.blockNumber,
      },
    },
  },
});

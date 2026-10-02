// What a deployment TARGET looks like — the knobs that differ between a
// testnet demo and a real deployment, in one place.
//
// The contracts themselves are already deployment-agnostic: `TendPoolVault`
// takes `asset` and `TendSeriesFactory` takes `pyth` as immutable constructor
// arguments, and no Solidity assumes a token's decimals. The demo-vs-real
// coupling lives entirely here and in scripts/deploy.ts.
//
// To deploy against real USDC/USDT: add a target with `settlementToken` and
// `pythAddress` set to the real contract addresses, leave `deployMocks` false,
// and give the three roles distinct addresses. Nothing else needs to change.

import { isAddress, type Hex } from "viem";

export interface RoleConfig {
  /// Can pause the factory and disable series. Should be a multisig on a real
  /// deployment.
  owner: Hex;
  /// Emergency-only guardian, separate from `owner` so a routine key and a
  /// break-glass key are not the same key.
  emergencyAdmin: Hex;
  /// Pool manager: authorises series and updates risk caps.
  manager: Hex;
  /// Signs EIP-712 PoolQuotes. **On a real deployment this MUST NOT be the
  /// deployer or the manager.** It is the one key that lives on a server, so a
  /// compromise of it must not also grant the ability to reconfigure the pool,
  /// move liquidity, or authorise new series. The demo collapses all four onto
  /// one EOA precisely because nothing is at stake there.
  quoteAuthority: Hex;
  /// Where protocol fees accrue.
  feeRecipient: Hex;
}

export interface PoolRiskConfig {
  /// Share of pool capital that may back open positions at once.
  maxUtilizationBps: number;
  /// Share of pool capital any single position may claim.
  maxPositionBps: number;
  /// Protocol fee taken from premium. 0 on the demo; a real deployment should
  /// set this deliberately rather than inherit zero.
  feeBps: number;
}

export interface DeploymentTarget {
  /// Hardhat network name; must match hardhat.config.ts.
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;

  /// When true the deploy script creates a MockERC20 settlement token and a
  /// MockPyth oracle. Real deployments set this false and supply the two
  /// addresses below.
  deployMocks: boolean;

  /// Existing settlement token (USDC/USDT/…). Required when deployMocks is
  /// false. Decimals are READ FROM THE TOKEN at deploy time and recorded in
  /// the manifest — never assumed.
  settlementToken?: Hex;

  /// Canonical IPyth receiver for this chain. Required when deployMocks is
  /// false.
  pythAddress?: Hex;

  roles: RoleConfig;
  pool: PoolRiskConfig;

  /// Written into the manifest so downstream tooling can tell a demo
  /// deployment from a real one without guessing.
  isProduction: boolean;
}

/// Placeholder used by the demo target: the deploy script substitutes the
/// connected deployer for any role left as this sentinel. Real targets must
/// name every role explicitly.
export const DEPLOYER_SENTINEL = "0x0000000000000000000000000000000000000000" as const;

/// Validates a target before any transaction is sent, so a misconfiguration
/// fails on the desk rather than halfway through a mainnet deploy.
export function assertDeploymentTarget(t: DeploymentTarget): void {
  if (!Number.isSafeInteger(t.chainId) || t.chainId <= 0) throw new Error("chainId must be a positive safe integer.");
  if (t.isProduction && t.deployMocks) throw new Error("Production targets must not deploy mocks.");
  for (const [name, address] of Object.entries(t.roles)) {
    if (!isAddress(address, { strict: false })) throw new Error(`Invalid ${name} address.`);
  }
  for (const [name, address] of [["settlementToken", t.settlementToken], ["pythAddress", t.pythAddress]]) {
    if (address !== undefined && !isAddress(address, { strict: false })) throw new Error(`Invalid ${name} address.`);
  }
  if (!t.deployMocks) {
    if (!t.settlementToken || t.settlementToken === DEPLOYER_SENTINEL) {
      throw new Error(
        `Target "${t.network}" has deployMocks=false but no settlementToken. Set it to the real ` +
          `USDC/USDT address on chain ${t.chainId}.`,
      );
    }
    if (!t.pythAddress || t.pythAddress === DEPLOYER_SENTINEL) {
      throw new Error(
        `Target "${t.network}" has deployMocks=false but no pythAddress. Set it to the canonical ` +
          `IPyth receiver on chain ${t.chainId}.`,
      );
    }
  }

  if (t.isProduction) {
    const { owner, emergencyAdmin, manager, quoteAuthority, feeRecipient } = t.roles;
    // Every role must be named explicitly in production. Leaving any of these
    // as the sentinel means the deploy script would silently substitute the
    // connected deployer key for it (see `role()` in scripts/deploy.ts) —
    // exactly how a demo config's "collapse everything onto one EOA" posture
    // leaks into a real deployment.
    if (owner === DEPLOYER_SENTINEL) {
      throw new Error(
        `Target "${t.network}" is production but owner is the deployer sentinel. owner can pause the ` +
          `factory and disable series for everyone; it must be a named multisig, not left to default to ` +
          `whoever happens to run the deploy transaction.`,
      );
    }
    if (emergencyAdmin === DEPLOYER_SENTINEL) {
      throw new Error(
        `Target "${t.network}" is production but emergencyAdmin is the deployer sentinel. This is the ` +
          `break-glass key, kept separate from owner precisely so a routine key and an emergency key are ` +
          `never the same key — leaving it as the sentinel collapses that separation onto the deploy key.`,
      );
    }
    if (manager === DEPLOYER_SENTINEL) {
      throw new Error(
        `Target "${t.network}" is production but manager is the deployer sentinel. The manager authorizes ` +
          `series and can move risk caps (utilization, position limits, fee); it must be named explicitly ` +
          `and passed to the vault's constructor, not silently left as whoever ran the deploy transaction.`,
      );
    }
    if (quoteAuthority === DEPLOYER_SENTINEL) {
      throw new Error(
        `Target "${t.network}" is production but quoteAuthority is the deployer sentinel. The ` +
          `quote-signing key lives on a server and must be a distinct key.`,
      );
    }
    if (feeRecipient === DEPLOYER_SENTINEL) {
      throw new Error(
        `Target "${t.network}" is production but feeRecipient is the deployer sentinel. Protocol fees ` +
          `would otherwise accrue to the throwaway deploy key instead of wherever revenue is actually meant ` +
          `to land.`,
      );
    }
    if (quoteAuthority.toLowerCase() === manager.toLowerCase()) {
      throw new Error(
        `Target "${t.network}": quoteAuthority must not equal manager. A compromised signing key ` +
          `would otherwise be able to reconfigure the pool.`,
      );
    }
    if (quoteAuthority.toLowerCase() === owner.toLowerCase()) {
      throw new Error(`Target "${t.network}": quoteAuthority must not equal owner.`);
    }
    if ([owner, manager, quoteAuthority].some((address) => address.toLowerCase() === emergencyAdmin.toLowerCase())) {
      throw new Error(`Target "${t.network}": emergencyAdmin must be separate from owner, manager and quoteAuthority.`);
    }
  }

  const { maxUtilizationBps, maxPositionBps, feeBps } = t.pool;
  for (const [name, value] of Object.entries(t.pool)) {
    if (!Number.isSafeInteger(value)) throw new Error(`${name} must be a finite safe integer.`);
  }
  if (maxUtilizationBps <= 0 || maxUtilizationBps > 10_000) {
    throw new Error(`maxUtilizationBps must be within (0, 10000], got ${maxUtilizationBps}.`);
  }
  if (maxPositionBps <= 0 || maxPositionBps > maxUtilizationBps) {
    throw new Error(`maxPositionBps must be within (0, maxUtilizationBps], got ${maxPositionBps}.`);
  }
  if (feeBps < 0 || feeBps > 1_000) {
    throw new Error(`feeBps must be within [0, 1000], got ${feeBps}.`);
  }
}

/// Validates the CONNECTED deployer against configured roles, once the actual
/// signer is known (`assertDeploymentTarget` only ever sees the config, never
/// the live signer, so it cannot catch this by itself).
///
/// This exists for one specific real-world mistake: an operator points two
/// env vars at the same private key — e.g. setting `QUOTE_AUTHORITY_KEY` to
/// the same value as `MONAD_DEPLOYER_KEY`, which is exactly what
/// `.env.example` documents for the demo. Two *config* addresses can differ
/// (passing `assertDeploymentTarget`'s distinctness checks) while both still
/// resolve to the deployer's own key, which config-only validation can never
/// observe. Checking the resolved deployer address directly closes that gap.
///
/// A no-op for non-production targets: the demo deliberately deploys with
/// every role collapsed onto the deployer, and that must keep working.
export function assertDeployerNotPrivileged(t: DeploymentTarget, deployer: Hex): void {
  if (!t.isProduction) return;
  const d = deployer.toLowerCase();
  const { owner, emergencyAdmin, quoteAuthority, manager } = t.roles;

  if (manager.toLowerCase() === d) {
    throw new Error(`Target "${t.network}": the connected deployer IS the configured manager.`);
  }

  if (quoteAuthority.toLowerCase() === d) {
    throw new Error(
      `Target "${t.network}": the connected deployer IS the configured quoteAuthority. The quote-signing ` +
        `key must live on a server, never on the machine/key that deploys contracts — otherwise a single ` +
        `compromised key both signs every fill AND could redeploy the protocol.`,
    );
  }
  if (owner.toLowerCase() === d) {
    throw new Error(
      `Target "${t.network}": the connected deployer IS the configured owner. owner should be a multisig ` +
        `held separately from any single deploy key — otherwise whoever holds the deploy key can also ` +
        `pause the factory and disable series unilaterally.`,
    );
  }
  if (emergencyAdmin.toLowerCase() === d) {
    throw new Error(
      `Target "${t.network}": the connected deployer IS the configured emergencyAdmin. The break-glass ` +
        `key must be separate from the deploy key, or there is no separation left between a routine key ` +
        `and the emergency key once either is compromised.`,
    );
  }
}

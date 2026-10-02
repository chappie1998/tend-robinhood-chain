import type { PoolState } from "../hooks/usePoolState";

export interface PoolCapacity {
  /** Uncommitted liquidity the pool could still lock into new positions right
   * now, bounded by both raw on-hand assets and the utilization headroom
   * (maxUtilizationBps of total collateral, minus what's already locked). */
  availableRaw: bigint;
  /** The largest single position (quote.maxPayout) the pool would authorize
   * right now, bounded by availableRaw AND the per-position cap
   * (maxPositionBps of total collateral). */
  maxPayoutRaw: bigint;
}

const BPS_DENOMINATOR = 10_000n;

function bpsLimit(amount: bigint, bps: number): bigint {
  return (amount * BigInt(bps)) / BPS_DENOMINATOR;
}

/**
 * Reproduces `fillPoolQuote`'s own three solvency checks client-side —
 * see the doc comment above `authorizeSeries` in contracts/TendPoolVault.sol,
 * which spells out this exact arithmetic as the canonical description of how
 * a fill is gated:
 *
 *   uint256 totalCollateral = totalAssets + lockedCollateral;
 *   uint256 utilizationLimit = calculateBpsLimit(totalCollateral, maxUtilizationBps);
 *   uint256 positionLimit    = calculateBpsLimit(totalCollateral, maxPositionBps);
 *   if (lockedAfter > utilizationLimit)  revert PoolUtilizationExceeded();
 *   if (quote.maxPayout > positionLimit) revert PoolPositionLimitExceeded();
 *   if (totalAssets < quote.maxPayout)   revert InsufficientLiquidity();
 *
 * The vault exposes no view function that answers "how much room is left" —
 * this is pure arithmetic over fields `usePoolState` already reads, so it can
 * never promise a fill the contract would actually refuse, and never needs a
 * second on-chain read.
 */
export function poolCapacity(pool: PoolState): PoolCapacity {
  const totalCollateral = pool.totalAssets + pool.lockedCollateral;
  const utilizationLimit = bpsLimit(totalCollateral, pool.maxUtilizationBps);
  const positionLimit = bpsLimit(totalCollateral, pool.maxPositionBps);
  const utilizationHeadroom =
    utilizationLimit > pool.lockedCollateral ? utilizationLimit - pool.lockedCollateral : 0n;

  const availableRaw = utilizationHeadroom < pool.totalAssets ? utilizationHeadroom : pool.totalAssets;
  const maxPayoutRaw = positionLimit < availableRaw ? positionLimit : availableRaw;

  return { availableRaw, maxPayoutRaw };
}

import type { Address } from "viem";
import { EXPLORER_URL } from "../chain";
import type { PoolStateQuery } from "../hooks/usePoolState";
import { formatBps, formatInt, formatTokenAmount, shortenAddress } from "../lib/format";
import { CopyableValue } from "./CopyableValue";
import { FaucetPanel } from "./FaucetPanel";
import { LiquidityForm } from "./LiquidityForm";

export function PoolPanel({
  vaultAddress,
  tokenAddress,
  poolQuery,
  showFaucet,
}: {
  vaultAddress: Address;
  tokenAddress: Address;
  poolQuery: PoolStateQuery;
  /** False only when the manifest names a real (non-mock) settlement token — see deployment.ts isMockSettlement. Minting is a mock-only affordance. */
  showFaucet: boolean;
}) {
  const { data, isLoading, isError, errors } = poolQuery;

  return (
    <div className="dock-panel">
      {/* "Be the house" leads the tab: LPs are the counterparty collecting the
          premium every trader pays, not a passive index. Copy + heading only —
          every number below, the PoolHasOpenPositions gate and deposit/
          withdraw behaviour are all unchanged. */}
      <div className="dock-panel__subhead dock-panel__subhead--split">
        <div>
          <h3 className="pool-panel__heading">Be the house</h3>
          <p className="hint">Supply liquidity and earn the premium every trader pays.</p>
        </div>
        <a className="link" href={`${EXPLORER_URL}/address/${vaultAddress}`} target="_blank" rel="noreferrer">
          Vault {shortenAddress(vaultAddress)}
        </a>
      </div>

      {isLoading && !data && <p className="hint">Loading pool state…</p>}

      {isError && (
        <p className="error-text">
          RPC error reading pool state: {errors[0] ?? "unknown error"}
        </p>
      )}

      {data && (
        <>
          {/* Faucet folded into a compact row rather than its own top-level panel —
              it funds trading and LP here, it isn't the point of the app.
              Hidden entirely against a real (non-mock) settlement token —
              minting doesn't apply there. See deployment.ts isMockSettlement. */}
          {showFaucet && (
            <div className="pool-faucet-row">
              <span className="hint">mUSDC faucet</span>
              <FaucetPanel tokenAddress={tokenAddress} />
            </div>
          )}

          <div className="stat-grid">
            <Stat label={`Total assets (${data.assetSymbol})`} value={formatTokenAmount(data.totalAssets, data.assetDecimals)} />
            <Stat label="Total shares" value={formatTokenAmount(data.totalShares, data.assetDecimals)} />
            <Stat label={`Locked collateral (${data.assetSymbol})`} value={formatTokenAmount(data.lockedCollateral, data.assetDecimals)} />
            <Stat label="Open positions" value={formatInt(data.openPositions)} />
            <Stat label="Max utilization" value={formatBps(data.maxUtilizationBps)} />
            <Stat label="Max position size" value={formatBps(data.maxPositionBps)} />
            <Stat label="Fee" value={formatBps(data.feeBps)} />
          </div>

          <div className="kv-list">
            <KV label="Settlement asset" value={data.assetSymbol} address={data.asset} />
            <KV label="Manager" address={data.manager} />
            <KV label="Quote authority" address={data.quoteAuthority} />
          </div>

          <LiquidityForm vaultAddress={vaultAddress} tokenAddress={tokenAddress} pool={data} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
    </div>
  );
}

function KV({ label, value, address }: { label: string; value?: string; address: Address }) {
  return (
    <div className="kv-row">
      <span className="kv-row__label">{label}</span>
      <span className="kv-row__value">
        {value ? `${value} (` : null}
        <CopyableValue value={address} />
        {value ? ")" : null}
      </span>
    </div>
  );
}

import { CHAIN_LABEL } from "../chain";
import type { Address } from "viem";
import type { PoolStateQuery } from "../hooks/usePoolState";
import { PoolPanel } from "./PoolPanel";

/**
 * "Write & earn": the liquidity side of the product as its own destination,
 * as on the Solana terminal, instead of a tab tucked under the chart. The pool
 * panel itself (stats, faucet, deposit/withdraw) is unchanged.
 */
export function EarnView({
  vaultAddress,
  tokenAddress,
  poolQuery,
  showFaucet,
}: {
  vaultAddress: Address;
  tokenAddress: Address;
  poolQuery: PoolStateQuery;
  showFaucet: boolean;
}) {
  return (
    <main className="dashboard-view">
      <div className="view-heading">
        <div>
          <h1>Write &amp; earn</h1>
          <p>
            Supply mUSDC to the pool that underwrites every capped option on Tend. Deposits and withdrawals pause while
            any position is open.
          </p>
        </div>
      </div>
      <section className="positions-card">
        <div className="section-head">
          <div>
            <h2>Liquidity pool</h2>
            <p>TendPoolVault on {CHAIN_LABEL}</p>
          </div>
        </div>
        <PoolPanel vaultAddress={vaultAddress} tokenAddress={tokenAddress} poolQuery={poolQuery} showFaucet={showFaucet} />
      </section>
      <p className="risk-note">
        Testnet only: mock mUSDC with no real value. Pool capital pays trader payouts, so it loses value when traders win.
      </p>
    </main>
  );
}

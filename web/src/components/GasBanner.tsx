import { useAccount } from "wagmi";
import { GAS_FAUCET_URL, GAS_TOKEN, monadTestnet } from "../chain";
import { useGasPreflight } from "../hooks/useGasPreflight";
import { formatTokenAmount } from "../lib/format";

// Gas token and faucet both come from the active chain — this build may be
// pointed at Monad (MON, public faucet) or Robinhood Chain (ETH, none yet).

/**
 * A wallet with too little gas to cover even one write's upfront debit
 * (see useGasPreflight's header comment) doesn't fail with a clear message —
 * Monad rejects the transaction pre-submission and it surfaces as an EMPTY
 * revert reason, which reads exactly like a contract bug. Every write flow
 * in this app (TradeTicket, FaucetPanel, LiquidityForm, PositionActionCell)
 * already disables its own CTA and explains why when this is the case; this
 * banner is the same signal surfaced once, prominently, the moment a tester
 * connects an empty wallet — so they see it before they've even picked a
 * market, rather than discovering it only after clicking into a ticket.
 *
 * Renders nothing unless the balance is POSITIVELY known to be insufficient
 * (never while still loading, and never for a disconnected/wrong-network
 * wallet — Header already owns the "wrong network" prompt).
 */
export function GasBanner() {
  const { isConnected, chainId } = useAccount();
  const onMonad = isConnected && chainId === monadTestnet.id;
  const gas = useGasPreflight();

  if (!onMonad || gas.isLoading || gas.balanceWei === undefined || gas.hasGas) return null;

  return (
    <div className="banner banner--error gas-banner">
      <strong>You&apos;re out of testnet {GAS_TOKEN}.</strong>
      <p>
        Your wallet holds {formatTokenAmount(gas.balanceWei, 18)} {GAS_TOKEN} — not enough to cover gas for a
        transaction on {monadTestnet.name}. Every write here (minting mUSDC, approving, trading, providing liquidity)
        needs a little {GAS_TOKEN} first.
        {GAS_FAUCET_URL ? (
          <>
            {" "}
            <a className="link" href={GAS_FAUCET_URL} target="_blank" rel="noreferrer">
              Get free testnet {GAS_TOKEN} here
            </a>
            , then come back.
          </>
        ) : (
          " Top the wallet up, then come back."
        )}
      </p>
    </div>
  );
}

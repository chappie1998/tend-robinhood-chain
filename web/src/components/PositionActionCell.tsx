import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNowSeconds } from "../hooks/useNowSeconds";
import { type Address, type Hex, parseEventLogs } from "viem";
import { useAccount, useReadContract, useSimulateContract } from "wagmi";
import { tendPoolVaultAbi, tendSeriesFactoryAbi } from "../abis";
import { monadTestnet } from "../chain";
import { useEarlyExitSupport } from "../hooks/useEarlyExitSupport";
import { useWriteAction } from "../hooks/useWriteAction";
import { toUserMessage } from "../lib/errors";
import { closeQuoteTuple, requestCloseQuote, type SignedCloseQuote } from "../lib/closeQuoteService";
import { formatTokenAmount } from "../lib/format";
import { TxStatus } from "./TxStatus";

// getSettlement returns struct Settlement { bool finalized; uint256 price;
// uint64 publishTime } — viem decodes it to an object with those named keys.
interface Settlement {
  finalized: boolean;
  price: bigint;
  publishTime: bigint;
}

/**
 * The settle / refund / close control for one open position. Before expiry the
 * holder can sell back to the pool at a signed desk bid (see
 * quote-service/closeQuote.ts); after it, the cell reads the series'
 * settlement state and refundability and shows exactly one path:
 *   - settlement finalized      -> Settle (pays out per the published price)
 *   - else refundable           -> Refund (returns the premium)
 *   - else                      -> disabled, with a hint about the keeper step
 * Client-side settlement *publishing* is intentionally NOT done here — the
 * keeper publishes the Pyth price via the CLI (`npm run settle:monad`); this
 * UI only calls settle/refund once the chain is ready for them.
 */
export function PositionActionCell({
  positionId,
  seriesId,
  vaultAddress,
  factoryAddress,
  assetDecimals,
  expiry,
}: {
  positionId: bigint;
  seriesId: Hex;
  vaultAddress: Address;
  factoryAddress: Address;
  assetDecimals: number;
  /**
   * The series' expiry, unix seconds. Without it this cell cannot tell
   * "not expired yet" apart from "expired, waiting on the keeper" — and it
   * showed "Awaiting settlement" for BOTH, which reads as "expiry has passed
   * and settlement is late" to someone whose position simply has hours left.
   * That wording sent a tester hunting for a settlement bug that did not
   * exist.
   */
  expiry?: number;
}) {
  const { address: account, isConnected, chainId } = useAccount();
  const wrongNetwork = isConnected && chainId !== monadTestnet.id;

  const factory = { address: factoryAddress, abi: tendSeriesFactoryAbi, chainId: monadTestnet.id } as const;

  const settlementRead = useReadContract({ ...factory, functionName: "getSettlement", args: [seriesId] });
  const refundableRead = useReadContract({ ...factory, functionName: "isRefundable", args: [seriesId] });

  const settlement = settlementRead.data as Settlement | undefined;
  const finalized = settlement?.finalized;
  const refundable = refundableRead.data;

  // Snapshotted per render rather than a ticking clock — this cell only needs
  // to distinguish before/after expiry, not to count down to the second.
  const nowSec = useNowSeconds(1000);

  const canSettle = finalized === true;
  const canRefund = finalized === false && refundable === true;

  const settleSim = useSimulateContract({
    address: vaultAddress,
    abi: tendPoolVaultAbi,
    chainId: monadTestnet.id,
    functionName: "settlePoolPosition",
    args: [positionId],
    query: { enabled: canSettle && Boolean(account) && !wrongNetwork },
  });
  const settleAction = useWriteAction();

  const refundSim = useSimulateContract({
    address: vaultAddress,
    abi: tendPoolVaultAbi,
    chainId: monadTestnet.id,
    functionName: "refundPoolPosition",
    args: [positionId],
    query: { enabled: canRefund && Boolean(account) && !wrongNetwork },
  });
  const refundAction = useWriteAction();

  // --- Early exit: sell the position back to the pool at a signed bid. ---
  // Two steps on purpose. The first fetches a bid and shows it; the second
  // spends it. A trader should always see what the desk is paying before
  // signing anything, and the bid carries the same short TTL as a buy quote.
  // Only vaults carrying the close path can buy a position back; this build
  // can be pointed at one that cannot.
  const { supported: earlyExitSupported } = useEarlyExitSupport(vaultAddress);
  const [closeQuote, setCloseQuote] = useState<SignedCloseQuote | null>(null);
  const closeQuoteMutation = useMutation({
    mutationFn: () => {
      if (!account) throw new Error("Connect a wallet first.");
      return requestCloseQuote({ positionId, seller: account });
    },
    onSuccess: setCloseQuote,
  });
  const bidSecondsLeft = closeQuote ? Number(closeQuote.quote.quoteExpiry) - nowSec : 0;
  const bidLive = Boolean(closeQuote) && bidSecondsLeft > 0;

  const closeSim = useSimulateContract({
    address: vaultAddress,
    abi: tendPoolVaultAbi,
    chainId: monadTestnet.id,
    // poolQuoteTuple's sibling: viem takes the struct as a positional tuple.
    args: closeQuote ? ([closeQuoteTuple(closeQuote.quote) as unknown as never, closeQuote.signature] as const) : undefined,
    functionName: "closePosition",
    query: { enabled: Boolean(bidLive && account && !wrongNetwork) },
  });
  const closeAction = useWriteAction();

  // Pull the realised payout / refunded premium out of the confirmed receipt.
  if (settleAction.isConfirmed && settleAction.receipt) {
    const logs = parseEventLogs({
      abi: tendPoolVaultAbi,
      eventName: "PositionSettled",
      logs: settleAction.receipt.logs,
    });
    const payout = logs.find((log) => log.args.positionId === positionId)?.args.payout;
    return (
      <div className="action-row">
        <span className="badge badge--ok">
          settled{payout !== undefined ? ` — payout ${formatTokenAmount(payout, assetDecimals)}` : ""}
        </span>
        <TxStatus action={settleAction} confirmedLabel="" />
      </div>
    );
  }

  if (refundAction.isConfirmed && refundAction.receipt) {
    const logs = parseEventLogs({
      abi: tendPoolVaultAbi,
      eventName: "PositionRefunded",
      logs: refundAction.receipt.logs,
    });
    const premium = logs.find((log) => log.args.positionId === positionId)?.args.premium;
    return (
      <div className="action-row">
        <span className="badge badge--off">
          refunded{premium !== undefined ? ` — ${formatTokenAmount(premium, assetDecimals)} premium` : ""}
        </span>
        <TxStatus action={refundAction} confirmedLabel="" />
      </div>
    );
  }

  if (closeAction.isConfirmed) {
    return (
      <div className="action-row">
        <span className="badge badge--off">closed</span>
        <TxStatus action={closeAction} confirmedLabel="" />
      </div>
    );
  }

  if (settlementRead.isLoading || refundableRead.isLoading) {
    return <span className="hint">checking…</span>;
  }

  if (canSettle) {
    return (
      <div className="action-row">
        <button
          className="button button--sm"
          disabled={!settleSim.data || wrongNetwork || settleAction.isSigning || settleAction.isConfirming}
          onClick={() => settleSim.data && settleAction.writeContract(settleSim.data.request)}
        >
          {settleAction.isSigning || settleAction.isConfirming ? "Settling…" : "Settle"}
        </button>
        <TxStatus action={settleAction} confirmedLabel="Settled." />
        {settleSim.error && <span className="error-text">{toUserMessage(settleSim.error)}</span>}
        {settleAction.error && <span className="error-text">{settleAction.error}</span>}
      </div>
    );
  }

  if (canRefund) {
    return (
      <div className="action-row">
        <button
          className="button button--sm"
          disabled={!refundSim.data || wrongNetwork || refundAction.isSigning || refundAction.isConfirming}
          onClick={() => refundSim.data && refundAction.writeContract(refundSim.data.request)}
        >
          {refundAction.isSigning || refundAction.isConfirming ? "Refunding…" : "Refund"}
        </button>
        <TxStatus action={refundAction} confirmedLabel="Refunded." />
        {refundSim.error && <span className="error-text">{toUserMessage(refundSim.error)}</span>}
        {refundAction.error && <span className="error-text">{refundAction.error}</span>}
      </div>
    );
  }

  // Not expired yet: nothing to settle, but the holder can sell back to the
  // pool at the desk's bid rather than waiting it out.
  if (expiry !== undefined && nowSec < expiry) {
    const timeLeft = (
      <span className="hint" title="This position cannot settle until its series expires. Settlement is published by the keeper shortly after that.">
        Expires in {formatDuration(expiry - nowSec)}
      </span>
    );

    if (!isConnected || wrongNetwork || !earlyExitSupported) return timeLeft;

    if (bidLive && closeQuote) {
      return (
        <div className="action-row">
          <button
            className="button button--sm button--primary"
            disabled={!closeSim.data || closeAction.isSigning || closeAction.isConfirming}
            title={`Model value ${closeQuote.humanTerms.mark} mUSDC, less the ${closeQuote.spreadBps / 100}% desk spread`}
            onClick={() => closeSim.data && closeAction.writeContract(closeSim.data.request)}
          >
            {closeAction.isSigning || closeAction.isConfirming
              ? "Selling…"
              : `Sell for ${closeQuote.humanTerms.bid} · ${bidSecondsLeft}s`}
          </button>
          <button className="button button--sm button--ghost" onClick={() => setCloseQuote(null)}>
            Cancel
          </button>
          <TxStatus action={closeAction} confirmedLabel="Closed." />
          {closeSim.error && <span className="error-text">{toUserMessage(closeSim.error)}</span>}
          {closeAction.error && <span className="error-text">{closeAction.error}</span>}
        </div>
      );
    }

    return (
      <div className="action-row">
        {timeLeft}
        <button
          className="button button--sm"
          disabled={closeQuoteMutation.isPending}
          title="Sell this position back to the pool at the desk's current bid, instead of holding it to expiry."
          onClick={() => closeQuoteMutation.mutate()}
        >
          {closeQuoteMutation.isPending ? "Pricing…" : closeQuote ? "Refresh bid" : "Close"}
        </button>
        {/* A bid that timed out is not an error — it just has to be asked for again. */}
        {closeQuote && !bidLive && <span className="hint">Bid expired.</span>}
        {closeQuoteMutation.isError && (
          <span className="error-text">{(closeQuoteMutation.error as Error).message}</span>
        )}
      </div>
    );
  }

  // Expired, but no settlement price on chain yet — this is the only state
  // that is genuinely "awaiting" anything.
  return (
    <span
      className="hint"
      title="Expired. The protocol keeper publishes the Pyth price shortly after expiry; refund becomes available after the settlement grace period if it never does."
    >
      Awaiting settlement
    </span>
  );
}

/** Compact "4h 52m" / "12m" for a positive second count. */
function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return "under a minute";
}

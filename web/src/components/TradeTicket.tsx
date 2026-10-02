import { LoaderCircle, RefreshCw, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { formatUnits, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { useAccount, useConnect, useReadContract, useSimulateContract, useSwitchChain } from "wagmi";
import { mockErc20Abi, tendPoolVaultAbi } from "../abis";
import { GAS_FAUCET_URL, GAS_TOKEN, monadTestnet } from "../chain";
import { useGasPreflight } from "../hooks/useGasPreflight";
import { useNowSeconds } from "../hooks/useNowSeconds";
import { usePythSpot } from "../hooks/usePythPrice";
import { useWriteAction } from "../hooks/useWriteAction";
import { toUserMessage } from "../lib/errors";
import { formatExactStrike, formatMultiple, formatProbabilityPercent, formatSignedPercent, formatTokenAmount, formatUsdPrice } from "../lib/format";
import { computePayoffSummary, PRICE_SCALE, type PayoffSummary } from "../lib/payoff";
import { poolQuoteTuple, type SignedQuoteResponse } from "../lib/quote";
import { requestQuote, type TileIndex } from "../lib/quoteService";
import { recordFillTxHash } from "../lib/tradeHistoryStorage";
import { PayoffDiagram } from "./PayoffDiagram";
import { TxStatus } from "./TxStatus";

/** 0 = Up, 1 = Down — matches the contract's uint8 direction. */
export type Direction = 0 | 1;

/** Debounce before an input change fires a new quote request. */
const AUTO_QUOTE_DEBOUNCE_MS = 600;

/** Within ±0.1% of spot reads as at-the-money rather than a meaningless ±0.03%. */
const ATM_TOLERANCE = 0.001;

const FIND_WALLET_URL = "https://ethereum.org/en/wallets/find-wallet/";

/** " (+0.42% vs spot)" — display-only context for the strike; empty when spot is unavailable. */
function strikeVsSpot(strikeRaw: bigint, spotPrice: number | undefined): string {
  if (spotPrice === undefined || spotPrice <= 0) return "";
  const strike = Number(strikeRaw) / PRICE_SCALE;
  if (!Number.isFinite(strike)) return "";
  const drift = (strike - spotPrice) / spotPrice;
  if (Math.abs(drift) <= ATM_TOLERANCE) return " (at the money)";
  return ` (${formatSignedPercent(drift)} vs spot)`;
}

/** Parses a human decimal string into raw base units, or undefined if empty/invalid/non-positive. Never throws. */
function tryParseDeposit(input: string, decimals: number): bigint | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const value = parseUnits(trimmed, decimals);
    return value > 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

/** "0:22" — a quote's 30s TTL (quote-service/derive.ts) reads better as m:ss. */
function formatClock(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(clamped / 60)}:${(clamped % 60).toString().padStart(2, "0")}`;
}

/** "32.98%" from an annualized-vol fraction — can exceed 100%, so never clamped. */
function formatVolPercent(fraction: number): string {
  if (!Number.isFinite(fraction) || fraction < 0) return "—";
  return `${(fraction * 100).toFixed(2)}%`;
}

/** "3.2h" above an hour, "18m" below it. */
function formatTimeToExpiry(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "—";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return `${hours.toFixed(hours < 10 ? 2 : 1)}h`;
}

/**
 * The quote service explains an unreachable payout multiple in pricing-engine
 * terms ("Target premium 10000000.000000 exceeds the at-the-money price …"),
 * which tells a trader nothing they can act on. Lead with what to do and keep
 * the full diagnostic one hover away. "Another multiple", not "a higher one":
 * the engine fails both ways (pricing.ts: too low and too high).
 */
function quoteErrorSummary(message: string): { text: string; detail?: string } {
  const unreachable = /^(\d+)x is not reachable\b/.exec(message);
  if (!unreachable) return { text: message };
  return {
    text: `${unreachable[1]}× can't be priced right now at this volatility and time to expiry. Try another multiple or a longer expiry.`,
    detail: message,
  };
}

/**
 * The strike (and breakeven) of the ticket's live quote, in human units,
 * published upward so the chart can draw them. Carries its feed id because
 * only a strike from the charted underlying may be drawn on it.
 */
export interface ActiveStrike {
  feedId: Hex;
  price: number;
  breakeven?: number;
}

interface LiveEconomics {
  quote: SignedQuoteResponse;
  summary: PayoffSummary;
}

/**
 * The ticket's payoff read-out. Every row always renders — a dormant bar until
 * a current signed quote exists — so nothing reflows when one lands. Only
 * figures the signed quote produced are ever shown; no client-side estimate.
 */
export function EconomicsRows({
  direction,
  assetDecimals,
  live,
  spotPrice,
  secondsLeft,
}: {
  direction: Direction;
  assetDecimals: number;
  live?: LiveEconomics;
  spotPrice?: number;
  secondsLeft?: number;
}) {
  const up = direction === 0;
  const binary = live?.summary.isBinary ?? true;
  const token = (raw: bigint) => `${formatTokenAmount(raw, assetDecimals)} mUSDC`;
  const row = (label: string, value: string | undefined, className?: string) => (
    <div className={value === undefined ? "econ-row--empty" : undefined}>
      <span>{label}</span>
      <strong className={value === undefined ? undefined : className}>{value ?? "—"}</strong>
    </div>
  );

  return (
    <div className="economics">
      {row("Signed premium", live && token(live.quote.quote.premium), "risk")}
      <div className="economics-total">
        <span>Max payout</span>
        <strong>
          {live ? token(live.quote.quote.maxPayout) : "—"}
          {live && <small>{formatMultiple(live.quote.multiple)}× your premium</small>}
        </strong>
      </div>
      {row(
        binary ? `Win only if expiry ${up ? ">" : "<"} strike` : `Breakeven (${up ? "above" : "below"})`,
        live && `$${live.summary.isBinary ? formatExactStrike(live.quote.quote.strike) : formatUsdPrice(live.summary.breakevenPrice)}`,
      )}
      {row(
        binary ? "Winning payout at expiry" : `Full payout ${up ? "at or above" : "at or below"}`,
        live && (live.summary.isBinary ? token(live.quote.quote.maxPayout) : `$${formatUsdPrice(live.summary.capPrice)}`),
      )}
      {row(
        binary ? `Tie or ${up ? "lower" : "higher"} expiry` : `${up ? "At or below" : "At or above"} strike`,
        live && "0 mUSDC",
        "risk",
      )}
      <details className="econ-detail">
        <summary>Pricing detail</summary>
        {row("Strike", live && `$${live.summary.isBinary ? formatExactStrike(live.quote.quote.strike) : formatUsdPrice(live.summary.strikePrice)}${strikeVsSpot(live.quote.quote.strike, spotPrice)}`)}
        {row(binary ? "Win probability" : "Chance of profit", live && formatProbabilityPercent(live.quote.probabilityProfit))}
        {!binary && row("Chance in the money", live && formatProbabilityPercent(live.quote.probabilityItm))}
        {row("Implied volatility", live && formatVolPercent(live.quote.impliedVolatility))}
        {row("Time to expiry", live && formatTimeToExpiry(live.quote.timeToExpiryHours))}
        {row("Maximum loss", live && token(live.summary.maxLoss), "risk")}
        {row("Quote valid for", live && secondsLeft !== undefined ? formatClock(secondsLeft) : undefined)}
        {live && (
          <div className="econ-diagram">
            <PayoffDiagram quote={live.quote.quote} assetDecimals={assetDecimals} assetSymbol="mUSDC" spotPrice={spotPrice} />
          </div>
        )}
      </details>
    </div>
  );
}

/** What the quote-request effect sends, and what a stale in-flight response is checked against. */
interface QuoteMutationVars {
  requestKey: string;
  buyer: Address;
  direction: Direction;
  tile: TileIndex;
  premiumHuman: string;
}

/**
 * The quote → approve → fill flow for one fillable series. The inputs live in
 * TicketColumn; this owns the signed quote and the on-chain steps. A quote is
 * fetched automatically (debounced) whenever the inputs change, every on-chain
 * step is simulated first and only sent if the simulation succeeds, and a
 * quote is bound to `buyer` so it is never filled by a different wallet.
 */
export function TradeTicket({
  seriesId,
  seriesFeedId,
  vaultAddress,
  tokenAddress,
  assetDecimals = 6,
  direction,
  tile,
  depositInput,
  onStrikeChange,
  onItmChange,
  onReset,
  showFaucet,
}: {
  seriesId: Hex;
  seriesFeedId: Hex;
  vaultAddress: Address;
  tokenAddress: Address;
  assetDecimals?: number;
  direction: Direction;
  tile: TileIndex;
  depositInput: string;
  onStrikeChange?: (strike: ActiveStrike | null) => void;
  /** The live quote's in-the-money chance, for the selected payoff tile; null without a current quote. */
  onItmChange?: (probability: number | null) => void;
  onReset: () => void;
  /** False only when the settlement token is not the mock one — minting doesn't apply there. */
  showFaucet: boolean;
}) {
  const { address: account, isConnected, chainId } = useAccount();
  const wrongNetwork = isConnected && chainId !== monadTestnet.id;
  const { connect, connectors, isPending: isConnecting } = useConnect();
  const { switchChain, isPending: isSwitching } = useSwitchChain();
  const [connectError, setConnectError] = useState<string | null>(null);

  // Monad debits gas upfront; a wallet without MON is rejected with an empty
  // revert. Quoting is plain HTTP and stays available — only the on-chain
  // step is gated.
  const gas = useGasPreflight();
  const gasKnownInsufficient = gas.balanceWei !== undefined && !gas.hasGas;

  const [receivedQuote, setReceivedQuote] = useState<{ data: SignedQuoteResponse; requestKey: string } | null>(null);
  // The selected payout tier fixes the winning multiple; capacity or raw-unit
  // parity can reduce the offered premium before the signed quote is returned.
  const premiumRaw = tryParseDeposit(depositInput, assetDecimals);
  const premiumHuman = premiumRaw !== undefined ? formatUnits(premiumRaw, assetDecimals) : undefined;
  const requestKey = [account?.toLowerCase(), seriesId, direction, tile, premiumHuman, wrongNetwork].join(":");
  const quote = receivedQuote?.requestKey === requestKey ? receivedQuote.data : null;

  const spot = usePythSpot(seriesFeedId);
  const nowSec = useNowSeconds(1000);
  const secondsLeft = quote ? Number(quote.quote.quoteExpiry) - nowSec : 0;
  const quoteExpired = Boolean(quote) && secondsLeft <= 0;

  function handleConnect() {
    setConnectError(null);
    const connector = connectors.find((c) => c.id === "injected") ?? connectors[0];
    if (!connector) {
      setConnectError("No wallet connector available.");
      return;
    }
    connect({ connector }, { onError: (error) => setConnectError(toUserMessage(error)) });
  }

  // Publish the live quote's strike and, only for legacy spreads, breakeven.
  // Binary tickets have a strict expiry threshold rather than a zero-P&L line.
  // The chart gets the signed quote's strike, not the independently refreshed
  // unsigned ladder preview.
  useEffect(() => {
    if (!quote || quoteExpired) {
      onStrikeChange?.(null);
      return;
    }
    const summary = computePayoffSummary(quote.quote);
    if (!Number.isFinite(summary.strikePrice) || summary.strikePrice <= 0) {
      onStrikeChange?.(null);
      return;
    }
    onStrikeChange?.({
      feedId: seriesFeedId,
      price: summary.strikePrice,
      breakeven: !summary.isBinary && Number.isFinite(summary.breakevenPrice) ? summary.breakevenPrice : undefined,
    });
  }, [quote, quoteExpired, seriesFeedId, onStrikeChange]);
  useEffect(() => () => onStrikeChange?.(null), [onStrikeChange]);

  const token = { address: tokenAddress, abi: mockErc20Abi, chainId: monadTestnet.id } as const;
  const allowanceRead = useReadContract({
    ...token,
    functionName: "allowance",
    args: account ? [account, vaultAddress] : undefined,
    query: { enabled: Boolean(account) },
  });
  const balanceRead = useReadContract({
    ...token,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) },
  });
  const balance = balanceRead.data;

  const quoteMutation = useMutation({
    mutationFn: (vars: QuoteMutationVars) => {
      if (!account) throw new Error("Connect a wallet first.");
      return requestQuote({
        seriesId,
        direction: vars.direction === 0 ? "up" : "down",
        buyer: vars.buyer,
        premium: vars.premiumHuman,
        tile: vars.tile,
      });
    },
    // A response for inputs the trader has since changed must not land.
    onSuccess: (data, vars) => {
      if (vars.requestKey === requestKey) setReceivedQuote({ data, requestKey: vars.requestKey });
    },
  });

  function requestQuoteNow() {
    if (premiumHuman === undefined || !account) return;
    quoteMutation.mutate({ direction, tile, premiumHuman, requestKey, buyer: account });
  }

  // Auto-quote on any input change, and again once a held quote expires
  // (clearing it flips quoteExpired back, so this settles after one pass).
  useEffect(() => {
    if (!account || wrongNetwork || premiumHuman === undefined || (quote && !quoteExpired)) return;
    const timer = setTimeout(() => {
      quoteMutation.reset();
      quoteMutation.mutate({ direction, tile, premiumHuman, requestKey, buyer: account });
    }, AUTO_QUOTE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // quoteMutation is recreated every render; everything it closes over is in the deps below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account, wrongNetwork, direction, tile, premiumHuman, quoteExpired, requestKey, quote]);

  const premium = quote?.quote.premium;
  const payoffSummary = quote ? computePayoffSummary(quote.quote) : undefined;
  // Reported by the service, which is the only side that knows what the
  // premium would have bought before the pool's caps applied.
  const wasClamped = Boolean(quote?.clamped);
  // Guards the one render between clearing the amount and the effect clearing the quote.
  const quoteIsCurrent = Boolean(quote && premiumHuman !== undefined);

  useEffect(() => {
    onItmChange?.(quoteIsCurrent && quote ? quote.probabilityItm : null);
  }, [quote, quoteIsCurrent, onItmChange]);
  useEffect(() => () => onItmChange?.(null), [onItmChange]);

  const allowance = allowanceRead.data;
  const needsApprove = premium !== undefined && allowance !== undefined ? allowance < premium : Boolean(quote);
  const insufficientBalance = premium !== undefined && balance !== undefined ? balance < premium : false;

  const approveSim = useSimulateContract({
    ...token,
    functionName: "approve",
    args: premium !== undefined ? [vaultAddress, premium] : undefined,
    query: { enabled: Boolean(quote && !quoteExpired && needsApprove && account && !wrongNetwork && premium !== undefined) },
  });
  const approveAction = useWriteAction();

  // viem accepts the PoolQuote struct as a positional tuple; poolQuoteTuple()
  // (lib/quote.ts) is the single source of truth for that field order.
  const fillArgs = quote ? ([poolQuoteTuple(quote.quote) as unknown as never, quote.signature] as const) : undefined;
  const fillSim = useSimulateContract({
    address: vaultAddress,
    abi: tendPoolVaultAbi,
    chainId: monadTestnet.id,
    functionName: "fillPoolQuote",
    args: fillArgs,
    query: { enabled: Boolean(quote && !needsApprove && !quoteExpired && !insufficientBalance && account && !wrongNetwork) },
  });
  const fillAction = useWriteAction();

  // Persist positionId -> txHash the moment a fill confirms: Position carries
  // no tx hash, and a log scan can't reach back far enough on Monad testnet.
  useEffect(() => {
    if (!fillAction.isConfirmed || !fillAction.receipt || !fillAction.hash) return;
    const filledLogs = parseEventLogs({ abi: tendPoolVaultAbi, eventName: "PoolQuoteFilled", logs: fillAction.receipt.logs });
    const positionId = filledLogs[0]?.args.positionId;
    if (positionId !== undefined) recordFillTxHash(positionId, fillAction.hash);
  }, [fillAction.isConfirmed, fillAction.receipt, fillAction.hash]);

  const hasInjectedProvider = typeof window !== "undefined" && Boolean((window as { ethereum?: unknown }).ethereum);
  const quoteError = quoteMutation.isError ? quoteErrorSummary((quoteMutation.error as Error).message) : undefined;
  const live: LiveEconomics | undefined = quoteIsCurrent && !quoteExpired && quote && payoffSummary ? { quote, summary: payoffSummary } : undefined;
  const directionWord = direction === 0 ? "Up" : "Down";

  let action: ReactNode;
  if (fillAction.isConfirmed) {
    action = (
      <div className="quote-empty">
        <div className="empty-icon empty-icon--ok">
          <ShieldCheck size={20} aria-hidden="true" />
        </div>
        <div>
          <strong>Position opened</strong>
          <p>Your fill confirmed. View it under Positions for available exit and settlement actions.</p>
        </div>
        <TxStatus action={fillAction} confirmedLabel="Filled." />
        <button type="button" className="button secondary" onClick={onReset}>
          New position
        </button>
      </div>
    );
  } else if (!isConnected && !hasInjectedProvider) {
    action = (
      <div className="quote-empty">
        <div className="empty-icon">
          <Wallet size={20} aria-hidden="true" />
        </div>
        <div>
          <strong>No wallet detected</strong>
          <p>Quotes are signed for your wallet address, so trading needs an EVM wallet in this browser — MetaMask, Rabby or similar. Install one, then reload.</p>
        </div>
        <a className="button primary" href={FIND_WALLET_URL} target="_blank" rel="noreferrer">
          <Wallet size={16} aria-hidden="true" /> Find a wallet
        </a>
      </div>
    );
  } else if (!isConnected) {
    action = (
      <div className="quote-empty">
        <div className="empty-icon">
          <Wallet size={20} aria-hidden="true" />
        </div>
        <div>
          <strong>Connect a wallet to see your price</strong>
          <p>Your quote is signed for your exact wallet address.</p>
        </div>
        <button type="button" className="button primary" onClick={handleConnect} disabled={isConnecting}>
          <Wallet size={16} aria-hidden="true" /> {isConnecting ? "Connecting…" : "Connect wallet"}
        </button>
        {connectError && <p className="error-text">{connectError}</p>}
      </div>
    );
  } else if (wrongNetwork) {
    action = (
      <div className="quote-empty">
        <div className="empty-icon">
          <Wallet size={20} aria-hidden="true" />
        </div>
        <div>
          <strong>Switch to Monad testnet</strong>
          <p>Your wallet is on another network. Quotes and fills happen on Monad testnet (chain {monadTestnet.id}).</p>
        </div>
        <button type="button" className="button primary" onClick={() => switchChain({ chainId: monadTestnet.id })} disabled={isSwitching}>
          {isSwitching ? "Switching…" : "Switch network"}
        </button>
      </div>
    );
  } else if (premiumHuman === undefined) {
    action = (
      <div className="quote-empty">
        <div className="empty-icon">
          <Sparkles size={20} aria-hidden="true" />
        </div>
        <div>
          <strong>Enter what you want to pay</strong>
          <p>Type a premium in mUSDC. The payout it buys is priced and signed for your wallet.</p>
        </div>
      </div>
    );
  } else if (quoteError && !quoteMutation.isPending && !live) {
    action = (
      <div className="quote-error" role="alert">
        <div>
          <strong>Couldn’t return a quote</strong>
          <p title={quoteError.detail}>{quoteError.text}</p>
        </div>
        <button type="button" className="button secondary" onClick={requestQuoteNow}>
          <RefreshCw size={15} aria-hidden="true" /> Retry
        </button>
      </div>
    );
  } else if (!live || quoteExpired) {
    action = (
      <div className="quote-loading" role="status" aria-live="polite">
        <div className="loading-title">
          <LoaderCircle size={17} className="spin" aria-hidden="true" /> {quoteExpired ? "Quote expired — refreshing…" : "Pricing your position…"}
        </div>
        <div className="quote-skeleton">
          <span />
          <span />
          <span />
        </div>
      </div>
    );
  } else {
    let label: string;
    let disabled: boolean;
    let onClick: (() => void) | undefined;
    if (insufficientBalance || gasKnownInsufficient) {
      label = needsApprove ? "Approve mUSDC" : `Buy ${directionWord}`;
      disabled = true;
    } else if (needsApprove) {
      label = approveAction.isSigning || approveAction.isConfirming ? "Approving…" : "Approve mUSDC";
      disabled = !approveSim.data || approveAction.isSigning || approveAction.isConfirming;
      onClick = () => approveSim.data && approveAction.writeContract(approveSim.data.request);
    } else {
      label = fillAction.isSigning || fillAction.isConfirming ? "Buying…" : `Buy ${directionWord}`;
      disabled = !fillSim.data || fillAction.isSigning || fillAction.isConfirming;
      onClick = () => fillSim.data && fillAction.writeContract(fillSim.data.request);
    }

    action = (
      <>
        {wasClamped && (
          <p className="hint">
            Your charged premium is {formatTokenAmount(live.quote.quote.premium, assetDecimals)} mUSDC (you offered {depositInput} mUSDC). The exact payout ratio or available pool capacity reduced it.
          </p>
        )}
        {insufficientBalance && (
          <p className="execution-error">
            Your mUSDC balance is below the {live.quote.humanTerms.premium} premium.
            {showFaucet ? " Mint test mUSDC under Write & earn." : ""}
          </p>
        )}
        {gasKnownInsufficient && (
          <p className="execution-error">
            You&apos;re out of testnet {GAS_TOKEN} for gas.
            {GAS_FAUCET_URL ? (
              <>
                {" "}
                <a className="link" href={GAS_FAUCET_URL} target="_blank" rel="noreferrer">
                  Get free testnet {GAS_TOKEN}
                </a>
                , then come back.
              </>
            ) : (
              " Top the wallet up, then come back."
            )}
          </p>
        )}
        <button type="button" className="button primary full ticket-cta" disabled={disabled} onClick={onClick}>
          {label} · {formatClock(secondsLeft)}
        </button>
        {needsApprove ? (
          <>
            <TxStatus action={approveAction} confirmedLabel="Approved." />
            {approveSim.error && <p className="error-text">Cannot approve: {toUserMessage(approveSim.error)}</p>}
            {approveAction.error && <p className="error-text">{approveAction.error}</p>}
          </>
        ) : (
          <>
            <TxStatus action={fillAction} confirmedLabel="Filled." />
            {fillSim.error && <p className="error-text">Cannot fill: {toUserMessage(fillSim.error)}</p>}
            {fillAction.error && <p className="error-text">{fillAction.error}</p>}
          </>
        )}
      </>
    );
  }

  return (
    <>
      <EconomicsRows
        direction={direction}
        assetDecimals={assetDecimals}
        live={live}
        spotPrice={spot.data?.price}
        secondsLeft={live ? secondsLeft : undefined}
      />
      <div className="ticket-action">{action}</div>
    </>
  );
}

import { ArrowDownRight, ArrowUpRight, Clock3, LoaderCircle, LockKeyhole, ShieldCheck, Target } from "lucide-react";
import { useState } from "react";
import { formatUnits, type Address, type Hex } from "viem";
import type { LiveSeriesCandidate } from "../hooks/useLiveSeries";
import { useEarlyExitSupport } from "../hooks/useEarlyExitSupport";
import { useNowSeconds } from "../hooks/useNowSeconds";
import { useSeriesDetail } from "../hooks/useSeriesDetail";
import { useStrikeLadder } from "../hooks/useStrikeLadder";
import { useWalletBalances } from "../hooks/useWalletBalances";
import { formatCountdown, formatExactStrike, formatMultiple, formatProbabilityPercent, formatTokenAmount } from "../lib/format";
import { DEFAULT_TILE, TILE_OPTIONS, type TileIndex } from "../lib/quoteService";
import { TENORS, type TenorId } from "../lib/seriesParams";
import { EconomicsRows, TradeTicket, type ActiveStrike, type Direction } from "./TradeTicket";

const QUICK_FILL_PERCENTS = [25, 50] as const;

const expiryClock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

function formatExpiryTime(expiry: bigint): string {
  return expiryClock.format(new Date(Number(expiry) * 1000));
}

/**
 * The "Build your position" ticket, ported from the Solana terminal. Its
 * inputs (direction, expiry, payoff, amount) always render, including when
 * the selected expiry has no open series — the form keeps its shape and the
 * action zone explains why nothing can be quoted, instead of collapsing to an
 * empty box. The quote/approve/fill flow mounts only for a series the chain
 * confirms is fillable (useSeriesDetail), never for a manifest fallback.
 */
export function TicketColumn({
  factoryAddress,
  vaultAddress,
  tokenAddress,
  seriesId,
  symbolLabel,
  assetDecimals,
  onStrikeChange,
  showFaucet,
  tenors,
  selectedTenorId,
  onSelectTenor,
}: {
  factoryAddress: Address;
  vaultAddress: Address;
  tokenAddress: Address;
  seriesId: Hex | undefined;
  symbolLabel: string | undefined;
  assetDecimals: number | undefined;
  onStrikeChange?: (strike: ActiveStrike | null) => void;
  /** False only when the manifest names a real (non-mock) settlement token — see deployment.ts isMockSettlement. */
  showFaucet: boolean;
  /** The active market's per-tenor candidates (useLiveSeries). Undefined while discovery is loading. */
  tenors: Record<TenorId, LiveSeriesCandidate> | undefined;
  /** Null when the active series came from the Series table rather than a canonical tenor. */
  selectedTenorId: TenorId | null;
  onSelectTenor: (tenorId: TenorId) => void;
}) {
  const { detail, fillable, reason, isLoading } = useSeriesDetail(factoryAddress, vaultAddress, seriesId);
  // "Held to expiry" stops being true on a vault that can buy positions back,
  // so every claim about exiting is read off the deployment, never assumed.
  const { supported: earlyExit } = useEarlyExitSupport(vaultAddress);
  const balances = useWalletBalances(tokenAddress);
  const nowSec = useNowSeconds(1000);
  const decimals = assetDecimals ?? 6;

  const [direction, setDirection] = useState<Direction>(0);
  const [tile, setTile] = useState<TileIndex>(DEFAULT_TILE);
  const [depositInput, setDepositInput] = useState("");
  // Bumped by "New position" after a fill: remounts the quote flow cleanly.
  const [resetNonce, setResetNonce] = useState(0);

  // The three live strikes map to fixed binary winning payouts: 1.5x, 2x,
  // and 3x. The service solves each strike conservatively at quote time.
  const { ladder, isLoading: ladderLoading, error: ladderError } = useStrikeLadder(
    seriesId,
    direction === 0 ? "up" : "down",
  );
  const selectedStrike = ladder?.tiles[tile];

  const selectedTenor = TENORS.find((tenor) => tenor.id === selectedTenorId);
  const selectedCandidate = selectedTenorId ? tenors?.[selectedTenorId] : undefined;
  // At a grid boundary discovery briefly falls back to the manifest. Never
  // mount a buy flow until discovery confirms the selected tenor's candidate.
  const discoveryUnavailable =
    selectedTenorId !== null && (!selectedCandidate?.fillable || selectedCandidate.seriesId !== seriesId);
  const tradable = Boolean(seriesId && detail && fillable && !discoveryUnavailable);
  const checking =
    !tenors || (!tradable && !discoveryUnavailable && (isLoading || Boolean(reason?.startsWith("Checking"))));
  const unavailableDetail = discoveryUnavailable ? selectedCandidate?.reason : reason;

  const balance = balances.musdcRaw;
  const hasBalance = balance !== undefined && balance > 0n;
  function quickFill(percent: number) {
    if (balance === undefined) return;
    setDepositInput(formatUnits((balance * BigInt(percent)) / 100n, decimals));
  }

  return (
    <aside className="ticket-column">
      <div className="trade-ticket">
        <div className="ticket-head">
          <div>
            <span className="eyebrow">Capped option{symbolLabel ? ` · ${symbolLabel}` : ""}</span>
            <h2>Build your position</h2>
          </div>
          <span className="no-liquidation" title="The pool escrows your full max payout the moment you buy.">
            <LockKeyhole size={13} aria-hidden="true" /> 100% locked
          </span>
        </div>

        <fieldset className="field-group">
          <legend>Direction</legend>
          <div className="segmented">
            <button type="button" className={direction === 0 ? "segment active up" : "segment"} aria-pressed={direction === 0} onClick={() => setDirection(0)}>
              <ArrowUpRight size={17} aria-hidden="true" /> Up
            </button>
            <button type="button" className={direction === 1 ? "segment active down" : "segment"} aria-pressed={direction === 1} onClick={() => setDirection(1)}>
              <ArrowDownRight size={17} aria-hidden="true" /> Down
            </button>
          </div>
        </fieldset>

        <fieldset className="field-group">
          <legend>Expires</legend>
          <div className="expiry-group-head">
            <span>Intraday</span>
            <small>{earlyExit ? "Expiry-only payout · signed desk bid may be available before expiry" : "Expiry-only payout · no early exit"}</small>
          </div>
          <div className="choice-row">
            {TENORS.map((tenor) => {
              const candidate = tenors?.[tenor.id];
              const open = Boolean(candidate?.fillable);
              return (
                <button
                  type="button"
                  key={tenor.id}
                  className={selectedTenorId === tenor.id ? "choice active" : "choice"}
                  aria-pressed={selectedTenorId === tenor.id}
                  disabled={!open}
                  title={open && candidate ? `${tenor.label}, expires ${formatExpiryTime(candidate.expiry)}` : (candidate?.reason ?? "Checking on-chain series…")}
                  onClick={() => onSelectTenor(tenor.id)}
                >
                  {tenor.id.toUpperCase()}
                  <small>{!tenors || candidate?.reason?.startsWith("Checking") ? "Checking…" : open && candidate ? formatExpiryTime(candidate.expiry) : "Unavailable"}</small>
                </button>
              );
            })}
          </div>
          <p className="expiry-policy">
            <ShieldCheck size={13} aria-hidden="true" />
            {tradable && detail
              ? `Expires ${formatExpiryTime(detail.expiry)} · ${formatCountdown(detail.expiry, nowSec)} left · settles via Tend oracle`
              : checking
                ? "Checking on-chain series…"
                : `No open ${selectedTenor?.label ?? "series"} series right now.`}
          </p>
        </fieldset>

        <fieldset className="field-group">
          <legend>Strike</legend>
          <div className="choice-row">
            {TILE_OPTIONS.map((option) => {
              const rung = ladder?.tiles[option];
              return (
                <button
                  type="button"
                  key={option}
                  className={tile === option ? "choice active" : "choice"}
                  aria-pressed={tile === option}
                  title={
                    rung
                      ? `Indicative strike ${formatExactStrike(Number(rung.strike))} for an expiry-only trade — ${formatMultiple(rung.multiple)}× your charged premium on a win. ` +
                        `${formatProbabilityPercent(rung.probabilityItm)} model win probability; ties lose. Check the signed quote below before buying.`
                      : "Pricing this strike…"
                  }
                  onClick={() => setTile(option)}
                >
                  {rung ? `${formatMultiple(rung.multiple)}×` : "—"}
                  <small>
                    {rung
                      ? `${formatProbabilityPercent(rung.probabilityProfit)} win`
                      : ladderLoading
                        ? "Pricing…"
                        : "Unavailable"}
                  </small>
                </button>
              );
            })}
          </div>
          <p className="expiry-policy">
            <Target size={13} aria-hidden="true" />
            {selectedStrike
              ? `Preview strike ${formatExactStrike(Number(selectedStrike.strike))} · ${formatMultiple(selectedStrike.multiple)}× on a strict ${direction === 0 ? "above" : "below"} finish at expiry. Check the signed strike below.`
              : ladderError
                ? ladderError
                : "Pricing the strikes for this expiry…"}
          </p>
        </fieldset>

        <div className="field-group">
          <label htmlFor="ticket-amount">You pay</label>
          <div className="amount-input">
            <span>$</span>
            <input
              id="ticket-amount"
              className="deposit-field__input"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              autoComplete="off"
              value={depositInput}
              onChange={(event) => setDepositInput(event.target.value)}
              aria-describedby="ticket-amount-note"
            />
            <span>mUSDC</span>
          </div>
          <div id="ticket-amount-note" className="input-note">
            <span>{balance !== undefined ? `Balance ${formatTokenAmount(balance, decimals)}` : "Balance —"}</span>
            <span className="quick-fill">
              {QUICK_FILL_PERCENTS.map((percent) => (
                <button type="button" key={percent} disabled={!hasBalance} onClick={() => quickFill(percent)}>
                  {percent}%
                </button>
              ))}
              <button type="button" disabled={!hasBalance} onClick={() => quickFill(100)}>
                Max
              </button>
            </span>
          </div>
        </div>

        {tradable && seriesId && detail ? (
          <TradeTicket
            key={`${seriesId}-${resetNonce}`}
            seriesId={seriesId}
            seriesFeedId={detail.pythFeedId}
            vaultAddress={vaultAddress}
            tokenAddress={tokenAddress}
            assetDecimals={decimals}
            direction={direction}
            tile={tile}
            depositInput={depositInput}
            onStrikeChange={onStrikeChange}
            onReset={() => {
              setResetNonce((nonce) => nonce + 1);
              setDepositInput("");
            }}
            showFaucet={showFaucet}
          />
        ) : (
          <>
            <EconomicsRows direction={direction} assetDecimals={decimals} />
            <div className="ticket-action">
              {checking ? (
                <div className="quote-loading" role="status" aria-live="polite">
                  <div className="loading-title">
                    <LoaderCircle size={17} className="spin" aria-hidden="true" /> Checking on-chain series…
                  </div>
                  <div className="quote-skeleton">
                    <span />
                    <span />
                    <span />
                  </div>
                </div>
              ) : (
                <div className="quote-empty">
                  <div className="empty-icon">
                    <Clock3 size={20} aria-hidden="true" />
                  </div>
                  <div title={unavailableDetail}>
                    <strong>Nothing open for this expiry</strong>
                    <p>
                      No {symbolLabel ?? ""} {selectedTenor?.label ?? ""} series is tradable on-chain right now. Series are
                      listed by the protocol keeper; pick another expiry if one shows a time.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
      <p className="risk-note" id="risk">
        Testnet only: mock mUSDC, real market reference data, no real asset value.{" "}
        {earlyExit
          ? "Expiry payout is binary. An eligible position may receive a signed desk bid before expiry; it is not guaranteed. It can lose its full premium."
          : "Expiry payout is binary. Positions are held to expiry and can lose their full premium."}
      </p>
    </aside>
  );
}

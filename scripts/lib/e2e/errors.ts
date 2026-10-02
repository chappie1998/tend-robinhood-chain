// Best-effort translation of the contracts' custom Solidity errors (see
// contracts/TendSeriesFactory.sol and contracts/TendPoolVault.sol) into a
// human explanation, so a revert during the e2e run points straight at the
// violated bound instead of a bare selector. Mirrors the pattern already
// used in scripts/bootstrap-monad.ts, extended with the fill/settle/publish
// errors this script can actually hit.
const KNOWN_ERROR_HINTS: Record<string, string> = {
  InvalidExpiry: "expiry is not far enough in the future (needs now + MIN_SERIES_LEAD).",
  InvalidObservationWindow: "observationWindow is 0 or exceeds MAX_OBSERVATION_WINDOW (1 hour).",
  InvalidSettlementGrace: "settlementGrace is 0 or exceeds MAX_SETTLEMENT_GRACE (24 hours).",
  InvalidConfidence: "maxConfidenceBps is 0 or exceeds MAX_CONFIDENCE_BPS (2,000 bps).",
  SeriesAlreadyExists: "a series with this exact parameter tuple (and thus id) already exists.",
  SeriesNotFound: "the series id is not registered on the factory.",
  SeriesSettlementTokenMismatch: "the series' settlementToken does not match the vault's asset.",
  InvalidLastTradeCutoff: "lastTradeAt must be >= now + MIN_TRADE_LEAD and < the series' expiry.",
  PoolHasOpenPositions: "the pool has open positions or locked collateral, which blocks this admin action.",
  SeriesNotTradable: "the series is disabled or the factory is paused.",
  SeriesNotAuthorized: "the series has not been authorized on this pool (authorizeSeries).",
  SeriesExpired: "block.timestamp is already >= series.expiry — the fill window closed.",
  LastTradeCutoffReached: "block.timestamp is already >= the pool's authorized lastTradeAt cutoff.",
  QuoteExpired: "quote.quoteExpiry has passed, or violates the lastTradeAt/series.expiry bounds.",
  InvalidAmount: "premium or maxPayout is zero.",
  InvalidWidth: "strike or width is zero.",
  InvalidDirection: "direction is neither Up (0) nor Down (1).",
  InvalidBuyer: "quote.buyer does not match the caller (msg.sender) of fillPoolQuote.",
  AlreadyFilled: "quote.nonce has already been used.",
  BadSignature: "the EIP-712 signature does not recover to the pool's quoteAuthority.",
  PoolInsolvent: "the pool has zero totalShares (no liquidity).",
  PoolUtilizationExceeded: "maxPayout would push lockedCollateral past maxUtilizationBps of total collateral.",
  PoolPositionLimitExceeded: "maxPayout exceeds maxPositionBps of total collateral (the per-position cap).",
  InsufficientLiquidity: "totalAssets is less than the quote's maxPayout.",
  PositionNotFound: "no position exists at this id.",
  AlreadySettled: "the position has already been settled or refunded.",
  NotFinalized: "the series' settlement has not been published yet (call publishSettlement first).",
  SeriesNotExpired: "block.timestamp is still before series.expiry — too early to publish settlement.",
  SettlementWindowClosed: "block.timestamp is past expiry + observationWindow + settlementGrace.",
  InsufficientFee: "msg.value sent with publishSettlement is less than pyth.getUpdateFee(updateData).",
  InvalidOraclePrice: "the Pyth update's price is <= 0.",
  InvalidObservationTime: "the Pyth update's publishTime is outside [expiry, expiry + observationWindow].",
  OracleConfidenceTooWide: "the Pyth update's confidence interval exceeds maxConfidenceBps of price.",
  AlreadyFinalized: "the series' settlement has already been published.",
  CollateralMismatch: "internal payout/pool/fee accounting did not reconcile to premium + maxPayout (should never happen).",
  DeadlineExpired: "the transaction's deadline parameter has already passed.",
  DepositTooSmall: "the deposit amount rounds down to 0 shares at the current pool exchange rate.",
  SlippageExceeded: "minSharesOut (or minAmountOut) was not met.",
  SettlementWindowOpen: "the settlement window has not closed yet, so a refund is not available.",
};

export function explainRevert(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  for (const [name, hint] of Object.entries(KNOWN_ERROR_HINTS)) {
    if (message.includes(name)) return `${name}: ${hint}`;
  }
  return message;
}

# Tend quote service

The active demo's HTTP signer is shared by the Vercel functions in `api/`, the local Vite dev server, and the standalone Node service. The client never receives `QUOTE_AUTHORITY_KEY`.

## Run

From the repository root:

```bash
npm install
npm --prefix web install
cp .env.example .env
# Set QUOTE_AUTHORITY_KEY to the existing testnet pool authority.
npm run dev
```

This starts the trading app and same-origin `/api/quote`, `/api/mark`, and `/api/market-data`. For a standalone quote process, use `npm run quote:service` and configure the web app's `VITE_QUOTE_SERVICE_URL` explicitly.

## Pricing and data

`derive.ts` reads the selected series and pool, fetches Coinbase spot and realized volatility, selects a conservative strike for the chosen 1.5×, 2× or 3× total winning payout, validates capacity and signs a buyer-bound EIP-712 quote. New quotes use a one-tick width so the deployed vault pays all or zero from the expiry settlement price; older wider positions retain their proportional payoff. `pricing.ts` estimates volatility from consecutive, completed hourly candles and refuses unsupported or stale input. Quote TTL is shared in `config/quotes.ts`.

`market-data/coinbase.ts` supports BTC-USD, ETH-USD and MON-USD through Coinbase's public Exchange API. It enforces timeouts, ticker freshness, OHLC sanity, bounded history windows and short caches. Four-hour candles aggregate hourly OHLC. No account, API key, fabricated-price fallback or paid Pyth entitlement is needed for this demo.

The server returns the existing normalized integer price/exponent and UDF candle shapes for client compatibility. They are exchange data, not Pyth attestations. Legacy `Hermes` / `Pyth` helper names do not establish oracle provenance. Retained Pyth diagnostics in `api/pyth.ts` and the fork scripts still require separately entitled credentials.

`/api/mark` is an indicative valuation endpoint, not an executable exit. Eligible positions may instead request a fresh signed bid from `/api/close-quote`; availability and bid amount are not guaranteed.

## Verification

```bash
npm test
npm run typecheck
npm run lint
DEMO_ORIGIN=https://monad.usetend.xyz npm run rehearse:demo
```

The live rehearsal also needs `MONAD_DEPLOYER_KEY` for testnet operation. It uses the existing mock collateral and MockPyth deployment, persists public receipts, resumes a pending position, waits for actual expiry and reconciles the final payout. See [DEMO.md](../DEMO.md) for the settlement convention and limitations.

# Metropolis build record

Updated September 27, 2026 against Git history through `5dc2f35`. Pre-event baseline: `5d71abe` (August 15). Compare `5d71abe..HEAD`; do not rewrite dates or erase prior history to imply a new project.

## Pre-existing foundation

July/August work includes the Solidity factory and pool, collateral escrow and existing fill risk caps, initial BTC/ETH app, basic quote signing, live charts, keeper, and testnet deployments. Contract comments also reference an earlier Solana `vsol` implementation; those provenance comments remain intact. A provenance URL and its ownership/license should be documented if that earlier source is distributed. No Solana receipt is Monad evidence.

## Implemented during September

| Commit | New behavior | Relevant source |
| --- | --- | --- |
| `aa64b65` (Sep 3) | Black–Scholes capped-spread pricing, realized volatility, strike solving, maker edge, rate limits and pricing tests | `quote-service/pricing.ts`, `derive.ts`, `rateLimit.ts` |
| `0de177f` (Sep 3) | Indicative present-value marks using the pricing model | `api/mark.ts`, `useMarkToMarket.ts` — not an executable early exit |
| `eb7be8b` (Sep 4) | First authorization of a new series while obligations remain open | `TendPoolVault.sol` — current source; do not assume the older deployed vault has this guard |
| `04f03ea` (Sep 5) | 15m/1h/12h expiry schedules and 20/5/1-rung ladders | `seed-series.ts`, `TenorSelector.tsx`, series discovery |
| `d400cae` (Sep 9) | Explicit manager role, production deployment-role checks, settlement publish-time restrictions and diagnostics | deployment validation, factory, tests — mock demo still bypasses oracle authentication |
| `a661219` (Sep 10) | Realized wallet trade history derived from chain positions and settlement state | `useTradeHistory.ts`, `TradeHistoryPanel.tsx`; scans newest 500 vault positions |
| `6f975ab` (Sep 12) | Public Coinbase data, fillable-expiry selection with quote headroom, live state refresh and resumable transaction rehearsal | `market-data/`, live series helpers, `scripts/rehearse-demo.ts` |

Additional build-window changes verified from commit history:

| Commit | New behavior | Relevant source |
| --- | --- | --- |
| `2935879` (Sep 16) | Signed early-exit bids and pool buyback, with realized close accounting | `api/close-quote.ts`, `quote-service/closeQuote.ts`, `TendPoolVault.sol` |
| `d1a9967` (Sep 16) | Early-exit vault migration and recorded live buy/close verification | `scripts/verify-early-exit.ts`, Monad manifest |
| `e5264e8`, `7d39a88`, `ed14a7f` (Sep 16) | Priced strike ladder, capacity charge, 4× ceiling and model probability of profit | `quote-service/strikeLadder.ts`, trade ticket |
| `cd25991`, `62627e7` (Sep 17) | MON market and sub-dollar strike/price precision | market-data, quote engine, app and seeding |
| `b618246`, `cf5665a` (Sep 18) | Same protocol deployed separately to Robinhood Chain testnet | chain config, second manifest |
| `cbb4e06`, `1f359bb` (Sep 16–18) | Local scheduled keeper wrapper with independent sweeps for both testnets | `scripts/keeper-local.sh` |

Robinhood deployment is portability evidence, not a substitute for Monad-specific transaction proof. These later changes supersede the original no-early-exit and arbitrary-multiple demo descriptions.

The active-source diff covers substantial implemented changes, but commit counts and line counts do not prove the event's substantial-majority eligibility requirement. The organizers make that determination. AI-assisted development is disclosed in the root README.

## Demonstrated outcome

The September 12 rehearsal used the live HTTP quote signer, opened position #10 on Monad testnet, waited for actual expiry, published the real Coinbase minute-open reference through MockPyth, settled, and reconciled balances. Premium: 99.999963 mUSDC. Maximum payout escrow: 2,500 mUSDC. Actual payout: zero. See `docs/evidence/demo-rehearsal.json` and the public `/pitch#proof` links.

The September 12 recovery run passed 59 application cases and 82 Solidity cases. Those are historical counts. A new verification run is required for later source; tests alone do not prove deployment equivalence. The active vault changed September 16, so the old runtime comparison no longer describes it.

## Source publication preparation

September 27 working-tree additions (not yet committed or deployed as new contracts): MetaMask Agent Wallet plugin; keeper gas budgeting and overlap protection; per-request quote identity checks; strict frontend/server chain selection; production deployment guards; unique-tick settlement selection and malformed-price defenses. See [production readiness](PRODUCTION-READINESS.md) for validation and the remaining authenticated-oracle and migration requirements. These are AI-assisted additions to the pre-existing protocol, not a claim that the entire project was created during the event.

- Owner authorized public visibility when submitting; no visibility change has yet occurred.
- MIT license for original Tend code; preserve Apache-2.0 and dependency-specific terms.
- Local reachable-history review covered 51 commits and 408 text blobs; no credential-pattern matches. This is a bounded scan, not a security certification or a review of remote attachments/logs.
- Exclude credentials, throwaway wallet files, node_modules and generated capture outputs; retain genuine commit history.
- Keep the public recording, transcript, actual receipts, setup instructions, and prior-work disclosures with the entry.

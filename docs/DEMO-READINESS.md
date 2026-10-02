# Tend demo readiness — 12 September 2026

Historical September 12 recovery snapshot. The product, deployed vault, supported markets and payout terms have changed since this report. See [current production readiness](PRODUCTION-READINESS.md), [current demo runbook](../DEMO.md) and [submission draft](../HACKATHON.md) before making current claims. The receipts and counts below document what was verified on September 12 only.

## September 12 verdict

The deployed Monad application is ready for a **guided testnet demo**: real prices, chart timeframes and BTC/ETH expiry schedules load; quote/selection issues are fixed; automated checks pass; and the live HTTP quote → on-chain fill → actual expiry → settlement rehearsal has passed. Browser wallet confirmation remains unverified because both available browsers have no injected wallet.

Unattended availability is still blocked by the scheduled keeper's GitHub billing issue. Mainnet readiness is a separate milestone.

## What the project is

Tend sells fully collateralized capped spreads on BTC/ETH. A buyer pays a premium for a directional payout at expiry. That premium is the maximum loss; 10×/25×/50× means maximum payout divided by premium. There is no early exit or liquidation engine.

| Layer | Active implementation |
| --- | --- |
| App | `web/`: Vite, React, wagmi/viem, charts, ticket, positions, pool and activity |
| Pricing | `quote-service/derive.ts`, `pricing.ts`, `api/quote.ts`: EIP-712 quotes, volatility, spread pricing and risk checks |
| Data | `market-data/coinbase.ts`, `api/market-data.ts`: real public Coinbase spot and OHLC |
| Marks | `api/mark.ts`: indicative valuation, not executable exit |
| Series | `TendSeriesFactory.sol`: series, settlement and refund timing |
| Pool | `TendPoolVault.sol`: collateral escrow, fills, payouts, LP shares and risk caps |
| Operations | `keeper-monad.ts`: resolution and expiry ladder maintenance |

The earlier Robinhood Chain preview (Next.js app, Cloudflare Worker, D1 schema) was removed on 2026-09-16; `contracts/TendMarket.sol` is its last remaining piece and is not deployed. `npm run dev` starts the Monad app.

## Completed recovery

- Upgraded Vercel CLI from 54.7.1 to **59.16.0**.
- Confirmed the Pyth key is denied crypto spot/history access. With the owner's authorization, replaced the demo data path with public Coinbase Exchange APIs; no paid data plan or new credential is required.
- Added ticker freshness, malformed-data rejection, bounded candle requests, timeout handling and coalesced caches. Empty expiry candles can be retried. Hourly candles aggregate into four-hour candles.
- Seeded/authorized the BTC and ETH ladders on the existing testnet contracts. All six market/tenor combinations were verified fillable after bootstrap.
- Changed selection from the farthest expiry to the nearest fillable expiry with room for the full 30-second quote and a request margin.
- Corrected the search range for keeper ladders that round to their own tenor grid; the 12-hour series now appears in the app. Exact expiry/countdown and hold-to-expiry behavior are visible.
- Tied displayed quotes to the current wallet and inputs, and repaired React/lint issues without disabling the relevant hook rules.
- Replaced backdated current-spot settlement in the demo helper with the real Coinbase expiry-minute opening price and its actual bucket timestamp. MockPyth still bypasses attestation verification; zero confidence means unavailable.
- Added a resumable HTTP-to-chain rehearsal that saves hashes, verifies ownership, reconciles premium/collateral/payout and validates finalized settlement against the exchange reference.
- Rewrote README, demo script, quote-service instructions, public pitch and Metropolis application draft. Removed cross-chain transaction claims and unsupported traction/production assertions.

## Verified checks

| Check | Result |
| --- | --- |
| Application tests | **59 passed** |
| Solidity tests | **82 passed**, including 256-run payout/escrow fuzz properties |
| Active API + web TypeScript | Passed |
| Repository ESLint | Passed |
| Production web build | Passed; existing large-bundle warning remains |
| Local browser | BTC and ETH hourly: 168 candles; four-hour: 180 candles; daily: 180 candles; live ticker; 12h selection and exact expiry visible |
| Independent code review | Reported cache/cutoff/recovery/search findings fixed and re-reviewed; no remaining critical/high finding |

These counts describe the current local source. The deployed vault runtime is 8,748 bytes versus 8,887 in the local build, so passing tests do not prove identical deployed behavior. See [DEMO.md](../DEMO.md) for the operational restriction: seed before trading, and do not rely on the newer authorization guard until source-matched deployment is verified.

## Live rehearsal evidence

- Live site: https://monad.usetend.xyz (Vercel production update, September 12).
- Full local evidence: [demo-rehearsal.json](evidence/demo-rehearsal.json).
- Position **10**; buyer `0xda33594d256531125411e0DD28f986fe3CCDD607`; expiry **2026-09-12 09:30:00 UTC**.
- Premium **99.999963 mUSDC**; maximum payout / collateral **2,500 mUSDC**.
- [Fill transaction](https://testnet.monadscan.com/tx/0x312a4aecb259f4e0339d960a474915930e4f34216796eb30a76cf8c4937f2997); gas used **329,141**. Premium debit and collateral lock verified.
- [Settlement publication](https://testnet.monadscan.com/tx/0x0142f6bafa56a1280c4584002808676f074d9e74f4efa248c7836b6d950c1861); real Coinbase expiry-minute opening price **$77,354.88**, actual bucket timestamp **1789205400**.
- [Position settlement](https://testnet.monadscan.com/tx/0xafc1f9101c35292c1f880d0d04dafb6985ee182969f5e61ed9cb3901def15fc3); actual payout **0 mUSDC**, demonstrating the premium-only loss case. Final buyer balance and escrow conservation verified.
- Post-settlement RPC read confirmed **0 locked collateral**, **0 open positions**, position #10 marked settled, and pool assets **100,099.999963 mUSDC**.
- Finished **2026-09-12 09:34:04 UTC**. Public RPC timeouts interrupted the wait/publication; the script resumed the saved position without a second fill. This verifies recovery, not uninterrupted infrastructure.
- Initial CLI attempts stopped before fill due to a tiny premium-rounding approval mismatch and a local-account override issue; both were fixed and reviewed. The completed receipt above is the sole new filled position from this rehearsal.

The verified HTTP/CLI rehearsal exercises the same signer and contracts as the app; it does not establish browser-extension confirmation. That must be checked separately with an injected test wallet.

## Remaining blockers and submission tasks

1. **Keeper availability.** [GitHub run 34678051119](https://github.com/chappie1998/tend-monad/actions/runs/34678051119) has no job steps: GitHub says recent account payments failed or its spending limit must be increased. Five inspected runs failed. A local reseed is temporary; it does not repair scheduling or guarantee the next expiry gets settled.
2. **Browser wallet rehearsal.** Browser-extension confirmation remains unverified. Test connect, testnet switch, approval, quote refresh, buy and reload with an injected test wallet. The completed video accurately identifies its historical trade as an HTTP/CLI execution and does not stage browser signing.
3. **Official submission.** Registration, solo team, Tend project details and **Onchain Finance & Trading** selection are saved in the [official portal](https://hackathon.monad.xyz/project). Agreements were accepted after explicit owner authorization. The Submission tab is date-gated: **September 22–October 14**, with the displayed deadline **October 14, 09:29 GMT+5:30**. Final submission has not occurred. Rules, rubric, prior work and AI disclosure are documented in [HACKATHON.md](../HACKATHON.md) and [METROPOLIS-BUILD.md](METROPOLIS-BUILD.md); organizers determine eligibility.
4. **Video and repository access.** The narrated, captioned **2:06 [demo video](https://monad.usetend.xyz/demo.html)** is published and playback verified. MIT licensing and third-party notices are prepared and reviewed. The GitHub repository remains **private**, following the owner's instruction to make it public when submitting; public source is required, and private judge access alone is insufficient. Final attachment fields can be completed when the portal opens.
5. **Production scope.** Real collateral requires verified oracle settlement, independent security review, a source-matched deployment and dependable operations. The current demo has none of those production assurances.

## Presentation recommendation

Lead with one actual testnet fill and the collateral it locks. Use an explicitly pre-existing expired position for the settlement segment of a short video. Show the capped payoff and maximum loss; state that the mock oracle and mUSDC are testnet infrastructure. Use [HACKATHON.md](../HACKATHON.md) as the submission draft and [DEMO.md](../DEMO.md) as the recording script.

# Tend — Monad Metropolis submission draft

Draft for review, not a submitted application. Target track: **Onchain Finance & Trading**.

- Live product: https://monad.usetend.xyz
- Product pitch: https://monad.usetend.xyz/pitch
- Historical product video: https://monad.usetend.xyz/demo.html — 2:06; predates current ladder, MON and early exits. Replacement required. A separate [binary founder-pitch draft](docs/video/README.md) is rendered locally; it has not been hosted or submitted and contains motion graphics rather than current app footage.
- Repository: https://github.com/chappie1998/tend-monad — **currently private; judge access must be arranged**
- Chain: Monad testnet, 10143
- Walkthrough / recording script: [DEMO.md](DEMO.md)
- Current evidence and remaining gaps: [docs/PRODUCTION-READINESS.md](docs/PRODUCTION-READINESS.md). The [September 12 demo-readiness snapshot](docs/DEMO-READINESS.md) is historical.

**Release status (September 28):** Fixed 1.5×/2×/3× binary payouts are implemented and verified in [Monad preview with fresh trade proof](https://tend-monad-jcwb3e6p9-ankitgc1s-projects.vercel.app) and [Robinhood preview](https://tend-robinhood-lwctdp59n-ankitgc1s-projects.vercel.app), but the live product and pitch URLs above still serve the preceding proportional-spread release. Vercel refused the production-target deploy as `Not authorized`. Replace these links or complete the release before submitting this copy; the fresh testnet receipt is linked below.

## One sentence

Tend gives BTC, ETH and MON traders capped directional exposure on Monad with a fixed maximum loss, no liquidation, and the maximum payout escrowed on-chain before every trade.

## Problem

A margined trade can be liquidated by an intermediate price move even if the trader's eventual directional view is right. Options can bound that risk, but their interfaces often ask users to understand several contract parameters before taking a simple directional position.

Tend presents that position as UP or DOWN, an expiry schedule, a premium and a maximum payout. It exposes the trade-off: the upside is capped, the premium can be lost in full, and early exits depend on a fresh signed pool bid before expiry.

## What we built

A Solidity pool and series factory, a React trading app, and an HTTP quote signer on Monad testnet. The app supports BTC/ETH/MON, 15-minute / 1-hour / 12-hour expiry schedules and fixed 1.5×, 2× and 3× total winning payout choices. It displays the exact expiry because scheduled contracts are not a new full duration from each purchase.

The quote engine uses live Coinbase Exchange prices and completed hourly candles to estimate realized volatility. For each selected payout multiple, it chooses a strike at a model win probability with a disclosed maker edge. The charged premium may decrease to fit pool capacity, while its winning payout keeps the exact chosen ratio. Quotes are buyer-bound EIP-712 messages with a 30-second lifetime. The vault enforces signature, nonce, expiry, series authorization, utilization and position-size checks before locking the maximum payout.

New trades have a binary payout determined only by the price published for expiry:

```
UP wins if expiry settlement price > strike.
DOWN wins if expiry settlement price < strike.
On a win, total payout = charged premium × selected multiple.
On a loss or exact tie, payout = 0.
```

Crossing the strike before expiry does not trigger a payout; the price can reverse. The existing vault supports this behavior through a one-tick signed width. Historical positions with wider widths retain proportional payouts. An unsettled series becomes refundable after its deadline. The buyer recovers the premium and the pool releases its collateral.

## Why Monad

Frequent expiry schedules and short-lived quotes require a responsive fill experience. Monad lets us use EVM tooling and explicit Solidity risk checks while demonstrating quote → fill → collateral lock with real testnet transactions. This submission should show the transaction receipts and measured behavior rather than claiming unmeasured TPS or superiority over other chains.

## What is different

- Maximum loss is an upfront premium; there is no margin balance to liquidate.
- Maximum payout is escrowed at entry, making the pool's obligation explicit.
- The expiry price alone decides an all-or-zero outcome for new positions; the buyer sees the exact strike and winning payout before filling.
- The interface exposes exact expiry, payout multiple and a signed early-exit bid separate from indicative value.
- Pricing, accounting and recovery paths are inspectable in the repository and on-chain receipts.

These are product and implementation claims, not a claim that Tend invented options or is the first protocol in this category.

## Proof to attach

September 28 binary run: [position #4 fill](https://testnet.monadscan.com/tx/0xb05a5cab6577e3fe4d91811269939254a23869a0727cf671454f29385276c3ca), [published reference](https://testnet.monadscan.com/tx/0x3bb0ee284bee08b557b999cda5bb6ebd323b191db1d7291aaaec88e41495ac58), [settlement](https://testnet.monadscan.com/tx/0xa1b922776cf823c1e9ff48cffab5517d032c3c550162c50db54772b903bbd17f), and [machine-readable evidence](docs/evidence/demo-rehearsal.json). The 10 mUSDC UP trade had a 20 mUSDC maximum payout, but the expiry price finished below its strike, so its actual payout was zero. This demonstrates the loss rule, not a profitable trade. The [September 12 position #10](docs/evidence/demo-rehearsal-2026-09-12.json) remains historical evidence.

Use only the latest successful `docs/evidence/demo-rehearsal.json` and the dated verification report. A local script called the same HTTP quote endpoint used by the app, then used a dedicated CLI wallet to approve mUSDC and open the actual testnet position. It waited for real expiry, published the reference, settled and checked balances and escrow conservation. No browser wallet confirmation was performed. Its hashes are public; its dedicated wallet key is gitignored.

Use the latest dated verification logs for test counts. Historical counts are not evidence of current tests passing. Local source tests do not establish byte-for-byte equivalence with a deployed contract. The September 16 vault migration and buy/close verification are recorded in commit `d1a9967`; retain the distinction between historical receipts and a fresh rehearsal.

Record a video under three minutes using [DEMO.md](DEMO.md). Show one live fill plus an explicitly pre-existing expired position, rather than implying a 15-minute trade expired during a three-minute video. Do not publish or submit before the video and evidence links are checked.

## Limitations and roadmap

1. **Testnet dollars, admin-posted oracle.** Coinbase supplies real single-exchange prices. Both testnets settle through `TendPriceOracle`: only the keeper's admin key can post a price, posts are write-once, and caller-supplied update data is ignored — so a trader cannot settle at an invented price. It is still a single trusted key, not an attested oracle. Its zero confidence field means unavailable. Production requires a verified oracle integration and a reviewed settlement convention; switching providers is not merely a branding/configuration change.
2. **Operational reliability.** A local scheduler now sweeps both testnets. It depends on the laptop being awake, online and funded; verify recent logs and market availability. A durable hosted keeper remains needed for unattended operation.
3. **Early-exit availability.** The signed buyback path is implemented. Bids include a desk spread, expire quickly and require an eligible position before expiry. Indicative marks are not executable bids.
4. **Wallet onboarding.** The current interface uses injected EVM wallets. Mobile/WalletConnect and more accessible onboarding are future work.
5. **Review and deployment.** Independent security review, a source-matched deployment, separate operational roles and production data access are required before real funds.

## Prior work disclosure

This repository and the core protocol predate the September 2026 event. Do not label all work as created during Metropolis. The September 12 changes restore public market data without a paid key, correct expiry discovery and quote cutoff behavior, improve the trade ticket, add a resumable real-transaction rehearsal, and rebuild the demo/submission materials around the Monad implementation.

The authenticated portal's rules (version 3.0, updated September 3, inspected September 12) permit an existing foundation only when prior components are identified in the README and substantial new functionality is built during the event. A substantial majority of submitted work must be created during the event. AI coding tools are permitted and must be disclosed in the README. The recovery update is commit `6f975ab`; it alone is not evidence that the required new-work threshold is met. Do not claim prior Solana transactions as Monad evidence.

## Portal status — checked September 27, 2026

Registration is complete in the owner's signed-in Brave session. The owner supplied the remaining personal details and explicitly authorized accepting the displayed rules, terms and privacy policy. A solo team and **Tend** project are saved in the [project workspace](https://hackathon.monad.xyz/project), with **Onchain Finance & Trading** selected. The description includes the live application, public demo video, actual transaction evidence, repository link, prior-work and AI disclosures, and testnet limitations. No sponsor bounty is selected: the listed integrations are not implemented in this product.

**Final submission is not yet open.** The September 27 authenticated portal shows **October 2** opening and **October 14, 2026, 09:29 IST** deadline. This supersedes the earlier September 22 opening note. Registration and saved project details are not a final submission confirmation.

Current [Onchain Finance & Trading requirements](https://hackathon.monad.xyz/tracks/onchain-finance):

- Public GitHub source with setup instructions, license, attribution and genuine build-window commit history.
- Public working-product demo of no more than **3 minutes**, on YouTube, Loom or Vimeo; Monad testnet is accepted.
- Separate pitch video of no more than **2 minutes** and logo of no more than **3 MB**.
- Track judging: technical implementation 20%, design 20%, originality 15%, founder–market fit 25%, traction 20%.
- Existing foundations and AI assistance must be disclosed. The organizers determine build-window eligibility.

The existing self-hosted September 12 video is historical evidence, not the finished submission asset: replace it to show current MON markets, fixed binary payout choices and early exits, and host it on an accepted platform. No sponsor bounty should be marked complete until its integration and required proof work. See [the bounty plan](docs/METROPOLIS-BOUNTY-PLAN.md).

The owner authorized making the repository public when submitting. MIT licensing, preserved third-party notices and a reviewed source-release plan are prepared; visibility remains private until then. The historical public video has narration, burned captions, optional WebVTT and a transcript. [docs/METROPOLIS-BUILD.md](docs/METROPOLIS-BUILD.md) maps implemented September functionality to commits; it does not certify the event's substantial-majority threshold.

Still needed: record current demo and separate pitch, verify accepted hosting and current live operation; when the portal opens, review the final submission fields, make the repository public under the existing owner authorization, attach the public demo and repository links, submit, and retain the portal confirmation. No scheduled follow-up has been configured.

# Tend — demo runbook

Target: Monad Metropolis, Onchain Finance & Trading. Product: fully collateralized BTC/ETH/MON expiry-price trades with fixed 1.5×, 2× or 3× winning payouts. Present a real transaction and its economics, with the testnet boundaries visible.

Historical recording (September 12; replace before submission): [2:06 product walkthrough](https://monad.usetend.xyz/demo.html). It combines captured product operation with earlier CLI trade receipts; it does not claim a new browser-signed buy. See [video production notes](docs/video/README.md).

## Before the call

1. `npm install && npm --prefix web install` then `npm run check`.
2. Confirm `QUOTE_AUTHORITY_KEY` matches the pool authority. Coinbase data needs no key.
3. Start `npm run dev`, open localhost:5173, and check BTC + ETH + MON prices and candles.
4. Run `npm run bootstrap:monad` with the funded testnet operator. Verify actual expiry times in the UI.
5. Fund an injected test wallet with test MON; mint mUSDC in Pool. Make LP deposits before opening positions.
6. Run `npm run rehearse:demo`. It tests the actual HTTP quote endpoint and reconciles the on-chain fill and settlement. Allow up to 30 minutes for the nearest series to expire. Evidence is written to `docs/evidence/demo-rehearsal.json`.
7. Check the local scheduler logs (`~/Library/Logs/tend-keeper/keeper.log`) and run the keeper as needed. The wrapper sweeps both testnets, but an asleep/offline laptop cannot maintain the demo.
8. Prepare one already-expired position for a short demo. Do not present it as the newly opened position.

## Three-minute walkthrough

**0:00–0:20 — problem and promise**

“Being right about direction should not require surviving a liquidation first. Tend lets you choose UP or DOWN with your maximum loss fixed before you buy.”

**0:20–0:55 — the trade**

Show BTC/ETH/MON, real Coinbase price, direction, premium, selected winning multiple, quoted strike, exact expiry and maximum loss. “This multiple is the total payout relative to the premium if the expiry settlement price finishes strictly on the winning side of the strike. An earlier crossing does not count, and a tie loses.” Open the payoff diagram.

**0:55–1:30 — proof**

Approve and buy with the prepared test wallet. Open the explorer transaction. Show the position and the pool collateral change. Explain that the maximum payout is escrowed on opening.

**1:30–2:05 — resolution**

Request and execute an early-exit bid on a prepared position. Show the close receipt and realized return, including any loss. Then show a clearly labeled pre-existing settled position and explain the timeout refund if no reference is published.

**2:05–2:35 — why it matters**

“One settlement asset backs both directions across multiple markets. Traders get a bounded outcome; LPs earn premium while the protocol enforces its payout limits.” Show the pool and explain the flat-pool LP restriction.

**2:35–2:55 — honest scope and next step**

“This runs on Monad testnet with mock dollars and mock oracle verification. Prices are real Coinbase exchange data. Next we harden settlement and operations, then test with users before considering real funds.”

## Settlement convention

For minute-aligned demo series, the operator fetches the Coinbase one-minute candle beginning at expiry and posts its opening price and bucket timestamp to `TendPriceOracle` as admin, then settles. This avoids substituting a later spot price and backdating it. Only the admin key can post, and settlement takes the earliest post at or after expiry, so no caller can pick or invent the price — but the admin is trusted, and this is not authenticated price publication. The confidence field is zero because Coinbase supplies no oracle confidence interval; it is not evidence of zero uncertainty.

If that candle is unavailable, publication fails and can be retried. Never replace it with the current price. Non-minute-aligned legacy series are unsupported by this convention and retain the contract's timeout refund path. Refund opens after expiry + observation window + settlement grace if no settlement was finalized.

## Contract-version note

The September 16 migration (`d1a9967`) replaced the Monad vault with the early-exit version at `0x179496c12efabb8131b16a3affeaf6cb5547b105`. Its recorded buy/close rehearsal demonstrates the deployment at that time. The former September 12 runtime-size comparison referred to the retired vault and must not be used as current evidence. Check the active manifest, contract code and current receipts before recording; passing local tests alone does not prove deployment equivalence.

## Failure handling

| Symptom | Action |
| --- | --- |
| No tradable expiry | Verify keeper logs; bootstrap fresh series; inspect exact expiry/cutoff |
| No market data | Inspect `/api/market-data`; fix upstream availability; do not invent prices |
| Quote expired after approval | Let the ticket fetch a new quote before buying |
| Wallet transaction rejected | Check network, test MON, token balance and approval |
| Awaiting settlement | Run the keeper or `POSITION_ID=<id> npm run settle:monad` |
| Oracle timeout | Refund through UI or keeper after the on-chain deadline |
| LP form disabled | Settle/refund all open obligations before LP entry/exit |

## Evidence policy

Use hashes and values from the latest successful rehearsal artifact, not copied claims from another chain. An HTTP/CLI rehearsal does not establish that a browser extension confirmation was tested; record that separately. A recorded demo should show the app, explorer evidence and disclosed limitations, not just slides.

## Latest completed rehearsal — September 28

Monad position **#4** used the current local HTTP signer and a dedicated CLI test wallet. It paid **10 mUSDC**, locked a **20 mUSDC** maximum payout for the **2×** tier, and signed an UP strike of **$84,575.198667** with a one-tick width. At the real **00:15 UTC** expiry, the Coinbase minute-open reference was **$84,420.19**, below the strike. The actual on-chain payout was **0 mUSDC**. Fill balances, final buyer balance, escrow conservation, reference price/time and the strict expiry-only result were checked. This is a demonstrated loss, not a profitable trade or a browser-wallet confirmation.

Receipts: [fill](https://testnet.monadscan.com/tx/0xb05a5cab6577e3fe4d91811269939254a23869a0727cf671454f29385276c3ca), [reference publication](https://testnet.monadscan.com/tx/0x3bb0ee284bee08b557b999cda5bb6ebd323b191db1d7291aaaec88e41495ac58), [settlement](https://testnet.monadscan.com/tx/0xa1b922776cf823c1e9ff48cffab5517d032c3c550162c50db54772b903bbd17f), and [full evidence](docs/evidence/demo-rehearsal.json). The [September 12 position #10 proof](docs/evidence/demo-rehearsal-2026-09-12.json) is archived. The rehearsal resumes a pending fill instead of opening a duplicate trade.

## Separate pitch and sponsor proof

Record a separate pitch of no more than two minutes: target trader and problem, bounded-loss experience, why Monad, evidence from actual users if available, and the next validation milestone. Do not invent traction. The product demo must stay within three minutes and be hosted on YouTube, Loom or Vimeo. Capture sponsor-specific operations separately when their rules need longer technical proof; a code-only integration does not establish live qualification.

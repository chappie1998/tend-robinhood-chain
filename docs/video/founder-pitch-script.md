# Tend founder pitch — under two minutes

Use this for the separate founder pitch. It describes the current testnet product and does not claim a current recorded demo, users, traction, an authenticated oracle, or an audit.

## Script (about 100 seconds)

“A trader can be right about where Bitcoin ends the day and still lose a margined position to a move along the way. Tend is for the trader who wants to express a direction while fixing the most they can lose upfront.

On Tend, a trader picks BTC, ETH, or MON, chooses UP or DOWN, and selects a 1.5-times, 2-times or 3-times total winning payout on a fifteen-minute, one-hour or twelve-hour schedule. The quote shows the strike and exact expiry. The premium is the maximum loss. There are no margin calls or liquidations. At the fill, the pool vault escrows the maximum payout on Monad testnet, so the obligation is visible and bounded.

Only the expiry settlement price decides a held trade: UP wins strictly above the strike, DOWN strictly below it, and a tie loses. Earlier crossings do not trigger a payout. Before expiry, an eligible position can request a separate signed early-exit bid. That bid has a short lifetime and is not guaranteed; an indicative mark alone cannot close a position.

We built the contracts, React app, pricing service, and testnet flow on Monad. Prices come from Coinbase Exchange, while the current settlement path uses testnet mUSDC and MockPyth. The deployed MockPyth runtime exactly matches our local test artifact on both configured testnets, so we can be precise about the limitation: the settlement price is not authenticated on-chain.

Our September 28 operator rehearsal filled a one-tick 2-times position, waited for real expiry, and settled it for zero when the final price finished below its UP strike. That verifies the loss rule on Monad testnet; it is not a user trade or traction. Next, we need authenticated settlement, reliable operations, independent review, and user testing before real funds.”

## Current-demo shot list

1. Title card: “Tend — defined-risk BTC, ETH and MON trades on Monad testnet.” Keep “testnet mUSDC” visible.
2. Market selector: switch among BTC, ETH and MON; show Coinbase source and the current price timestamp.
3. Trade ticket: show UP/DOWN, a 15-minute, 1-hour, and 12-hour schedule, then the fixed 1.5×/2×/3× choices and quoted strikes. State that premium is maximum loss and the selected multiple is total payout only on a win at expiry.
4. Quote and fill: show exact expiry, signed quote lifetime, maximum payout, wallet confirmation, and the resulting explorer receipt. Only label this a successful user transaction if a real user performs it during capture.
5. Position view: request a signed early-exit bid for an eligible position. Show bid expiry and realized close result; state that the bid is optional and distinct from an indicative mark.
6. Historical proof: show September 12 position #10 with its zero payout. Label it “historical operator rehearsal — not a user transaction.”
7. Boundaries card: “Coinbase exchange data; testnet mUSDC; DeployableMockPyth runtime match; no authenticated on-chain settlement; no external audit.”

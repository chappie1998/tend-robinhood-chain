# Decision records

> Historical decision record. New quotes now use a one-tick width for an expiry-only binary payout; older wider positions retain their original spread rules. The deployed testnet receiver is MockPyth and does not authenticate Coinbase observations. See [current architecture](../README.md) and [readiness](PRODUCTION-READINESS.md).

## 1. Keep capped-spread, cash-settled options — do not move to physically-settled covered calls

**Status:** decided
**Context:** [split.markets](https://www.split.markets) ships ETH options on Base/Arbitrum marketed as
"leverage crypto that can't get liquidated" — oracle-free, physically settled, with a WETH-denominated
LP vault. Tend's Monad demo settles cash against Pyth, and its canonical Pyth receiver on Monad testnet
is broken (`InvalidWormholeVaa`, stale on-chain Wormhole guardian set), forcing the demo onto MockPyth.
That raised the question of whether Tend should go oracle-free too.

**Decision: no.** Tend keeps the capped-spread, cash-settled instrument and the Pyth oracle.

### Why

**1. The oracle failure is Monad-testnet-specific, not fundamental.**
MockPyth exists solely because *one testnet receiver* has a stale guardian set. Pyth works on Solana,
Base, Arbitrum and presumably Monad mainnet. Rewriting the vault because a testnet deployment is stale
is the wrong trigger for an architectural change.

**2. Cash settlement is what lets one pool serve many markets — which is the actual differentiator.**
`TendPoolVault` holds a single settlement asset (mUSDC) and writes both UP and DOWN on *any* Pyth feed,
with risk bounded explicitly by `maxPayout`. Physical settlement requires the pool to hold the
underlying itself, and calls and puts need opposite inventory (calls need the asset, puts need the
strike currency). That is precisely why Split is **ETH-only**: their pool shape constrains their market
count. Adopting physical settlement would import that limitation and undercut the multi-market /
RWA thesis, which is the thing Split structurally cannot serve.

**3. "Sending a token" is not what makes settlement oracle-free.**
A payout whose *size* is computed from a price still needs a feed, whichever asset is transferred. The
oracle disappears only when exercise becomes a **choice at a fixed strike** — the holder exercises only
when it pays, and that decision reveals the price. That means vanilla calls (uncapped), an active
exerciser, and incentivised third-party "callers" for anyone who forgets. It is a different instrument
with a real UX regression, not a settlement swap.

**4. Our capped spread is inherently cash-settled.**
`calculatePayout` is linear from `strike` to `strike ± width`, capped at `maxPayout`. The payout is a
*variable amount* determined by where the price landed — delivering that physically would require
knowing the price, i.e. the oracle returns. Going physical necessarily means abandoning the capped
spread for vanilla options.

### On Split's better LP redemption — and why we are not copying it

Split lets LPs *"redeem for pro-rata WETH any time the pool has free liquidity"*, where Tend reverts
`PoolHasOpenPositions` on `deposit`/`withdraw`/`authorizeSeries`/`updatePool` while any obligation is
open. That looks strictly worse until you read our accounting:

- `fillPoolQuote` does `totalAssets -= maxPayout` — so **`totalAssets` is already free liquidity**;
  `lockedCollateral` and `escrowedPremium` are tracked separately and sit outside it.
- Share NAV is computed off `totalAssets` alone (`calculateDepositShares(amount, totalShares, totalAssets)`).

So permitting entry/exit while positions are open would **misprice shares in both directions**: an
exiting LP forfeits their claim on escrowed premium and on collateral that returns unspent, while a
depositor could enter cheaply just before settlement and capture premium they never underwrote. The
guard prevents NAV gaming; it is a correctness property, not an oversight.

Doing it Split's way requires NAV to mark open positions to market — which needs either an oracle or,
as their docs describe, *"the pool's signed NAV"*: a trusted off-chain signer. That trades one trusted
component for another, which is a poor deal for a protocol whose pitch is minimising them.

**Revisit if:** LP lockup becomes a real adoption constraint. The honest fix is then per-series
sub-pools (isolating each obligation so unrelated capital stays liquid), not a signed NAV. In the
meantime the keeper (`npm run keeper:monad`) settles and refunds promptly, which keeps lockup windows
short, and the UI states the reason plainly rather than greying the buttons out silently.

### What we do instead

- Keep the multi-market, single-asset-pool design (BTC + ETH on Monad; equities/RWA on Solana).
- Keep MockPyth **only** on Monad testnet, documented as such, with the canonical receiver recorded in
  the manifest so a mainnet deployment swaps it with no code change.
- Invest in the parts that actually differentiate: more markets, RWA underlyings, and the 24/7
  settlement that legacy equity rails cannot offer.

# Tend on Robinhood Chain

**Choose a direction. Know your maximum loss.**

Tend is a defined-risk BTC, ETH and MON trading prototype on **Robinhood Chain testnet** (chain ID 46630). A trader chooses UP or DOWN, an expiry and a fixed **1.5×, 2× or 3× total winning payout**. The premium is the maximum trading loss, excluding gas. The vault escrows the full potential payout before the position opens; there is no margin account or liquidation.

[Open the live app](https://robinhood.usetend.xyz) · [One-minute explainer](web/public/media/tend-robinhood-submission.mp4) · [Deployment manifest](deployments/robinhood-testnet.json) · [Explorer: vault](https://explorer.testnet.chain.robinhood.com/address/0x9542d2908591aed8366cede289286a8fcdf32f90)

> **Testnet prototype:** mUSDC is a valueless mock token. Coinbase spot and candle data drive quotes. At expiry, Tend's operator posts the Coinbase expiry-minute reference to TendPriceOracle. The oracle is admin-controlled and prices are **not independently attested on-chain**. Contracts are unaudited; this is not ready for real funds.

## How a trade works

1. Connect an EVM wallet to Robinhood Chain testnet and mint mock mUSDC in the app's Pool tab.
2. Select BTC, ETH or MON, an expiry group, direction and payout tier. Review the signed quote's premium, strike, expiry and maximum payout.
3. Approve the premium and buy. The vault reserves the entire winning obligation from pool assets before accepting the trade.
4. Only the **final price at the stated expiry** decides the held trade. Crossing the strike earlier and reversing by expiry is a loss. A strictly favorable finish pays the selected total multiple; a tie or unfavorable finish pays zero. An eligible position may separately accept a fresh signed early-exit bid before expiry.

| Direction | Winning condition | Payout |
| --- | --- | --- |
| UP | Settlement price > strike | Premium × selected multiple |
| DOWN | Settlement price < strike | Premium × selected multiple |
| Either | Tie or unfavorable finish | Zero |

The displayed multiple is total payout divided by premium, not net profit or a guaranteed return. An early-exit bid may be below the premium. If no reference price is published before the series deadline, the buyer can reclaim the premium.

## Robinhood testnet deployment

| Contract | Address |
| --- | --- |
| TendPoolVault | [0x9542d2908591aed8366cede289286a8fcdf32f90](https://explorer.testnet.chain.robinhood.com/address/0x9542d2908591aed8366cede289286a8fcdf32f90) |
| TendSeriesFactory | [0x7097d8b82c1c7caa4f3ae11d15c162c93eaaf2d0](https://explorer.testnet.chain.robinhood.com/address/0x7097d8b82c1c7caa4f3ae11d15c162c93eaaf2d0) |
| TendPriceOracle | [0x7df5109f5232e571dcad8af71fe6c43878ac5b69](https://explorer.testnet.chain.robinhood.com/address/0x7df5109f5232e571dcad8af71fe6c43878ac5b69) |
| Mock mUSDC | [0xbd66a19f0cb2e3b51c47eea0ff0961bfadd511dd](https://explorer.testnet.chain.robinhood.com/address/0xbd66a19f0cb2e3b51c47eea0ff0961bfadd511dd) |

The full manifest is [deployments/robinhood-testnet.json](deployments/robinhood-testnet.json). The on-chain oracle accepts a write-once price per observation only from the admin. The keeper supplies that price and settles expiring series. This trust assumption is a production blocker.

## Buildathon scope

Tend's base protocol and trading app existed before this buildathon. Robinhood-specific work includes the chain deployment and site, chain-aware signer and keeper paths, fixed expiry-only 1.5×/2×/3× payouts, signed early exits, admin-only write-once TendPriceOracle, and BTC/ETH/MON market seeding. The app uses live Coinbase data. This repository is a source snapshot for the Robinhood Chain testnet submission; retained Monad files document the prior foundation and shared multi-chain code.

## Run and verify locally

Node.js 22.13+ is required (Node 24 recommended). The quote-authority private key stays server-side and is intentionally absent from this repository. Install root and web dependencies, copy .env.example to .env, and configure the testnet quote authority in .env to issue executable quotes. Then run npm run dev and open http://localhost:5173. Without the key, charts and on-chain reads can still work, but executable quotes report missing configuration.

Run npm run check for lint, tests, typecheck, build and Solidity tests. Run npm run check:readiness for a read-only live readiness check. The production-mode guard refuses real-money mode while settlement relies on one admin-posted oracle.

The React app is in web/, quote and data APIs in api/ and quote-service/, vault/factory/oracle in contracts/, and Robinhood-aware keeper in scripts/keeper-monad.ts. npm run bootstrap:robinhood and npm run keeper:robinhood operate on Robinhood Chain testnet; they require a funded operator wallet and are not needed to read or build the project.

## License

Original Tend code is MIT-licensed unless a file has another SPDX identifier or third-party notice. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Dependencies keep their own licenses.

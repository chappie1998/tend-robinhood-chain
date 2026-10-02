# Production readiness — September 28, 2026

Status: hardened testnet prototype with production-hosted web/API on Monad and Robinhood testnets. **Not approved for real funds.** Source changes are based on commit `5dc2f3521054373915dc6a4d6375fca0c7a14367`. The web/API releases did not redeploy the Solidity contracts.

**Binary release status:** This working tree now prices and displays exact 1.5×, 2× and 3× all-or-zero winning payouts, decided only by the expiry settlement price. Preview deployments exist on both testnets. The production aliases still serve the preceding proportional-spread web/API release because `vercel deploy --prod` returned `Not authorized`; there is no source-matched production binary release yet. Existing wider-width positions retain their original proportional payout.

## Implemented

- Keeper settlement/refund processing is no longer blocked by the estimated cost of rebuilding every market. New series, authorizations and liquidity operations use fresh balance/fee checks, estimated gas, explicit transaction caps and a native-token reserve. Coverage is distributed across market/tenor pairs before deeper ladder rungs.
- Local keeper overlap uses a kernel advisory lock inherited by child processes. It requires Python 3 on macOS/Linux and does not delete potentially live lock owners.
- Production deployment configurations reject mock contracts, malformed addresses, invalid chain IDs, non-integer risk parameters and unsafe role overlap. Deployment checks the RPC chain and required contract code before sending transactions.
- Quote endpoints recheck chain identity, vault/factory/token/oracle wiring and signer authority on every request. `TEND_MODE=production` refuses trading because the current runtime supports only demo deployments.
- Frontend and server chain selections must agree, including Vite mode-specific environment files. Unknown chain values fail instead of silently selecting Monad.
- Factory source now requests the first authenticated price update at or after expiry, rejects a wrong/empty returned feed, and refuses a positive price that normalizes to zero.
- `npm run check:readiness` checks live RPC freshness, immutable wiring, pool capacity and signer configuration without sending transactions. `-- --production` exits nonzero. It does not certify market availability, external audits or oracle authenticity.

## Verification

The September 28 complete `npm run check` passed: 99 application tests, 92 Solidity tests (including fuzz tests), lint, root/web TypeScript and the Vite build. Independent TypeScript, security, and code reviews were performed. Raw evidence is under `outputs/production/2026-09-27/` and `outputs/production/2026-09-28/`; these directories are intentionally gitignored.

After the binary changes, the focused application suite passed 97 tests with lint, root/web TypeScript and Monad build; the separate contract suite passed 93 tests. Robinhood's chain-specific build also passed. Raw logs: `binary-post-browser-app-check.log`, `binary-final-contract-tests.log` and `binary-post-browser-robinhood-build.log` in the same September 28 output directory. Independent code and TypeScript reviewers checked the binary quote, mark, expiry and UI paths; their reported precision, stale-preview and post-expiry-mark issues were fixed before the final application run. The live, read-only readiness checks passed wiring and signer checks on both chains, while both identified the deployed `DeployableMockPyth` runtime and did not claim production readiness.

The current [Monad binary preview with fresh proof](https://tend-monad-jcwb3e6p9-ankitgc1s-projects.vercel.app) is deployment `dpl_2j6JFpgjrRNbjosFLBWRrQGzPM8c`; the [Robinhood binary preview](https://tend-robinhood-lwctdp59n-ankitgc1s-projects.vercel.app) is `dpl_79amCDc69C4QcQ1uzuiL8zxwLSj6`. Brave browser checks on the immediately preceding binary build showed BTC/ETH/MON, live Coinbase history, three payout tiers, exact indicative strike and expiry-only ticket labels on both. Read-only signed requests returned one-tick width, 10 mUSDC premium and 15 mUSDC maximum payout for Monad 1.5× on chain 10143, and 30 mUSDC maximum payout for Robinhood 3× on chain 46630. Logs: `binary-monad-final-preview-deploy.log`, `binary-monad-proof-preview-deploy.log`, `binary-robinhood-final-preview-deploy.log`, `binary-monad-final-preview-quote.log` and `binary-robinhood-final-preview-quote.log`. These are signed quote checks, not filled on-chain trades or demonstrated expiry settlements.

A separate source-matched local API rehearsal then filled and settled Monad position #4 on-chain. Its 10 mUSDC UP premium locked a 20 mUSDC maximum payout at a one-tick strike of $84,575.198667. The Coinbase expiry-minute opening price at 00:15 UTC was $84,420.19, so its verified strict binary payout was 0. The run checked source price/time, buyer balances and escrow conservation. [Full evidence](evidence/demo-rehearsal.json) and raw `binary-live-rehearsal.log` retain hashes and values; the September 12 proportional-spread proof is archived separately. This proves one testnet loss path, not a win, a browser-wallet fill, reliable unattended operation, or oracle authenticity.

Read-only Monad evidence at `2026-09-27T15:49:07.801Z`: chain 10143, correct contract wiring and signer, one-second-old RPC head, 100,000 mUSDC pool assets and zero locked collateral. Keeper dry-run completed with zero failures and no writes. Dry-run ladder results are **planned outcomes**, not proof those markets already exist or that every rung is affordable.

The SDK 4.3.1 mock's unique parser passes `checkUniqueness=false`. A test-only adapter exercises its underlying parser with uniqueness enabled. These tests prove local selection behavior, not cryptographic authenticity or canonical receiver compatibility.

After review, the live keeper restored all nine Monad market/tenor pairs with zero failures using the existing contracts. Brave verification of `https://monad.usetend.xyz` showed **3 TRADABLE**, active 15M/1H/12H choices and live priced strike tiles. This was testnet maintenance, not deployment of the hardened factory or web/API source. Both chain builds also passed; the supported exported-chain environment regression and final kernel-lock tests passed separately.

Live maintenance completed with exit 0 on Monad at `2026-09-27T16:08:57Z` and Robinhood at `2026-09-27T16:12:20Z`. Both reported zero failures and fillable series across all nine pairs. Remaining keeper balances: 2.9450 MON and 0.4812 Robinhood test ETH. Raw receipts: `outputs/production/2026-09-27/keeper-maintenance-raw.log`. The run exposed an existing Robinhood explorer-link bug; it was fixed afterward using the actual client chain ID, independently reviewed and covered by a passing regression test. The retained raw log preserves the original URLs; use the network label and transaction hash to locate Robinhood receipts on its own explorer.

On September 28, the preceding proportional-spread web/API was deployed to `https://monad.usetend.xyz` (Vercel deployment `dpl_3i28NsCKVhQ7wcPoFjd53hd7iXoz`) and `https://robinhood.usetend.xyz` (`dpl_B29L7ucfiDjkYfns8FQ9dwmCLTqd`). Browser checks showed three tradable BTC/ETH/MON markets, priced 15-minute/1-hour/12-hour strike choices and live Coinbase history on both sites. Read-only quote requests with a dummy public address returned signed quotes on chain 10143 and chain 46630 respectively. The Robinhood response is retained at `outputs/production/2026-09-28/robinhood-after-live-quote.json`. Public HTML responses have chain-specific static titles and accurate testnet descriptions (`monad-after-metadata.html`, `robinhood-after-metadata.html`). No browser wallet trade or on-chain transaction was sent as part of these release checks.

Earlier deployments used `DeployableMockPyth`, which accepted a price from any caller; since `publishSettlement` is permissionless, anyone could settle at an invented price. Both testnets were redeployed on September 28 with `TendPriceOracle`, which only its admin can write to and which ignores caller-supplied update data. `npm run check:readiness` identifies it by exact runtime bytecode. It is a single trusted key, not an attested oracle. `npm run check:readiness -- --production` correctly refused readiness. Fresh web dependency installation and audit showed zero high or critical advisories and 22 moderate advisories; the latter require upstream major-version migration and separate wallet regression testing.

## Release gates

1. **Authenticated settlement:** the live deployments use an admin-posted oracle (`TendPriceOracle`) with Coinbase data. Real exchange prices do not authenticate settlement on-chain. Verify a supported receiver and historical update access, including rejection of a later tick inside the 15-second window; then repeat the full lifecycle against that receiver. Do not treat a simulated CRE workflow as this proof.
2. **Contract migration:** `factory.pyth` and `vault.factory` are immutable. The source fixes require a new factory and vault, verified addresses and a deliberate cutover. Existing positions keep their original contracts and settlement rules. Never replace manifests to hide outstanding positions.
3. **Independent review and operations:** external contract audit, separate privileged/signing roles, key custody, funded reliable keeper hosting, alerting, restore drills and sustained buy/close/settle/refund evidence remain required. A laptop scheduler is not a production availability guarantee.
4. **Sponsor integrations:** Dynamic onboarding, hosted Envio and Chainlink CRE still need the previously requested account/environment access. No placeholder integrations were added. The MetaMask plugin is implemented and tested separately, but a host-installed, policy-mediated live flow remains unverified.
5. **Submission release:** refresh the actual-operation demo and pitch after the trading flow is stable; make the repository public at submission as requested. Do not claim sponsor qualification, users or traction without evidence.

## Operating commands

```bash
npm run check
npm run check:readiness
npm run check:readiness -- --production  # expected refusal for current deployments
DRY_RUN=1 npm run keeper:monad           # no transaction or manifest writes
bash scripts/keeper-local.sh             # live maintenance on both testnets
```

Set `TEND_CHAIN` and `VITE_CHAIN` together to `monad` or `robinhood`. `TEND_MODE=demo` is separate from Node/Vite's production build mode. Do not put the quote key in a `VITE_` variable. Readiness output includes only public metadata and check outcomes.

Local Vercel CLI was upgraded to 60.1.3 before the September 28 releases.

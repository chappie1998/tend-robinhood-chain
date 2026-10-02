# Bounty implementation verification — September 27, 2026

Base commit: `5dc2f3521054373915dc6a4d6375fca0c7a14367` plus the local changes described below. This is a dated engineering checkpoint, not a submission or bounty qualification certificate.

## Application and submission materials

README, HACKATHON, DEMO and the Metropolis build record now describe BTC/ETH/MON, signed early exits, the priced strike ladder capped at 4×, the September 16 vault migration, and the local keeper. Three UI copy corrections remove contradictory no-early-exit claims from portfolio, positions and fill confirmation. Independent read-only code/document review found no actionable issues in those changes.

Verification performed with raw `tee` logs and Bash `pipefail`:

- `npm run check`: lint passed; 75 application tests passed; root/web TypeScript checks passed; Vite production build passed. Solidity stage timed out acquiring the compiler cache lock under the filesystem sandbox.
- `npm run test:contracts`: rerun with access to the normal Hardhat compiler cache; **88 Solidity tests passed**, including payout/escrow fuzz tests. No Solidity source changed in this pass.
- `git diff --check`: passed.

Raw local logs: `outputs/bounties/2026-09-27/root-check-final.log` and `contracts-final.log` (gitignored). The Vite chunk-size warning remains; it does not fail the build.

## Live demo observation

Brave loaded https://monad.usetend.xyz with BTC, ETH and MON Coinbase reference prices, 288 real BTC candle bars, and the early-exit-capable vault. However, all BTC expiry choices displayed **Unavailable**. This was a read-only check; no fill, approval or close was sent.

The public deployment manifest still contains September 19 seed IDs. That alone does not establish an outage because the app derives current series from onchain parameters. The actual keeper log supplies the cause: September 27 Monad sweeps failed their gas preflight at **5.1407 test MON** against approximately **5.5016 MON** required for a worst-case full-ladder rebuild. The observed Robinhood sweep succeeded. A test-MON top-up and a successful subsequent Monad sweep are required before claiming current tradability.

The earlier September 12 demo remains historical evidence. It must be replaced with a current product recording and a separate pitch; no new video was produced in this pass.

## MetaMask Agent Wallet package

The separate package in `integrations/metamask-agent-wallet` implements live keeper-ladder discovery, buyer-bound quote validation, bounded position enumeration, exact token approval, buy and early close. Transactions use the Agent Wallet host executor; the package does not manage private keys. Its final 17 tests, TypeScript check, build and actual npm packaging passed. Independent security/TypeScript review found no production-code findings after the quote-binding and discovery fixes. A development-only Vitest advisory was resolved by upgrading to 5.0.2; the final package audit reported zero vulnerabilities. The 7.0.0 host CLI was available, but its doctor check reported no initialized/authenticated wallet; no live plugin trade was attempted. The installable archive is `integrations/metamask-agent-wallet/outputs/bounties/2026-09-27/tend-protocol-metamask-agent-wallet-plugin-0.1.0.tgz` (gitignored), SHA-256 `1dee5ab8b4a4bb67c8c369a2172d05eec36230ae23a050f9c1d0e7580825a7f8`. Raw package logs remain under its local `outputs/bounties/2026-09-27/` directory. This is implementation evidence, not completed bounty qualification.

## External integration prerequisites

- Vercel authentication, dev-tools and workflow discovery did not offer Dynamic, Envio or Chainlink CRE.
- Dynamic awaits a real sandbox environment ID/account setup. No stand-in integration was added.
- Envio CLI 3.12.1 and Docker 29.5.2 were available. The actual Tend vault import stopped with a required `ENVIO_API_TOKEN`; no indexer was provisioned or connected to the UI.
- CRE CLI v1.35.0 was downloaded from the official release into `/private/tmp/tend-cre-cli/`, with SHA-256 matching the GitHub release asset. CRE account/login is still needed; no simulation was run.

The user was asked to complete the account steps and save any secret token locally, never in chat. No sponsor selections, public-source visibility change, or final portal submission were made.

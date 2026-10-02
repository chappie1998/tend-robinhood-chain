# Tend: Metropolis bounty and judging plan

Verified September 27, 2026 against the signed-in Metropolis portal and repository commit `5dc2f3521054373915dc6a4d6375fca0c7a14367`. This is a researched plan, not proof of sponsor qualification or a submitted entry. Existing changes in both testnet deployment manifests were preserved. No code, account preferences, or bounty selections were changed.

The September 27 code-gap assessment and dated checkpoint below are historical. Current trading quotes use expiry-only 1.5×/2×/3× binary payouts; see [README](../README.md) and [production readiness](PRODUCTION-READINESS.md). The bounty targets and award amounts need fresh portal verification before selection.

## Decision

Keep **Onchain Finance & Trading**. Target **Dynamic OR Privy**, **MetaMask Agent Wallet**, **Envio**, and a **Chainlink CRE feasibility spike**. Ship only integrations that improve the core product and can be demonstrated. Do not build three overlapping onboarding systems merely to add prize amounts.

The coherent product story is: **Tend lets traders express a short-term view with a known premium budget, an escrowed maximum payout, and an early-exit quote.** The initial-user hypothesis should be narrower than “crypto traders”: people already taking short-term BTC/ETH/MON directional views who want bounded exposure without maintaining a margin account. Validate this with real users; do not claim interviews, demand, or retention that have not occurred.

## Current official rules and award amounts

- [Tracks catalogue](https://hackathon.monad.xyz/tracks): one primary track; multiple compatible sponsor bounties. Tend currently has Onchain Finance & Trading and no sponsor bounties selected.
- [Prize page](https://hackathon.monad.xyz/prizes): each track has three equal **$10,000** awards, not a $30,000 award to one project. Grand Champion is **$25,000**, at judges' discretion. Sponsor bounties stack with main-track prizes. Do not assume additional stacking restrictions or guaranteed wins.
- Portal currently says submissions open **October 2** and deadline **October 14, 2026, 09:29 GMT+5:30 (IST)**. Earlier local submission notes have older opening dates. Use the current portal; aim to finish by October 10 with a buffer.
- [Finance track deliverables](https://hackathon.monad.xyz/tracks/onchain-finance): public GitHub repository; working Monad mainnet OR testnet product; logo JPG/JPEG/PNG/WEBP up to 3 MB; technical demo video up to **3 minutes** on YouTube, Loom or Vimeo showing actual operation; separate founder/problem pitch up to **2 minutes**. Optional 30-second advertisement does not affect judging.
- Current rubric: technical execution **20%**, design/craft **20%**, originality/track insight **15%**, founder/market readiness **25%**, traction/path forward **20%**. This supersedes the older equal-weight rubric in local notes.
- Prior-work and AI disclosures remain necessary under the previously inspected event rules. Preserve history and identify event-window work. This research does not independently certify the event's substantial-majority threshold.

## Best targets

Amounts below are the award to a single winning entry unless explicitly called a pool. Effort ranges are planning estimates for a focused engineer, not commitments; include integration, meaningful tests and demo evidence. Account access and chain support can change the estimate.

| Priority | Bounty | Award | Tend feature and acceptance evidence | Estimated effort / gate |
| --- | --- | --- | --- | --- |
| 1 | [Dynamic](https://hackathon.monad.xyz/tracks/best-use-of-dynamic) | $5,000 | Embedded wallet onboarding plus real approval, buy and early-close signing. Deployed judge-usable app; explain integrated primitives. Measure landing-to-first-fill and preserve tx receipts. | 2–3 days. Confirm account access and Monad testnet flow first. |
| Alternative to Dynamic | [Privy](https://hackathon.monad.xyz/tracks/privy) | $5,000 | Embedded wallet actually executes Tend operations; auth-only explicitly does not qualify. Demonstrate beyond-login functionality, not a login badge. | Similar estimate. Choose one onboarding provider based on a working spike. |
| 2 | [MetaMask Agent Wallet plugin](https://hackathon.monad.xyz/tracks/best-agent-wallet-plugin) | $2,500 | Installable Tend venue plugin: inspect markets, get premium/max-payout/expiry, request fill, list positions, request early exit. All transactions through Agent Wallet; no user-key handling or bypass of policy/MFA. Include `skills/<name>/SKILL.md`, README and real-flow demo. | 2–3 days. Official docs list Monad testnet 10143; verify installed `mm chains list` and plugin API before implementation. Bounty says plugin support after v6.2.0. |
| 3 | [Envio](https://hackathon.monad.xyz/tracks/best-use-of-envio) | $1,000 | Event-driven position history and pool risk view consumed by Tend UI. Index fills, closes, settlements, refunds and liquidity events; derive wallet P&L and pool obligations. Public config/schema/handlers or HyperSync code; live data flow and restart/reconciliation evidence. | 1–2 days. Confirm Monad testnet backfill support or supported RPC indexing. Preserve contract truth, reorg handling and the current fallback. |
| 4, conditional | [Chainlink CRE](https://hackathon.monad.xyz/tracks/best-workflow-with-cre) | $3,000 | Meaningful settlement/operations workflow combining blockchain state with external market data: identify due series, validate observations, prepare a decision, drive a consumer or operational action. Successful CRE CLI simulation explicitly qualifies; live CRE network deployment is not required by the bounty. | Half-day feasibility spike, then 2–3 days if viable. Prove Monad interaction/relay route and data semantics first. Do not assume native network support from an incompletely rendered docs page. |
| Optional | [Alchemy](https://hackathon.monad.xyz/tracks/best-projects-using-alchemy) | $1,000 **credits** | Use a supported Monad service materially in the working app; reliable RPC reads are a possible candidate. Document actual use and measured reliability. | Only if it naturally becomes part of infrastructure work. Not cash. |
| Conditional eligibility | [Community Team](https://hackathon.monad.xyz/tracks/best-community-team-project) | $5,000 | Genuine affiliation with an onboarded campus/community group selected in the profile. Standard working-product submission. | Ask owner; do not invent affiliation. No additional technical feature. |

The four core sponsor targets (one $5,000 wallet provider, MetaMask $2,500, Envio $1,000, CRE $3,000) total **$11,500 in listed awards**, all conditional on qualifying and winning. Without the CRE feasibility gate, the core is $8,500. A track award is separately $10,000. These are opportunity amounts, not expected winnings or probabilities.

## Alternatives and distractions

| Bounty | Actual award structure | Recommendation and reason |
| --- | --- | --- |
| [Mera UX](https://hackathon.monad.xyz/tracks/best-mera-powered-ux-on-monad) | $2,500, single prize | Strong product alternative to Dynamic/Privy if passkey-first onboarding is the chosen direction. Mera must be the entire account layer, one passkey ceremony, scoped prompt-free sessions, and live recovery after clearing local storage/fresh device. A passkey button alone fails. |
| [Mera One Passkey, Many Keys](https://hackathon.monad.xyz/tracks/mera-one-passkey-many-keys) | $2,500, single prize | Stretch only: encrypted private trading journal/strategy state could fit, but it must use a non-account PRF namespace and demonstrate cross-device recovery. Wallet signing itself does not qualify. |
| [Nansen](https://hackathon.monad.xyz/tracks/best-use-of-nansen) | $5,000 pool: $2,000/$1,500/$1,000/$500 | Optional later: actionable market context or wallet-risk explanations using real Nansen data. Basic token prices/raw data exposure do not qualify. Confirm data access/cost and relevance to BTC/ETH/MON before spending time. |
| [Aurora Intents](https://hackathon.monad.xyz/tracks/bring-any-chain-liquidity-to-monad) | $5,000 headline; first place $2,500 | Defer unless real supported cross-chain funds can arrive and be used inside Tend. Mocked bridging fails; current mUSDC collateral is not an asset users can bridge. Mainnet funding does not justify exposing the mock-oracle vault to real funds. |
| [Agora Mobile Trading](https://hackathon.monad.xyz/tracks/best-mobile-trading-app-on-monad-agora-onchain-trading-bount) | $10,000, single prize | Poor fit without substantial expansion: mobile app + Mera + AUSD balance + an actual Perpl trade are all required. Our existing Tend vault trades do not count as Perpl integration. |
| [Kuru consumer trading](https://hackathon.monad.xyz/tracks/build-the-next-consumer-trading-app-on-kuru) | $5,000, single prize | Requires real Kuru spot-orderbook routing, target user, demand and retention evidence. A separate spot interface dilutes current product focus. |
| [Kuru new assets](https://hackathon.monad.xyz/tracks/bring-new-assets-and-markets-to-kuru) | $5,000, single prize | Tokenizing Tend claims for Kuru could be conceptually relevant, but requires issuance/redemption, settlement, liquidity and legal/operational viability. Significant protocol redesign. Defer. |
| [Perpl API](https://hackathon.monad.xyz/tracks/best-use-of-perpl-s-api) | $5,000 pool: two $2,500 winners | Requires working Perpl automation with real onchain activity and reliable risk-managed execution. A Tend keeper is not a Perpl bot. Defer. |
| [Perpl analytics/risk](https://hackathon.monad.xyz/tracks/best-analytics-risk-tool) | $3,000 pool: three $1,000 winners | Requires a comprehensive Perpl-focused protocol and wallet dashboard. Our own vault risk dashboard does not qualify. Defer. |
| KIMI | $3,000 in credits | All tracks, but real KIMI-powered product feature required. No reason to add an unrelated chat box for credits. |
| Agora payments / Cleanverse / Hunyuan / Qwen | Different primary tracks | Portal disables these under Finance. Keep the strongest primary track; do not switch just to make more checkboxes available. |

## Current code evidence and highest-impact gaps

Inspected `web/package.json`, `web/src/wagmiConfig.ts`, `web/src/chain.ts`, `web/src/hooks/useTradeHistory.ts`, `contracts/TendPoolVault.sol`, `contracts/test/DeployableMockPyth.sol`, `quote-service/strikeLadder.ts`, `api/close-quote.ts`, keeper code and current Git history. No relevant sponsor SDK integration was found in this inspected scope. Prior local tests were not rerun for this research-only task and are not new evidence of current live health.

1. **Settlement authenticity is the highest technical credibility gap.** The deployed design still uses MockPyth. A local process obtaining real Coinbase data does not authenticate every onchain settlement input. A CRE simulation by itself does not change that. Any new settlement receiver must validate who/report provenance, market/series identity, observation time, expiry window, duplicates and replay. Preserve the refund path. Treat this as separate protocol security work, not a sponsor-logo change.
2. **Onboarding is extension-only.** `wagmiConfig.ts` uses the injected connector. A complete embedded/passkey wallet flow improves first-user experience and opens a wallet bounty.
3. **History enumerates positions and has a bounded scan.** Envio offers a product reason to add indexing. Reconcile results against onchain records; distinguish closed, settled and refunded positions.
4. **Documentation is materially stale.** README/HACKATHON describe BTC/ETH, no early exits, and 10x/25x/50x controls. Source supports MON, signed early close, and a strike ladder capped at 4x. The build record stops before several major September additions. Rewrite docs and portal description against final shipped behavior.
5. **Robinhood is now in source and manifests.** This is useful reuse, but Monad judging needs Monad-specific receipts, usage and product behavior. Do not substitute Robinhood/Solana evidence.
6. **Proof must be current.** Refresh buy, early exit, expiry settlement and timeout-refund demonstrations on the actual submission deployment. Source tests do not establish deployed bytecode equivalence. Quote/fill latency should be measured rather than inferred from chain marketing.

## Execution sequence through submission

1. September 27–28: freeze a truthful current baseline; establish source/deployment mapping and demo health. Verify one end-to-end wallet-provider spike, MetaMask chain/plugin compatibility, and CRE data/chain feasibility. Cut blocked dependencies early.
2. September 29–October 3: implement the chosen onboarding flow and meaningful settlement/operations work. Preserve raw test/rehearsal evidence. Record failure cases, not only the happy path.
3. October 4–6: add the small MetaMask venue plugin and Envio history/risk pipeline if core stability remains good. Each must pass its bounty-specific demonstration before being claimed.
4. October 7–9: usability sessions with a small number of actual target users; record task completion, time to first trade, feedback and repeat use. Show testnet activity honestly, not as real-money volume. Explain LP incentives, correlated exposure, quote-authority trust, and liquidity needs.
5. October 10: release candidate. Public source/license/setup/history, current prior-work and AI disclosures, three-minute operation demo, two-minute founder pitch, working judge instructions, links and receipts. Select only earned bounties and submit with buffer before the portal deadline.

Keep the live demo simple: enter with a known premium, show escrow and receipt, inspect early-exit value, close one position, and show a clearly labeled pre-existing expired position settling. Show the actual loss as well as the cap. Do not pretend a 15-minute position expired inside a three-minute recording.

## Technical source checks

- [MetaMask plugin docs](https://docs.metamask.io/agent-wallet/plugins/): commands receive scoped host capabilities; transaction submission remains policy-gated. Plugins do not receive the user's recovery phrase or session token.
- [MetaMask supported networks](https://docs.metamask.io/agent-wallet/reference/supported-chains/): lists Monad testnet 10143 and Robinhood testnet 46630; installed CLI output remains authoritative for that version.
- [CRE documentation](https://docs.chain.link/cre): local simulation is available; deployment to the CRE network requires approval. Simulation is not evidence of a deployed decentralized oracle.
- [Envio HyperIndex](https://docs.envio.dev/docs/HyperIndex/overview): use the official setup/network documentation when implementing. Bounty accepts Cloud or self-hosted pipeline.

Next action: turn the core shortlist into bounded implementation tasks after resolving provider access and network feasibility. No external applications, messages or integration accounts were created by this assessment.

## Community follow-up

The owner asked whether joining now could qualify. Read-only inspection of Profile → Edit → Communities showed no selected community and an onboarded list including **Encode Club**, **Hyderabad DAO**, **OpenBuild**, **AI Builders**, **LXDAO**, and multiple university groups. Profile editing was cancelled without saving.

Encode Club has a [public community invitation](https://discord.com/invite/encode-club-705799923014041651) and describes itself as a global developer/professional/student community. [Hyderabad DAO](https://www.hyderabaddao.com/) also advertises joining its community. These show a path to joining a community, not proof of eligibility for this prize. The bounty page does not specify whether new members joining during Metropolis qualify or whether a solo entrant needs endorsement.

Suggested question to organizers/community lead (draft only, not sent): “I’m a solo founder in Pune building Tend for Metropolis. If I join Encode Club during the build window and participate as a community member, may Tend represent Encode Club for Best Community Team Project? Is any prior-membership cutoff, referral, team-size requirement, or community-lead endorsement required?”

Only set affiliation after real membership/representation is established; don't select a university club without an actual connection. Community prize remains conditional.

## Implementation checkpoint — September 27

Base source: `5dc2f3521054373915dc6a4d6375fca0c7a14367`. The two deployment manifests were already modified by the operator's keeper; preserve those changes.

- MetaMask venue plugin: implemented in `integrations/metamask-agent-wallet` with market discovery, quotes, positions, buy and close. Independent review fixes bind quote terms to the requested trade and remove stale market IDs. Qualification still needs installation in an initialized host and a recorded policy-mediated trade. Do not claim the bounty from unit tests alone.
- Submission docs and runbook: updated for MON, signed early exits, priced strike tiles capped at 4×, later September build history, and current portal requirements. The September 12 video must be replaced.
- Dynamic: absent from the Vercel authentication marketplace results; waiting for a provisioned Dynamic sandbox environment ID and account setup. No placeholder wallet integration added.
- Envio: official CLI 3.12.1 installed for investigation; Docker 29.5.2 available. Actual contract import refused initialization without `ENVIO_API_TOKEN`. Waiting for the user to save that token locally. No indexer or live indexing claim yet.
- CRE: official CLI v1.35.0 downloaded to a task-local temporary directory and SHA-256 checked against its GitHub release. Account creation/login is required for simulation; waiting for the user. No workflow simulation or decentralized oracle claim yet.
- Live Monad check: public market prices and charts load, but all BTC expiry choices were unavailable. September 27 keeper logs explain the outage: operator balance 5.1407 test MON versus a 5.5016 MON worst-case preflight requirement. The latest observed Robinhood sweep succeeded. Fund the Monad keeper and verify reseeding before recording or judging.

Application validation: lint, 75 application tests, TypeScript checks, production build and 88 Solidity tests passed; see [the dated verification](evidence/bounty-readiness-2026-09-27.md).

Required next steps: provision the three sponsor accounts; restore the live Monad markets; produce current demo and pitch evidence. External services need real setup before integration code under the installed Vercel Marketplace workflow. No sponsor selection, public-source release, or final submission was performed in this implementation pass.

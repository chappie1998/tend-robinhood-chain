# Tend MetaMask Agent Wallet plugin

This package adds five `mm tend` commands for Tend's **Monad testnet** deployment:

- `mm tend markets`
- `mm tend quote <series-id> <up|down> <premium> <tile>`
- `mm tend positions`
- `mm tend buy <series-id> <up|down> <premium> <tile>`
- `mm tend close <position-id>`

`premium` is a human mUSDC amount and `tile` is `0`, `1`, or `2`. `markets` reconstructs the keeper's bounded BTC/ETH/MON tenor ladders, derives candidate IDs on-chain, and returns only live, factory-tradable, vault-authorized candidates as fillable. `quote` is read-only. `buy` may submit an exact ERC-20 approval before the fill. `close` requests a holder-specific signed bid before submission. `positions` reports `scanTruncated: true` when the 250-ID bound means older history may be omitted.

## Safety boundary

The plugin accepts only Monad testnet chain ID `10143`, the checked-in Tend deployment, and HTTPS API origins (localhost HTTP is allowed for development). It rejects quote responses with the wrong chain, vault, wallet, expired or long-lived validity, premium above 100 mUSDC, or payout above 4× premium. Close bids cannot exceed the position's escrowed maximum payout. Position discovery scans at most the latest 250 IDs.

Every approval, fill, and close goes through MetaMask Agent Wallet's `walletExecutor`. That keeps signing and submission inside the host's policy and MFA flow. The plugin has no private-key input, does not read recovery phrases or session tokens, and has no direct RPC transaction broadcaster.

## Build and local install

Requires Node.js 22.18+ and MetaMask Agent Wallet 7.x. Plugins are beta and disabled by default.

```sh
npm install
npm test
npm run typecheck
npm run build
mm config set experimentalPlugins true
mm config set experimentalAllowUnverifiedInstalls true
mm plugins install "file:$PWD"
```

Review the consent screen. `markets`, `quote`, and `positions` request `wallet-read`; `buy` and `close` additionally request `wallet-submit`. All commands target only chain `10143`.

Local host installation and live transaction execution have not succeeded yet. The available CLI was verified as 7.0.0, but its read-only doctor check reported unauthenticated, uninitialized, and no installed Agent Wallet skill. At validation time the Monad deployment also had no currently tradable series, so a live markets → quote → buy rehearsal could not qualify. Repository tests cover deterministic live-ladder discovery with a mock public client; they do not prove current keeper health or an installed host flow.

The deployment uses mock USDC and a MockPyth receiver fed from public market data; this is testnet software, not a mainnet or production trading claim. The current public quote API is `https://monad.usetend.xyz`; override it with `--api-origin` only for an HTTPS deployment or localhost development server.

Official references used for this implementation: [plugin overview](https://docs.metamask.io/agent-wallet/plugins/), [build guide](https://docs.metamask.io/agent-wallet/plugins/build-a-plugin/), [plugin API reference](https://docs.metamask.io/agent-wallet/reference/plugins/), and the [official template](https://github.com/MetaMask/agent-wallet-plugin-template).

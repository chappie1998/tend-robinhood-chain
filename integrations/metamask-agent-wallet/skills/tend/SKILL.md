---
name: tend
description: Quote, inspect, buy, and close bounded Tend positions on Monad testnet through the installed MetaMask Agent Wallet plugin.
---

# Tend on Monad testnet

Use `mm tend markets --json` to obtain current series IDs. Use `mm tend quote <series-id> <up|down> <premium> <tile> --json` before a trade. Explain premium, strike tile, maximum payout, quote expiry, and that this is mock-USDC testnet activity.

Before submitting, run `mm doctor --json` and require `authenticated: true` and `initialized: true`. Ask the user to approve the specific testnet premium and direction. Then run `mm tend buy ... --json`. Do not alter or bypass MetaMask policy, MFA, consent, or wallet selection. Never request or handle a recovery phrase, private key, CLI token, or quote-authority key.

Use `mm tend positions --json` to inspect positions. Close only an open position owned by the selected wallet, after showing the returned bid and obtaining the user's approval, with `mm tend close <position-id> --json`.

Keep defaults bounded: premium at most 100 mUSDC, tile `0`-`2`, payout at most 4×, Monad testnet chain ID `10143`, and the plugin's compiled Tend deployment. Treat a rejected quote, address mismatch, unsupported chain, expired quote, policy rejection, or MFA request as a stop condition. Do not retry by switching wallets, origins, contracts, or transaction routes.

# Third-party notices

Tend's original code is licensed under the root MIT license, except files with a different SPDX identifier or an existing third-party notice. Dependency code and assets retain their own licenses; the root license does not relicense them. Lockfiles record dependency versions. Generated dependencies and private operational files are not part of the source release.

## TradingView Lightweight Charts

TradingView Lightweight Charts™

Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/

Licensed under Apache-2.0; full text: [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt). [Upstream notice](https://github.com/tradingview/lightweight-charts/blob/v5.2.0/NOTICE). The chart keeps its TradingView attribution link enabled; a public notices page accompanies the app. Upstream also attributes incorporated tslib portions to Microsoft Corporation under BSD Zero Clause.

## Pyth Solidity SDK

Copyright 2025 Pyth Data Association.

The `@pythnetwork/pyth-sdk-solidity` dependency is Apache-2.0. `contracts/test/DeployableMockPyth.sol` is an Apache-2.0 wrapper around its MockPyth; retain that file's SPDX identifier. The MIT license does not replace these terms. See [LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt) and the installed SDK's LICENSE.

## Application and build dependencies

React, wagmi, viem, TanStack Query, Vite, TypeScript, and Lucide provide the core app/tooling; consult each installed package's license and notices. Solidity tests also use forge-std (Apache-2.0 OR MIT). The legacy preview uses Next.js, Drizzle, Cloudflare tooling, and image-processing dependencies with separate terms, including LGPL/MPL components.

Optional MetaMask SDK packages present transitively in the wallet dependency lockfile have ConsenSys non-commercial license conditions, including a monthly-active-user threshold. They are not covered by Tend's MIT license. The current app configures only the injected wallet connector; this is not a representation that every optional dependency is OSI-licensed. Review the installed package terms before enabling or redistributing those SDKs.

## Data, brands, and media

Coinbase Exchange supplies the real market data; API access and data redistribution remain subject to the provider's terms. The code license does not grant rights to third-party trademarks, market data, or explorer branding. Demo footage identifies its original live app and MonadScan pages. Testnet receipts and amounts are historical evidence, not live prices or investment results.

> **Historical deployment notes.** Use [README.md](README.md), [DEMO.md](DEMO.md) and [docs/DEMO-READINESS.md](docs/DEMO-READINESS.md) for the current September 2026 demo. Older Pyth entitlement, test-count and transaction claims below describe earlier runs, not current verification. The active app now uses public Coinbase market data and expiry-minute reference prices through MockPyth. Current deployed bytecode also differs from the latest source; see the runbook.

# Monad testnet deployment (Tend EVM options protocol)

> Testnet demo only. `mUSDC` is a valueless mock token minted by the deployer;
> `MON` from the faucet is testnet gas, not real value. The contracts here
> (`TendSeriesFactory.sol`, `TendPoolVault.sol`) are unaudited prototypes —
> see the top-level [README.md](./README.md) and the contracts' own NatSpec
> for the full "Prototype — unaudited" framing. Do not point real funds at
> this deployment.

This mirrors the Robinhood Chain deployment path described in the main
README, targeting [Monad](https://monad.xyz) testnet instead. The contracts
have no chain-specific opcodes, so the only new work is network config, a
deployable mock settlement token, and a deploy script — the contracts
themselves are untouched.

## Network parameters

| Field | Value |
| --- | --- |
| Chain name | Monad Testnet |
| Chain ID | `10143` |
| RPC URL | `https://testnet-rpc.monad.xyz` |
| Explorer | `https://testnet.monadscan.com` |
| Native token | `MON` |
| Faucet | `https://faucet.monad.xyz` |
| Pyth (`IPyth`) — canonical receiver | `0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379` |

> **Settlement oracle note (testnet only).** Monad testnet's canonical Pyth
> receiver above cannot verify live Hermes price updates — it reverts
> `InvalidWormholeVaa` (selector `0x2acbe915`) because its on-chain Wormhole
> guardian set is stale. So this demo deploys Pyth's own **`MockPyth`** (via
> the thin `DeployableMockPyth` wrapper) and drives it with **real,
> Hermes-sourced** BTC/USD prices; only Wormhole signature verification is
> bypassed. `TendSeriesFactory` is written against the `IPyth` interface and
> is unchanged — a Monad **mainnet** deployment passes the canonical receiver
> here with no code change. The live manifest records both the deployed
> `mockPyth` address and the `canonicalPythAddress` for provenance.

These are defined once, in [`config/monad.ts`](./config/monad.ts), and
imported by both `hardhat.config.ts` (network wiring) and
`scripts/deploy.ts` (deployment + manifest). A future Monad mainnet
deployment only needs a new entry there — no other file hardcodes these
values.

## Prerequisites

1. `npm install` (installs `@nomicfoundation/hardhat-viem` and `viem`,
   alongside the existing Hardhat 3 toolchain).
2. A throwaway EOA private key, funded with testnet `MON` from
   [the faucet](https://faucet.monad.xyz).
3. Export it as `MONAD_DEPLOYER_KEY` (never commit this — see
   `.env.example`):

   ```bash
   export MONAD_DEPLOYER_KEY=0x...
   ```

   If this env var is unset, `hardhat.config.ts` still loads fine (the
   `monadTestnet` network config resolves to an empty `accounts` array), so
   `npx hardhat compile` and `npm run test:contracts` never require it. It
   is only read — lazily, via Hardhat's `configVariable` — the moment a
   script actually connects to `monadTestnet`.

## Deploying

```bash
npm run deploy:monad
```

This runs `hardhat run scripts/deploy.ts --network monadTestnet`, which
deploys, in order:

1. **MockUSDC** — `MockERC20("Mock USD Coin", "mUSDC", 6)`, then mints
   10,000,000 mUSDC (raw 6-decimal units) to the deployer for demo
   liquidity.
2. **DeployableMockPyth** — `DeployableMockPyth(60, 0)` (a thin, deployable
   subclass of Pyth's `MockPyth`; `validTimePeriod = 60s`,
   `singleUpdateFeeInWei = 0`). This is the settlement oracle for the testnet
   demo — see the settlement-oracle note above for why the canonical Monad
   receiver can't be used.
3. **TendSeriesFactory** — `TendSeriesFactory(deployer, deployer, pyth)`,
   i.e. the deployer is both `initialOwner` and `initialEmergencyAdmin` for
   this demo, and `pyth` is the `DeployableMockPyth` address deployed in the
   previous step (the canonical receiver on mainnet).
4. **TendPoolVault** — `TendPoolVault(factory, mUSDC, deployer, 8000, 2500,
   0, deployer)`: `quoteAuthority = deployer`, `maxUtilizationBps = 8000`
   (80%), `maxPositionBps = 2500` (25%), `feeBps = 0`, `feeRecipient =
   deployer`.

The script logs its deployment plan (contract + resolved constructor args)
before sending any transactions, then logs each deployed address as it
goes.

### Manifest

On success, it writes `deployments/monad-testnet.json`:

```json
{
  "network": "monadTestnet",
  "chainId": 10143,
  "rpcUrl": "https://testnet-rpc.monad.xyz",
  "explorer": "https://testnet.monadscan.com",
  "pythAddress": "0x... (the deployed MockPyth — the active settlement oracle)",
  "canonicalPythAddress": "0xFC6bd9F9f0c6481c6Af3A7Eb46b296A5B85ed379",
  "pythNote": "Settlement uses MockPyth; canonical receiver reverts InvalidWormholeVaa on live Hermes updates. Prices are real (Hermes-sourced); only Wormhole signature verification is bypassed. Mainnet uses the canonical receiver unchanged.",
  "deployer": "0x...",
  "contracts": {
    "mockUSDC": "0x...",
    "mockPyth": "0x...",
    "tendSeriesFactory": "0x...",
    "tendPoolVault": "0x..."
  },
  "deployedAt": "2026-01-01T00:00:00.000Z"
}
```

### Re-running

The script is idempotent-*friendly*, not idempotent: these contracts don't
use `CREATE2`, so re-running `deploy:monad` always deploys fresh instances
at new addresses. If `deployments/monad-testnet.json` already exists, the
script prints its contents and a warning before deploying again, then
overwrites it with the new addresses. Keep a copy of an old manifest first
if you need to preserve a previous deployment's addresses.

### Validating the script without a funded key

`scripts/deploy.ts` only touches the network once it actually runs, so it
can be type-checked / imported safely with no key at all. It can also be
run with no `--network` flag (`npx hardhat run scripts/deploy.ts`), which
connects to Hardhat's local, in-memory, auto-funded network instead — this
exercises the full deploy + constructor wiring with zero risk, and
deliberately skips writing `monad-testnet.json` (it only writes the
manifest when connected to the real `monadTestnet` network).

## Proving real Pyth settlement (fork test)

Every test in this repo (`contracts/TendSeriesFactory.t.sol`) and every
live settlement on Monad testnet (`scripts/e2e-monad.ts`,
`scripts/keeper-monad.ts`) runs `publishSettlement` against **MockPyth**,
because Monad testnet's canonical `IPyth` receiver rejects live Hermes
updates with `InvalidWormholeVaa` (see the settlement oracle note above).
That means `TendSeriesFactory.publishSettlement`'s call into a REAL Pyth
receiver — real Wormhole VAA verification, a real update fee — had never
executed anywhere, until:

```bash
npm run test:pyth-fork
```

This forks **Base mainnet** (`chainId 8453`, a chain whose canonical Pyth
receiver works) at a pinned historical block, deploys a throwaway
`TendSeriesFactory` pointed at Pyth's **real, live** receiver, and:

1. verifies the receiver on the fork itself (bytecode present,
   `getUpdateFee` responds, `getPriceUnsafe` returns a real, sane BTC/USD
   price) rather than trusting a hardcoded address — see
   `config/base-fork.ts` for exactly how that address was chosen;
2. creates a handful of series with `expiry` shortly after the fork
   block's own timestamp;
3. fetches a **real historical Hermes VAA** (`hermes.pyth.network/v2/updates/price/{unixTimestamp}`)
   whose `publishTime` falls inside one series' settlement window;
4. advances the fork's EVM clock (which starts at the fork block's
   timestamp, not the real wall-clock time) past `expiry`, pays the real
   `getUpdateFee`, and calls `publishSettlement` — asserting it succeeds
   and the settled price matches Hermes exactly;
5. asserts the negative cases against the same real receiver: publishing
   twice (`AlreadyFinalized`), underpaying the fee (`InsufficientFee`), and
   a VAA outside the settlement window.

This is **not** part of `npm run test:contracts` or `npm run check` — it
needs live network access to a public Base RPC and to Hermes, so it must
never make the offline suite flaky. Run it on demand. See the header
comment in `scripts/pyth-fork-settlement.ts` for the full writeup,
including a finding this test surfaced: `TendSeriesFactory.InvalidObservationTime`
appears to be unreachable dead code, because Pyth's own
`parsePriceFeedUpdates` already enforces the same `[expiry, observationEnd]`
bound internally (on both MockPyth and the real receiver) and reverts with
its own `PriceFeedNotFoundWithinRange` first.

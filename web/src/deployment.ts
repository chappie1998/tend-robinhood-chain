import { MANIFEST_FILE } from "./chain";
import { isAddress, isAddressEqual, zeroAddress, type Address } from "viem";

// Shape written by scripts/deploy.ts (worktree root) to
// deployments/<chain>-testnet.json. Kept in sync by hand since web/ is a
// separate package from the Hardhat project at the worktree root.
export interface DeploymentManifest {
  network: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
  pythAddress: string;
  deployer: string;
  contracts: {
    mockUSDC: Address;
    tendSeriesFactory: Address;
    tendPoolVault: Address;
  };
  /**
   * The settlement token's own identity, as recorded by scripts/deploy.ts at
   * deploy time (config/deployment-target.ts). `isMock` is the load-bearing
   * field: true when the settlement token is a MockERC20 this deployment
   * minted itself (`deployMocks: true`), false when it names a real,
   * external token (e.g. real USDC) supplied by the deployment target.
   * Optional — manifests written before this field existed lack it; see
   * `isMockSettlement` below for how that's handled, rather than treating a
   * missing field as a validation failure the way `isValidManifest` would
   * for a required one.
   */
  settlement?: {
    token: Address;
    symbol: string;
    decimals: number;
    isMock: boolean;
  };
  deployedAt: string;
  /**
   * One entry per (seeded market, tenor) pair (config/markets.ts x
   * scripts/lib/e2e/seed-series.ts's TENORS on the chain-scripts side) — e.g.
   * BTC/15m, BTC/1h, BTC/12h, ETH/15m, ... Only the fields the SPA consumes
   * are typed; kept optional so a manifest without it (or an entry missing a
   * field) still validates and the app still works. The series' own
   * on-chain params are read authoritatively via getSeries — this only pins
   * which id(s) to surface as a fallback.
   *
   * The market selector (App.tsx / MarketSelector.tsx) reads the whole array
   * via `seededMarkets` below, driving both the chart's feed and (as a
   * per-tenor fallback only — see useLiveSeries.ts) the trade ticket's
   * target series.
   */
  seededSeries?: Array<{
    seriesId: `0x${string}`;
    /**
     * The seeded series' Pyth feed id and symbol, used only to show live price
     * context for its underlying. Both optional so a manifest written without
     * them still validates — the app just skips the price panel.
     */
    pythFeedId?: `0x${string}`;
    symbol?: string;
    /** Which tenor this entry belongs to (seriesParams.ts's TenorId — "15m" |
     * "1h" | "12h"). Optional so a pre-multi-tenor manifest still validates;
     * an entry without it is simply dropped by `seededMarkets` below, same as
     * a missing seriesId/pythFeedId — there is no tenor to file it under. */
    tenorId?: string;
  }>;
}

/** A bytes32 hex string — the shape of a series id and of a Pyth feed id. */
const BYTES32_HEX = /^0x[0-9a-fA-F]{64}$/;

/** One seeded market, validated and ready for the selector/chart/ticket to use. */
export interface SeededMarket {
  symbol: string;
  feedId: `0x${string}`;
  /** Manifest fallback series id per tenor id ("15m" | "1h" | "12h") — used
   * by useLiveSeries.ts only when its own on-chain search finds nothing
   * fillable for that tenor. Never assumed current; always re-checked
   * on-chain before anything renders it as tradable. */
  seriesIdByTenor: Record<string, `0x${string}`>;
}

/**
 * Every seeded market that carries a usable feed id, grouped from the
 * manifest's flat (market, tenor) entries, in first-seen order (BTC before
 * ETH, per config/markets.ts). Validated rather than trusted: the manifest
 * is fetched JSON and the feed id is interpolated into a Pyth URL, so an
 * entry missing or malforming a required field is dropped rather than shown
 * half-configured. A market with no valid tenor entries at all is dropped
 * entirely — a market a trader can't actually chart or fill is worse than
 * one missing from the list; a market with SOME valid tenor entries is kept,
 * with only the invalid ones missing from `seriesIdByTenor` (useLiveSeries.ts
 * treats a missing manifest fallback the same as "nothing found yet").
 */
export function seededMarkets(manifest: DeploymentManifest): SeededMarket[] {
  const bySymbol = new Map<string, SeededMarket>();
  const order: string[] = [];

  for (const s of manifest.seededSeries ?? []) {
    if (typeof s.pythFeedId !== "string" || !BYTES32_HEX.test(s.pythFeedId)) continue;
    if (typeof s.seriesId !== "string" || !BYTES32_HEX.test(s.seriesId)) continue;
    if (typeof s.tenorId !== "string" || s.tenorId.length === 0) continue;
    const symbol = typeof s.symbol === "string" && s.symbol.length > 0 ? s.symbol : "Market";

    let entry = bySymbol.get(symbol);
    if (entry === undefined) {
      entry = { symbol, feedId: s.pythFeedId, seriesIdByTenor: {} };
      bySymbol.set(symbol, entry);
      order.push(symbol);
    }
    entry.seriesIdByTenor[s.tenorId] = s.seriesId;
  }

  return order.map((symbol) => bySymbol.get(symbol)!);
}

/**
 * Whether the manifest's settlement token is the demo's own mock (a
 * MockERC20 scripts/deploy.ts minted itself, whose `mint()` is public)
 * rather than a real token like USDC. This is the ONE thing that should gate
 * every mint/faucet affordance in the UI (see FaucetPanel.tsx, PoolPanel.tsx,
 * TradeTicket.tsx) — minting only makes sense against a token this
 * deployment created; offered against a real settlement token it's nonsense
 * at best and a support incident at worst.
 *
 * Defaults to true (mock) when `settlement` is absent: every manifest this
 * repo has ever produced without the field was in fact a mock deployment
 * (the field is new, not retroactive), so defaulting to "show the faucet"
 * preserves existing behaviour for those manifests rather than hiding a
 * legitimate mock faucet because a still-valid older manifest hasn't been
 * regenerated. The only value that hides it is an explicit `false`.
 */
export function isMockSettlement(manifest: DeploymentManifest): boolean {
  return manifest.settlement?.isMock !== false;
}

export type DeploymentState =
  | { status: "loading" }
  | { status: "not-deployed"; reason: string }
  | { status: "error"; message: string }
  | { status: "ready"; manifest: DeploymentManifest };

// Per chain, resolved from the build's VITE_CHAIN (see chain.ts). A shared
// manifest would have one deployment serving the other chain's addresses.
const MANIFEST_URL = `/deployments/${MANIFEST_FILE}`;

/** Runtime shape check — never trust a static import or a fetched payload blindly. */
function isValidManifest(value: unknown): value is DeploymentManifest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.chainId !== "number") return false;
  if (typeof v.contracts !== "object" || v.contracts === null) return false;
  const c = v.contracts as Record<string, unknown>;
  return (
    typeof c.mockUSDC === "string" &&
    isAddress(c.mockUSDC) &&
    typeof c.tendSeriesFactory === "string" &&
    isAddress(c.tendSeriesFactory) &&
    typeof c.tendPoolVault === "string" &&
    isAddress(c.tendPoolVault)
  );
}

function hasZeroAddress(manifest: DeploymentManifest): boolean {
  return (
    isAddressEqual(manifest.contracts.mockUSDC, zeroAddress) ||
    isAddressEqual(manifest.contracts.tendSeriesFactory, zeroAddress) ||
    isAddressEqual(manifest.contracts.tendPoolVault, zeroAddress)
  );
}

/**
 * Fetches this build's deployment manifest from /deployments/
 * (copied there from the repo-root deployments/ dir by
 * scripts/sync-deployment.mjs before dev/build). Never throws — every
 * failure mode (404, malformed JSON, zero addresses) resolves to a
 * "not-deployed" or "error" state instead of crashing the app.
 */
export async function loadDeploymentManifest(): Promise<DeploymentState> {
  let response: Response;
  try {
    response = await fetch(MANIFEST_URL, { cache: "no-store" });
  } catch (error) {
    return { status: "error", message: `Network error fetching deployment manifest: ${String(error)}` };
  }

  if (response.status === 404) {
    return { status: "not-deployed", reason: "No deployment manifest found for Monad testnet yet." };
  }
  if (!response.ok) {
    return { status: "error", message: `Unexpected response fetching deployment manifest: HTTP ${response.status}` };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return { status: "error", message: `Deployment manifest is not valid JSON: ${String(error)}` };
  }

  if (!isValidManifest(payload)) {
    return { status: "error", message: "Deployment manifest is malformed (missing or invalid contract addresses)." };
  }

  if (hasZeroAddress(payload)) {
    return { status: "not-deployed", reason: "Deployment manifest lists a zero address — contracts are not live." };
  }

  return { status: "ready", manifest: payload };
}

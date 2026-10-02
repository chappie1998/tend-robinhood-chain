// Previews the exact binary tiers for one series without signing anything.
// The signed quote calls the same strike engine; this only omits the premium,
// capacity clamp, nonce, and signature.
import { formatUnits, type Hex, type PublicClient } from "viem";
import { fetchDemoSpotPrice } from "../market-data/coinbase.js";
import { normalizePythPrice } from "../scripts/lib/e2e/hermes.js";
import { FACTORY_ABI } from "./abi.js";
import { httpError } from "./derive.js";
import { MAKER_EDGE_BPS, realizedVolatility, VolatilityUnavailableError } from "./pricing.js";
import { strikeLadder } from "./strikeLadder.js";

const PRICE_SCALE = 100_000_000; // 1e8, the contract's scale
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

const SERIES_ID_RE = /^0x[0-9a-fA-F]{64}$/;

export interface LadderPreviewTile {
  index: number;
  strike: string;
  strikeOffsetFraction: number;
  /** Exact winning payout multiple for this binary tier. */
  multiple: number;
  probabilityItm: number;
  /** For a binary ticket, profit probability equals win probability. */
  probabilityProfit: number;
}

export interface LadderPreviewPayload {
  seriesId: Hex;
  direction: "up" | "down";
  spot: number;
  impliedVolatility: number;
  timeToExpiryHours: number;
  tiles: LadderPreviewTile[];
}

export async function deriveStrikeLadder(params: {
  publicClient: PublicClient;
  factory: Hex;
  body: unknown;
}): Promise<{ status: number; json: LadderPreviewPayload }> {
  const b = (params.body ?? {}) as Record<string, unknown>;
  const seriesId = b.seriesId;
  if (typeof seriesId !== "string" || !SERIES_ID_RE.test(seriesId)) {
    throw httpError(400, "`seriesId` must be a 32-byte 0x-prefixed hex string.");
  }
  const direction = b.direction === "down" ? "down" : "up";
  if (b.direction !== undefined && b.direction !== "up" && b.direction !== "down") {
    throw httpError(400, '`direction` must be "up" or "down".');
  }

  const series = (await params.publicClient.readContract({
    address: params.factory,
    abi: FACTORY_ABI,
    functionName: "getSeries",
    args: [seriesId as Hex],
  })) as { pythFeedId: Hex; expiry: bigint };

  const now = BigInt(Math.floor(Date.now() / 1000));
  if (series.expiry <= now) throw httpError(409, `Series ${seriesId} has already expired.`);

  const [spot, volAnnual] = await Promise.all([
    fetchDemoSpotPrice(series.pythFeedId),
    realizedVolatility(series.pythFeedId).catch((err: unknown) => {
      const message = err instanceof VolatilityUnavailableError ? err.message : String(err);
      throw httpError(502, `Could not price this series: ${message}`);
    }),
  ]);
  const normalizedSpot = normalizePythPrice(spot.price, spot.expo);
  if (normalizedSpot <= 0n) throw httpError(502, "Coinbase returned a non-positive spot price.");

  const spotHuman = Number(normalizedSpot) / PRICE_SCALE;
  const timeYears = Number(series.expiry - now) / SECONDS_PER_YEAR;

  let tiles;
  try {
    tiles = strikeLadder({ direction, spot: spotHuman, volAnnual, timeYears, makerEdgeBps: MAKER_EDGE_BPS, priceScale: PRICE_SCALE });
  } catch (err) {
    throw httpError(502, `Could not derive a conservative binary strike: ${err instanceof Error ? err.message : String(err)}`);
  }

  return {
    status: 200,
    json: {
      seriesId: seriesId as Hex,
      direction,
      spot: spotHuman,
      impliedVolatility: volAnnual,
      timeToExpiryHours: timeYears * SECONDS_PER_YEAR / 3600,
      tiles: tiles.map((tile) => ({
        index: tile.index,
        strike: formatUnits(tile.strikeRaw, 8),
        strikeOffsetFraction: tile.strikeOffsetFraction,
        multiple: tile.multiple,
        probabilityItm: tile.probabilityItm,
        probabilityProfit: tile.probabilityProfit,
      })),
    },
  };
}

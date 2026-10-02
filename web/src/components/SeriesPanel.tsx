import { useNowSeconds } from "../hooks/useNowSeconds";
import type { Address } from "viem";
import { useChainReads } from "../hooks/useChainReads";
import { tendPoolVaultAbi } from "../abis";
import { EXPLORER_URL, monadTestnet } from "../chain";
import { fillabilityOf } from "../hooks/useSeriesDetail";
import { useSeriesList, type SeriesSummary } from "../hooks/useSeriesList";
import { bytes32ToUtf8, shortenAddress } from "../lib/format";
import { CopyableValue } from "./CopyableValue";
import { ExpiryCountdown } from "./ExpiryCountdown";

/**
 * The "Markets" dock tab: every series the factory has created recently
 * (plus the seeded ones, always pinned), not just the seeded BTC/ETH pair the
 * market selector shows. Selecting a row here (or the selector above) sets the
 * SAME active-series state at the App level, which is what actually drives
 * the trade ticket — this panel no longer owns or renders a ticket itself.
 *
 * The Pyth feed id and settlement token — developer/verification output, not
 * something a trader scans a table for — sit behind a per-row `<details>`
 * disclosure instead of two always-visible hash columns, so the primary row
 * is symbol, expiry, tradability and the trade action.
 */
export function SeriesPanel({
  factoryAddress,
  vaultAddress,
  pinnedSeriesIds,
  selectedSeriesId,
  onSelectSeries,
}: {
  factoryAddress: Address;
  vaultAddress: Address;
  pinnedSeriesIds?: readonly `0x${string}`[];
  /** The series id the ticket column currently targets, so the matching row can be highlighted. */
  selectedSeriesId?: `0x${string}`;
  /** Sets the active series at the App level — the row's "Trade" button, not a local toggle. */
  onSelectSeries: (series: SeriesSummary) => void;
}) {
  const { data, isLoading, isError, errors, scanTruncated } = useSeriesList(factoryAddress, pinnedSeriesIds);

  const seriesIds = data?.map((series) => series.seriesId) ?? [];

  // Live per-series pool authorization ([enabled, lastTradeAt]) — dynamic
  // (guardian can disable, cutoff is time-based), so it's read fresh here
  // rather than derived from the creation log.
  const authRead = useChainReads({
    contracts:
      seriesIds.length > 0
        ? seriesIds.map(
            (id) =>
              ({
                address: vaultAddress,
                abi: tendPoolVaultAbi,
                chainId: monadTestnet.id,
                functionName: "seriesAuth",
                args: [id],
              }) as const,
          )
        : [],
    allowFailure: true,
    query: { enabled: seriesIds.length > 0 },
  });

  const nowSec = BigInt(useNowSeconds(10_000));

  return (
    <div className="dock-panel">
      <div className="dock-panel__subhead">
        <a
          className="link"
          href={`${EXPLORER_URL}/address/${factoryAddress}`}
          target="_blank"
          rel="noreferrer"
        >
          Factory {shortenAddress(factoryAddress)}
        </a>
      </div>

      {isLoading && <p className="hint">Loading series (scanning SeriesCreated logs)…</p>}

      {isError && <p className="error-text">RPC error reading series logs: {errors[0] ?? "unknown error"}</p>}

      {!isLoading && data && data.length === 0 && (
        <p className="hint">No series found in the recent scan window. Anyone can permissionlessly create one via createSeries.</p>
      )}

      {scanTruncated && (
        <p className="hint">
          Note: the RPC limits log queries to a recent block window, so series created further back may not be
          listed here yet.
        </p>
      )}

      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Expiry</th>
                <th>Tradable</th>
                <th>Details</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.map((series, index) => {
                const authEntry = authRead.data?.[index];
                const auth = authEntry?.status === "success" ? (authEntry.result as readonly [boolean, bigint]) : undefined;
                const { fillable, reason } = fillabilityOf(series, auth, nowSec);
                const isActive = series.seriesId === selectedSeriesId;
                return (
                  <tr key={series.seriesId} className={isActive ? "table__row--active" : undefined}>
                    <td>
                      {bytes32ToUtf8(series.symbol)}
                      {series.seeded && (
                        <span className="badge badge--network" style={{ marginLeft: 6 }} title="Canonical seeded demo series from the deployment manifest">
                          seeded
                        </span>
                      )}
                    </td>
                    <td>
                      <ExpiryCountdown expiry={series.expiry} tickMs={30_000} />
                    </td>
                    <td>
                      {series.isTradable === undefined ? (
                        "—"
                      ) : series.isTradable ? (
                        <span className="badge badge--ok">tradable</span>
                      ) : (
                        <span className="badge badge--off">not tradable</span>
                      )}
                    </td>
                    <td>
                      {/* Pyth feed id and settlement token are verification
                          detail, not something a trader scans for — one click
                          away rather than two permanent hash columns. */}
                      <details className="row-details">
                        <summary>feed / token</summary>
                        <div className="row-details__body">
                          <div className="kv-row">
                            <span className="kv-row__label">Pyth feed</span>
                            <span className="kv-row__value">
                              <CopyableValue value={series.pythFeedId} />
                            </span>
                          </div>
                          <div className="kv-row">
                            <span className="kv-row__label">Settlement token</span>
                            <span className="kv-row__value">
                              <CopyableValue value={series.settlementToken} />
                            </span>
                          </div>
                        </div>
                      </details>
                    </td>
                    <td>
                      <button
                        className="button button--sm"
                        disabled={!fillable}
                        title={reason}
                        onClick={() => onSelectSeries(series)}
                      >
                        {isActive ? "Trading" : "Trade"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

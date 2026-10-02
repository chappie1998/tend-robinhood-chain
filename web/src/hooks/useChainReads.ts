import { useReadContracts } from "wagmi";

/**
 * `useReadContracts` with multicall chunking DISABLED, for every on-chain read
 * in this app. Use this instead of wagmi's `useReadContracts` directly.
 *
 * WHY THIS EXISTS
 *
 * viem chunks a multicall into several smaller multicalls once the encoded
 * calldata exceeds `batchSize` (default 1024 bytes) — and it issues those
 * chunks CONCURRENTLY. Monad's public RPC rate-limits that burst, so the
 * chunks come back as failures.
 *
 * Measured against https://testnet-rpc.monad.xyz on 2026-08-16, 106 reads:
 *
 *   batchSize 1024 (viem default) -> ~26 parallel requests ->  28/106 ok
 *   batchSize  512                -> even more parallelism ->   8/106 ok
 *   batchSize    0 (one request)  ->  1 request            -> 106/106 ok
 *
 * Smaller chunks make it strictly WORSE. One unchunked multicall is a single
 * HTTP request and succeeds完全.
 *
 * WHY IT MATTERS SO MUCH HERE
 *
 * Every call site passes `allowFailure: true`, so a rate-limited chunk is not
 * an error — it is a `status: "failure"` entry that the caller reads as
 * "this data does not exist". The symptom is never a stack trace; it is the
 * UI quietly rendering an empty or wrong state:
 *
 *   - useLiveSeries found no series and fell back to the stale manifest, so
 *     the header read "expired" while the chain had tradable series.
 *   - usePoolState read no liquidity, so the ticket showed "NO LIQ" and the
 *     Pool tab rendered blank — against a vault holding 100,150 mUSDC.
 *
 * Both shipped to production before anyone opened the page on a desktop.
 *
 * >>> Do NOT add a bare `useReadContracts` elsewhere in this app, and do not
 * >>> re-enable chunking without re-measuring against the RPC actually in
 * >>> use. If a future RPC caps single-multicall size instead, the fix is a
 * >>> SEQUENTIAL (not concurrent) chunker, not viem's parallel one.
 */
export const useChainReads: typeof useReadContracts = ((params: Parameters<typeof useReadContracts>[0]) =>
  useReadContracts({ ...params, batchSize: 0 })) as typeof useReadContracts;

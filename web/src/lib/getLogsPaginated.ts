// Monad testnet's public RPC (https://testnet-rpc.monad.xyz) rejects
// eth_getLogs calls spanning more than 100 blocks ("eth_getLogs is limited to
// a 100 range" — confirmed empirically), and the chain is already tens of
// millions of blocks in, so a naive `fromBlock: 0n` scan (as you'd write
// against a slow L1) is not just slow here, it's flatly rejected by the RPC
// and would require ~500k sequential requests to reach genesis regardless.
//
// For this read-path slice we instead scan backward from the latest block in
// bounded 100-block windows, capped to a recent lookback window. That's
// sufficient to find series/positions created recently (which is the only
// case that exists pre-mainnet), but it is a real limitation: a series
// created further back than the lookback window will not show up. A later
// slice should either track each factory/vault's deployment block (so the
// scan has a real floor instead of a heuristic one) or read from an indexer.
const RPC_LOG_RANGE_LIMIT = 100n;
const DEFAULT_LOOKBACK_BLOCKS = 3_000n;

export interface PaginatedLogsResult<T> {
  logs: T[];
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  /** True if the lookback window was hit before reaching block 0 — i.e. older logs may exist but weren't scanned. */
  truncated: boolean;
}

/**
 * Calls `fetchChunk(fromBlock, toBlock)` repeatedly over bounded windows
 * from `latestBlock` backward to `latestBlock - lookbackBlocks` (or block 0,
 * whichever is higher), respecting the RPC's 100-block range limit.
 * Sequential, not parallel — deliberately gentle on the public RPC.
 */
export async function getLogsPaginated<T>(
  fetchChunk: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  latestBlock: bigint,
  lookbackBlocks: bigint = DEFAULT_LOOKBACK_BLOCKS,
): Promise<PaginatedLogsResult<T>> {
  const floor = latestBlock > lookbackBlocks ? latestBlock - lookbackBlocks : 0n;
  const truncated = floor > 0n;

  const results: T[] = [];
  let to = latestBlock;
  while (to >= floor) {
    const windowFloor = to - RPC_LOG_RANGE_LIMIT + 1n;
    const from = windowFloor > floor ? windowFloor : floor;
    const chunk = await fetchChunk(from, to);
    results.push(...chunk);
    if (from === floor) break;
    to = from - 1n;
  }

  return { logs: results, scannedFromBlock: floor, scannedToBlock: latestBlock, truncated };
}

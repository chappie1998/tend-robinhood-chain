import type { Hex } from "viem";

/**
 * Maps a filled position's id to the tx hash that created it, so the trade
 * history table can link each row to its own transaction.
 *
 * `Position` (contracts/TendPoolVault.sol) carries no tx hash, and a log
 * scan can't recover one after the fact either — Monad testnet's public RPC
 * caps eth_getLogs to 100-block windows, bounding any log-based lookback to
 * roughly the last 25 minutes (see getLogsPaginated.ts). So the hash is
 * captured once, at the moment a fill actually confirms (TradeTicket.tsx),
 * and never reconstructed later. A position filled before this shipped, or
 * from a different browser/device, simply has no stored hash — the panel
 * must render that honestly rather than fabricate one.
 *
 * Every access is wrapped in try/catch: this machine has hit "device out of
 * storage" before, and a failed localStorage write must never break the
 * trade that just succeeded on-chain, nor the panel reading it back.
 */
const STORAGE_KEY_PREFIX = "tend:fillTx:";

function storageKey(positionId: bigint): string {
  return `${STORAGE_KEY_PREFIX}${positionId.toString()}`;
}

/** Records the tx hash that filled `positionId`. Silently a no-op if storage is unavailable or full. */
export function recordFillTxHash(positionId: bigint, txHash: Hex): void {
  try {
    window.localStorage.setItem(storageKey(positionId), txHash);
  } catch {
    // Storage full/denied/unavailable. The fill itself already succeeded
    // on-chain — losing this one row's tx-hash link is a cosmetic gap, not
    // a reason to disturb the trade flow.
  }
}

/** The tx hash that filled `positionId`, if this browser recorded one. Undefined otherwise — never fabricated. */
export function getFillTxHash(positionId: bigint): Hex | undefined {
  try {
    const value = window.localStorage.getItem(storageKey(positionId));
    return value && value.startsWith("0x") ? (value as Hex) : undefined;
  } catch {
    return undefined;
  }
}

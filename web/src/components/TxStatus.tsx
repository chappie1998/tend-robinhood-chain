import { EXPLORER_URL } from "../chain";
import type { WriteAction } from "../hooks/useWriteAction";

const EXPLORER_TX = `${EXPLORER_URL}/tx`;

/**
 * Inline status line for a write action: pending signature, confirming, or a
 * link to the confirmed tx on the explorer. Errors are rendered by the caller
 * (which usually also wants the simulate error), so this stays purely about
 * the send/confirm lifecycle.
 */
export function TxStatus({ action, confirmedLabel = "Confirmed" }: { action: WriteAction; confirmedLabel?: string }) {
  if (action.error) return null;

  if (action.isSigning) return <span className="hint">Confirm in your wallet…</span>;

  if (action.hash && action.isConfirming) {
    return (
      <span className="hint">
        Confirming…{" "}
        <a className="link" href={`${EXPLORER_TX}/${action.hash}`} target="_blank" rel="noreferrer">
          view tx
        </a>
      </span>
    );
  }

  if (action.hash && action.isConfirmed) {
    return (
      <span className="hint">
        {confirmedLabel}{" "}
        <a className="link" href={`${EXPLORER_TX}/${action.hash}`} target="_blank" rel="noreferrer">
          view tx
        </a>
      </span>
    );
  }

  return null;
}

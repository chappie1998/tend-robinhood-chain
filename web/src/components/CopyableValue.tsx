import { useState } from "react";
import { shortenAddress } from "../lib/format";

/**
 * A truncated hash/address that copies its full value to the clipboard on
 * click. The full value is always available on hover via `title` (same as
 * the plain shortenAddress+title pattern used everywhere else in this app),
 * so this is purely additive — nothing regresses if the Clipboard API is
 * unavailable (e.g. an insecure context), it just silently does nothing.
 */
export function CopyableValue({ value, display }: { value: string; display?: string }) {
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard denied or unavailable — the title attribute still lets the
      // value be selected/copied manually, so this is not worth surfacing.
    }
  }

  return (
    <button type="button" className="copyable" title={value} onClick={handleCopy}>
      {display ?? shortenAddress(value)}
      {copied && <span className="copyable__flash">Copied</span>}
    </button>
  );
}

import type { Address } from "viem";
import { useReadContract } from "wagmi";
import { tendPoolVaultAbi } from "../abis";
import { monadTestnet } from "../chain";

/**
 * Whether the vault this app is pointed at can buy a position back before
 * expiry (TendPoolVault.closePosition).
 *
 * Feature-detected rather than assumed, because the two facts move
 * independently: this build can ship before the vault that supports it is
 * deployed, and a manifest can point at either. `CLOSE_QUOTE_TYPEHASH` is a
 * constant that exists only on a vault carrying the close path, so the read
 * succeeding IS the capability.
 *
 * Everything that claims a position can (or cannot) be sold early reads this,
 * so the app never offers an action the chain would reject — and never tells a
 * trader a position is locked to expiry when it isn't.
 */
export function useEarlyExitSupport(vaultAddress: Address | undefined): { supported: boolean | undefined } {
  const read = useReadContract({
    address: vaultAddress,
    abi: tendPoolVaultAbi,
    chainId: monadTestnet.id,
    functionName: "CLOSE_QUOTE_TYPEHASH",
    query: {
      enabled: Boolean(vaultAddress),
      // A deployment does not change under us; don't re-ask on every mount.
      staleTime: Infinity,
      retry: false,
    },
  });

  // Undefined while the read is in flight: callers must not render either
  // claim until it resolves.
  if (read.isPending) return { supported: undefined };
  return { supported: !read.isError && read.data !== undefined };
}

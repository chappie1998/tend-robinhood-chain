import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { monadTestnet } from "../chain";
import { toUserMessage } from "../lib/errors";

/**
 * Thin wrapper over the standard wagmi write lifecycle
 * (useWriteContract -> useWaitForTransactionReceipt), shared by every write
 * flow in the app so each caller only deals with useSimulateContract + a
 * button. On confirmation it invalidates all react-query caches so freshly
 * changed on-chain state (pool totals, positions, balances, allowances) is
 * refetched — the reads in this app are all keyed by wagmi/react-query, and a
 * broad invalidate is the honest, race-free way to reflect a state change we
 * know just landed.
 *
 * Receipts are pinned to Monad testnet's chainId so the wait doesn't follow a
 * wallet that's connected to some other chain.
 *
 * The return type is inferred (exported as WriteAction) rather than annotated,
 * so the exact wagmi `writeContract` mutate type flows through to callers
 * unchanged.
 */
export function useWriteAction() {
  const queryClient = useQueryClient();
  const { writeContract, data: hash, isPending: isSigning, error: writeError, reset } = useWriteContract();

  const {
    data: receipt,
    isLoading: isConfirming,
    isSuccess: isConfirmed,
    error: waitError,
  } = useWaitForTransactionReceipt({ hash, chainId: monadTestnet.id });

  useEffect(() => {
    if (isConfirmed) {
      void queryClient.invalidateQueries();
    }
  }, [isConfirmed, queryClient]);

  const rawError = writeError ?? waitError;

  return {
    writeContract,
    hash,
    /** Wallet is open / signing. */
    isSigning,
    /** Tx sent, waiting for a receipt. */
    isConfirming,
    /** Receipt received and status === success. */
    isConfirmed,
    receipt,
    error: rawError ? toUserMessage(rawError) : undefined,
    reset,
  };
}

export type WriteAction = ReturnType<typeof useWriteAction>;

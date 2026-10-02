import { useQuery } from "@tanstack/react-query";
import { useAccount, useBalance, usePublicClient } from "wagmi";
import { monadTestnet } from "../chain";

/**
 * Monad debits `gasLimit * maxFeePerGas` UP FRONT, before a transaction is
 * even simulated — so an underfunded sender isn't rejected with a normal
 * "insufficient funds" message, it's rejected pre-submission and surfaces
 * through viem as a revert with an EMPTY reason string. That reads exactly
 * like a contract bug, not a funding problem (see scripts/keeper-monad.ts's
 * own gas preflight, which hit this for real on 2026-08-05: the keeper sat
 * at 0.0186 MON against a ~0.024 MON call and every run failed pointing at
 * the contract, not the balance).
 *
 * This hook is the same preflight, ported client-side: read the wallet's
 * live MON balance and the network's live gas price, and let callers refuse
 * to even attempt a write when the balance can't cover one — so the tester
 * sees "you need testnet MON" before ever hitting the wallet, instead of a
 * baffling empty revert after signing.
 *
 * GAS_BUDGET_PER_WRITE is a generous ceiling for the heaviest single write
 * in this app (fillPoolQuote), sized the same way scripts/keeper-monad.ts
 * sizes its own preflight (measured on-chain gas + 50% headroom for
 * gas-price movement) rather than guessed.
 */
const GAS_BUDGET_PER_WRITE = 300_000n;
const HEADROOM_NUMERATOR = 3n;
const HEADROOM_DENOMINATOR = 2n;

/** How often the live gas price is refreshed — it moves slowly enough that a snappier poll would just be extra RPC load. */
const GAS_PRICE_REFRESH_MS = 30_000;

export interface GasPreflight {
  /** The connected wallet's live MON balance, or undefined until known (no account, or still loading). */
  balanceWei: bigint | undefined;
  /** What one write is estimated to cost upfront at the current gas price, or undefined until the gas price is known. */
  neededWei: bigint | undefined;
  /**
   * True only once BOTH balance and neededWei are known and the balance
   * covers it. Never true while still loading — callers that gate a button
   * on this should treat "unknown" the same as "don't block", since a false
   * positive here (blocking someone who actually has gas) is worse than
   * letting a genuinely-underfunded submission fail once.
   */
  hasGas: boolean;
  /** True while either the balance or the gas price is still being fetched for a connected account. */
  isLoading: boolean;
}

/**
 * Gas preflight for the connected wallet on Monad testnet. Reads
 * `eth_getBalance` (wagmi's `useBalance` — a plain JSON-RPC call, not a
 * multicall, so this does not need to route through `useChainReads`) and
 * `eth_gasPrice`, and combines them into a single "can this wallet even
 * afford to send one more write" signal.
 */
export function useGasPreflight(): GasPreflight {
  const { address: account, chainId } = useAccount();
  const onMonad = chainId === monadTestnet.id;
  const publicClient = usePublicClient({ chainId: monadTestnet.id });

  const balanceQuery = useBalance({
    address: account,
    chainId: monadTestnet.id,
    query: { enabled: Boolean(account) && onMonad },
  });

  const gasPriceQuery = useQuery({
    queryKey: ["monad-gas-price"],
    queryFn: () => publicClient!.getGasPrice(),
    enabled: Boolean(publicClient) && Boolean(account) && onMonad,
    staleTime: GAS_PRICE_REFRESH_MS,
    refetchInterval: GAS_PRICE_REFRESH_MS,
  });

  const balanceWei = balanceQuery.data?.value;
  const gasPrice = gasPriceQuery.data;
  const neededWei = gasPrice !== undefined ? (GAS_BUDGET_PER_WRITE * gasPrice * HEADROOM_NUMERATOR) / HEADROOM_DENOMINATOR : undefined;

  return {
    balanceWei,
    neededWei,
    hasGas: balanceWei !== undefined && neededWei !== undefined && balanceWei >= neededWei,
    isLoading: Boolean(account) && onMonad && (balanceQuery.isPending || gasPriceQuery.isPending),
  };
}

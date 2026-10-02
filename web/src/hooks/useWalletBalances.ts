import type { Address } from "viem";
import { useAccount, useBalance, useReadContract } from "wagmi";
import { mockErc20Abi } from "../abis";
import { monadTestnet } from "../chain";

export interface WalletBalances {
  /** Settlement token (mUSDC) balance, raw smallest-unit — undefined until the account and the read both resolve. */
  musdcRaw: bigint | undefined;
  /** Native MON balance, raw wei — the same `eth_getBalance` read useGasPreflight.ts uses for its own gas check, surfaced here for display instead of a pass/fail gate. */
  monRaw: bigint | undefined;
  isLoading: boolean;
}

/**
 * The connected wallet's two balances that matter anywhere in this app: the
 * settlement asset (mUSDC — for trading and LPing) and native MON (for gas).
 * Same primitives FaucetPanel.tsx (`balanceOf`) and useGasPreflight.ts
 * (`useBalance`) already use, just exposed as their own hook for
 * PortfolioView's account summary row, which needs both at once and isn't
 * mounted anywhere either of those call sites lives.
 */
export function useWalletBalances(tokenAddress: Address | undefined): WalletBalances {
  const { address: account } = useAccount();

  const musdcRead = useReadContract({
    address: tokenAddress,
    abi: mockErc20Abi,
    chainId: monadTestnet.id,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(tokenAddress && account) },
  });

  const monRead = useBalance({
    address: account,
    chainId: monadTestnet.id,
    query: { enabled: Boolean(account) },
  });

  return {
    musdcRaw: musdcRead.data,
    monRaw: monRead.data?.value,
    isLoading: Boolean(account) && (musdcRead.isLoading || monRead.isLoading),
  };
}

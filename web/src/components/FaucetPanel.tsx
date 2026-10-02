import { type Address, parseUnits } from "viem";
import { useAccount, useReadContract, useSimulateContract } from "wagmi";
import { mockErc20Abi } from "../abis";
import { GAS_FAUCET_URL, GAS_TOKEN, monadTestnet } from "../chain";
import { useGasPreflight } from "../hooks/useGasPreflight";
import { useWriteAction } from "../hooks/useWriteAction";
import { toUserMessage } from "../lib/errors";
import { formatTokenAmount } from "../lib/format";
import { TxStatus } from "./TxStatus";

const FAUCET_HUMAN_AMOUNT = "10000";

/**
 * mUSDC faucet, folded into a compact inline control (balance + a single
 * mint button) rather than its own full-width panel — this app is a trading
 * demo, not a faucet, and the faucet shouldn't outrank the pool it funds.
 * Meant to be embedded beside another panel's content (see PoolPanel), not
 * rendered as a standalone section.
 *
 * The mock token's `mint` is public, so anyone can top up their own test
 * balance. On confirmation, useWriteAction invalidates the query caches so
 * the balance (and the pool/positions reads that depend on it) refresh
 * automatically.
 */
export function FaucetPanel({ tokenAddress }: { tokenAddress: Address }) {
  const { address: account, isConnected, chainId } = useAccount();
  const wrongNetwork = isConnected && chainId !== monadTestnet.id;

  const token = { address: tokenAddress, abi: mockErc20Abi, chainId: monadTestnet.id } as const;

  const decimalsRead = useReadContract({ ...token, functionName: "decimals" });
  const decimals = decimalsRead.data ?? 6;

  const balanceRead = useReadContract({
    ...token,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) },
  });

  const mintAmount = parseUnits(FAUCET_HUMAN_AMOUNT, decimals);

  const simulate = useSimulateContract({
    ...token,
    functionName: "mint",
    args: account ? [account, mintAmount] : undefined,
    query: { enabled: Boolean(account) && !wrongNetwork },
  });

  const action = useWriteAction();

  // Monad debits gasLimit * maxFeePerGas UPFRONT — minting is usually the
  // very FIRST on-chain action a new tester takes, so it's the first place
  // an empty wallet would hit the empty-revert wall described in
  // useGasPreflight's header comment. Checked here rather than trusting the
  // simulate error alone: eth_call-based simulation doesn't reliably surface
  // "your account can't actually afford to send this."
  const gas = useGasPreflight();
  const gasKnownInsufficient = gas.balanceWei !== undefined && !gas.hasGas;

  if (!isConnected) {
    return <span className="faucet-inline hint">Connect a wallet to mint test mUSDC.</span>;
  }

  return (
    <span className="faucet-inline">
      <span className="faucet-inline__balance">
        {balanceRead.data !== undefined ? `${formatTokenAmount(balanceRead.data, decimals)} mUSDC` : "—"}
      </span>
      <button
        className="button button--sm"
        disabled={wrongNetwork || gasKnownInsufficient || !simulate.data || action.isSigning || action.isConfirming}
        onClick={() => simulate.data && action.writeContract(simulate.data.request)}
        title="Mint 10,000 test mUSDC — the mock token's mint() is public"
      >
        {action.isSigning || action.isConfirming ? "Minting…" : `+${Number(FAUCET_HUMAN_AMOUNT).toLocaleString()} mUSDC`}
      </button>
      <TxStatus action={action} confirmedLabel="Minted." />
      {wrongNetwork && <span className="hint">Switch network to mint.</span>}
      {!wrongNetwork && gasKnownInsufficient && (
        <span className="error-text">
          Need testnet {GAS_TOKEN} for gas first
          {GAS_FAUCET_URL ? (
            <>
              {" — "}
              <a className="link" href={GAS_FAUCET_URL} target="_blank" rel="noreferrer">
                get some here
              </a>
              .
            </>
          ) : (
            "."
          )}
        </span>
      )}
      {!wrongNetwork && !gasKnownInsufficient && simulate.error && (
        <span className="error-text">{toUserMessage(simulate.error)}</span>
      )}
      {action.error && <span className="error-text">{action.error}</span>}
    </span>
  );
}

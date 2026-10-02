import { useState } from "react";
import { type Address, formatUnits, parseUnits } from "viem";
import { useAccount, useReadContract, useSimulateContract } from "wagmi";
import { mockErc20Abi, tendPoolVaultAbi } from "../abis";
import { CHAIN_LABEL, monadTestnet } from "../chain";
import type { PoolState } from "../hooks/usePoolState";
import { useWriteAction } from "../hooks/useWriteAction";
import { toUserMessage } from "../lib/errors";
import { formatInt, formatTokenAmount } from "../lib/format";
import { TxStatus } from "./TxStatus";

type Mode = "deposit" | "withdraw";

/** Basis-point slippage presets, matching the 0.5% default the task calls for. */
const SLIPPAGE_OPTIONS = ["10", "50", "100", "200"] as const; // bps: 0.1%, 0.5%, 1%, 2%
const DEFAULT_SLIPPAGE_BPS: (typeof SLIPPAGE_OPTIONS)[number] = "50";
const BPS_DENOMINATOR = 10_000n;

/** How far out `deadline` is set from "now" at the moment the form was last touched. */
const DEADLINE_SECONDS = 300;

/** Parses a human decimal string into raw base units, or undefined if empty/invalid/zero. Never throws. */
function tryParseUnits(input: string, decimals: number): bigint | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const value = parseUnits(trimmed, decimals);
    return value > 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * LP deposit/withdraw form: amount input, a live shares-out/assets-out
 * preview from the vault's own `calculate*` pure views, a slippage tolerance
 * that derives `minSharesOut`/`minAmountOut`, and the same approve-then-act
 * pattern as TradeTicket for deposit's ERC20 transfer. Every write is
 * simulate-gated (fail-closed) exactly like the rest of the app.
 *
 * Both `deposit` and `withdraw` revert `PoolHasOpenPositions` while the pool
 * has any open position or locked collateral (contracts/TendPoolVault.sol) —
 * that gate gets its own visible banner here, not just a disabled button,
 * per the "don't just grey out silently" requirement.
 */
export function LiquidityForm({
  vaultAddress,
  tokenAddress,
  pool,
}: {
  vaultAddress: Address;
  tokenAddress: Address;
  pool: PoolState;
}) {
  const { address: account, isConnected, chainId } = useAccount();
  const wrongNetwork = isConnected && chainId !== monadTestnet.id;

  const [mode, setMode] = useState<Mode>("deposit");
  const [amountInput, setAmountInput] = useState("");
  const [slippageBps, setSlippageBps] = useState<(typeof SLIPPAGE_OPTIONS)[number]>(DEFAULT_SLIPPAGE_BPS);
  const [deadline, setDeadline] = useState<bigint>(() => BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS));

  function refreshDeadline() {
    setDeadline(BigInt(Math.floor(Date.now() / 1000) + DEADLINE_SECONDS));
  }

  const decimals = pool.assetDecimals;
  const gated = pool.openPositions !== 0n || pool.lockedCollateral !== 0n;
  const connectedShares = pool.connectedSharesOf;

  const vault = { address: vaultAddress, abi: tendPoolVaultAbi, chainId: monadTestnet.id } as const;
  const token = { address: tokenAddress, abi: mockErc20Abi, chainId: monadTestnet.id } as const;

  // The connected wallet's current shares, valued in the settlement asset via
  // the vault's own withdraw-preview math — "what would withdrawing all of it
  // yield right now", not a fabricated conversion rate.
  const shareValueRead = useReadContract({
    ...vault,
    functionName: "calculateWithdrawAmount",
    args: connectedShares !== undefined ? [connectedShares, pool.totalShares, pool.totalAssets] : undefined,
    query: { enabled: Boolean(connectedShares !== undefined && connectedShares > 0n) },
  });

  function switchMode(next: Mode) {
    refreshDeadline();
    setMode(next);
    setAmountInput("");
  }

  // ---- Deposit -----------------------------------------------------------

  const depositAmountRaw = tryParseUnits(amountInput, decimals);

  const depositSharesPreview = useReadContract({
    ...vault,
    functionName: "calculateDepositShares",
    args: depositAmountRaw !== undefined ? [depositAmountRaw, pool.totalShares, pool.totalAssets] : undefined,
    query: { enabled: mode === "deposit" && depositAmountRaw !== undefined },
  });

  const minSharesOut =
    depositSharesPreview.data !== undefined
      ? (depositSharesPreview.data * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR
      : undefined;

  const allowanceRead = useReadContract({
    ...token,
    functionName: "allowance",
    args: account ? [account, vaultAddress] : undefined,
    query: { enabled: Boolean(account) },
  });
  const balanceRead = useReadContract({
    ...token,
    functionName: "balanceOf",
    args: account ? [account] : undefined,
    query: { enabled: Boolean(account) },
  });

  const needsApprove =
    depositAmountRaw !== undefined && allowanceRead.data !== undefined
      ? allowanceRead.data < depositAmountRaw
      : depositAmountRaw !== undefined;
  const insufficientBalance =
    depositAmountRaw !== undefined && balanceRead.data !== undefined ? balanceRead.data < depositAmountRaw : false;

  const approveSim = useSimulateContract({
    ...token,
    functionName: "approve",
    args: depositAmountRaw !== undefined ? [vaultAddress, depositAmountRaw] : undefined,
    query: {
      enabled: Boolean(
        mode === "deposit" && depositAmountRaw !== undefined && needsApprove && account && !wrongNetwork && !gated,
      ),
    },
  });
  const approveAction = useWriteAction();

  const depositSim = useSimulateContract({
    ...vault,
    functionName: "deposit",
    args:
      depositAmountRaw !== undefined && minSharesOut !== undefined
        ? [depositAmountRaw, minSharesOut, deadline]
        : undefined,
    query: {
      enabled: Boolean(
        mode === "deposit" &&
          depositAmountRaw !== undefined &&
          minSharesOut !== undefined &&
          !needsApprove &&
          !insufficientBalance &&
          !gated &&
          account &&
          !wrongNetwork,
      ),
    },
  });
  const depositAction = useWriteAction();

  // ---- Withdraw ------------------------------------------------------------

  const sharesRaw = tryParseUnits(amountInput, decimals);
  const insufficientShares = sharesRaw !== undefined && connectedShares !== undefined ? sharesRaw > connectedShares : false;

  const withdrawPreview = useReadContract({
    ...vault,
    functionName: "calculateWithdrawAmount",
    args: sharesRaw !== undefined ? [sharesRaw, pool.totalShares, pool.totalAssets] : undefined,
    query: { enabled: mode === "withdraw" && sharesRaw !== undefined && sharesRaw <= pool.totalShares },
  });

  const minAmountOut =
    withdrawPreview.data !== undefined
      ? (withdrawPreview.data * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR
      : undefined;

  const withdrawSim = useSimulateContract({
    ...vault,
    functionName: "withdraw",
    args: sharesRaw !== undefined && minAmountOut !== undefined ? [sharesRaw, minAmountOut, deadline] : undefined,
    query: {
      enabled: Boolean(
        mode === "withdraw" &&
          sharesRaw !== undefined &&
          minAmountOut !== undefined &&
          !insufficientShares &&
          !gated &&
          account &&
          !wrongNetwork,
      ),
    },
  });
  const withdrawAction = useWriteAction();

  const assetLabel = pool.assetSymbol;

  return (
    <div className="liquidity-form">
      <div className="toggle-group" role="group" aria-label="Liquidity action">
        <button className={`button ${mode === "deposit" ? "" : "button--ghost"}`} onClick={() => switchMode("deposit")}>
          Deposit
        </button>
        <button className={`button ${mode === "withdraw" ? "" : "button--ghost"}`} onClick={() => switchMode("withdraw")}>
          Withdraw
        </button>
      </div>

      <div className="kv-list">
        <div className="kv-row">
          <span className="kv-row__label">Your shares</span>
          <span className="kv-row__value">{connectedShares !== undefined ? formatTokenAmount(connectedShares, decimals) : "—"}</span>
        </div>
        <div className="kv-row">
          <span className="kv-row__label">Value</span>
          <span className="kv-row__value">
            {connectedShares === undefined
              ? "—"
              : connectedShares === 0n
                ? `0 ${assetLabel}`
                : shareValueRead.data !== undefined
                  ? `~${formatTokenAmount(shareValueRead.data, decimals)} ${assetLabel}`
                  : "…"}
          </span>
        </div>
      </div>

      {gated && (
        <p className="error-text">
          Deposits and withdrawals are paused: the pool has {formatInt(pool.openPositions)} open position(s) and{" "}
          {formatTokenAmount(pool.lockedCollateral, decimals)} {assetLabel} locked as collateral. The vault reverts
          with <code>PoolHasOpenPositions()</code> until every position is settled or refunded.
        </p>
      )}

      {!isConnected && <p className="hint">Connect a wallet to provide or withdraw liquidity.</p>}
      {wrongNetwork && <p className="error-text">Switch to {CHAIN_LABEL} to continue.</p>}

      <div className="ticket__inputs">
        <label className="ticket__field">
          <span className="stat__label">{mode === "deposit" ? `Amount (${assetLabel})` : "Shares to withdraw"}</span>
          <input
            className="select"
            type="text"
            inputMode="decimal"
            placeholder="0.0"
            value={amountInput}
            onChange={(event) => { refreshDeadline(); setAmountInput(event.target.value); }}
          />
        </label>

        {mode === "withdraw" && connectedShares !== undefined && connectedShares > 0n && (
          <button
            type="button"
            className="button button--ghost button--sm"
            onClick={() => setAmountInput(formatUnits(connectedShares, decimals))}
          >
            Max
          </button>
        )}

        <label className="ticket__field">
          <span className="stat__label">Slippage tolerance</span>
          <select
            className="select"
            value={slippageBps}
            onChange={(event) => { refreshDeadline(); setSlippageBps(event.target.value as (typeof SLIPPAGE_OPTIONS)[number]); }}
          >
            {SLIPPAGE_OPTIONS.map((bps) => (
              <option key={bps} value={bps}>
                {(Number(bps) / 100).toFixed(1)}%
              </option>
            ))}
          </select>
        </label>
      </div>

      {mode === "deposit" ? (
        <>
          <div className="kv-list">
            <div className="kv-row">
              <span className="kv-row__label">Estimated shares out</span>
              <span className="kv-row__value">
                {depositAmountRaw === undefined
                  ? "—"
                  : depositSharesPreview.data !== undefined
                    ? formatTokenAmount(depositSharesPreview.data, decimals)
                    : depositSharesPreview.error
                      ? "unavailable"
                      : "…"}
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-row__label">Minimum shares out</span>
              <span className="kv-row__value">{minSharesOut !== undefined ? formatTokenAmount(minSharesOut, decimals) : "—"}</span>
            </div>
          </div>

          {depositSharesPreview.error && (
            <p className="error-text">Cannot preview deposit: {toUserMessage(depositSharesPreview.error)}</p>
          )}

          {insufficientBalance && (
            <p className="error-text">Your {assetLabel} balance is below the amount entered.</p>
          )}

          {needsApprove && !insufficientBalance && !gated && (
            <div className="action-row">
              <button
                className="button"
                disabled={!approveSim.data || approveAction.isSigning || approveAction.isConfirming}
                onClick={() => approveSim.data && approveAction.writeContract(approveSim.data.request)}
              >
                {approveAction.isSigning || approveAction.isConfirming ? "Approving…" : `Approve ${assetLabel}`}
              </button>
              <TxStatus action={approveAction} confirmedLabel="Approved." />
              {approveSim.error && <span className="error-text">Cannot approve: {toUserMessage(approveSim.error)}</span>}
              {approveAction.error && <span className="error-text">{approveAction.error}</span>}
            </div>
          )}

          {!needsApprove && !insufficientBalance && !gated && (
            <div className="action-row">
              <button
                className="button button--primary"
                disabled={!depositSim.data || depositAction.isSigning || depositAction.isConfirming}
                onClick={() => depositSim.data && depositAction.writeContract(depositSim.data.request)}
              >
                {depositAction.isSigning || depositAction.isConfirming ? "Depositing…" : "Deposit liquidity"}
              </button>
              <TxStatus action={depositAction} confirmedLabel="Deposited." />
              {depositSim.error && <span className="error-text">Cannot deposit: {toUserMessage(depositSim.error)}</span>}
              {depositAction.error && <span className="error-text">{depositAction.error}</span>}
            </div>
          )}
        </>
      ) : (
        <>
          <div className="kv-list">
            <div className="kv-row">
              <span className="kv-row__label">Estimated {assetLabel} out</span>
              <span className="kv-row__value">
                {sharesRaw === undefined
                  ? "—"
                  : withdrawPreview.data !== undefined
                    ? formatTokenAmount(withdrawPreview.data, decimals)
                    : withdrawPreview.error
                      ? "unavailable"
                      : "…"}
              </span>
            </div>
            <div className="kv-row">
              <span className="kv-row__label">Minimum {assetLabel} out</span>
              <span className="kv-row__value">
                {minAmountOut !== undefined ? formatTokenAmount(minAmountOut, decimals) : "—"}
              </span>
            </div>
          </div>

          {withdrawPreview.error && (
            <p className="error-text">Cannot preview withdrawal: {toUserMessage(withdrawPreview.error)}</p>
          )}

          {insufficientShares && <p className="error-text">You only hold {formatTokenAmount(connectedShares ?? 0n, decimals)} shares.</p>}

          {!insufficientShares && !gated && (
            <div className="action-row">
              <button
                className="button button--primary"
                disabled={!withdrawSim.data || withdrawAction.isSigning || withdrawAction.isConfirming}
                onClick={() => withdrawSim.data && withdrawAction.writeContract(withdrawSim.data.request)}
              >
                {withdrawAction.isSigning || withdrawAction.isConfirming ? "Withdrawing…" : "Withdraw liquidity"}
              </button>
              <TxStatus action={withdrawAction} confirmedLabel="Withdrawn." />
              {withdrawSim.error && <span className="error-text">Cannot withdraw: {toUserMessage(withdrawSim.error)}</span>}
              {withdrawAction.error && <span className="error-text">{withdrawAction.error}</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

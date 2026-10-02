import type { Address } from "viem";
import { useAccount,  } from "wagmi";
import { useChainReads } from "./useChainReads";
import { tendPoolVaultAbi, mockErc20Abi } from "../abis";
import { monadTestnet } from "../chain";
import { toUserMessage } from "../lib/errors";

export interface PoolState {
  asset: Address;
  manager: Address;
  quoteAuthority: Address;
  totalAssets: bigint;
  totalShares: bigint;
  lockedCollateral: bigint;
  openPositions: bigint;
  maxUtilizationBps: number;
  maxPositionBps: number;
  feeBps: number;
  assetSymbol: string;
  assetDecimals: number;
  connectedSharesOf: bigint | undefined;
}

export interface PoolStateQuery {
  data: PoolState | undefined;
  isLoading: boolean;
  isError: boolean;
  errors: string[];
}

/** Pulls a successful result out of a wagmi multicall entry, else undefined. */
function unwrap<T>(entry: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined): T | undefined {
  return entry?.status === "success" ? entry.result : undefined;
}

/**
 * Reads all of TendPoolVault's public state via multicall (Monad testnet has
 * the standard Multicall3 deployment at 0xcA11bde0..., confirmed reachable by
 * `eth_getCode`), then a dependent read for the settlement asset's
 * symbol/decimals, then the connected wallet's sharesOf if a wallet is
 * connected. Reads are pinned to Monad testnet's chainId regardless of which
 * chain the connected wallet is currently on.
 */
export function usePoolState(vaultAddress: Address | undefined): PoolStateQuery {
  const { address: account } = useAccount();

  const vaultContract = vaultAddress
    ? ({ address: vaultAddress, abi: tendPoolVaultAbi, chainId: monadTestnet.id } as const)
    : undefined;

  const core = useChainReads({
    contracts: vaultContract
      ? [
          { ...vaultContract, functionName: "asset" },
          { ...vaultContract, functionName: "manager" },
          { ...vaultContract, functionName: "quoteAuthority" },
          { ...vaultContract, functionName: "totalAssets" },
          { ...vaultContract, functionName: "totalShares" },
          { ...vaultContract, functionName: "lockedCollateral" },
          { ...vaultContract, functionName: "openPositions" },
          { ...vaultContract, functionName: "maxUtilizationBps" },
          { ...vaultContract, functionName: "maxPositionBps" },
          { ...vaultContract, functionName: "feeBps" },
        ]
      : [],
    allowFailure: true,
    query: { enabled: Boolean(vaultContract), refetchInterval: 15_000 },
  });

  const [assetRes, managerRes, quoteAuthorityRes, totalAssetsRes, totalSharesRes, lockedCollateralRes, openPositionsRes, maxUtilizationBpsRes, maxPositionBpsRes, feeBpsRes] =
    core.data ?? [];

  const assetAddress = unwrap<Address>(assetRes);

  const assetInfo = useChainReads({
    contracts: assetAddress
      ? [
          { address: assetAddress, abi: mockErc20Abi, functionName: "symbol", chainId: monadTestnet.id },
          { address: assetAddress, abi: mockErc20Abi, functionName: "decimals", chainId: monadTestnet.id },
        ]
      : [],
    allowFailure: true,
    query: { enabled: Boolean(assetAddress) },
  });

  const [symbolRes, decimalsRes] = assetInfo.data ?? [];

  const sharesQuery = useChainReads({
    contracts: vaultContract && account ? [{ ...vaultContract, functionName: "sharesOf", args: [account] }] : [],
    allowFailure: true,
    query: { enabled: Boolean(vaultContract && account), refetchInterval: 30_000 },
  });

  const sharesOfRes = sharesQuery.data?.[0];

  const isLoading = core.isLoading || (Boolean(assetAddress) && assetInfo.isLoading) || (Boolean(account) && sharesQuery.isLoading);

  // toUserMessage (not the raw `.message`/`String()`) — a viem RPC failure's
  // full message is a multi-paragraph dump of the request body and raw call
  // arguments (hex calldata with no whitespace), which readable-wraps fine as
  // short prose but forces the whole page hundreds of thousands of pixels
  // wide when rendered verbatim, since a run of hex digits with no spaces has
  // no wrap opportunity. Reproduced: a single failed multicall here blew the
  // page out to ~54,000px wide. shortMessage is the concise, wrap-safe form.
  const errors: string[] = [];
  for (const entry of [...(core.data ?? []), ...(assetInfo.data ?? []), ...(sharesQuery.data ?? [])]) {
    if (entry?.status === "failure") errors.push(toUserMessage(entry.error));
  }
  if (core.error) errors.push(toUserMessage(core.error));
  if (assetInfo.error) errors.push(toUserMessage(assetInfo.error));
  if (sharesQuery.error) errors.push(toUserMessage(sharesQuery.error));

  const asset = unwrap<Address>(assetRes);
  const manager = unwrap<Address>(managerRes);
  const quoteAuthority = unwrap<Address>(quoteAuthorityRes);
  const totalAssets = unwrap<bigint>(totalAssetsRes);
  const totalShares = unwrap<bigint>(totalSharesRes);
  const lockedCollateral = unwrap<bigint>(lockedCollateralRes);
  const openPositions = unwrap<bigint>(openPositionsRes);
  const maxUtilizationBps = unwrap<number>(maxUtilizationBpsRes);
  const maxPositionBps = unwrap<number>(maxPositionBpsRes);
  const feeBps = unwrap<number>(feeBpsRes);
  const assetSymbol = unwrap<string>(symbolRes);
  const assetDecimals = unwrap<number>(decimalsRes);
  const connectedSharesOf = unwrap<bigint>(sharesOfRes);

  const data: PoolState | undefined =
    asset !== undefined &&
    manager !== undefined &&
    quoteAuthority !== undefined &&
    totalAssets !== undefined &&
    totalShares !== undefined &&
    lockedCollateral !== undefined &&
    openPositions !== undefined &&
    maxUtilizationBps !== undefined &&
    maxPositionBps !== undefined &&
    feeBps !== undefined &&
    assetSymbol !== undefined &&
    assetDecimals !== undefined
      ? {
          asset,
          manager,
          quoteAuthority,
          totalAssets,
          totalShares,
          lockedCollateral,
          openPositions,
          maxUtilizationBps,
          maxPositionBps,
          feeBps,
          assetSymbol,
          assetDecimals,
          connectedSharesOf,
        }
      : undefined;

  return {
    data,
    isLoading,
    isError: errors.length > 0,
    errors,
  };
}

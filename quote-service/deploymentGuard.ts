import { getAddress, parseAbi, type PublicClient } from "viem";

export interface DeploymentIdentity {
  chainId: number;
  contracts: { tendSeriesFactory?: string; tendPoolVault?: string; mockUSDC?: string };
  pythAddress?: string;
  isProduction?: boolean;
  settlement?: { token: string; isMock: boolean };
}

const identityAbi = parseAbi([
  "function factory() view returns (address)",
  "function asset() view returns (address)",
  "function pyth() view returns (address)",
  "function quoteAuthority() view returns (address)",
]);

/** NODE_ENV=production describes hosting, not permission to accept real funds. */
export function assertRuntimeMode(mode = process.env.TEND_MODE): void {
  if (mode === undefined || mode === "demo") return;
  if (mode === "production") {
    throw new Error("Production trading is disabled: authenticated settlement and a reviewed production deployment are required.");
  }
  throw new Error("TEND_MODE must be demo or production.");
}

/** Revalidate on every request so role rotation and RPC misrouting fail closed. */
export async function verifyDeploymentIdentity(client: PublicClient, manifest: DeploymentIdentity) {
  const factory = getAddress(manifest.contracts.tendSeriesFactory ?? "");
  const vault = getAddress(manifest.contracts.tendPoolVault ?? "");
  const token = getAddress(manifest.settlement?.token ?? manifest.contracts.mockUSDC ?? "");
  const oracle = getAddress(manifest.pythAddress ?? "");
  const chainId = await client.getChainId();
  if (chainId !== manifest.chainId || (client.chain && client.chain.id !== chainId)) {
    throw new Error("RPC chain does not match the configured deployment.");
  }
  const [onchainFactory, onchainAsset, onchainOracle, authority] = await Promise.all([
    client.readContract({ address: vault, abi: identityAbi, functionName: "factory" }),
    client.readContract({ address: vault, abi: identityAbi, functionName: "asset" }),
    client.readContract({ address: factory, abi: identityAbi, functionName: "pyth" }),
    client.readContract({ address: vault, abi: identityAbi, functionName: "quoteAuthority" }),
  ]);
  if (getAddress(onchainFactory) !== factory) throw new Error("Vault factory does not match the deployment.");
  if (getAddress(onchainAsset) !== token) throw new Error("Vault asset does not match the deployment.");
  if (getAddress(onchainOracle) !== oracle) throw new Error("Factory oracle does not match the deployment.");
  return { factory, vault, token, oracle, authority: getAddress(authority) };
}

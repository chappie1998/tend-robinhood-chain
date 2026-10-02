import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256, parseAbi, type Hex } from "viem";

const factoryAbi = parseAbi(["function pyth() view returns (address)"]);
const mockArtifactUrl = new URL("../../artifacts/contracts/test/DeployableMockPyth.sol/DeployableMockPyth.json", import.meta.url);
const adminOracleArtifactUrl = new URL("../../artifacts/contracts/TendPriceOracle.sol/TendPriceOracle.json", import.meta.url);

type Address = `0x${string}`;
type RuntimeCode = `0x${string}`;

export interface OracleManifest {
  chainId: number;
  contracts: { tendSeriesFactory?: string };
  pythAddress?: string;
}

export interface OracleInventoryClient {
  chain?: { id: number };
  getChainId(): Promise<number>;
  readContract(request: { address: Address; abi: typeof factoryAbi; functionName: "pyth" }): Promise<Address>;
  getCode(request: { address: Address }): Promise<RuntimeCode | undefined>;
}

export type OracleType =
  | "exact-demo-mock-pyth"
  | "exact-admin-price-oracle"
  | "unknown-oracle-unverified"
  | "no-runtime-code"
  | "manifest-oracle-mismatch"
  | "rpc-or-wiring-failure";

export interface OracleInventory {
  expectedChainId: number;
  observedChainId?: number;
  factory?: Address;
  manifestOracle?: Address;
  factoryOracle?: Address;
  runtimeCodeHash?: Hex;
  localMockRuntimeCodeHash: Hex;
  oracleType: OracleType;
  wiringVerified: boolean;
  authenticatedSettlementVerified: false;
}

/** The local artifact is required only to identify an exact demo MockPyth match. */
export class LocalMockPythArtifactError extends Error {
  constructor() {
    super("Local DeployableMockPyth runtime artifact is unavailable. Run `npx hardhat compile` before readiness checks.");
    this.name = "LocalMockPythArtifactError";
  }
}

function asRuntimeCode(value: unknown): RuntimeCode {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]*$/.test(value)) {
    throw new Error("Local MockPyth artifact has invalid runtime bytecode.");
  }
  return value as RuntimeCode;
}

/** TendPriceOracle's local runtime code, or undefined if it has not been compiled. */
export async function loadLocalAdminOracleRuntimeCode(artifactUrl = adminOracleArtifactUrl): Promise<RuntimeCode | undefined> {
  try {
    const artifact = JSON.parse(await readFile(fileURLToPath(artifactUrl), "utf8")) as { deployedBytecode?: unknown };
    return asRuntimeCode(artifact.deployedBytecode);
  } catch {
    return undefined;
  }
}

/** Reads the local compiled artifact; it is evidence, never a claim about an arbitrary deployed oracle. */
export async function loadLocalMockPythRuntimeCode(artifactUrl = mockArtifactUrl): Promise<RuntimeCode> {
  let source: string;
  try {
    source = await readFile(fileURLToPath(artifactUrl), "utf8");
  } catch {
    throw new LocalMockPythArtifactError();
  }
  let artifact: unknown;
  try {
    artifact = JSON.parse(source);
  } catch {
    throw new LocalMockPythArtifactError();
  }
  if (typeof artifact !== "object" || artifact === null || !("deployedBytecode" in artifact)) {
    throw new LocalMockPythArtifactError();
  }
  try {
    return asRuntimeCode(artifact.deployedBytecode);
  } catch {
    throw new LocalMockPythArtifactError();
  }
}

export function runtimeCodeHash(runtimeCode: RuntimeCode): Hex {
  return keccak256(runtimeCode);
}

/**
 * Inspects immutable factory wiring and the oracle's runtime code without making
 * any chain writes. A non-mock runtime remains unverified: bytecode alone does
 * not prove it authenticates price attestations.
 */
export async function inspectOracle(
  client: OracleInventoryClient,
  manifest: OracleManifest,
  localMockRuntimeCode: RuntimeCode,
  localAdminOracleRuntimeCode?: RuntimeCode,
): Promise<OracleInventory> {
  const localMockRuntimeCodeHash = runtimeCodeHash(localMockRuntimeCode);
  try {
    const factory = getAddress(manifest.contracts.tendSeriesFactory ?? "");
    const manifestOracle = getAddress(manifest.pythAddress ?? "");
    const [observedChainId, factoryOracle] = await Promise.all([
      client.getChainId(),
      client.readContract({ address: factory, abi: factoryAbi, functionName: "pyth" }).then(getAddress),
    ]);
    const runtimeCode = await client.getCode({ address: factoryOracle });
    const deployedRuntimeCodeHash = runtimeCode && runtimeCode !== "0x" ? runtimeCodeHash(runtimeCode) : undefined;
    const chainMatches = observedChainId === manifest.chainId && (client.chain?.id === undefined || client.chain.id === observedChainId);
    const wiringVerified = chainMatches && factoryOracle === manifestOracle;

    if (!wiringVerified) {
      return {
        expectedChainId: manifest.chainId, observedChainId, factory, manifestOracle, factoryOracle,
        runtimeCodeHash: deployedRuntimeCodeHash, localMockRuntimeCodeHash, oracleType: "manifest-oracle-mismatch",
        wiringVerified: false, authenticatedSettlementVerified: false,
      };
    }
    if (!deployedRuntimeCodeHash) {
      return {
        expectedChainId: manifest.chainId, observedChainId, factory, manifestOracle, factoryOracle,
        localMockRuntimeCodeHash, oracleType: "no-runtime-code", wiringVerified: true,
        authenticatedSettlementVerified: false,
      };
    }
    return {
      expectedChainId: manifest.chainId, observedChainId, factory, manifestOracle, factoryOracle,
      runtimeCodeHash: deployedRuntimeCodeHash, localMockRuntimeCodeHash,
      oracleType: deployedRuntimeCodeHash === localMockRuntimeCodeHash
        ? "exact-demo-mock-pyth"
        : localAdminOracleRuntimeCode !== undefined && deployedRuntimeCodeHash === runtimeCodeHash(localAdminOracleRuntimeCode)
          ? "exact-admin-price-oracle"
          : "unknown-oracle-unverified",
      wiringVerified: true, authenticatedSettlementVerified: false,
    };
  } catch {
    return {
      expectedChainId: manifest.chainId, localMockRuntimeCodeHash,
      oracleType: "rpc-or-wiring-failure", wiringVerified: false, authenticatedSettlementVerified: false,
    };
  }
}

// Persists (and reuses) a fresh EOA used as the "buyer" throughout the
// Monad e2e proof. The key is generated once and cached at
// .devnet/monad-e2e-buyer.json (chmod 0600, gitignored) so re-running the
// script doesn't mint a brand-new wallet — and require re-funding it — every
// single time.
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Hex, createWalletClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { monadTestnetChain } from "./chain.js";
import { MONAD_TESTNET } from "../../../config/monad.js";

const BUYER_KEY_PATH = path.join(process.cwd(), ".devnet", "monad-e2e-buyer.json");

interface PersistedBuyer {
  address: Hex;
  privateKey: Hex;
}

export interface BuyerWallet {
  address: Hex;
  walletClient: ReturnType<typeof createWalletClient>;
  keyPath: string;
  reused: boolean;
}

/// Loads the buyer key from disk if present, otherwise generates a fresh one
/// and persists it with 0600 permissions. The private key is never logged.
export async function loadOrCreateBuyerWallet(): Promise<BuyerWallet> {
  let persisted: PersistedBuyer | undefined;
  try {
    const raw = await readFile(BUYER_KEY_PATH, "utf8");
    persisted = JSON.parse(raw) as PersistedBuyer;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const reused = persisted !== undefined;

  if (persisted === undefined) {
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    persisted = { address: account.address, privateKey };
    await mkdir(path.dirname(BUYER_KEY_PATH), { recursive: true });
    await writeFile(BUYER_KEY_PATH, `${JSON.stringify(persisted, null, 2)}\n`, { mode: 0o600 });
  }

  // Re-assert 0600 unconditionally: writeFile's mode option only applies at
  // creation, and a pre-existing file (or a restrictive umask elsewhere)
  // could otherwise leave it more permissive than intended.
  await chmod(BUYER_KEY_PATH, 0o600);

  const account = privateKeyToAccount(persisted.privateKey);
  const walletClient = createWalletClient({
    account,
    chain: monadTestnetChain,
    transport: http(MONAD_TESTNET.rpcUrl),
  });

  return { address: persisted.address, walletClient, keyPath: BUYER_KEY_PATH, reused };
}

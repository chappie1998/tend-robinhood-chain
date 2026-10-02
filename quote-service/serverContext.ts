// Shared, freshly validated signer/address context for the serverless quote endpoints.
//
// Both /api/quote and /api/close-quote need the same three things: the
// quoteAuthority signer, the factory address and the vault address — plus the
// same per-request assertion that the key we hold really is the pool's
// quoteAuthority. Building that twice invites the two endpoints to drift apart
// on the exact check that decides whether a signature will be honoured
// on-chain, so it is built once here.
//
// The private key (QUOTE_AUTHORITY_KEY) is supplied at deploy time as an
// environment variable — never committed, never logged.
import { type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { ACTIVE_MANIFEST } from "../config/activeChain.js";
import { assertRuntimeMode, verifyDeploymentIdentity } from "./deploymentGuard.js";
import { normalizePrivateKey } from "./derive.js";

export interface QuoteContext {
  account: PrivateKeyAccount;
  factory: Hex;
  vault: Hex;
}

export interface ManifestContracts {
  tendSeriesFactory?: string;
  tendPoolVault?: string;
}

// Recheck chain, immutable wiring and authority before every signature.
export async function getQuoteContext(publicClient: PublicClient, contracts: ManifestContracts): Promise<QuoteContext> {
  assertRuntimeMode();
  const account = privateKeyToAccount(normalizePrivateKey(process.env.QUOTE_AUTHORITY_KEY, "QUOTE_AUTHORITY_KEY"));
  const { factory, vault, authority } = await verifyDeploymentIdentity(publicClient, {
    ...ACTIVE_MANIFEST,
    contracts: { ...ACTIVE_MANIFEST.contracts, ...contracts },
  });
  if (authority !== account.address) throw new Error("Signer does not match the pool's quoteAuthority.");
  return { account, factory, vault };
}

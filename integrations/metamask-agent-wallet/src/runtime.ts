import { InputFieldType, type CommandIO, type InputSchema, schemaToArgs, schemaToFlags } from "@metamask/agent-wallet/plugin";
import { getAddress, isAddressEqual, type Address, type Hex, type PublicClient } from "viem";
import { CHAIN_ID, MAX_POSITION_SCAN, VAULT } from "./config.js";
import { vaultAbi } from "./abi.js";

export { schemaToArgs, schemaToFlags };
export const text = (flag: string, message: string, required = true, index?: number) => ({ type: InputFieldType.Text, flag, message, required, prompt: false, ...(index === undefined ? {} : { index }) }) as const;
export const commonApiInput = { apiOrigin: text("api-origin", "Tend API origin (default: https://monad.usetend.xyz)", false) } satisfies InputSchema;

export function selectedAddress(state: unknown): Address {
  type Ref = { id: string } | { address: string } | { name: string };
  type Wallet = { id?: string; address: string; name?: string };
  const s = state as { selectedWallet?: { ref: Ref }; byokWallets: Wallet[]; remoteWallets: Wallet[] };
  if (!s.selectedWallet) throw new Error("Select an EVM wallet before using Tend.");
  const ref = s.selectedWallet.ref;
  if ("address" in ref) return getAddress(ref.address);
  const wallets = [...s.byokWallets, ...s.remoteWallets];
  const wallet = "id" in ref ? wallets.find((w) => w.id === ref.id) : wallets.find((w) => w.name === ref.name);
  if (!wallet) throw new Error("Selected EVM wallet address is unavailable.");
  return getAddress(wallet.address);
}

export interface PositionView { id: bigint; buyer: Address; seriesId: Hex; direction: number; strike: bigint; width: bigint; premium: bigint; maxPayout: bigint; feeBps: number; settled: boolean; closed: boolean; closeBid: bigint }
export async function readPosition(client: PublicClient, id: bigint): Promise<PositionView> {
  const p = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "positions", args: [id] });
  return { id, buyer: p[0], seriesId: p[1], direction: p[2], strike: p[3], width: p[4], premium: p[5], maxPayout: p[6], feeBps: p[7], settled: p[8], closed: p[9], closeBid: p[10] };
}
export async function walletPositions(client: PublicClient, buyer: Address): Promise<{ positions: PositionView[]; scanTruncated: boolean; scanned: number }> {
  const next = await client.readContract({ address: VAULT, abi: vaultAbi, functionName: "nextPositionId" });
  const start = next > MAX_POSITION_SCAN ? next - MAX_POSITION_SCAN : 1n;
  const ids: bigint[] = []; for (let id = start; id < next; id += 1n) ids.push(id);
  const rows = await client.multicall({ allowFailure: true, contracts: ids.map((id) => ({ address: VAULT, abi: vaultAbi, functionName: "positions" as const, args: [id] })) });
  const positions = rows.flatMap((row, index) => {
    if (row.status !== "success") return [];
    const p = row.result;
    return isAddressEqual(p[0], buyer) ? [{ id: ids[index], buyer: p[0], seriesId: p[1], direction: p[2], strike: p[3], width: p[4], premium: p[5], maxPayout: p[6], feeBps: p[7], settled: p[8], closed: p[9], closeBid: p[10] }] : [];
  });
  return { positions, scanTruncated: next > MAX_POSITION_SCAN + 1n, scanned: ids.length };
}
export function clientFrom(ctx: { publicClient(chainId: number): PublicClient }): PublicClient { return ctx.publicClient(CHAIN_ID); }
export function transaction(to: Address, data: Hex) { return { to, data, value: "0x0" as Hex }; }
export function resolved<T extends InputSchema>(io: CommandIO, schema: T) { return io.resolveInputs(schema); }

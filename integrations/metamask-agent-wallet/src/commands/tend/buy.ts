import { type CommandIO, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import { type Hex } from "viem";
import { erc20Abi, vaultAbi } from "../../abi.js";
import { CHAIN_ID, SETTLEMENT_TOKEN, VAULT } from "../../config.js";
import { approveData, buyData, requestQuote } from "../../core.js";
import { clientFrom, commonApiInput, resolved, schemaToArgs, schemaToFlags, selectedAddress, text, transaction } from "../../runtime.js";

const inputs = { seriesId: text("series-id", "Tend series id", true, 0), direction: text("direction", "up or down", true, 1), premium: text("premium", "Premium in mUSDC (max 100)", true, 2), tile: text("tile", "Strike tile 0, 1, or 2", true, 3), ...commonApiInput } satisfies InputSchema;
export default class TendBuy extends PluginCommand<unknown> {
  static override description = "Buy a bounded Tend position through MetaMask policy-gated submission.";
  static override flags = schemaToFlags(inputs); static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "tend:buy";
  async execute(io: CommandIO) {
    const i = await resolved(io, inputs); const buyer = selectedAddress(this.ctx.walletStateManager.read());
    if (i.direction !== "up" && i.direction !== "down") throw new Error("direction must be up or down.");
    const direction: "up" | "down" = i.direction;
    const tile = Number(i.tile); if (![0, 1, 2].includes(tile)) throw new Error("tile must be 0, 1, or 2.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(i.seriesId)) throw new Error("series-id must be 32-byte hex.");
    const request = { seriesId: i.seriesId as Hex, direction, premium: i.premium, tile, buyer, origin: i.apiOrigin };
    let signed = await requestQuote(request);
    const client = clientFrom(this.ctx);
    const allowance = await client.readContract({ address: SETTLEMENT_TOKEN, abi: erc20Abi, functionName: "allowance", args: [buyer, VAULT] });
    const execute = await this.ctx.walletExecutor(io, this.pluginCommandId);
    let approval;
    if (allowance < signed.quote.premium) {
      approval = await execute({ kind: "transaction", chainId: CHAIN_ID, transaction: transaction(SETTLEMENT_TOKEN, approveData(signed.quote.premium)) }, { waitForReceipt: true });
      signed = await requestQuote(request);
      const refreshedAllowance = await client.readContract({ address: SETTLEMENT_TOKEN, abi: erc20Abi, functionName: "allowance", args: [buyer, VAULT] });
      if (refreshedAllowance < signed.quote.premium) throw new Error("Refreshed quote exceeds the approved premium; request a new trade instead of broadening approval.");
    }
    await client.simulateContract({ address: VAULT, abi: vaultAbi, functionName: "fillPoolQuote", args: [signed.quote, signed.signature], account: buyer });
    const fill = await execute({ kind: "transaction", chainId: CHAIN_ID, transaction: transaction(VAULT, buyData(signed)) });
    return { quote: signed, approval, fill };
  }
}

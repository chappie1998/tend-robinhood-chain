import { type CommandIO, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import { CHAIN_ID, VAULT } from "../../config.js";
import { vaultAbi } from "../../abi.js";
import { closeData, requestCloseQuote } from "../../core.js";
import { clientFrom, commonApiInput, readPosition, resolved, schemaToArgs, schemaToFlags, selectedAddress, text, transaction } from "../../runtime.js";

const inputs = { positionId: text("position-id", "Positive Tend position id", true, 0), ...commonApiInput } satisfies InputSchema;
export default class TendClose extends PluginCommand<unknown> {
  static override description = "Close an open Tend position through MetaMask policy-gated submission.";
  static override flags = schemaToFlags(inputs); static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "tend:close";
  async execute(io: CommandIO) {
    const i = await resolved(io, inputs); if (!/^\d+$/.test(i.positionId) || i.positionId === "0") throw new Error("position-id must be a positive integer.");
    const positionId = BigInt(i.positionId); const seller = selectedAddress(this.ctx.walletStateManager.read());
    const position = await readPosition(clientFrom(this.ctx), positionId);
    if (position.buyer !== seller) throw new Error("Position does not belong to the selected wallet.");
    if (position.settled || position.closed) throw new Error("Position is already closed, settled, or refunded.");
    const signed = await requestCloseQuote({ positionId, seller, maxPayout: position.maxPayout, origin: i.apiOrigin });
    await clientFrom(this.ctx).simulateContract({ address: VAULT, abi: vaultAbi, functionName: "closePosition", args: [signed.quote, signed.signature], account: seller });
    const execute = await this.ctx.walletExecutor(io, this.pluginCommandId);
    const close = await execute({ kind: "transaction", chainId: CHAIN_ID, transaction: transaction(VAULT, closeData(signed)) });
    return { quote: signed, close };
  }
}

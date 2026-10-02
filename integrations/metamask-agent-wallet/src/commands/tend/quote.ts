import { type CommandIO, type InputSchema, PluginCommand } from "@metamask/agent-wallet/plugin";
import { type Hex } from "viem";
import { requestQuote } from "../../core.js";
import { commonApiInput, resolved, schemaToArgs, schemaToFlags, selectedAddress, text } from "../../runtime.js";

const inputs = { seriesId: text("series-id", "Tend series id", true, 0), direction: text("direction", "up or down", true, 1), premium: text("premium", "Premium in mUSDC", true, 2), tile: text("tile", "Strike tile 0, 1, or 2", true, 3), ...commonApiInput } satisfies InputSchema;
export default class TendQuote extends PluginCommand<unknown> {
  static override description = "Request a bounded, wallet-specific Tend quote without submitting a transaction.";
  static override flags = schemaToFlags(inputs); static override args = schemaToArgs(inputs);
  protected readonly pluginCommandId = "tend:quote";
  async execute(io: CommandIO) {
    const i = await resolved(io, inputs); const buyer = selectedAddress(this.ctx.walletStateManager.read());
    if (i.direction !== "up" && i.direction !== "down") throw new Error("direction must be up or down.");
    const tile = Number(i.tile); if (![0, 1, 2].includes(tile)) throw new Error("tile must be 0, 1, or 2.");
    if (!/^0x[0-9a-fA-F]{64}$/.test(i.seriesId)) throw new Error("series-id must be 32-byte hex.");
    return requestQuote({ seriesId: i.seriesId as Hex, direction: i.direction, premium: i.premium, tile, buyer, origin: i.apiOrigin });
  }
}

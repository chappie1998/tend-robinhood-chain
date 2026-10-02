import { PluginCommand } from "@metamask/agent-wallet/plugin";
import { clientFrom, selectedAddress, walletPositions } from "../../runtime.js";

export default class TendPositions extends PluginCommand<unknown> {
  static override description = "List the selected wallet's recent Tend positions (bounded to 250 ids).";
  protected readonly pluginCommandId = "tend:positions";
  async execute() {
    const buyer = selectedAddress(this.ctx.walletStateManager.read());
    const result = await walletPositions(clientFrom(this.ctx), buyer);
    return { buyer, chainId: 10_143, scanLimit: 250, scanTruncated: result.scanTruncated, scanned: result.scanned, positions: result.positions.map((p) => ({ ...p, id: p.id.toString(), strike: p.strike.toString(), width: p.width.toString(), premium: p.premium.toString(), maxPayout: p.maxPayout.toString(), closeBid: p.closeBid.toString(), direction: p.direction === 0 ? "up" : "down" })) };
  }
}

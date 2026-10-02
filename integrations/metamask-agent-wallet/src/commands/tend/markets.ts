import { PluginCommand } from "@metamask/agent-wallet/plugin";
import { assertDeployment } from "../../core.js";
import { discoverMarkets } from "../../markets.js";
import { clientFrom } from "../../runtime.js";

export default class TendMarkets extends PluginCommand<{ chainId: number; testnet: true; markets: unknown[] }> {
  static override description = "List Tend markets configured for Monad testnet.";
  protected readonly pluginCommandId = "tend:markets";
  async execute() {
    const client = clientFrom(this.ctx);
    await assertDeployment(client);
    const markets = await discoverMarkets(client);
    return { chainId: 10_143, testnet: true as const, markets };
  }
}

import type { IncomingMessage, ServerResponse } from "node:http";
import { DATA_SOURCE, fetchDemoCandles, fetchDemoSpotPrice, productForFeed } from "../market-data/coinbase.js";

/** Public demo market data. Pyth-shaped numbers preserve the contract's price scale;
 * the source is always explicitly Coinbase, never represented as Pyth attestations.
 */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader("Content-Type", "application/json");
  if (req.method !== "GET") { res.statusCode = 405; res.end(JSON.stringify({ error: "Only GET is supported." })); return; }
  const query = new URL(req.url ?? "", "http://localhost").searchParams;
  try {
    let body: unknown;
    if (query.get("kind") === "spot") {
      const ids = [...new Set(query.getAll("ids[]"))];
      if (ids.length < 1 || ids.length > 2) throw new Error("Request one or two supported feed IDs.");
      ids.forEach(productForFeed);
      body = { source: DATA_SOURCE, settlement: "Testnet MockPyth; exchange data is not an oracle attestation", parsed: await Promise.all(ids.map(async (id) => {
        const value = await fetchDemoSpotPrice(id);
        return { id: id.replace(/^0x/, ""), price: { price: String(value.price), conf: "0", expo: value.expo, publish_time: value.publishTime } };
      })) };
      res.setHeader("Cache-Control", "public, max-age=3");
    } else if (query.get("kind") === "history") {
      const bars = await fetchDemoCandles(query.get("symbol") ?? "", query.get("resolution") ?? "60", Number(query.get("from")), Number(query.get("to")));
      body = { source: DATA_SOURCE, s: bars.length ? "ok" : "no_data", t: bars.map(b => b.time), o: bars.map(b => b.open), h: bars.map(b => b.high), l: bars.map(b => b.low), c: bars.map(b => b.close) };
      res.setHeader("Cache-Control", "public, max-age=30");
    } else { throw new Error('kind must be "spot" or "history".'); }
    res.end(JSON.stringify(body));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Market data unavailable.";
    res.statusCode = /Invalid candle|Unsupported market|Request one|kind must/.test(message) ? 400 : 502;
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ error: message, source: DATA_SOURCE }));
  }
}

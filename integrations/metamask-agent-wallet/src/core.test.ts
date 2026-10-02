import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, getAddress } from "viem";
import { vaultAbi } from "./abi.js";
import { VAULT, apiOrigin } from "./config.js";
import { buyData, parseSignedCloseQuote, parseSignedQuote } from "./core.js";

const buyer = getAddress("0x1111111111111111111111111111111111111111");
const seriesId = `0x${"22".repeat(32)}`;
const signature = `0x${"33".repeat(65)}`;
function quote(overrides: Record<string, unknown> = {}) {
  return { chainId: 10143, verifyingContract: VAULT, multiple: 2, tile: 1, signature, quote: { nonce: "1", direction: "0", strike: "100", width: "10", premium: "1000000", maxPayout: "2000000", quoteExpiry: "2000000060", seriesId, buyer, ...overrides } };
}
const intent = { seriesId: seriesId as `0x${string}`, direction: "up" as const, premium: "1", tile: 1, buyer };

describe("quote validation", () => {
  it("accepts a bounded quote and encodes the exact fill", () => {
    vi.setSystemTime(new Date(2_000_000_000_000));
    const parsed = parseSignedQuote(quote(), intent);
    const decoded = decodeFunctionData({ abi: vaultAbi, data: buyData(parsed) });
    expect(decoded.functionName).toBe("fillPoolQuote");
    expect(parsed.quote.premium).toBe(1_000_000n);
    vi.useRealTimers();
  });
  it.each([
    ["wrong chain", { chainId: 1 }],
    ["wrong vault", { verifyingContract: buyer }],
    ["large multiple", { multiple: 5, quote: { ...quote().quote, maxPayout: "5000000" } }],
    ["large premium", { quote: { ...quote().quote, premium: "100000001" } }],
  ])("rejects %s", (_label, override) => {
    vi.setSystemTime(new Date(2_000_000_000_000));
    expect(() => parseSignedQuote({ ...quote(), ...override }, intent)).toThrow();
    vi.useRealTimers();
  });
  it.each([
    ["series", { ...intent, seriesId: `0x${"44".repeat(32)}` as `0x${string}` }],
    ["direction", { ...intent, direction: "down" as const }],
    ["tile", { ...intent, tile: 2 }],
    ["premium", { ...intent, premium: "0.5" }],
  ])("rejects a response that changes requested %s", (_label, changedIntent) => {
    vi.setSystemTime(new Date(2_000_000_000_000));
    expect(() => parseSignedQuote(quote(), changedIntent)).toThrow(/match|exceeds/);
    vi.useRealTimers();
  });
  it("rejects a close bid above escrow", () => {
    vi.setSystemTime(new Date(2_000_000_000_000));
    const payload = { chainId: 10143, verifyingContract: VAULT, signature, bid: "3", quote: { nonce: "2", positionId: "7", bid: "300", quoteExpiry: "2000000060", seller: buyer } };
    expect(() => parseSignedCloseQuote(payload, buyer, 7n, 299n)).toThrow(/escrow/);
    vi.useRealTimers();
  });
});

describe("API origin validation", () => {
  it("allows HTTPS and localhost HTTP only", () => {
    expect(apiOrigin("https://example.com")).toBe("https://example.com");
    expect(apiOrigin("http://localhost:5173")).toBe("http://localhost:5173");
    expect(() => apiOrigin("http://example.com")).toThrow(/HTTPS/);
    expect(() => apiOrigin("https://user:pass@example.com")).toThrow(/bare origin/);
    expect(() => apiOrigin("https://example.com/quote")).toThrow(/bare origin/);
  });
});

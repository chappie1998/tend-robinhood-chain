import { describe, expect, it } from "vitest";
import { selectedAddress } from "./runtime.js";

describe("selectedAddress", () => {
  const address = "0x1111111111111111111111111111111111111111";
  it.each([
    { selectedWallet: { ref: { address } }, byokWallets: [], remoteWallets: [] },
    { selectedWallet: { ref: { id: "remote-1" } }, byokWallets: [], remoteWallets: [{ id: "remote-1", address }] },
    { selectedWallet: { ref: { name: "local" } }, byokWallets: [{ name: "local", address }], remoteWallets: [] },
  ])("resolves Agent Wallet 7 WalletRef forms", (state) => expect(selectedAddress(state)).toBe(address));

  it("fails closed for a missing selected ref", () => {
    expect(() => selectedAddress({ selectedWallet: { ref: { id: "missing" } }, byokWallets: [], remoteWallets: [] })).toThrow(/unavailable/);
  });
});

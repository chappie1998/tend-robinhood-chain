import { createConfig, createStorage, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { monadTestnet } from "./chain";

/**
 * Namespaced + VERSIONED wagmi storage key.
 *
 * wagmi persists the active connection to localStorage and rehydrates it on
 * load. `getConnectorClient` then calls `connection.connector.getChainId()`
 * on whatever it rehydrated — so a connection persisted by a DIFFERENT wagmi
 * version can come back as a connector object missing that method, and every
 * write path (approve, buy) dies with a bare
 * `r.connector.getChainId is not a function`. Confirmed in the wild: the
 * error surfaced only for a browser that had used an earlier build of this
 * app, while a fresh profile worked.
 *
 * Bumping the suffix invalidates that stale state: wagmi finds nothing under
 * the new key, starts clean, and the user simply reconnects. Bump it again
 * on any future wagmi major upgrade rather than asking testers to clear site
 * data by hand — most will just conclude the app is broken.
 */
const WAGMI_STORAGE_KEY = "tend-monad.wagmi.v2";

// Injected/MetaMask only — no WalletConnect for this demo slice.
// `as const` narrows the tuple to the ONE chain this build selected. Without
// it the type widens to the union of every chain chain.ts can return, and
// wagmi then demands a transport for a chain this build never talks to.
const chains = [monadTestnet] as const;

export const wagmiConfig = createConfig({
  chains,
  connectors: [injected()],
  storage: createStorage({
    key: WAGMI_STORAGE_KEY,
    // `localStorage` is read at module scope by wagmi, and is absent during
    // SSR/prerender and in privacy modes that block site data. Guarding here
    // keeps a storage-less environment from throwing before the app renders;
    // wagmi falls back to in-memory state, which just means the connection is
    // not remembered across reloads.
    storage: typeof window !== "undefined" ? window.localStorage : undefined,
  }),
  transports: {
    [monadTestnet.id]: http(monadTestnet.rpcUrls.default.http[0]),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}

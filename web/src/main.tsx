import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { WagmiProvider } from "wagmi";
import { App } from "./App";
import { wagmiConfig } from "./wagmiConfig";
import "./styles.css";

// Every read in this app (Pyth spot/chart, on-chain state, positions, pool)
// goes through react-query, and every one of those hooks already renders a
// plain-language error in the UI on failure (see usePythPrice.ts,
// usePoolState.ts, etc.) — but a tester's own browser console should never
// be silent about the underlying cause while the UI just says "unavailable".
// One global handler here logs every query failure app-wide (query key +
// error) rather than adding a console.error to each hook individually, so
// this can never be missed on a new query someone adds later.
const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => {
      console.error(`[query:${JSON.stringify(query.queryKey)}] failed:`, error);
    },
  }),
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Missing #root element in index.html");
}

createRoot(container).render(
  <StrictMode>
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </WagmiProvider>
  </StrictMode>,
);

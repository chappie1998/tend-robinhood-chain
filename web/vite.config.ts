import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { apiDevServer } from "./vite-plugin-api-dev";
import { resolve } from "node:path";
import { resolveBuildChain } from "./scripts/build-env.mjs";
import { syncDeployment } from "./scripts/sync-deployment.mjs";

// Plain client-side SPA — no SSR, no Cloudflare Workers, no RSC. It is the
// only build in this repo; the Next.js/Worker scaffold it was once kept
// separate from was removed on 2026-09-16. See README-web.md.
export default defineConfig(async ({ mode }) => {
  const chain = resolveBuildChain(mode, resolve(import.meta.dirname, ".."), import.meta.dirname);
  process.env.TEND_CHAIN = chain;
  process.env.VITE_CHAIN = chain;
  await syncDeployment(chain);
  const chainMetadata = chain === "robinhood"
    ? {
        title: "Tend — Robinhood Testnet",
        description: "Tend fixed-payout expiry trades on Robinhood Chain testnet with valueless mUSDC test assets.",
      }
    : {
        title: "Tend — Monad Testnet",
        description: "Tend fixed-payout expiry trades on Monad testnet with valueless mUSDC test assets.",
      };
  return {
  // apiDevServer mounts the repo's api/*.ts functions during `vite dev`.
  // Without it /api/* falls through to the SPA catch-all and returns
  // index.html, which the app parses as JSON — the chart and spot price then
  // show "not valid JSON" locally while production is perfectly healthy.
  plugins: [
    react(),
    apiDevServer(),
    {
      name: "tend-chain-html-metadata",
      transformIndexHtml(html: string) {
        return html
          .replace("<title>Tend</title>", `<title>${chainMetadata.title}</title>`)
          .replace('content="Tend options protocol testnet demo."', `content="${chainMetadata.description}"`);
      },
    },
  ],
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    port: 5173,
  },
  };
});

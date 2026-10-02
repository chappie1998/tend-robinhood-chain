import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/**
 * Serves the repo's `api/*.ts` functions during `vite dev`.
 *
 * Vite only builds the SPA. In production those files are deployed as Vercel
 * serverless functions, but the dev server knows nothing about them, so
 * `/api/pyth` fell through to the SPA catch-all and returned index.html —
 * which the app then tried to parse as JSON, producing
 * "Unexpected token '<', '<!doctype '... is not valid JSON" on the chart and
 * the spot price. Nothing was actually broken; local dev simply had no API,
 * and the failure looked exactly like a production outage. It cost real
 * debugging time more than once.
 *
 * The handlers are plain `(IncomingMessage, ServerResponse)` functions —
 * precisely Connect middleware's signature — so they can be mounted directly
 * rather than proxied to the deployed site. That matters: proxying would make
 * local edits to `api/*.ts` untestable, and would silently spend the
 * production Pyth quota from every dev reload.
 *
 * Loaded through Vite's own module graph (`ssrLoadModule`), so the TypeScript
 * is transformed by Vite and edits hot-reload without restarting the server.
 */
export function apiDevServer(): Plugin {
  const repoRoot = resolve(import.meta.dirname, "..");

  return {
    name: "tend:api-dev-server",
    apply: "serve",

    configureServer(server) {
      // The handlers read process.env directly (they run on Vercel in
      // production, where env vars are injected). Vite only auto-loads .env
      // from ITS root (web/), and only for VITE_-prefixed client vars, so the
      // repo-root .env holding PYTH_API_KEY has to be loaded by hand — and
      // deliberately without overriding anything already exported in the
      // shell, so `PYTH_API_KEY=... npm run dev` still wins.
      try {
        const raw = readFileSync(resolve(repoRoot, ".env"), "utf8");
        for (const line of raw.split("\n")) {
          const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
          if (!match) continue;
          const [, key, rawValue] = match;
          if (process.env[key] !== undefined) continue;
          process.env[key] = rawValue.trim().replace(/^["']|["']$/g, "");
        }
      } catch {
        // No .env is a valid state — the handlers each fail closed with their
        // own message naming the variable they need, which is more useful
        // than anything this plugin could say about it.
      }

      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/")) return next();

        // Route name only: strip the query string, and refuse anything that
        // is not a bare identifier so a crafted path cannot walk out of api/.
        const route = url.slice("/api/".length).split("?")[0].replace(/\/+$/, "");
        if (!/^[a-z0-9-]+$/i.test(route)) return next();

        try {
          const module = await server.ssrLoadModule(resolve(repoRoot, "api", `${route}.ts`));
          const handler = module.default as
            | ((req: IncomingMessage, res: ServerResponse) => Promise<void> | void)
            | undefined;
          if (typeof handler !== "function") return next();
          await handler(req, res);
        } catch (error) {
          // Surface the real reason as JSON. Falling through to next() here
          // would hand back index.html again and recreate the exact
          // "not valid JSON" confusion this plugin exists to remove.
          const message = error instanceof Error ? error.message : String(error);
          server.config.logger.error(`[api-dev] /api/${route} failed: ${message}`);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: `Local /api/${route} failed: ${message}` }));
          }
        }
      });
    },
  };
}

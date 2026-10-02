import { loadEnv } from "vite";
import { assertMatchingChains } from "../../config/chain-selection.mjs";

// Match Vite's mode-specific files and shell precedence. Only the public chain
// selector is copied into the browser environment; never expose all loaded vars.
export function resolveBuildChain(mode, repoRoot, webRoot, shell = process.env) {
  const root = loadEnv(mode, repoRoot, "");
  const web = loadEnv(mode, webRoot, "");
  return assertMatchingChains(
    shell.TEND_CHAIN ?? web.TEND_CHAIN ?? root.TEND_CHAIN,
    shell.VITE_CHAIN ?? web.VITE_CHAIN ?? root.VITE_CHAIN,
  );
}

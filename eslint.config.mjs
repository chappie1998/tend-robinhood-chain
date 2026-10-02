// Standalone lint config.
//
// This used to extend eslint-config-next, which was a leftover from a Next.js
// app that no longer exists in this repo (removed 2026-09-16 along with app/,
// db/, drizzle/ and worker/). Nothing here is a Next project: the root is
// Solidity plus Node scripts, and web/ is a Vite React SPA. Depending on
// Next's config meant carrying next, react and their toolchain as root
// dependencies purely to lint.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "artifacts/**",
    "cache/**",
    "node_modules/**",
    "web/public/**",
  ]),
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Scripts and services run on Node; the SPA runs in a browser. Without
    // this, every `process`, `console` and `window` reads as undefined.
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        AbortController: "readonly",
        DOMException: "readonly",
        window: "readonly",
        document: "readonly",
        navigator: "readonly",
        localStorage: "readonly",
        ResizeObserver: "readonly",
        HTMLElement: "readonly",
        HTMLDivElement: "readonly",
        HTMLInputElement: "readonly",
        Node: "readonly",
        PointerEvent: "readonly",
        Response: "readonly",
        Request: "readonly",
      },
    },
  },
  {
    // The SPA's hook rules. Kept deliberately: TradeTicket.tsx carries an
    // explicit `react-hooks/exhaustive-deps` disable with a comment arguing
    // why, and that directive only means something while the rule is on.
    files: ["web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.recommended.rules,
  },
]);

/// <reference types="vite/client" />

// Only the vars this app actually reads are declared; everything else on
// import.meta.env stays the Vite default (string | boolean | undefined).
interface ImportMetaEnv {
  /** Base URL of the quote-signing service. Defaults to http://localhost:8787. */
  readonly VITE_QUOTE_SERVICE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

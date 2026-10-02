/** Shared by Node, the Vite build and the browser. Unknown values fail closed. */
export function selectChain(value, name = "TEND_CHAIN") {
  if (value === undefined) return "monad";
  if (value === "monad" || value === "robinhood") return value;
  throw new Error(`${name} must be monad or robinhood.`);
}

export function assertMatchingChains(server, browser) {
  const serverChain = selectChain(server);
  const browserChain = selectChain(browser, "VITE_CHAIN");
  if (serverChain !== browserChain) throw new Error("TEND_CHAIN and VITE_CHAIN must select the same chain.");
  return browserChain;
}

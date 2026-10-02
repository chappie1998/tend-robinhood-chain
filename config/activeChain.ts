// The chain the server-side functions talk to, selected at deploy time by the
// TEND_CHAIN environment variable.
//
// One codebase, two deployments (monad.usetend.xyz and
// robinhood.usetend.xyz). Both manifests are imported STATICALLY because
// @vercel/node inlines JSON imports into the function bundle at build time —
// a dynamic path would resolve to nothing at runtime. The selection is then a
// plain constant, which also keeps the two deployments honest: a function can
// only ever reach the chain it was built for.
//
// Defaults to Monad when unset, so an existing deployment that has never heard
// of this variable keeps behaving exactly as it did.
import { MONAD_TESTNET } from "./monad.js";
import { selectChain } from "./chain-selection.mjs";
import { ROBINHOOD_TESTNET } from "./robinhood.js";
import monadManifest from "../deployments/monad-testnet.json" with { type: "json" };
import robinhoodManifest from "../deployments/robinhood-testnet.json" with { type: "json" };

const IS_ROBINHOOD = selectChain(process.env.TEND_CHAIN) === "robinhood";

export const ACTIVE_CHAIN = IS_ROBINHOOD ? ROBINHOOD_TESTNET : MONAD_TESTNET;

/** Deployment manifest for the active chain — contracts, roles, seeded series. */
export const ACTIVE_MANIFEST = IS_ROBINHOOD ? robinhoodManifest : monadManifest;

/** viem chain definition for the active chain. */
export const ACTIVE_CHAIN_KEY = IS_ROBINHOOD ? "robinhood" : "monad";

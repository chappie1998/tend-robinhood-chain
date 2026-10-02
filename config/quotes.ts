/** Shared signer TTL and browser headroom for request/confirmation latency. */
export const QUOTE_TTL_SECONDS = 30n;
export const QUOTE_SELECTION_HEADROOM_SECONDS = QUOTE_TTL_SECONDS + 15n;

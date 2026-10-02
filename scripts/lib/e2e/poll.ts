// Bounded polling helper: waits for a predicate to become true, sleeping
// between checks and logging progress, instead of busy-spinning or blocking
// forever. Used for the ~16-18 minute wait until the e2e series expires.
export async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(params: {
  description: string;
  intervalMs: number;
  timeoutMs: number;
  check: () => Promise<{ done: boolean; progress: string }>;
}): Promise<void> {
  const deadline = Date.now() + params.timeoutMs;
  // The public Monad testnet RPC intermittently drops a request ("Failed to
  // make POST request"). A transient blip during a ~16-18 minute poll must
  // not abort the whole run, so a failed `check()` is treated as a retryable
  // event: log it and keep polling until the overall timeout is reached. Only
  // if the RPC stays unreachable for the entire timeout window do we give up.
  let lastError: unknown;
  for (;;) {
    try {
      const { done, progress } = await params.check();
      lastError = undefined;
      if (done) {
        console.log(`  [wait] ${params.description}: done (${progress}).`);
        return;
      }
      console.log(`  [wait] ${params.description}: ${progress}`);
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
      console.log(`  [wait] ${params.description}: transient check error, will retry — ${message}`);
    }
    if (Date.now() >= deadline) {
      const suffix = lastError
        ? ` (last error: ${lastError instanceof Error ? lastError.message.split("\n")[0] : String(lastError)})`
        : "";
      throw new Error(
        `Timed out after ${params.timeoutMs}ms waiting for: ${params.description}${suffix}`,
      );
    }
    await sleep(params.intervalMs);
  }
}

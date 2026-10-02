#!/bin/bash
# One keeper sweep, for a local scheduler (launchd/cron) to invoke.
#
# WHY A WRAPPER: launchd gives a job almost no environment — no PATH to node,
# no working directory. Both are resolved here so the plist stays a plain
# schedule and this file owns everything about HOW the sweep runs.
#
# The sweep is idempotent: a skipped or overlapping run costs nothing but the
# reads, so a machine that was asleep simply catches up on its next run.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO" || exit 1

# Node from the user's own install (nvm, homebrew or system), since launchd's
# PATH contains none of them.
for candidate in "$HOME/.nvm/versions/node"/*/bin /opt/homebrew/bin /usr/local/bin /usr/bin; do
  if [ -x "$candidate/node" ]; then PATH="$candidate:$PATH"; fi
done
export PATH

LOG_DIR="$HOME/Library/Logs/tend-keeper"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/keeper.log"

# A kernel advisory lock has no stale-owner cleanup race: the kernel releases
# it only after the final inherited descriptor closes. Marking the descriptor
# inheritable also keeps the lock held if this shell exits while npm/node is
# still shutting down after a signal.
if [ "${TEND_KEEPER_LOCK_HELD:-}" != "1" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) keeper cannot start: python3 is required for overlap locking ===" >> "$LOG"
    exit 1
  fi
  exec python3 - "$0" "$LOG_DIR/keeper.lock" "$LOG" "$@" <<'PY'
import datetime
import fcntl
import os
import sys

script, lock_path, log_path, *args = sys.argv[1:]
lock_file = open(lock_path, "a+")
try:
    fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    with open(log_path, "a") as log:
        log.write(f"=== {stamp} keeper already running; skipping overlap ===\n")
    raise SystemExit(0)

os.set_inheritable(lock_file.fileno(), True)
environment = os.environ.copy()
environment["TEND_KEEPER_LOCK_HELD"] = "1"
os.execve(script, [script, *args], environment)
PY
fi

# Process-level lock tests stop here, before any RPC or keeper command.
if [ -n "${TEND_KEEPER_LOCK_TEST_HOLD_SECONDS:-}" ]; then
  echo "=== keeper test lock acquired ===" >> "$LOG"
  sleep "$TEND_KEEPER_LOCK_TEST_HOLD_SECONDS"
  exit 0
fi

# Keep the log from growing without bound on a machine left running.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 5000000 ]; then
  mv "$LOG" "$LOG.1"
fi

# Both testnets, in one pass. Each sweep is independent: Robinhood failing
# must not stop Monad being maintained, so the exit status is the WORST of
# the two rather than whichever ran last.
STATUS=0
for CHAIN in monad robinhood; do
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) starting $CHAIN sweep ===" >> "$LOG"
  npm run "keeper:$CHAIN" >> "$LOG" 2>&1
  RC=$?
  echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) $CHAIN finished, exit $RC ===" >> "$LOG"
  [ $RC -ne 0 ] && STATUS=$RC
done

# Surface the balance so a wallet running dry is visible in the log before it
# becomes a silent failure to reseed.
node --import tsx -e '
import { createPublicClient, http, formatEther } from "viem";
import { monadTestnetChain, robinhoodTestnetChain } from "./scripts/lib/e2e/chain.js";
const WALLET = "0x9660093CE5a6Cfe346d1fEF2bdC12e5E77C2a2Cc";
// Both chains, because the same key pays gas on each and a dry wallet stops
// that chain silently — the ladder simply is not topped up any more.
for (const [label, chain, low] of [["MON", monadTestnetChain, 2], ["ETH (Robinhood)", robinhoodTestnetChain, 0.05]]) {
  try {
    const c = createPublicClient({ chain, transport: http() });
    const bal = Number(formatEther(await c.getBalance({ address: WALLET })));
    console.log(`keeper balance: ${bal.toFixed(4)} ${label}` + (bal < low ? "  *** LOW — top up or the ladder stops ***" : ""));
  } catch (err) {
    console.log(`keeper balance: ${label} unavailable (${err instanceof Error ? err.message : String(err)})`);
  }
}
' >> "$LOG" 2>&1

exit $STATUS

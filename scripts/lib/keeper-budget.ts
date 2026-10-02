export interface FairPair<T> {
  pair: string;
  rungs: readonly T[];
}

export interface FairRung<T> {
  pair: string;
  rung: T;
}

/** Missing/oldest manifest coverage goes first; stable for equal expiries. */
export function leastCoveredPairs<T>(
  pairs: readonly FairPair<T>[],
  expiryByPair: ReadonlyMap<string, bigint>,
): FairPair<T>[] {
  return [...pairs].sort((left, right) => {
    const leftExpiry = expiryByPair.get(left.pair) ?? 0n;
    const rightExpiry = expiryByPair.get(right.pair) ?? 0n;
    return leftExpiry < rightExpiry ? -1 : leftExpiry > rightExpiry ? 1 : 0;
  });
}

/** Round-robin by rung depth: every pair's nearest rung precedes any second rung. */
export function fairRungOrder<T>(pairs: readonly FairPair<T>[], startIndex = 0): FairRung<T>[] {
  const ordered: FairRung<T>[] = [];
  const rotated = pairs.length === 0
    ? []
    : [...pairs.slice(startIndex % pairs.length), ...pairs.slice(0, startIndex % pairs.length)];
  const depth = pairs.reduce((max, pair) => Math.max(max, pair.rungs.length), 0);
  for (let index = 0; index < depth; index += 1) {
    for (const pair of rotated) {
      const rung = pair.rungs[index];
      if (rung !== undefined) ordered.push({ pair: pair.pair, rung });
    }
  }
  return ordered;
}

export interface KeeperBudgetClaim {
  label: string;
  gasUnits: bigint;
  holdGasUnits?: bigint;
}

export interface KeeperBudgetDecision {
  allowed: boolean;
  dryRun: boolean;
  maxCostWei: bigint;
  balanceWei?: bigint;
  gasPriceWei?: bigint;
  reason?: string;
}

export interface KeeperBudgetSnapshot {
  committedWei: bigint;
  heldWei: bigint;
  deferred: string[];
}

export interface KeeperBudget {
  claim(claim: KeeperBudgetClaim): Promise<KeeperBudgetDecision>;
  complete(label: string, gasUnits: bigint): Promise<KeeperBudgetDecision>;
  snapshot(): KeeperBudgetSnapshot;
}

export function createKeeperBudget(params: {
  reserveWei: bigint;
  balance: () => Promise<bigint>;
  gasPrice: () => Promise<bigint>;
  dryRun?: boolean;
}): KeeperBudget {
  let committedWei = 0n;
  const heldByLabel = new Map<string, bigint>();
  const deferred: string[] = [];

  return {
    async claim({ label, gasUnits, holdGasUnits = 0n }) {
      if (params.dryRun) return { allowed: true, dryRun: true, maxCostWei: 0n };

      // Read both immediately before each transaction. Sequential receipt waits
      // mean the balance includes every prior transaction's actual gas burn.
      const [balanceWei, gasPrice] = await Promise.all([params.balance(), params.gasPrice()]);
      const maxCostWei = (gasUnits * gasPrice * 3n) / 2n;
      const heldWei = Array.from(heldByLabel.values()).reduce((sum, value) => sum + value, 0n);
      if (balanceWei < params.reserveWei + heldWei + maxCostWei) {
        const reason =
          `${label} deferred: balance ${balanceWei} wei cannot cover bounded gas ${maxCostWei} wei ` +
          `while preserving reserve ${params.reserveWei} wei`;
        deferred.push(reason);
        return { allowed: false, dryRun: false, maxCostWei, balanceWei, gasPriceWei: gasPrice, reason };
      }
      committedWei += maxCostWei;
      if (holdGasUnits > 0n) heldByLabel.set(label, (holdGasUnits * gasPrice * 3n) / 2n);
      return { allowed: true, dryRun: false, maxCostWei, balanceWei, gasPriceWei: gasPrice };
    },
    async complete(label, gasUnits) {
      heldByLabel.delete(label);
      if (params.dryRun) return { allowed: true, dryRun: true, maxCostWei: 0n };
      const [balanceWei, gasPrice] = await Promise.all([params.balance(), params.gasPrice()]);
      const maxCostWei = (gasUnits * gasPrice * 3n) / 2n;
      const heldWei = Array.from(heldByLabel.values()).reduce((sum, value) => sum + value, 0n);
      if (balanceWei < params.reserveWei + heldWei + maxCostWei) {
        const reason =
          `${label} deferred at completion: fresh balance ${balanceWei} wei cannot cover gas ${maxCostWei} wei ` +
          `while preserving reserve ${params.reserveWei} wei and ${heldWei} wei held for other rungs`;
        deferred.push(reason);
        return { allowed: false, dryRun: false, maxCostWei, balanceWei, gasPriceWei: gasPrice, reason };
      }
      return { allowed: true, dryRun: false, maxCostWei, balanceWei, gasPriceWei: gasPrice };
    },
    snapshot() {
      return {
        committedWei,
        heldWei: Array.from(heldByLabel.values()).reduce((sum, value) => sum + value, 0n),
        deferred: [...deferred],
      };
    },
  };
}

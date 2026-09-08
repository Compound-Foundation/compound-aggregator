export function addUserAmount(
  totals: Map<string, bigint>,
  user: string,
  amount: bigint,
): void {
  if (amount === 0n) return;
  const key = user.toLowerCase();
  totals.set(key, (totals.get(key) ?? 0n) + amount);
}

export function remainingV2Owed(accrued: bigint, pending: bigint): bigint {
  return accrued + pending;
}

export function remainingV2OwedRows(params: {
  marketAddress: string;
  users: string[];
  accruedByUser: Map<string, bigint>;
  pendingByUser: Map<string, bigint>;
}): Array<{ marketAddress: string; userAddress: string; owed: bigint }> {
  const seen = new Set<string>();
  const out: Array<{
    marketAddress: string;
    userAddress: string;
    owed: bigint;
  }> = [];

  for (const user of params.users) {
    const key = user.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const owed = remainingV2Owed(
      params.accruedByUser.get(key) ?? 0n,
      params.pendingByUser.get(key) ?? 0n,
    );
    if (owed === 0n) continue;

    out.push({
      marketAddress: params.marketAddress,
      userAddress: key,
      owed,
    });
  }

  return out;
}

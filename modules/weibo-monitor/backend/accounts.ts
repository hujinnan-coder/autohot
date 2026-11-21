import accountList from "../accounts.json" with { type: "json" };

type Tier = "top" | "rest";

interface Account {
  uid: string;
  name: string;
  tier: Tier;
}

const INTERVAL_MINUTES: Record<Tier, number> = { top: 120, rest: 720 };
export const TICK_MINUTES = 10;

export const accounts = new Map((accountList as Account[]).map(account => [`weibopage-${account.uid}`, account]));

export function tickTime(now: Date): Date {
  const slot = TICK_MINUTES * 60_000;
  return new Date(Math.floor(now.getTime() / slot) * slot);
}

export function nextDueAt(tier: Tier, tick: Date): Date {
  return new Date(tick.getTime() + INTERVAL_MINUTES[tier] * 60_000);
}

/** Give each tier an even spread of first reads over its interval. */
export function initialDueAccounts(now: Date): Array<{ sourceId: string; nextDueAt: Date }> {
  return (["top", "rest"] as const).flatMap(tier => {
    const group = [...accounts].filter(([, account]) => account.tier === tier);
    return group.map(([sourceId], index) => ({
      sourceId,
      nextDueAt: new Date(now.getTime() + Math.floor(INTERVAL_MINUTES[tier] * index / group.length) * 60_000),
    }));
  });
}

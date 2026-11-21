import type { AdminCosts, BeforeJson } from "@aihot/contracts/admin";
import type { JSONValue } from "postgres";
import { z } from "zod";
import { estimateUsage, type ServicePrice, type UncostedUsage } from "../providers/pricing.ts";
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { MODELS } from "../providers/llm.ts";

const ACCOUNTS = [
  { service: "deepseek", account: "DEEPSEEK_API_KEY", base: "DEEPSEEK_BASE_URL", path: "/user/balance" },
  { service: "deepseek", account: "LLM_API_KEY", base: "LLM_BASE_URL", path: "/user/balance" },
  { service: "mimo", account: "XIAOMI_MIMO_API_KEY", base: "XIAOMI_MIMO_BASE_URL", path: "/v1/platform/balance" },
];

// Update the calendar each November when the next year's official schedule is published.
const HOLIDAY_RANGES_2026 = [
  ["01-01", "01-03"], ["02-15", "02-23"], ["04-04", "04-06"], ["05-01", "05-05"],
  ["06-19", "06-21"], ["09-25", "09-27"], ["10-01", "10-07"],
] as const;
const ADJUSTED_WORKDAYS_2026 = ["01-04", "02-14", "02-28", "05-09", "09-20", "10-10"];

const currency = z.string().min(1);
const amount = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const deepseekInfo = z.object({ currency, total_balance: amount, granted_balance: amount, topped_up_balance: amount })
  .transform(({ currency, total_balance, granted_balance, topped_up_balance }) => ({
    currency, balance: total_balance, granted: granted_balance, toppedUp: topped_up_balance,
  }));
const mimoInfo = z.object({ currency, total_available: amount })
  .transform(({ currency, total_available }) => ({
    currency, balance: total_available, granted: null, toppedUp: null,
  }));
const balanceReply = z.object({
  is_available: z.boolean(),
  balance_infos: z.tuple([z.unknown()]).rest(z.unknown()),
});

export const balancesEnabled = () => process.env.PROVIDER_BALANCE_ENABLED === "true";

export async function fetchProviderBalances() {
  const results = await Promise.all(ACCOUNTS.map(async ({ service, account, base, path }) => {
    try {
      const apiKey = credential("models", account);
      const baseUrl = credential("models", base);
      if (!apiKey || !baseUrl) return null;
      // Model base URLs can include the chat API version. Balance paths carry their own version.
      const url = `${baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "")}${path}`;
      const res = await fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(30_000),
      }).catch((error: unknown) => {
        // Fetch errors can include the rejected authorization header.
        const reason = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
        throw new Error(`Balance request ${reason}`);
      });
      if (!res.ok) {
        await res.body?.cancel();
        throw new Error(`Balance HTTP ${res.status}`);
      }
      const raw = (await res.json().catch(() => null)) as JSONValue;
      const reply = balanceReply.safeParse(raw);
      if (!reply.success) throw new Error("Invalid balance response");
      const info = (service === "mimo" ? mimoInfo : deepseekInfo).safeParse(reply.data.balance_infos[0]);
      if (!info.success) throw new Error("Invalid balance response");
      const { currency, balance, granted, toppedUp } = info.data;
      await sql`INSERT INTO provider_balances (service, account, currency, balance, granted, topped_up, is_available, raw)
        VALUES (${service}, ${account}, ${currency}, ${balance}, ${granted}, ${toppedUp}, ${reply.data.is_available}, ${sql.json(raw)})`;
      return { service, account, status: "ok" as const };
    } catch (error) {
      return { service, account, status: "error" as const, error: String(error).slice(0, 200) };
    }
  }));
  return { accounts: results.filter((result) => result !== null) };
}

interface BalanceRow {
  service: string;
  account: string;
  currency: string;
  balance: number;
  granted: number | null;
  topped_up: number | null;
  is_available: boolean;
  fetched_at: Date;
  spend_window: number | null;
  since_first: number;
  samples: number;
}

export async function latestProviderBalances() {
  const rows = await sql<Pick<BalanceRow, "service" | "account" | "currency" | "balance">[]>`
    WITH latest AS (
      SELECT DISTINCT ON (service, account) service, account, currency, balance, fetched_at, id
      FROM provider_balances
      WHERE account IN ${sql(ACCOUNTS.map(({ account }) => account))}
      ORDER BY service, account, fetched_at DESC, id DESC
    )
    SELECT service, account, currency, balance FROM latest ORDER BY fetched_at DESC, id DESC`;
  return rows.filter((row) => ACCOUNTS.some(({ service, account }) => row.service === service && row.account === account));
}

export async function platformBalances(days: number): Promise<BeforeJson<AdminCosts["platform"]>> {
  const since = new Date(Date.now() - days * 86400_000);
  // Keep the arithmetic in numeric and compare snapshots within a currency. PostgreSQL's
  // greatest ignores NULL, so unavailable top-up and grant fields contribute zero.
  const rows = await sql<BalanceRow[]>`
    WITH pairs AS (
      SELECT id, service, account, currency, balance, granted, topped_up, is_available, fetched_at,
             lag(fetched_at) OVER snapshots AS previous_at,
             greatest(0, lag(balance) OVER snapshots - balance
               + greatest(0, topped_up - lag(topped_up) OVER snapshots)
               + greatest(0, granted - lag(granted) OVER snapshots)) AS spend
      FROM provider_balances
      WINDOW snapshots AS (PARTITION BY service, account, currency ORDER BY fetched_at, id)
    )
    SELECT DISTINCT ON (service, account) service, account, currency, balance, granted, topped_up, is_available, fetched_at,
           sum(spend) FILTER (WHERE previous_at >= ${since}) OVER account_currency AS spend_window,
           sum(spend) OVER account_currency AS since_first,
           count(*) OVER (PARTITION BY service, account) AS samples
    FROM pairs
    WINDOW account_currency AS (PARTITION BY service, account, currency)
    ORDER BY service, account, fetched_at DESC, id DESC`;
  return rows.map((row) => ({
    service: row.service,
    account: row.account,
    currency: row.currency,
    balance: row.balance,
    granted: row.granted,
    toppedUp: row.topped_up,
    isAvailable: row.is_available,
    fetchedAt: row.fetched_at.toISOString(),
    spendWindow: row.spend_window === null ? null : { days, amount: row.spend_window },
    sinceFirst: row.since_first,
    samples: row.samples,
  }));
}

export interface AttemptUsage extends UncostedUsage {
  service: string;
  model: string | null;
  prices: ServicePrice[];
  tokens_in_uncosted_offpeak: UncostedUsage["tokens_in_uncosted"];
  tokens_out_uncosted_offpeak: UncostedUsage["tokens_out_uncosted"];
  tokens_cached_offpeak: UncostedUsage["tokens_cached"];
}

/** Services whose configured base URL points at api.deepseek.com: their off-peak tokens bill at half
 * price. Both the deepseek and llm services sit on that endpoint here; a relay in LLM_BASE_URL would
 * drop the llm service from the list and its estimate stays at the peak price (conservative). */
export function deepseekServices() {
  return [...new Set(Object.values(MODELS)
    .filter((spec) => URL.parse(credential("models", spec.baseUrlEnv) ?? "")?.hostname?.endsWith("deepseek.com"))
    .map((spec) => spec.service))];
}

export function uncostedAttemptTotals(services: string[]) {
  const localTime = sql`(a.started_at AT TIME ZONE 'Asia/Shanghai')`;
  const cached = sql`coalesce((a.usage->'prompt_tokens_details'->>'cached_tokens')::bigint, (a.usage->>'prompt_cache_hit_tokens')::bigint, 0)`;
  const calendarYear = sql`EXTRACT(YEAR FROM ${localTime}) = 2026`;
  const monthDay = sql`to_char(${localTime}, 'MM-DD')`;
  const starts = HOLIDAY_RANGES_2026.map(([start]) => start);
  const ends = HOLIDAY_RANGES_2026.map(([, end]) => end);
  // Holiday and make-up workday overrides apply only to the published Beijing calendar year.
  const offpeak = sql`a.cost IS NULL AND a.service = ANY(${services}) AND (
    (${calendarYear} AND EXISTS (
      SELECT 1 FROM unnest(${starts}::text[], ${ends}::text[]) AS holidays(first_day, last_day)
      WHERE ${monthDay} BETWEEN first_day AND last_day
    )) OR
    (EXTRACT(ISODOW FROM ${localTime}) IN (6, 7)
      AND NOT (${calendarYear} AND ${monthDay} = ANY(${ADJUSTED_WORKDAYS_2026}::text[]))) OR
    (EXTRACT(HOUR FROM ${localTime}) NOT BETWEEN 9 AND 11 AND EXTRACT(HOUR FROM ${localTime}) NOT BETWEEN 14 AND 17)
  )`;
  return sql`
    sum((a.usage->>'prompt_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_in_uncosted,
    sum((a.usage->>'completion_tokens')::bigint) FILTER (WHERE a.cost IS NULL) AS tokens_out_uncosted,
    sum(${cached}) FILTER (WHERE a.cost IS NULL) AS tokens_cached,
    sum((a.usage->>'prompt_tokens')::bigint) FILTER (WHERE ${offpeak}) AS tokens_in_uncosted_offpeak,
    sum((a.usage->>'completion_tokens')::bigint) FILTER (WHERE ${offpeak}) AS tokens_out_uncosted_offpeak,
    sum(${cached}) FILTER (WHERE ${offpeak}) AS tokens_cached_offpeak`;
}

export function estimateAttemptUsage(row: AttemptUsage) {
  const offpeak = {
    tokens_in_uncosted: Number(row.tokens_in_uncosted_offpeak ?? 0),
    tokens_out_uncosted: Number(row.tokens_out_uncosted_offpeak ?? 0),
    tokens_cached: Number(row.tokens_cached_offpeak ?? 0),
  };
  // Stored rates are peak prices, so price the two token groups before applying the discount.
  const peak = estimateUsage(row.prices, row.service, row.model, {
    tokens_in_uncosted: Number(row.tokens_in_uncosted ?? 0) - offpeak.tokens_in_uncosted,
    tokens_out_uncosted: Number(row.tokens_out_uncosted ?? 0) - offpeak.tokens_out_uncosted,
    tokens_cached: Number(row.tokens_cached ?? 0) - offpeak.tokens_cached,
  });
  const discounted = estimateUsage(row.prices, row.service, row.model, offpeak);
  if (!peak || !discounted) return null;
  return { amount: peak.amount + discounted.amount * 0.5, currency: peak.currency };
}

interface DailyAttemptRow extends AttemptUsage {
  day: string;
  calls: number;
  actual_cost: number | null;
  recorded_cost: number | null;
  currency: string | null;
}

/** Keep unpriced activity for active-day averages and group charges in their original currencies. */
export async function dailyAttemptCosts(since: Date, until?: Date) {
  const rows = await sql<DailyAttemptRow[]>`
    WITH usage AS (
      SELECT (a.started_at AT TIME ZONE 'Asia/Shanghai')::date AS day, a.service, a.model, count(*)::int AS calls,
             ${uncostedAttemptTotals(deepseekServices())},
             sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost,
             sum(a.cost) FILTER (WHERE a.cost_basis = 'estimated') AS recorded_cost, a.currency
      FROM receipt_attempts a
      WHERE a.started_at >= ${since} AND a.origin = 'live'
        ${until ? sql`AND a.started_at < ${until}` : sql``}
      GROUP BY day, a.service, a.model, a.currency
    )
    SELECT to_char(u.day, 'YYYY-MM-DD') AS day, u.service, u.model, u.calls, u.actual_cost, u.recorded_cost,
           u.currency, u.tokens_in_uncosted, u.tokens_out_uncosted, u.tokens_cached,
           u.tokens_in_uncosted_offpeak, u.tokens_out_uncosted_offpeak, u.tokens_cached_offpeak,
           (SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM service_prices p
                        WHERE p.service = u.service AND p.model IN (u.model, '')) AS prices
    FROM usage u ORDER BY u.day, u.service, u.model`;
  return rows.map((row) => {
    const spend: { amount: number; currency: string }[] = [];
    const charged = (row.actual_cost ?? 0) + (row.recorded_cost ?? 0);
    if (row.currency && charged !== 0) spend.push({ amount: charged, currency: row.currency });
    const estimate = estimateAttemptUsage(row);
    if (estimate && estimate.amount !== 0) spend.push(estimate);
    return { day: row.day, service: row.service, calls: row.calls, spend };
  });
}

export async function balanceRunway(
  days: number, dailyCosts?: ReturnType<typeof dailyAttemptCosts>,
): Promise<AdminCosts["runway"]> {
  const groups = new Map<string, typeof ACCOUNTS>();
  for (const account of ACCOUNTS) {
    const key = credential("models", account.account);
    const groupKey = key === null ? `account:${account.account}` : `key:${key}`;
    const group = groups.get(groupKey) ?? [];
    group.push(account);
    groups.set(groupKey, group);
  }

  const [snapshots, usage] = await Promise.all([
    latestProviderBalances(),
    dailyCosts ?? dailyAttemptCosts(new Date(Date.now() - days * 86400_000)),
  ]);

  const runway: AdminCosts["runway"] = [];
  for (const group of groups.values()) {
    const snapshot = snapshots.find((row) => group.some(({ service, account }) => row.service === service && row.account === account));
    if (!snapshot) continue;
    const accounts = group.map(({ account }) => account);
    const services = new Set(Object.values(MODELS).filter(({ apiKeyEnv }) => accounts.includes(apiKeyEnv)).map(({ service }) => service));
    const activeDays = new Set<string>();
    let total = 0;
    let currencyMismatch = false;
    for (const row of usage) {
      if (!services.has(row.service)) continue;
      activeDays.add(row.day);
      for (const spend of row.spend) {
        if (spend.currency !== snapshot.currency) currencyMismatch = true;
        total += spend.amount;
      }
    }
    const dailySpend = currencyMismatch || total === 0 ? null : total / activeDays.size;
    runway.push({
      accounts, currency: snapshot.currency, balance: snapshot.balance, dailySpend,
      daysLeft: dailySpend !== null && dailySpend > 0 ? Math.floor(snapshot.balance / dailySpend) : null,
    });
  }
  return runway;
}

import type { AdminCosts, BeforeJson } from "@aihot/contracts/admin";
import { beijingDate, beijingMidnight, monthRange } from "@aihot/contracts/time";
import { z } from "zod";
import { audit } from "../audit.ts";
import { credential } from "../config.ts";
import { one, sql, type Db } from "../db.ts";
import { balanceRunway, dailyAttemptCosts, deepseekServices, estimateAttemptUsage, platformBalances, uncostedAttemptTotals, type AttemptUsage } from "../operations/balances.ts";
import type { ServicePrice } from "../providers/pricing.ts";

type Budget = Pick<AdminCosts["budget"], "monthlyCNY" | "monthlyUSD" | "alertBalance">;
type Price = AdminCosts["prices"][number];
type Spend = { amount: number; currency: string };

const budgetKey = "cost.budget";
const budgetAmount = z.number().nonnegative().nullish();
const budgetInput = z.object({ monthlyCNY: budgetAmount, monthlyUSD: budgetAmount, alertBalance: budgetAmount });
const tokenPrice = z.number().nonnegative().max(99_999_999.999999).nullable().default(null);
const priceInput = z.object({
  service: z.string().trim().min(1),
  model: z.string(), // An empty model is the service-wide fallback.
  currency: z.enum(["CNY", "USD"]),
  inputPerMtok: tokenPrice,
  cachedPerMtok: tokenPrice,
  outputPerMtok: tokenPrice,
});

const numeric = (value: number | string | null) => value === null ? null : Number(value);

function budgetValues(input?: Partial<Budget>): Budget {
  return {
    monthlyCNY: input?.monthlyCNY ?? null,
    monthlyUSD: input?.monthlyUSD ?? null,
    alertBalance: input?.alertBalance ?? null,
  };
}

async function readBudget(db: Db = sql) {
  const [row] = await db<{ value: Budget }[]>`SELECT value FROM settings WHERE key = ${budgetKey}`;
  return row?.value;
}

export async function updateCostBudget(input: unknown, actor: string): Promise<Budget> {
  const next = budgetValues(budgetInput.parse(input));
  const subject = `settings:${budgetKey}`;
  return sql.begin(async (tx) => {
    // A new key has no row to lock before recording its previous value.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${subject}))`;
    const before = await readBudget(tx);
    await tx`INSERT INTO settings (key, value, updated_by) VALUES (${budgetKey}, ${tx.json(next)}, ${actor})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    await audit(actor, "costs.budget", subject, null, before, next, { db: tx });
    return next;
  });
}

function serializePrice(row: ServicePrice): Price {
  return {
    service: row.service, model: row.model, currency: row.currency,
    inputPerMtok: numeric(row.input_per_mtok), cachedPerMtok: numeric(row.cached_per_mtok),
    outputPerMtok: numeric(row.output_per_mtok),
  };
}

async function listPrices(db: Db = sql) {
  const rows = await db<ServicePrice[]>`SELECT * FROM service_prices ORDER BY service, model`;
  return rows.map(serializePrice);
}

export async function upsertCostPrice(input: unknown, actor: string): Promise<Price[]> {
  const { service, model, currency, inputPerMtok, cachedPerMtok, outputPerMtok } = priceInput.parse(input);
  const subject = `${service}/${model}`;
  return sql.begin(async (tx) => {
    // Serialize updates to this price, including simultaneous first inserts.
    await tx`SELECT pg_advisory_xact_lock(hashtext(${`costs.price:${subject}`}))`;
    const [before] = await tx<ServicePrice[]>`SELECT * FROM service_prices WHERE service = ${service} AND model = ${model}`;
    const after = one(await tx<ServicePrice[]>`
      INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok)
      VALUES (${service}, ${model}, ${currency}, ${inputPerMtok}, ${cachedPerMtok}, ${outputPerMtok})
      ON CONFLICT (service, model) DO UPDATE SET currency = EXCLUDED.currency, input_per_mtok = EXCLUDED.input_per_mtok,
        cached_per_mtok = EXCLUDED.cached_per_mtok, output_per_mtok = EXCLUDED.output_per_mtok, updated_at = now()
      RETURNING *`);
    await audit(actor, "costs.price", subject, null, before ? serializePrice(before) : null, serializePrice(after), { db: tx });
    return listPrices(tx);
  });
}

interface CostTotals extends Omit<AttemptUsage, "service" | "model" | "prices"> {
  calls: number;
  actual_cost: number | string | null;
  recorded_cost: number | string | null;
  currency: string | null;
}

type CostRow = CostTotals & AttemptUsage;

interface UsageRow extends Pick<AttemptUsage, "service" | "model" | "prices"> {
  purpose: string;
  totals: { all: CostTotals & { tokens_in: number | string | null; tokens_out: number | string | null }; retry?: CostTotals; failed?: CostTotals };
}

function attemptCostTotals(services: string[]) {
  return sql`count(*)::int AS calls,
    ${uncostedAttemptTotals(services)},
    sum(a.cost) FILTER (WHERE a.cost_basis = 'actual') AS actual_cost,
    sum(a.cost) FILTER (WHERE a.cost_basis = 'estimated') AS recorded_cost,
    max(a.currency) AS currency`;
}

const usagePrices = sql`(SELECT coalesce(jsonb_agg(p), '[]'::jsonb) FROM service_prices p
                        WHERE p.service = u.service AND p.model IN (u.model, '')) AS prices`;

function estimateWithTokens(row: CostRow) {
  if (row.tokens_in_uncosted === null && row.tokens_out_uncosted === null && !Number(row.tokens_cached ?? 0)) return null;
  return estimateAttemptUsage(row);
}

function subsetCost(group: UsageRow, totals: CostTotals | undefined) {
  if (!totals) return null;
  const estimate = estimateWithTokens({ ...group, ...totals });
  if (totals.actual_cost === null && totals.recorded_cost === null && estimate === null) return null;
  return Number(totals.actual_cost ?? 0) + Number(totals.recorded_cost ?? 0) + (estimate?.amount ?? 0);
}

function addSpend(totals: Map<string, number>, { amount, currency }: Spend) {
  totals.set(currency, (totals.get(currency) ?? 0) + amount);
}

function spendAmounts(totals: Map<string, number>): Spend[] {
  return [...totals].filter(([, amount]) => amount !== 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amount]) => ({ amount, currency }));
}

function chargedSpend(row: CostTotals): Spend | null {
  if (!row.currency || (row.actual_cost === null && row.recorded_cost === null)) return null;
  return { currency: row.currency, amount: Number(row.actual_cost ?? 0) + Number(row.recorded_cost ?? 0) };
}

function addAttemptSpend(totals: Map<string, number>, row: CostRow) {
  const charged = chargedSpend(row);
  if (charged) addSpend(totals, charged);
  const estimate = estimateWithTokens(row);
  if (estimate) addSpend(totals, estimate);
  return estimate;
}

async function topSubjects(since: Date, services: string[]): Promise<AdminCosts["topSubjects"]> {
  const rows = await sql<(CostRow & { subject: string })[]>`
    WITH usage AS (
      SELECT regexp_replace(r.subject, '@[0-9]+$', '') AS subject, a.service, a.model, ${attemptCostTotals(services)}
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.origin = 'live' AND a.started_at >= ${since} AND r.subject LIKE 'article:%'
      GROUP BY 1, a.service, a.model, a.currency
    )
    SELECT u.*, ${usagePrices} FROM usage u`;
  const subjects = new Map<string, { calls: number; spend: Map<string, number>; estimates: Map<string, number> }>();
  for (const row of rows) {
    const subject = subjects.get(row.subject) ?? { calls: 0, spend: new Map(), estimates: new Map() };
    subject.calls += row.calls;
    const estimate = addAttemptSpend(subject.spend, row);
    if (estimate) addSpend(subject.estimates, estimate);
    subjects.set(row.subject, subject);
  }

  // The subject contract reports one currency. Use the same CNY-first ranking as the cost page.
  return [...subjects].map(([subject, { calls, spend, estimates }]) => {
    const currency = ["CNY", "USD", ...spend.keys()].find((code) => spend.get(code))
      ?? spend.keys().next().value ?? null;
    const cost = currency === null ? null : spend.get(currency)!;
    const estimated = currency === null ? undefined : estimates.get(currency);
    const estimate = currency !== null && estimated !== undefined ? { amount: estimated, currency } : null;
    return { subject, calls, cost, currency, estimate };
  }).sort((a, b) => (b.cost || b.calls / 1e9) - (a.cost || a.calls / 1e9) || a.subject.localeCompare(b.subject)).slice(0, 10);
}

async function monthlyAttemptCosts(today: string, services: string[]): Promise<AdminCosts["monthly"]> {
  const [year, month] = today.split("-").map(Number) as [number, number, number];
  const months = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(year, month - 6 + i, 1)).toISOString().slice(0, 7));
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const rows = await sql<(CostRow & { month: string })[]>`
    WITH usage AS (
      SELECT date_trunc('month', a.started_at AT TIME ZONE 'Asia/Shanghai') AS month_start, a.service, a.model,
             ${attemptCostTotals(services)}
      FROM receipt_attempts a
      WHERE a.origin = 'live' AND a.started_at >= ${beijingMidnight(`${months[0]}-01`)}
        AND a.started_at < ${beijingMidnight(nextMonth)}
      GROUP BY 1, a.service, a.model, a.currency
    )
    SELECT u.*, to_char(u.month_start, 'YYYY-MM') AS month, ${usagePrices} FROM usage u`;
  const totals = new Map(months.map((label) => [label, new Map<string, number>()]));
  for (const row of rows) addAttemptSpend(totals.get(row.month)!, row);
  return [...totals].map(([month, spend]) => ({ month, spend: spendAmounts(spend) }));
}

async function pipelineSpend(since: Date, services: string[]): Promise<Record<string, number>> {
  const rows = await sql<CostRow[]>`
    WITH usage AS (
      SELECT a.service, a.model, ${attemptCostTotals(services)}
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      WHERE a.origin = 'live' AND a.started_at >= ${since}
        AND r.purpose IN ('prefilter_article', 'score_article', 'understand_article', 'summarize_article', 'structure_article')
      GROUP BY a.service, a.model, a.currency
    )
    SELECT u.*, ${usagePrices} FROM usage u`;
  const totals = new Map<string, number>();
  for (const row of rows) addAttemptSpend(totals, row);
  return Object.fromEntries(spendAmounts(totals).map(({ currency, amount }) => [currency, amount]));
}

export async function costsOverview(days = 7): Promise<BeforeJson<AdminCosts>> {
  days = Math.min(90, Number(days) || 7);
  const now = Date.now();
  const since = new Date(now - days * 86400_000);
  const today = beijingDate(now);
  const services = deepseekServices();
  // A failed retry belongs to both subsets. Aggregate each scope with the same pricing inputs.
  const usageQuery = sql<UsageRow[]>`
    WITH usage AS (
      SELECT a.service, a.model, r.purpose, scope.name,
             sum((a.usage->>'prompt_tokens')::bigint) AS tokens_in, sum((a.usage->>'completion_tokens')::bigint) AS tokens_out,
             ${attemptCostTotals(services)}
      FROM receipt_attempts a JOIN receipts r ON r.id = a.receipt_id
      CROSS JOIN LATERAL (VALUES ('all', true), ('retry', a.attempt >= 2),
                                ('failed', a.status IN ('failed', 'unknown'))) AS scope(name, included)
      WHERE a.started_at >= ${since} AND a.origin = 'live' AND scope.included
      GROUP BY a.service, a.model, r.purpose, scope.name
    )
    SELECT u.service, u.model, u.purpose, jsonb_object_agg(u.name, to_jsonb(u)) AS totals, ${usagePrices}
    FROM usage u GROUP BY u.service, u.model, u.purpose ORDER BY u.service, u.model, u.purpose`;
  const dailyCosts = dailyAttemptCosts(since);
  const [usage, platform, dailyUsage, runway, budgets, settings, prices, monthly, subjects, pipelineCost, outputCounts] = await Promise.all([
    usageQuery,
    platformBalances(days),
    dailyCosts,
    balanceRunway(days, dailyCosts),
    sql<{ service: string; per_day: number; used_24h: number }[]>`
      SELECT b.service, b.per_day,
             (SELECT count(*)::int FROM receipt_attempts a
              WHERE a.service = b.service AND a.origin = 'live'
                AND a.started_at > now() - interval '24 hours') AS used_24h
      FROM budgets b ORDER BY b.service`,
    readBudget(),
    listPrices(),
    monthlyAttemptCosts(today, services),
    topSubjects(since, services),
    pipelineSpend(since, services),
    sql<{ selected: number; reports: number }[]>`
      SELECT (SELECT count(DISTINCT article_id)::int FROM selected_ledger WHERE op = 'upsert' AND changed_at >= ${since}) AS selected,
             (SELECT count(*)::int FROM reports WHERE generated_at >= ${since}) AS reports`,
  ]);
  const byDay = new Map<string, { calls: number; spend: Map<string, number> }>();
  for (const row of dailyUsage) {
    const day = byDay.get(row.day) ?? { calls: 0, spend: new Map<string, number>() };
    day.calls += row.calls;
    for (const spend of row.spend) addSpend(day.spend, spend);
    byDay.set(row.day, day);
  }
  const daily: AdminCosts["daily"] = [];
  for (const [day, { calls, spend }] of byDay) {
    const amounts = spendAmounts(spend);
    if (amounts.length > 0) daily.push({ day, calls, spend: amounts });
  }

  const monthSpend = { CNY: 0, USD: 0, ...Object.fromEntries(monthly.at(-1)!.spend.map(({ currency, amount }) => [currency, amount])) };
  const elapsedDays = Number(today.slice(8));
  const monthDays = Number(monthRange(today.slice(0, 7))!.end.slice(8));
  const forecast = Object.fromEntries(Object.entries(monthSpend).map(([currency, amount]) => [currency, amount / elapsedDays * monthDays]));

  const rows = usage.map((group) => {
    const { service, model, purpose, totals } = group;
    const u = totals.all;
    return {
      service, model, purpose, calls: u.calls, retried: totals.retry?.calls ?? 0,
      tokensIn: Number(u.tokens_in ?? 0), tokensOut: Number(u.tokens_out ?? 0),
      actualCost: numeric(u.actual_cost), recordedCost: numeric(u.recorded_cost),
      wasteCost: subsetCost(group, totals.retry), failedCost: subsetCost(group, totals.failed),
      currency: u.currency, estimate: estimateAttemptUsage({ ...group, ...u }),
    };
  });
  const { selected, reports } = one(outputCounts);
  // Loopback embeddings have no provider charge. Report that separately from receipt totals.
  const embeddingHost = URL.parse(credential("models", "EMBEDDING_BASE_URL") ?? "")?.hostname;
  const localServices = ["127.0.0.1", "localhost", "[::1]"].includes(embeddingHost ?? "") ? ["embedding"] : [];
  return {
    days, localServices, rows, platform, daily, runway, prices, monthly,
    topSubjects: subjects,
    budget: { ...budgetValues(settings), monthSpend, forecast },
    budgets: budgets.map((b) => ({ service: b.service, perDay: b.per_day, used24h: b.used_24h })),
    outputs: { selectedArticles: selected, reports, pipelineCost },
  };
}

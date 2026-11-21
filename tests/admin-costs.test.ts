import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { costsOverview, updateCostBudget, upsertCostPrice } from "@aihot/backend/admin/costs";
import { costsCsv } from "@aihot/backend/admin/costs-export";
import { closeDb, sql } from "@aihot/backend/db";
import { addDays, beijingAt, beijingDate } from "@aihot/contracts/time";

const prefix = `test-admin-costs-${tag()}`;
const purpose = `${prefix}-purpose`;
const services = {
  actual: `${prefix}-actual`, priced: `${prefix}-priced`, unpriced: `${prefix}-unpriced`, daily: `${prefix}-daily`,
  monthly: `${prefix}-monthly`, subjects: `${prefix}-subjects`, writable: `${prefix}-writable`, pipeline: `${prefix}-pipeline`,
};
const deepseekModels = { midnight: `${prefix}-midnight`, periods: `${prefix}-periods` };
const idleBudget = `${prefix}-idle`;

after(async () => {
  await sql`DELETE FROM receipts WHERE purpose = ${purpose} OR service = ${services.pipeline}`;
  await sql`DELETE FROM service_prices WHERE service IN ${sql(Object.values(services))}`;
  await sql`DELETE FROM service_prices WHERE service = 'deepseek' AND model IN ${sql(Object.values(deepseekModels))}`;
  await sql`DELETE FROM budgets WHERE service IN ${sql([services.actual, idleBudget])}`;
  await sql`DELETE FROM audit_log WHERE actor = ${prefix}`;
});
after(closeDb);

async function receipt(service: string, model: string | null, subject: string | null = null, receiptPurpose = purpose) {
  const [row] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, subject, status)
    VALUES (${`${service}:${model}:${subject}`}, ${service}, ${model}, ${receiptPurpose}, ${subject}, 'completed') RETURNING id`;
  return row!.id;
}

test("costs count live attempts and retries and report rolling daily budget usage", async () => {
  const service = services.actual;
  const model = "test-model";
  const id = await receipt(service, model);
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, origin, usage, cost, currency, cost_basis, started_at)
    VALUES
      (${id}, 1, ${service}, ${model}, 'received', 'live', '{"prompt_tokens":10,"completion_tokens":2}', 0.25, 'USD', 'actual', now()),
      (${id}, 2, ${service}, ${model}, 'failed', 'live', '{"prompt_tokens":20,"completion_tokens":4}', 0.5, 'USD', 'actual', now()),
      (${id}, 3, ${service}, ${model}, 'received', 'replay', NULL, 10, 'USD', 'actual', now()),
      (${id}, 4, ${service}, ${model}, 'received', 'imported', NULL, 10, 'USD', 'actual', now()),
      (${id}, 5, ${service}, ${model}, 'received', 'live', NULL, 10, 'USD', 'actual', now() - interval '2 days')`;
  await sql`INSERT INTO budgets (service, per_minute, per_hour, per_day)
    VALUES (${service}, 1, 10, 100), (${idleBudget}, 1, 5, 25)`;

  const overview = await costsOverview(1);
  assert.equal(overview.days, 1);
  assert.deepEqual(overview.rows.filter((row) => row.service === service), [{
    service, model, purpose, calls: 2, retried: 1, tokensIn: 30, tokensOut: 6, actualCost: 0.75, recordedCost: null,
    wasteCost: 0.5, failedCost: 0.5, currency: "USD", estimate: null,
  }]);
  assert.deepEqual(overview.budgets.find((row) => row.service === service), { service, perDay: 100, used24h: 2 });
  assert.deepEqual(overview.budgets.find((row) => row.service === idleBudget), { service: idleBudget, perDay: 25, used24h: 0 });
  assert.equal((await costsOverview(7)).budgets.find((row) => row.service === service)?.used24h, 2);
});

test("costs estimate uncosted tokens using model and service-wide prices", async () => {
  const service = services.priced;
  const exact = await receipt(service, "exact-price");
  const generic = await receipt(service, "generic-price");
  const cached = await receipt(service, "cache-price");
  const empty = await receipt(service, "empty-price");
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok)
    VALUES (${service}, 'exact-price', 'USD', 3, 1, 5), (${service}, '', 'CNY', 4, NULL, 2),
           (${service}, 'cache-price', 'USD', NULL, 2, NULL), (${service}, 'empty-price', 'USD', NULL, NULL, NULL)`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, cost, currency, cost_basis)
    VALUES
      (${exact}, 1, ${service}, 'exact-price', 'received',
       '{"prompt_tokens":2000000,"completion_tokens":500000,"prompt_tokens_details":{"cached_tokens":500000},"prompt_cache_hit_tokens":1000000}', NULL, NULL, NULL),
      (${exact}, 2, ${service}, 'exact-price', 'received',
       '{"prompt_tokens":1000000,"completion_tokens":1000000,"prompt_tokens_details":{"cached_tokens":1000000}}', 3, 'USD', 'actual'),
      (${exact}, 3, ${service}, 'exact-price', 'received',
       '{"prompt_tokens":30,"completion_tokens":6}', 2, 'USD', 'estimated'),
      (${exact}, 4, ${service}, 'exact-price', 'received',
       '{"prompt_tokens":1000000,"completion_tokens":500000,"prompt_tokens_details":{"cached_tokens":500000}}', 1.25, 'USD', 'estimated'),
      (${generic}, 1, ${service}, 'generic-price', 'received',
       '{"prompt_tokens":1000000,"completion_tokens":500000,"prompt_cache_hit_tokens":250000}', NULL, NULL, NULL),
      (${cached}, 1, ${service}, 'cache-price', 'received',
       '{"prompt_tokens":1000000,"prompt_cache_hit_tokens":500000}', NULL, NULL, NULL),
      (${empty}, 1, ${service}, 'empty-price', 'received', '{"prompt_tokens":1000000}', NULL, NULL, NULL)`;

  const overview = await costsOverview(100);
  assert.equal(overview.days, 90);
  const rows = overview.rows.filter((row) => row.service === service);
  const exactRow = rows.find((row) => row.model === "exact-price");
  assert.deepEqual(exactRow, {
    service, model: "exact-price", purpose, calls: 4, retried: 3, tokensIn: 4_000_030, tokensOut: 2_000_006,
    actualCost: 3, recordedCost: 3.25, wasteCost: 6.25, failedCost: null, currency: "USD", estimate: { amount: 7.5, currency: "USD" },
  });
  assert.deepEqual(rows.find((row) => row.model === "generic-price")?.estimate, { amount: 5, currency: "CNY" });
  assert.deepEqual(rows.find((row) => row.model === "cache-price")?.estimate, { amount: 1, currency: "USD" });
  assert.equal(rows.find((row) => row.model === "empty-price")?.estimate, null);
});

test("costs include services without a model or price", async () => {
  const service = services.unpriced;
  const id = await receipt(service, null);
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status)
    VALUES (${id}, 1, ${service}, 'received'), (${id}, 2, ${service}, 'unknown')`;

  const overview = await costsOverview();
  assert.equal(overview.days, 7);
  assert.deepEqual(overview.rows.filter((row) => row.service === service), [{
    service, model: null, purpose, calls: 2, retried: 1, tokensIn: 0, tokensOut: 0, actualCost: null, recordedCost: null,
    wasteCost: null, failedCost: null, currency: null, estimate: null,
  }]);
});

test("daily costs group at Beijing midnight and combine charges and estimates by currency", async (t) => {
  // The half-price rule follows the configured DeepSeek endpoint; pin it, since tests run without .env.
  const previous = process.env.DEEPSEEK_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previous;
  });
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
  const service = services.daily;
  const model = deepseekModels.midnight;
  const usd = await receipt("deepseek", model);
  const cny = await receipt(service, "cny");
  const unpriced = await receipt(service, null);
  t.after(async () => { await sql`DELETE FROM receipts WHERE id IN ${sql([usd, cny, unpriced])}`; });
  const firstDay = addDays(beijingDate(Date.now()), -10);
  const nextDay = addDays(firstDay, 1);
  const zeroDay = addDays(firstDay, 2);
  const first = beijingAt(firstDay, "23:30");
  const next = beijingAt(nextDay, "00:30");
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok)
    VALUES ('deepseek', ${model}, 'USD', 0.75)`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, cost, currency, cost_basis, started_at)
    VALUES
      (${usd}, 1, 'deepseek', ${model}, 'received', '{"prompt_tokens":1000000}', 0.25, 'USD', 'actual', ${first}),
      (${usd}, 2, 'deepseek', ${model}, 'received', '{"prompt_tokens":1000000}', 0.5, 'USD', 'estimated', ${first}),
      (${usd}, 3, 'deepseek', ${model}, 'received', '{"prompt_tokens":1000000}', NULL, NULL, NULL, ${first}),
      (${usd}, 4, 'deepseek', ${model}, 'received', NULL, 1.25, 'USD', 'actual', ${next}),
      (${cny}, 1, ${service}, 'cny', 'received', NULL, 2, 'CNY', 'actual', ${first}),
      (${unpriced}, 1, ${service}, NULL, 'received', NULL, 1, NULL, 'actual', ${first}),
      (${unpriced}, 2, ${service}, NULL, 'received', NULL, 0, 'USD', 'actual', ${beijingAt(zeroDay, "12:00")})`;

  const { daily } = await costsOverview(14);
  assert.deepEqual(daily.filter(({ day }) => day >= firstDay && day <= zeroDay), [
    { day: firstDay, calls: 5, spend: [{ amount: 2, currency: "CNY" }, { amount: 1.125, currency: "USD" }] },
    { day: nextDay, calls: 1, spend: [{ amount: 1.25, currency: "USD" }] },
  ]);
});

test("DeepSeek usage and daily costs estimate Beijing off-peak tokens at half price", async (t) => {
  const previous = process.env.DEEPSEEK_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.DEEPSEEK_BASE_URL;
    else process.env.DEEPSEEK_BASE_URL = previous;
  });
  process.env.DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1";
  t.mock.timers.enable({ apis: ["Date"], now: beijingAt("2026-11-21", "12:00") });
  const model = deepseekModels.periods;
  const id = await receipt("deepseek", model);
  t.after(async () => { await sql`DELETE FROM receipts WHERE id = ${id}`; });
  const usage = sql.json({ prompt_tokens: 1_500_000, completion_tokens: 500_000, prompt_cache_hit_tokens: 500_000 });
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok, cached_per_mtok, output_per_mtok)
    VALUES ('deepseek', ${model}, 'CNY', 4, 2, 6)`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, started_at)
    VALUES
      (${id}, 1, 'deepseek', ${model}, 'received', ${usage}, ${beijingAt("2026-10-24", "10:00")}),
      (${id}, 2, 'deepseek', ${model}, 'unknown', ${usage}, ${beijingAt("2026-10-25", "03:00")}),
      (${id}, 3, 'deepseek', ${model}, 'received', ${usage}, ${beijingAt("2026-10-26", "10:00")}),
      (${id}, 4, 'deepseek', ${model}, 'received', ${usage}, ${beijingAt("2026-10-01", "10:00")}),
      (${id}, 5, 'deepseek', ${model}, 'received', ${usage}, ${beijingAt("2026-10-10", "10:00")})`;

  const { daily, rows } = await costsOverview(90);
  const expected = [
    { day: "2026-10-01", calls: 1, spend: [{ amount: 4, currency: "CNY" }] },
    { day: "2026-10-10", calls: 1, spend: [{ amount: 8, currency: "CNY" }] },
    { day: "2026-10-24", calls: 1, spend: [{ amount: 4, currency: "CNY" }] },
    { day: "2026-10-25", calls: 1, spend: [{ amount: 4, currency: "CNY" }] },
    { day: "2026-10-26", calls: 1, spend: [{ amount: 8, currency: "CNY" }] },
  ];
  assert.deepEqual(daily.filter(({ day }) => expected.some((entry) => entry.day === day)), expected);
  const row = rows.find((r) => r.service === "deepseek" && r.model === model);
  assert.deepEqual(row?.estimate, { amount: 28, currency: "CNY" });
  assert.equal(row?.wasteCost, 24);
  assert.equal(row?.failedCost, 4);
});

test("costs mark embeddings as local when the configured host is loopback", async (t) => {
  const previous = process.env.EMBEDDING_BASE_URL;
  t.after(() => {
    if (previous === undefined) delete process.env.EMBEDDING_BASE_URL;
    else process.env.EMBEDDING_BASE_URL = previous;
  });

  for (const base of ["http://127.0.0.1:11434", "http://localhost:11434", "http://[::1]:11434"]) {
    process.env.EMBEDDING_BASE_URL = base;
    assert.deepEqual((await costsOverview()).localServices, ["embedding"]);
  }
  process.env.EMBEDDING_BASE_URL = "https://embeddings.example.com/v1";
  assert.deepEqual((await costsOverview()).localServices, []);
  delete process.env.EMBEDDING_BASE_URL;
  assert.deepEqual((await costsOverview()).localServices, []);
});

test("cost budget persists cleared fields and forecasts from the current Beijing month", async (t) => {
  const [previous] = await sql`SELECT * FROM settings WHERE key = 'cost.budget'`;
  t.after(async () => {
    if (previous) {
      await sql`UPDATE settings SET value = ${sql.json(previous.value)}, updated_by = ${previous.updated_by},
        updated_at = ${previous.updated_at} WHERE key = 'cost.budget'`;
    } else await sql`DELETE FROM settings WHERE key = 'cost.budget'`;
  });
  t.mock.timers.enable({ apis: ["Date"], now: beijingAt("2024-02-12", "10:00") });
  const id = await receipt(services.monthly, "test-model");
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok)
    VALUES (${services.monthly}, 'test-model', 'CNY', 6)`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, started_at, cost, currency, cost_basis, usage)
    VALUES
      (${id}, 1, ${services.monthly}, 'test-model', 'received', ${beijingAt("2024-01-31", "23:59")}, 17, 'USD', 'actual', NULL),
      (${id}, 2, ${services.monthly}, 'test-model', 'received', ${beijingAt("2024-02-01", "00:00")}, 12, 'CNY', 'actual', NULL),
      (${id}, 3, ${services.monthly}, 'test-model', 'received', ${beijingAt("2024-02-02", "10:00")}, 6, 'CNY', 'estimated', NULL),
      (${id}, 4, ${services.monthly}, 'test-model', 'received', ${beijingAt("2024-02-02", "10:00")}, NULL, NULL, NULL, '{"prompt_tokens":1000000}'),
      (${id}, 5, ${services.monthly}, 'test-model', 'received', ${beijingAt("2023-08-31", "23:59")}, 99, 'USD', 'actual', NULL)`;
  const initial = { monthlyCNY: 400, monthlyUSD: 25, alertBalance: 30 };
  assert.deepEqual(await updateCostBudget(initial, prefix), initial);
  const cleared = { monthlyCNY: 500, monthlyUSD: null, alertBalance: null };
  assert.deepEqual(await updateCostBudget({ monthlyCNY: 500, alertBalance: null }, prefix), cleared);
  const [setting] = await sql`SELECT value, updated_by FROM settings WHERE key = 'cost.budget'`;
  assert.deepEqual(setting, { value: cleared, updated_by: prefix });
  const [entry] = await sql`SELECT before, after FROM audit_log WHERE actor = ${prefix} AND action = 'costs.budget'
    AND subject = 'settings:cost.budget' ORDER BY id DESC LIMIT 1`;
  assert.deepEqual(entry, { before: initial, after: cleared });

  const { budget, monthly } = await costsOverview(1);
  assert.deepEqual(budget, { ...cleared, monthSpend: { CNY: 24, USD: 0 }, forecast: { CNY: 58, USD: 0 } });
  assert.deepEqual(monthly, [
    { month: "2023-09", spend: [] },
    { month: "2023-10", spend: [] },
    { month: "2023-11", spend: [] },
    { month: "2023-12", spend: [] },
    { month: "2024-01", spend: [{ amount: 17, currency: "USD" }] },
    { month: "2024-02", spend: [{ amount: 24, currency: "CNY" }] },
  ]);
});

test("top subjects merge article revisions and rank the ten most expensive subjects", async () => {
  const service = services.subjects;
  const subject = `article:${prefix}-best`;
  const original = await receipt(service, "first-model", subject);
  const revision = await receipt(service, "second-model", `${subject}@3`);
  const nonArticle = await receipt(service, null, `report:${prefix}`);
  const ignored = await receipt(service, null, `article:${prefix}-replay`);
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok)
    VALUES (${service}, 'second-model', 'CNY', 4)`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, origin, cost, currency, cost_basis, usage)
    VALUES
      (${original}, 1, ${service}, 'first-model', 'received', 'live', 8, 'CNY', 'actual', NULL),
      (${original}, 2, ${service}, 'first-model', 'received', 'live', 100, 'USD', 'actual', NULL),
      (${revision}, 1, ${service}, 'second-model', 'received', 'live', 6, 'CNY', 'estimated', NULL),
      (${revision}, 2, ${service}, 'second-model', 'received', 'live', NULL, NULL, NULL, '{"prompt_tokens":1000000}'),
      (${nonArticle}, 1, ${service}, NULL, 'received', 'live', 300, 'CNY', 'actual', NULL),
      (${ignored}, 1, ${service}, NULL, 'received', 'replay', 200, 'CNY', 'actual', NULL)`;
  for (let cost = 1; cost <= 12; cost++) {
    const id = await receipt(service, null, `article:${prefix}-${cost}`);
    await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, status, cost, currency, cost_basis)
      VALUES (${id}, 1, ${service}, 'received', ${cost}, 'USD', 'actual')`;
  }
  const { topSubjects } = await costsOverview(1);
  assert.equal(topSubjects.length, 10);
  assert.deepEqual(topSubjects[0], { subject, calls: 4, cost: 18, currency: "CNY", estimate: { amount: 4, currency: "CNY" } });
  assert.deepEqual(topSubjects.slice(1).map((row) => row.subject), [12, 11, 10, 9, 8, 7, 6, 5, 4].map((n) => `article:${prefix}-${n}`));
});

test("price writes insert and replace a rate and return the price table", async () => {
  const service = services.writable;
  const initial = { service, model: "", currency: "CNY", inputPerMtok: 0.75, cachedPerMtok: null, outputPerMtok: 2 };
  assert.deepEqual((await upsertCostPrice(initial, prefix)).find((row) => row.service === service), initial);
  const updated = { ...initial, currency: "USD", inputPerMtok: null, cachedPerMtok: 0, outputPerMtok: 3.125 };
  const prices = await upsertCostPrice(updated, prefix);
  assert.deepEqual(prices.filter((row) => row.service === service), [updated]);
  assert.deepEqual((await costsOverview()).prices, prices);
  const changes = await sql`SELECT before, after FROM audit_log WHERE actor = ${prefix} AND action = 'costs.price'
    AND subject = ${`${service}/`} ORDER BY id`;
  assert.deepEqual([...changes], [{ before: null, after: initial }, { before: initial, after: updated }]);
});

test("output KPIs count distinct selections and reports and isolate article pipeline spend", async (t) => {
  const { outputs: before } = await costsOverview(1);
  const service = services.pipeline;
  const id = await receipt(service, "test-model", null, "score_article");
  const other = await receipt(service, null);
  const older = new Date(Date.now() - 2 * 86400_000);
  t.after(async () => {
    await sql`DELETE FROM selected_ledger WHERE article_id LIKE ${`${prefix}%`}`;
    await sql`DELETE FROM reports WHERE key LIKE ${`${prefix}%`}`;
  });
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok)
    VALUES (${service}, 'test-model', 'CNY', 2)`;
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, origin, cost, currency, cost_basis, usage)
    VALUES
      (${id}, 1, ${service}, 'test-model', 'received', 'live', 1, 'USD', 'actual', NULL),
      (${id}, 2, ${service}, 'test-model', 'received', 'live', 0.5, 'USD', 'estimated', NULL),
      (${id}, 3, ${service}, 'test-model', 'received', 'live', NULL, NULL, NULL, '{"prompt_tokens":1000000}'),
      (${id}, 4, ${service}, 'test-model', 'received', 'replay', 100, 'CNY', 'actual', NULL),
      (${other}, 1, ${service}, NULL, 'received', 'live', 20, 'CNY', 'actual', NULL)`;
  await sql`INSERT INTO selected_ledger (seq, article_id, op, changed_at)
    VALUES (-1, ${prefix}, 'upsert', now()), (-2, ${prefix}, 'upsert', now()),
      (-3, ${`${prefix}-removed`}, 'remove', now()), (-4, ${`${prefix}-older`}, 'upsert', ${older})`;
  await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
    VALUES ('daily', ${prefix}, now(), now(), '{}', now()), ('weekly', ${`${prefix}-older`}, ${older}, ${older}, '{}', ${older})`;

  const { outputs } = await costsOverview(1);
  assert.deepEqual(outputs, {
    selectedArticles: before.selectedArticles + 1,
    reports: before.reports + 1,
    pipelineCost: { ...before.pipelineCost, CNY: (before.pipelineCost.CNY ?? 0) + 2, USD: (before.pipelineCost.USD ?? 0) + 1.5 },
  });
});

test("cost CSVs have a BOM and Chinese headers and quote provider fields", () => {
  const model = 'a,"b"';
  const usage = {
    service: "provider", model, calls: 1, retried: 0, tokensIn: 10, tokensOut: 5,
    actualCost: 2, recordedCost: null, wasteCost: null, failedCost: null, currency: "CNY", estimate: null,
  };
  const data = {
    daily: [{ day: "2024-02-02", calls: 1, spend: [{ amount: 2, currency: "CNY" }] }],
    rows: [{ ...usage, purpose: "score_article" }, { ...usage, purpose: "prefilter_article" }],
    topSubjects: [{ subject: "article:test", calls: 1, cost: 2, currency: "CNY", estimate: null }],
  };
  assert.equal(costsCsv("daily", data), "\uFEFF日期,调用次数,花费\r\n2024-02-02,1,CNY 2\r\n");
  const models = costsCsv("models", data).trimEnd().split("\r\n");
  assert.match(models[0]!, /^\uFEFF服务,模型,调用次数,/);
  assert.deepEqual(models.slice(1), ['provider,"a,""b""",2,0,20,10,CNY 4,,,,']);
  const purposes = costsCsv("purposes", data).trimEnd().split("\r\n");
  assert.match(purposes[0]!, /^\uFEFF服务,模型,用途,调用次数,/);
  assert.equal(purposes.length, 3);
  assert.equal(costsCsv("subjects", data), "\uFEFF内容,调用次数,花费,币种,单价估算\r\narticle:test,1,2,CNY,\r\n");
});

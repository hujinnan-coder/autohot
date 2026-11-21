import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { costsOverview } from "@aihot/backend/admin/costs";
import { closeDb, sql } from "@aihot/backend/db";
import { balanceRunway, fetchProviderBalances, platformBalances } from "@aihot/backend/operations/balances";
import { addDays, beijingAt, beijingDate } from "@aihot/contracts/time";

const fixture = `test-balances-${tag()}`;

after(async () => {
  await sql`DELETE FROM provider_balances WHERE raw->>'fixture' = ${fixture}`;
  await closeDb();
});

test("provider balance requests use each configured account and save its first balance", async (t) => {
  const flash = { fixture, is_available: true, balance_infos: [
    { currency: "CNY", total_balance: "12.23", granted_balance: "0.23", topped_up_balance: "12.00" },
    { currency: "USD", total_balance: "20.00", granted_balance: "5.00", topped_up_balance: "15.00" },
  ] };
  const pro = { fixture, is_available: false, balance_infos: [
    { currency: "CNY", total_balance: "2.30", granted_balance: "0.00", topped_up_balance: "2.30" },
  ] };
  const mimo = { fixture, object: "balance", is_available: true, balance_infos: [
    { currency: "CNY", cash_balance: "47.58", gift_balance: "1.00", total_available: "48.58" },
  ] };
  const replies: Record<string, object> = {
    "/flash/user/balance": flash,
    "/pro/user/balance": pro,
    "/mimo/v1/platform/balance": mimo,
  };
  const requests: { method?: string; path: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    const path = req.url ?? "/";
    requests.push({ method: req.method, path, authorization: req.headers.authorization });
    const reply = replies[path];
    res.writeHead(reply ? 200 : 403, { "content-type": "application/json" });
    res.end(JSON.stringify(reply ?? { error: "unavailable" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  const url = `http://127.0.0.1:${port}`;
  const env = {
    DEEPSEEK_BASE_URL: `${url}/flash/v1/`, DEEPSEEK_API_KEY: "fake-flash",
    LLM_BASE_URL: `${url}/pro`, LLM_API_KEY: "fake-pro",
    XIAOMI_MIMO_BASE_URL: `${url}/mimo/v1`, XIAOMI_MIMO_API_KEY: "fake-mimo",
  };
  for (const [key, value] of Object.entries(env)) {
    const previous = process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
    process.env[key] = value;
  }

  const result = await fetchProviderBalances();
  assert.deepEqual(result.accounts, [
    { service: "deepseek", account: "DEEPSEEK_API_KEY", status: "ok" },
    { service: "deepseek", account: "LLM_API_KEY", status: "ok" },
    { service: "mimo", account: "XIAOMI_MIMO_API_KEY", status: "ok" },
  ]);
  assert.deepEqual(requests.sort((a, b) => a.path.localeCompare(b.path)), [
    { method: "GET", path: "/flash/user/balance", authorization: "Bearer fake-flash" },
    { method: "GET", path: "/mimo/v1/platform/balance", authorization: "Bearer fake-mimo" },
    { method: "GET", path: "/pro/user/balance", authorization: "Bearer fake-pro" },
  ]);
  const snapshots = () => sql`
    SELECT service, account, currency, balance, granted, topped_up, is_available, raw
    FROM provider_balances WHERE raw->>'fixture' = ${fixture} ORDER BY account`;
  assert.deepEqual([...(await snapshots())], [
    { service: "deepseek", account: "DEEPSEEK_API_KEY", currency: "CNY", balance: 12.23, granted: 0.23, topped_up: 12, is_available: true, raw: flash },
    { service: "deepseek", account: "LLM_API_KEY", currency: "CNY", balance: 2.3, granted: 0, topped_up: 2.3, is_available: false, raw: pro },
    { service: "mimo", account: "XIAOMI_MIMO_API_KEY", currency: "CNY", balance: 48.58, granted: null, topped_up: null, is_available: true, raw: mimo },
  ]);

  delete replies["/pro/user/balance"];
  delete process.env.XIAOMI_MIMO_BASE_URL;
  requests.length = 0;
  const partial = await fetchProviderBalances();
  assert.deepEqual(partial.accounts, [
    { service: "deepseek", account: "DEEPSEEK_API_KEY", status: "ok" },
    { service: "deepseek", account: "LLM_API_KEY", status: "error", error: "Error: Balance HTTP 403" },
  ]);
  assert.deepEqual(requests.map((r) => r.path).sort(), ["/flash/user/balance", "/pro/user/balance"]);
  assert.deepEqual((await snapshots()).map((r) => r.account), ["DEEPSEEK_API_KEY", "DEEPSEEK_API_KEY", "LLM_API_KEY", "XIAOMI_MIMO_API_KEY"]);
});

test("platform spend sums adjacent pairs with both snapshots inside the window", async () => {
  const deepseek = `${fixture}-deepseek`;
  const mimo = `${fixture}-mimo`;
  const sparse = `${fixture}-sparse`;
  await sql`
    INSERT INTO provider_balances (service, account, currency, balance, granted, topped_up, is_available, raw, fetched_at)
    SELECT service, account, 'CNY', balance, granted, topped_up, true, ${sql.json({ fixture })}, now() - hours * interval '1 hour'
    FROM (VALUES
      ('deepseek', ${deepseek}, 80, 100, 10, 90),
      ('deepseek', ${deepseek}, 60, 96, 9, 87),
      ('deepseek', ${deepseek}, 10, 112, 9, 107),
      ('deepseek', ${deepseek}, 8, 114, 14, 107),
      ('deepseek', ${deepseek}, 6, 110, 10, 107),
      ('deepseek', ${deepseek}, 4, 130, 10, 127),
      ('deepseek', ${deepseek}, 2, 128, 8, 127),
      ('mimo', ${mimo}, 10, 12.34, NULL, NULL),
      ('mimo', ${mimo}, 8, 20.34, NULL, NULL),
      ('mimo', ${mimo}, 2, 18.11, NULL, NULL),
      ('mimo', ${sparse}, 25, 12, NULL, NULL),
      ('mimo', ${sparse}, 2, 10, NULL, NULL)
    ) AS snapshots(service, account, hours, balance, granted, topped_up)`;

  const platform = await platformBalances(1);
  const flash = platform.find((row) => row.account === deepseek);
  assert.deepEqual(flash?.spendWindow, { days: 1, amount: 9 });
  assert.equal(flash?.sinceFirst, 17);
  assert.equal(flash?.samples, 7);
  assert.equal(flash?.balance, 128);
  assert.equal(flash?.granted, 8);
  assert.equal(flash?.toppedUp, 127);

  const mimoBalance = platform.find((row) => row.account === mimo);
  assert.deepEqual(mimoBalance?.spendWindow, { days: 1, amount: 2.23 });
  assert.equal(mimoBalance?.sinceFirst, 2.23);
  const sparseBalance = platform.find((row) => row.account === sparse);
  assert.equal(sparseBalance?.spendWindow, null);
  assert.equal(sparseBalance?.sinceFirst, 2);
  assert.equal(sparseBalance?.samples, 2);
  assert.deepEqual((await costsOverview(1)).platform, platform);
});

test("balance runway combines shared credentials and averages across Beijing days with calls", async (t) => {
  const accounts = ["DEEPSEEK_API_KEY", "LLM_API_KEY"];
  for (const account of accounts) {
    const previous = process.env[account];
    t.after(() => {
      if (previous === undefined) delete process.env[account];
      else process.env[account] = previous;
    });
    process.env[account] = `${fixture}-shared-key`;
  }
  const model = `${fixture}-model`;
  t.after(async () => {
    await sql`DELETE FROM receipts WHERE purpose = ${fixture}`;
    await sql`DELETE FROM service_prices WHERE service = 'deepseek' AND model = ${model}`;
  });
  await sql`INSERT INTO provider_balances (service, account, currency, balance, is_available, raw)
    VALUES ('deepseek', 'DEEPSEEK_API_KEY', 'CNY', 23, true, ${sql.json({ fixture })}),
           ('deepseek', 'LLM_API_KEY', 'CNY', 23, true, ${sql.json({ fixture })})`;
  await sql`INSERT INTO service_prices (service, model, currency, input_per_mtok)
    VALUES ('deepseek', ${model}, 'CNY', 2)`;
  const [deepseek, llm] = await sql<{ id: number }[]>`
    INSERT INTO receipts (logical_key, service, model, purpose, status)
    VALUES (${`${fixture}-deepseek`}, 'deepseek', ${model}, ${fixture}, 'completed'),
           (${`${fixture}-llm`}, 'llm', ${model}, ${fixture}, 'completed')
    RETURNING id`;
  const today = beijingDate(Date.now());
  const first = beijingAt(addDays(today, -4), "12:00");
  const next = beijingAt(addDays(today, -2), "12:00");
  await sql`INSERT INTO receipt_attempts (receipt_id, attempt, service, model, status, usage, cost, currency, cost_basis, started_at)
    VALUES
      (${deepseek!.id}, 1, 'deepseek', ${model}, 'received', '{"prompt_tokens":2000000}', NULL, NULL, NULL, ${first}),
      (${llm!.id}, 1, 'llm', ${model}, 'received', '{"prompt_tokens":1000000}', 3, 'CNY', 'estimated', ${first}),
      (${deepseek!.id}, 2, 'deepseek', ${model}, 'received', '{"prompt_tokens":1000000}', NULL, NULL, NULL, ${next})`;

  const { runway } = await costsOverview(7);
  assert.deepEqual(runway.filter((row) => row.accounts.some((account) => accounts.includes(account))), [
    { accounts, currency: "CNY", balance: 23, dailySpend: 4.5, daysLeft: 5 },
  ]);
  const sharesKey = (row: { accounts: string[] }) => row.accounts.includes("DEEPSEEK_API_KEY");
  assert.deepEqual((await balanceRunway(1)).find(sharesKey), {
    accounts, currency: "CNY", balance: 23, dailySpend: null, daysLeft: null,
  });
  await sql`UPDATE receipt_attempts SET currency = 'USD' WHERE receipt_id = ${llm!.id}`;
  assert.deepEqual((await balanceRunway(7)).find(sharesKey), {
    accounts, currency: "CNY", balance: 23, dailySpend: null, daysLeft: null,
  });
});

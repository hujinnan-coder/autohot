import { stub } from "./setup.ts";
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { beijingAt } from "@aihot/contracts/time";
import { closeDb, sql } from "@aihot/backend/db";
import { getBoss, stopBoss } from "@aihot/backend/jobs/queue";
import { checkAlerts, collectFindings } from "@aihot/backend/operations/alerts";

const at = (date: string, time = "10:00") => beijingAt(date, time).getTime();
const key = (date: string) => `report.daily:${date}`;
const daily = (keys: string[]) => keys.filter(k => k.startsWith("report.daily"));
async function report(date: string) {
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at) VALUES('daily',${date},${new Date(at(date))},${new Date(at(date))},'{}',${new Date(at(date))})`;
}
let feishu: Awaited<ReturnType<typeof stub>>;
const notices: string[] = [];
before(async () => {
  feishu = await stub((_hit, req) => {
    notices.push(req.body);
    return { code: 0 };
  });
  Object.assign(process.env, { FEISHU_INTERNAL_ENABLED: "true", FEISHU_ALERT_WEBHOOK_URL: feishu.url, WEBHOOK_HUB_URL: "" });
  await getBoss();
});
beforeEach(async () => {
  notices.length = 0;
  Object.assign(process.env, { COLLECT_ENABLED: "true", MODEL_CALLS_ENABLED: "true" });
  await sql`DELETE FROM reports`;
  await sql`DELETE FROM job_runs WHERE job='reports.compose'`;
  await sql`DELETE FROM settings WHERE key IN ('alerts.state','heartbeat.worker')`;
});
after(async () => { await feishu?.close(); await stopBoss(); await closeDb(); });

test("midnight preserves a missing edition; each date recovers only when its report exists", async () => {
  let result = await checkAlerts(at("2026-10-06", "23:30"));
  assert.deepEqual(daily(result.sent), [key("2026-10-06")]);
  result = await checkAlerts(at("2026-10-07", "00:10"));
  assert.deepEqual(daily(result.open), [key("2026-10-06")]);
  assert.deepEqual(daily(result.sent), []);
  result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open).sort(), [key("2026-10-06"), key("2026-10-07")]);
  await report("2026-10-07");
  result = await checkAlerts(at("2026-10-07", "10:10"));
  assert.deepEqual(daily(result.sent), [`${key("2026-10-07")}:recovered`]);
  assert.deepEqual(daily(result.open), [key("2026-10-06")]);
  await report("2026-10-06");
  assert.deepEqual(daily((await checkAlerts(at("2026-10-07", "10:20"))).sent), [`${key("2026-10-06")}:recovered`]);
  assert.deepEqual(daily((await checkAlerts(at("2026-10-07", "10:30"))).sent), []);
});

test("recent gap detection uses report activity and each edition's overdue time", async () => {
  await sql`INSERT INTO job_runs(job,started_at,status) VALUES('reports.compose',${new Date(at("2026-10-05"))},'failed')`;
  await report("2026-10-06");
  const findings = await collectFindings(at("2026-10-07", "08:59"));
  assert.deepEqual(daily(findings.map(f => f.key)), [key("2026-10-05")]);
  await report("2026-09-01");
  assert.deepEqual(daily((await collectFindings(at("2026-10-07"))).map(f => f.key)),
    [1,2,3,4,5,7].map(d => key(`2026-10-0${d}`)));
});

test("open dates outlive disabled generation and restarts keep checking missing editions", async () => {
  await checkAlerts(at("2026-10-01"));
  process.env.MODEL_CALLS_ENABLED = "false";
  let result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open), [key("2026-10-01")]);
  assert.deepEqual(daily(result.sent), []);
  process.env.MODEL_CALLS_ENABLED = "true";
  await sql`INSERT INTO settings(key,value) VALUES('heartbeat.worker',${sql.json({ startedAt: new Date(at("2026-10-07")).toISOString() })})`;
  result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(daily(result.open), [key("2026-10-01"), key("2026-10-07")]);
  assert.ok(result.sent.includes(key("2026-10-01")), "a restart keeps checking the unresolved edition");
  await sql`DELETE FROM settings WHERE key='heartbeat.worker'`;
  result = await checkAlerts(at("2026-10-07"));
  assert.deepEqual(result.sent, [], "rechecking after the restart does not duplicate the reminder");
  process.env.COLLECT_ENABLED = "false";
  await report("2026-10-01");
  assert.ok((await checkAlerts(at("2026-10-07", "10:10"))).sent.includes(`${key("2026-10-01")}:recovered`));
});

test("an edition still missing past the scan window is closed once instead of reminded forever", async () => {
  await checkAlerts(at("2026-10-01"));
  let result = await checkAlerts(at("2026-10-08"));
  assert.ok(result.sent.includes(`${key("2026-10-01")}:expired`));
  assert.ok(!result.open.includes(key("2026-10-01")));
  result = await checkAlerts(at("2026-10-08", "12:00"));
  assert.ok(!result.sent.some(k => k.startsWith(key("2026-10-01"))));
});

const WEEK_KEY = "report.weekly:2026-W41";
const MONDAY = "2026-10-12";
async function weekly() {
  await sql`INSERT INTO reports(kind,key,window_start,window_end,content,generated_at)
    VALUES('weekly','2026-W41',now(),now(),'{}',now())`;
}

test("weekly and monthly gaps page the owner only after their two-hour grace periods", async () => {
  await report("2026-10-10");
  assert.ok(!(await collectFindings(at(MONDAY, "11:59"))).some(f => f.key === WEEK_KEY));
  const findings = await collectFindings(at(MONDAY, "12:00"));
  const weeklyGaps = findings.filter(f => f.key.startsWith("report.weekly:"));
  assert.deepEqual(weeklyGaps.map(f => [f.key, f.level]), [[WEEK_KEY, "now"]]);
  const monthlyKey = "report.monthly:2026-10";
  assert.ok(!(await collectFindings(at("2026-11-01", "12:29"))).some(f => f.key === monthlyKey));
  assert.equal((await collectFindings(at("2026-11-01", "12:30"))).find(f => f.key === monthlyKey)?.level, "now");
});

test("a published weekly has no missing-issue finding", async () => {
  await report("2026-10-10");
  await weekly();
  assert.ok(!(await collectFindings(at(MONDAY, "12:00"))).some(f => f.key === WEEK_KEY));
});

test("a missing weekly recovers when its issue is published", async () => {
  await report("2026-10-10");
  assert.ok((await checkAlerts(at(MONDAY, "12:00"))).sent.includes(WEEK_KEY));
  await weekly();
  const result = await checkAlerts(at(MONDAY, "12:10"));
  assert.ok(result.sent.includes(`${WEEK_KEY}:recovered`));
  assert.ok(!result.open.includes(WEEK_KEY));
});

test("a weekly still missing beyond the scan window stops reminders without claiming recovery", async () => {
  await report("2026-10-10");
  assert.ok((await checkAlerts(at(MONDAY, "12:00"))).sent.includes(WEEK_KEY));
  notices.length = 0;
  const result = await checkAlerts(at("2026-11-16", "12:00"));
  assert.ok(result.sent.includes(`${WEEK_KEY}:expired`));
  assert.ok(!result.sent.includes(`${WEEK_KEY}:recovered`));
  assert.ok(!result.open.includes(WEEK_KEY));
  assert.ok(notices.some(body => body.includes("2026-W41 的周报没能补出，停止提醒")));
});

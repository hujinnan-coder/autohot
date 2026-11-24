import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { beijingAt } from "@aihot/contracts/time";
import { migrationPlan } from "../../../scripts/migration-safety.ts";
import { DAY, HOUR, LIMITS, MINUTE, readerConfig } from "../backend/config.ts";
import { publicWallPath } from "../backend/gate-policy.ts";
import { adminLookupsInput, eventsInput } from "../backend/inputs.ts";
import { NotConfigured, unconfiguredMailer } from "../backend/mailer.ts";
import { displayInvite, EVENT_KINDS, generateInvite, normalizeInvite, otpRetryAfter, sameOrigin, secretHash, sessionTiming } from "../backend/rules.ts";

test("invitation codes use the unambiguous alphabet, accept formatting and hash with the deployment key", () => {
  const codes = new Set(Array.from({ length: 200 }, generateInvite));
  assert.equal(codes.size, 200);
  for (const code of codes) {
    assert.match(code, /^[2-9A-HJKM-NP-Z]{10}$/);
    assert.match(displayInvite(code), /^.{2}-.{4}-.{4}$/);
    assert.equal(normalizeInvite(` ${displayInvite(code).toLowerCase().replace("-", " - ")} `), code);
  }
  for (const invalid of ["023456789A", "O23456789A", "123456789A", "I23456789A", "L23456789A", "A-very-long-code"]) {
    assert.equal(normalizeInvite(invalid), null);
  }
  const code = "ABCD234567";
  const hash = secretHash("key", "invite", code);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(secretHash("key", "invite", normalizeInvite(displayInvite(code))!), hash);
  assert.notEqual(secretHash("other key", "invite", code), hash);
  assert.notEqual(secretHash("key", "otp", code), hash);
});

test("session timing applies idle and absolute deadlines and throttles rolling writes", () => {
  const policy = readerConfig({}, "test");
  const now = new Date("2026-11-24T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const tomorrow = ago(-DAY);
  assert.deepEqual(sessionTiming(now, ago(72 * HOUR), tomorrow, policy), { valid: false, renew: false });
  assert.deepEqual(sessionTiming(now, ago(72 * HOUR - 1), tomorrow, policy), { valid: true, renew: true });
  assert.deepEqual(sessionTiming(now, ago(5 * MINUTE), now, policy), { valid: false, renew: false });
  assert.deepEqual(sessionTiming(now, ago(10 * MINUTE - 1), tomorrow, policy), { valid: true, renew: false });
  assert.deepEqual(sessionTiming(now, ago(10 * MINUTE), tomorrow, policy), { valid: true, renew: true });
  assert.equal(policy.sessionLifetime, 30 * DAY);
  assert.equal(policy.maxSessions, 3);
});

test("OTP throttling returns the longest remaining cooldown across email and IP limits", () => {
  const now = new Date("2026-11-24T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const spaced = [1, 2, 3, 4, 5].map(n => ago(n * MINUTE));
  assert.equal(otpRetryAfter(now, [], []), 0);
  assert.equal(otpRetryAfter(now, [ago(15_000)], []), 45);
  assert.equal(otpRetryAfter(now, spaced.slice(0, -1), []), 0);
  assert.equal(otpRetryAfter(now, spaced, []), 55 * 60);
  assert.equal(otpRetryAfter(now, [], Array.from({ length: LIMITS.otpIpPerHour }, () => ago(HOUR - 10_000))), 10);
  assert.equal(otpRetryAfter(now, [ago(15_000)], Array.from({ length: LIMITS.otpIpPerHour }, () => ago(HOUR - 10_000))), 45);
});

test("the wall exempts explicit entrances and fails closed for content and unlisted paths", () => {
  for (const path of ["/api/site/meta", "/api/v1/agent", "/api/v1/items", "/api/mcp", "/api/img-proxy", "/feed.xml",
    "/feed/all.xml", "/llms.txt", "/sitemap.xml", "/sitemaps/items.xml", "/items/example/markdown",
    "/future-content", "/api/reader-future", "/og/posters/example.png", "/og/future"]) {
    assert.equal(publicWallPath(path, "GET"), false, path);
  }
  for (const path of ["/api/health", "/robots.txt", "/api/auth/login", "/api/admin/readers", "/api/reader/session", "/logo.svg"]) {
    assert.equal(publicWallPath(path, "GET"), true, path);
  }
  assert.equal(publicWallPath("/api/ingest/items", "POST"), true);
  assert.equal(publicWallPath("/api/ingest/example", "POST"), false);
  assert.equal(publicWallPath("/og/items/example.png", "HEAD", "/og/items/:file"), true);
  assert.equal(publicWallPath("/api/health", "PATCH"), false);
});

test("origin validation compares protocol, authority and port without accepting a path or spoofed authority", () => {
  assert.equal(sameOrigin("https://example.test", "example.test", "https"), true);
  assert.equal(sameOrigin("http://[::1]:3000", "[::1]:3000", "http"), true);
  for (const origin of [undefined, "null", "http://example.test", "https://example.test:8443", "https://else.test", "https://example.test/path"]) {
    assert.equal(sameOrigin(origin, "example.test", "https"), false);
  }
  assert.equal(sameOrigin("https://else.test", "example.test@else.test", "https"), false);
});

test("event input accepts the supported kinds and rejects unlisted kinds and device fingerprints", () => {
  const events = EVENT_KINDS.map(kind => kind === "dwell" ? { kind, dwell_bucket: "10_29s" } : { kind });
  assert.equal(eventsInput.safeParse({ events }).success, true);
  for (const invalid of [
    { kind: "login" }, { kind: "dwell" }, { kind: "dwell", dwell_bucket: "every-millisecond" },
    { kind: "view_item", query: "unnecessary" }, { kind: "view_item", fingerprint: "device" },
  ]) {
    assert.equal(eventsInput.safeParse({ events: [invalid] }).success, false);
  }
  assert.equal(eventsInput.safeParse({ events: Array.from({ length: LIMITS.eventBatch + 1 }, () => events[0]) }).success, false);
});

test("admin lookups accept one page of applications and up to two reader IDs per invite", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  const ids = (count: number) => Array.from({ length: count }, () => id).join(",");
  assert.deepEqual(adminLookupsInput.parse({ reader_ids: ids(2), application_ids: id }), {
    reader_ids: [id, id], application_ids: [id],
  });
  assert.equal(adminLookupsInput.safeParse({ reader_ids: ids(2 * LIMITS.resultPage), application_ids: ids(LIMITS.resultPage) }).success, true);
  assert.equal(adminLookupsInput.safeParse({ reader_ids: ids(2 * LIMITS.resultPage + 1) }).success, false);
  assert.equal(adminLookupsInput.safeParse({ application_ids: ids(LIMITS.resultPage + 1) }).success, false);
});

test("reader configuration requires both secrets and a 32-character token for an enabled wall", async () => {
  assert.equal(readerConfig({ READER_WALL_ENABLED: "1", READER_CHILD_INVITES_ENABLED: "yes" }, null).wallEnabled, false);
  assert.equal(readerConfig({}, null).childEnabled, false);
  assert.equal(readerConfig({}, null).childQuota, 2);
  assert.equal(readerConfig({}, null).inviteLifetime, 72 * HOUR);
  const wall = { READER_WALL_ENABLED: "true" };
  const token = "x".repeat(32);
  assert.throws(() => readerConfig(wall, "test"), /READER_INTERNAL_TOKEN/);
  assert.throws(() => readerConfig({ ...wall, READER_INTERNAL_TOKEN: " " + token.slice(1) }, "test"), /at least 32 characters/);
  assert.throws(() => readerConfig({ ...wall, READER_INTERNAL_TOKEN: token }, null), /SESSION_SECRET/);
  assert.equal(readerConfig({ ...wall, READER_INTERNAL_TOKEN: token }, "test").internalToken, token);
  assert.equal(readerConfig({ READER_INTERNAL_TOKEN: "short" }, null).wallEnabled, false);
  await assert.rejects(unconfiguredMailer.send({ to: "test@example.test", subject: "", text: "", html: "" }), NotConfigured);
});

test("each reader migration is a single online-safe statement", () => {
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).sort();
  assert.ok(files[0]?.startsWith("0180_"));
  for (const file of files) {
    const statement = readFileSync(new URL(file, dir), "utf8");
    const plan = migrationPlan(statement);
    assert.ok(plan.kind === "index" || (plan.kind === "transaction" && /^(?:CREATE TABLE IF NOT EXISTS |ALTER TABLE reader_users ADD COLUMN IF NOT EXISTS inactivity_\w+ timestamptz;)/.test(statement)), file);
  }
  const identityIndex = readFileSync(new URL("0206_reader_identity_user_provider.sql", dir), "utf8");
  assert.match(identityIndex, /^CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS \w+ ON reader_auth_identities \(user_id, provider\);/);
});

// Isolation: per-file process with the standalone unreachable database, fixed Beijing time and a fake mailer.
test("reader inactivity schedules use the default thresholds and skip an out-of-window 11:00 job", async () => {
  const { createReaderAccounts } = await import("../server.ts");
  const policy = readerConfig({ READER_MAIL_ENABLED: "true" }, null);
  assert.equal(policy.inactiveDays, 30);
  assert.equal(policy.inactiveGraceDays, 3);
  assert.equal(policy.adminEmail, null);
  assert.equal(readerConfig({ READER_ADMIN_EMAIL: " owner@example.test " }, null).adminEmail, "owner@example.test");
  let now = beijingAt("2025-02-03", "10:59");
  const { schedules } = createReaderAccounts({ policy, now: () => now, mailer: {
    async send() { assert.fail("out-of-window job sent mail"); },
  } });
  assert.deepEqual(schedules?.map(({ name, cron, missed }) => [name, cron, missed]), [
    ["reader-accounts.inactive-notice", "0 11 * * *", "once"],
    ["reader-accounts.inactive-final-notice", "0 9 * * *", "once"],
    ["reader-accounts.inactive-digest", "0 11 * * 1", "once"],
  ]);
  for (const time of ["10:59", "11:01"]) {
    now = beijingAt("2025-02-03", time);
    assert.deepEqual(await schedules![0]!.run(), { reminded: 0, deleted: 0, deferred: 0, failed: 0 });
  }
});

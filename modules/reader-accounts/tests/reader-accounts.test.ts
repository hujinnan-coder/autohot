import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test, type TestContext } from "node:test";
import type { FastifyInstance, InjectOptions, RouteOptions } from "fastify";
import { reportDateLabel } from "@aihot/contracts/site";
import { beijingAt } from "@aihot/contracts/time";
import { withSubject } from "@aihot/site";
import { gate, tag } from "../../../tests/setup.ts";
import { DAY, HOUR, LIMITS, MINUTE, readerConfig } from "../backend/config.ts";
import type { Mail, Mailer } from "../backend/mailer.ts";
import { secretHash, sessionToken, tokenHash } from "../backend/rules.ts";
import { assertAnonymousWall } from "./wall-cases.ts";

const password = "reader-test-admin-password";
process.env.ADMIN_PASSWORD = password;
const { sql, closeDb } = await import("@aihot/backend/db");
const { sessionPrincipal, passwordLogin } = await import("@aihot/backend/admin/auth");
const { installModules } = await import("@aihot/backend/modules");
const { buildApp } = await import("@aihot/api/app");
const { upsertMaterial } = await import("@aihot/backend/content/materials");
const { ogEtag } = await import("@aihot/backend/media/og");
const { SERVER_MODULES } = await import("@aihot/site/modules/server");
const { createReaderAccounts } = await import("../server.ts");
const { issueOtp, verifyOtp } = await import("../backend/otp.ts");
const { approveReader } = await import("../backend/accounts.ts");
const { adminIssueInvites } = await import("../backend/invites.ts");
const { retainReaderData } = await import("../backend/events.ts");
after(closeDb);

class TestMailer implements Mailer {
  readonly messages: Mail[] = [];
  fail = false;
  async send(mail: Mail) {
    if (this.fail) throw new Error("test mail failed");
    this.messages.push(mail);
  }
}

const secret = "reader-account-test-secret";
const internal = "reader-internal-test-token-32-characters";
const BASE = "/api/reader";
const ADMIN_INVITES = "/api/admin/reader-invites";
const ADMIN_READERS = "/api/admin/readers";
const ADMIN_APPLICATIONS = "/api/admin/reader-applications";
const ADMIN_LOOKUPS = "/api/admin/reader-lookups";
const profile = { name: "测试读者", company: "示例公司", job_title: "产品经理", wechat: "wechat-example", referrer: "介绍人" };
const consent = { tracking_consent: false, terms_accepted: true, privacy_accepted: true, terms_version: "1", privacy_version: "1" };
let ipSequence = 0;
function uniqueIp() {
  ipSequence++;
  return `198.18.${Math.floor(ipSequence / 256)}.${ipSequence % 256}`;
}
const age = (ms: number) => new Date(Date.now() - ms);
const emailFor = () => `reader-${tag()}@example.test`;

async function open(t: TestContext, env: NodeJS.ProcessEnv = {}) {
  const policy = readerConfig({ READER_WALL_ENABLED: "true", READER_INTERNAL_TOKEN: internal, READER_MAIL_ENABLED: "true", ...env }, secret);
  const mailer = new TestMailer();
  const readerModule = createReaderAccounts({ policy, mailer, siteUrl: "https://reader.test" });
  const routes: RouteOptions[] = [];
  installModules([...SERVER_MODULES.filter(m => m.name !== "reader-accounts"), readerModule]);
  const app = await buildApp({ onRoute: route => { routes.push(route); } });
  t.after(() => app.close());
  const ip = uniqueIp();
  const call = (method: InjectOptions["method"], url: string, payload?: InjectOptions["payload"], headers: InjectOptions["headers"] = {}) =>
    app.inject({ method, url, payload, remoteAddress: ip, headers: { host: "reader.test", origin: "https://reader.test", "x-forwarded-proto": "https", ...headers } });
  async function otp(email: string) {
    const { code } = await issueOtp(policy, email, ip);
    return verifyOtp(policy, email, code);
  }
  async function signup(code: string, email = emailFor(), fields: Partial<typeof profile & typeof consent> = {}) {
    const { ticket } = await otp(email);
    return call("POST", `${BASE}/register`, { email, code, ticket, ...profile, ...consent, ...fields });
  }
  async function newReader(fields: Partial<typeof profile & typeof consent> = {}) {
    const [invite] = await adminIssueInvites(policy, 1, {});
    const email = emailFor();
    const res = await signup(invite!.code, email, fields);
    assert.equal(res.statusCode, 201, res.body);
    const cookie = readerSessionCookie(res.headers["set-cookie"]);
    const me = await call("GET", `${BASE}/me`, undefined, { cookie });
    assert.equal(me.statusCode, 200, me.body);
    return { email, cookie, invite: invite!, id: me.json().id as string, result: res.json() };
  }
  return { app, policy, mailer, call, routes, otp, signup, newReader, ip };
}

function readerSessionCookie(setCookie: string | string[] | undefined) {
  assert.equal(typeof setCookie, "string");
  assert.match(setCookie as string, /Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000; Secure$/);
  return (setCookie as string).split(";")[0]!;
}

async function adminHeaders() {
  const { token } = await passwordLogin(password, "/admin", undefined);
  const cookie = `aihot_admin=${token}`;
  const admin = await sessionPrincipal(cookie);
  assert.ok(admin && !admin.dev);
  return { cookie, "x-csrf-token": admin.csrf };
}

async function expectProtected(app: FastifyInstance, cookie: string | undefined, status: number) {
  const reply = await app.inject({ url: "/api/site/meta", headers: { cookie } });
  assert.equal(reply.statusCode, status, reply.body);
  assert.equal(reply.headers["cache-control"], "private, no-store");
}

// Isolation: per-file database copy plus tagged emails, invitation IDs and a dedicated request IP.
test("invite acceptance is atomic and one-use, and refuses expiry, revocation and a different bound email", async t => {
  const f = await open(t);
  const admin = await adminHeaders();
  const generated = await f.call("POST", ADMIN_INVITES, {}, admin);
  assert.equal(generated.statusCode, 201, generated.body);
  const invite = generated.json();
  assert.equal(invite.requires_approval, false);
  const [stored] = await sql`SELECT code_hash, expires_at, created_at FROM reader_invites WHERE id = ${invite.id}`;
  assert.equal(stored!.code_hash, secretHash(secret, "invite", invite.code.replaceAll("-", "")));
  assert.ok(stored!.expires_at.getTime() - stored!.created_at.getTime() > 71 * HOUR);

  const raced = await Promise.all([f.signup(invite.code), f.signup(invite.code)]);
  assert.deepEqual(raced.map(res => res.statusCode).sort(), [201, 400]);
  assert.equal(raced.find(res => res.statusCode === 201)!.json().status, "active");
  assert.deepEqual((await f.call("GET", `${BASE}/invite/check?code=${invite.code}`)).json(), { valid: false, bound_email: false });

  const rightEmail = emailFor();
  const [bound] = await adminIssueInvites(f.policy, 1, { bound_email: rightEmail });
  assert.deepEqual((await f.call("GET", `${BASE}/invite/check?code=${bound!.code}`)).json(), { valid: true, bound_email: true });
  assert.equal((await f.signup(bound!.code)).json().code, "invalid_invite");
  assert.equal((await f.signup(bound!.code, rightEmail)).statusCode, 201);
  const duplicateSubject = emailFor();
  await assert.rejects(sql`INSERT INTO reader_auth_identities (provider, subject, user_id)
    SELECT provider, ${duplicateSubject}, user_id FROM reader_auth_identities WHERE provider = 'email' AND subject = ${rightEmail}`,
    { code: "23505" });

  const [expired, revoked] = await adminIssueInvites(f.policy, 2, { batch_tag: tag() });
  await sql`UPDATE reader_invites SET expires_at = ${age(MINUTE)} WHERE id = ${expired!.id}`;
  assert.equal((await f.call("POST", `${ADMIN_INVITES}/${revoked!.id}/revoke`, undefined, admin)).statusCode, 204);
  for (const dead of [expired!, revoked!]) assert.equal((await f.signup(dead.code)).json().code, "invalid_invite");
  const list = await f.call("GET", ADMIN_INVITES, undefined, admin);
  assert.equal(list.statusCode, 200);
  assert.ok(list.json().invites.every((row: object) => !("code" in row) && !("code_hash" in row)));
});

// Isolation: per-file database copy plus tagged emails and separate IPs per app.
test("child invitation valve, automatic allotment, activation and the invitation chain", async t => {
  const off = await open(t, { READER_CHILD_INVITES_ENABLED: "yes" });
  const noChildren = await off.newReader();
  assert.deepEqual(noChildren.result.child_invites, []);
  const noCookie = { cookie: noChildren.cookie };
  assert.deepEqual((await off.call("GET", `${BASE}/me/invites`, undefined, noCookie)).json(), { invites: [], quota: 0 });
  assert.equal((await off.call("POST", `${BASE}/me/invites`, {}, noCookie)).json().code, "child_invites_disabled");
  assert.equal((await sql`SELECT id FROM reader_invites WHERE issuer_reader_id = ${noChildren.id}`).length, 0);

  const on = await open(t, { READER_CHILD_INVITES_ENABLED: "true" });
  const parent = await on.newReader();
  const parentCookie = { cookie: parent.cookie };
  assert.equal(parent.result.child_invites.length, 2);
  const [first, second] = parent.result.child_invites;
  assert.equal(first.requires_approval, true);
  const rows = (await on.call("GET", `${BASE}/me/invites`, undefined, parentCookie)).json().invites;
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row: object) => !("code" in row)));
  const replacement = await on.call("POST", `${BASE}/me/invites`, { replace_id: second.id }, parentCookie);
  assert.equal(replacement.statusCode, 201, replacement.body);
  assert.equal((await on.signup(second.code)).json().code, "invalid_invite");

  const pending = await on.signup(first.code);
  assert.equal(pending.statusCode, 201, pending.body);
  assert.equal(pending.json().status, "pending");
  assert.deepEqual(pending.json().child_invites, []);
  const cookie = readerSessionCookie(pending.headers["set-cookie"]);
  await expectProtected(on.app, cookie, 401);
  const me = await on.call("GET", `${BASE}/me`, undefined, { cookie });
  const id = me.json().id;
  await assert.rejects(approveReader(on.policy, parent.id), { code: "reader_not_pending" });
  const admin = await adminHeaders();
  const noCsrf = await on.call("POST", `${ADMIN_READERS}/${id}/approve`, undefined, { cookie: admin.cookie });
  assert.equal(noCsrf.statusCode, 403);
  const approved = await on.call("POST", `${ADMIN_READERS}/${id}/approve`, undefined, admin);
  assert.equal(approved.statusCode, 200, approved.body);
  assert.equal(approved.json().status, "active");
  assert.equal(approved.json().child_invites.length, 2);
  assert.equal(approved.json().email_sent, true);
  assert.equal(on.mailer.messages.length, 1);
  await expectProtected(on.app, cookie, 200);
  const details = await on.call("GET", `${ADMIN_READERS}/${id}`, undefined, admin);
  assert.equal(details.json().invited_by.id, parent.id);
});

// Isolation: per-file database copy plus tagged emails and distinct synthetic IPs for per-IP limits.
test("OTP confidentiality, six-digit email delivery, cooldown, rate limits, expiry and attempt exhaustion", async t => {
  const f = await open(t);
  const email = emailFor();
  const sent = await f.call("POST", `${BASE}/otp/send`, { email: email.toUpperCase() });
  assert.equal(sent.statusCode, 204, sent.body);
  assert.equal(sent.body, "");
  const mail = f.mailer.messages[0]!;
  const otp = /\d{6}/.exec(mail.text)![0];
  assert.equal(mail.to, email);
  const [row] = await sql`SELECT id, code_hash FROM reader_otps WHERE email = ${email}`;
  assert.equal(row!.code_hash, secretHash(secret, `otp:${row!.id}`, otp));
  const cooldown = await f.call("POST", `${BASE}/otp/send`, { email });
  assert.equal(cooldown.statusCode, 429);
  assert.ok(Number(cooldown.headers["retry-after"]) > 0);
  const wrong = otp === "000000" ? "000001" : "000000";
  for (let i = 0; i < LIMITS.otpAttempts; i++) {
    assert.equal((await f.call("POST", `${BASE}/otp/verify`, { email, code: wrong })).json().code, "invalid_otp");
  }
  assert.equal((await f.call("POST", `${BASE}/otp/verify`, { email, code: otp })).json().code, "invalid_otp");
  const [exhausted] = await sql`SELECT attempts, code_hash FROM reader_otps WHERE id = ${row!.id}`;
  assert.equal(exhausted!.attempts, 5);
  assert.equal(exhausted!.code_hash, null);

  const expiringEmail = emailFor();
  const expiring = await issueOtp(f.policy, expiringEmail, f.ip);
  await sql`UPDATE reader_otps SET expires_at = ${age(MINUTE)} WHERE id = ${expiring.id}`;
  await assert.rejects(verifyOtp(f.policy, expiringEmail, expiring.code), { code: "invalid_otp" });
  for (let i = 1; i < LIMITS.otpEmailPerHour; i++) {
    await sql`UPDATE reader_otps SET created_at = created_at - interval '70 seconds' WHERE email = ${email}`;
    await issueOtp(f.policy, email, f.ip);
  }
  await sql`UPDATE reader_otps SET created_at = created_at - interval '70 seconds' WHERE email = ${email}`;
  await assert.rejects(issueOtp(f.policy, email, uniqueIp()), { code: "rate_limited" });
  const busyIp = uniqueIp();
  for (let i = 0; i < LIMITS.otpIpPerHour; i++) await issueOtp(f.policy, emailFor(), busyIp);
  await assert.rejects(issueOtp(f.policy, emailFor(), busyIp), { code: "rate_limited" });
  // The real-IP header is set by the trusted web proxy. Forwarded header variations must not change its bucket.
  for (const forwarded of [busyIp, uniqueIp(), `${uniqueIp()}, ${busyIp}`]) {
    const limited = await f.call("POST", `${BASE}/otp/send`, { email: emailFor() },
      { "x-real-ip": busyIp, "x-forwarded-for": forwarded });
    assert.equal(limited.statusCode, 429, limited.body);
    assert.equal(limited.json().code, "rate_limited");
  }
});

// Isolation: per-file database copy plus tagged email. Timestamp edits use this reader's session hashes only.
test("session cap, slow rolling activity, idle/absolute expiration, logout, disable and restore", async t => {
  const f = await open(t);
  const reader = await f.newReader();
  const cookies = [reader.cookie];
  for (let i = 0; i < 3; i++) {
    await sql`UPDATE reader_otps SET created_at = created_at - interval '70 seconds' WHERE email = ${reader.email}`;
    const { code } = await issueOtp(f.policy, reader.email, f.ip);
    const login = await f.call("POST", `${BASE}/login`, { email: reader.email, code });
    assert.equal(login.statusCode, 200, login.body);
    cookies.push(readerSessionCookie(login.headers["set-cookie"]));
  }
  await expectProtected(f.app, cookies[0], 401);
  for (const cookie of cookies.slice(1)) await expectProtected(f.app, cookie, 200);

  const hash = tokenHash(sessionToken(cookies[3])!);
  const getTimes = async () => (await sql<{ last_seen_at: Date; expires_at: Date }[]>`
    SELECT last_seen_at, expires_at FROM reader_sessions WHERE id_hash = ${hash}`)[0]!;
  const initial = await getTimes();
  await expectProtected(f.app, cookies[3], 200);
  assert.deepEqual(await getTimes(), initial);
  await sql`UPDATE reader_sessions SET last_seen_at = ${age(71 * HOUR)} WHERE id_hash = ${hash}`;
  const state = await f.call("GET", `${BASE}/session`, undefined, { cookie: cookies[3] });
  assert.equal(state.json().loggedIn, true);
  assert.ok((await getTimes()).last_seen_at < age(70 * HOUR));
  const forgedPage = await f.call("GET", `${BASE}/session`, undefined, { cookie: cookies[3], "x-reader-page-view": "1" });
  assert.deepEqual(forgedPage.json(), state.json());
  assert.ok((await getTimes()).last_seen_at < age(70 * HOUR));
  const pageView = await f.call("GET", `${BASE}/session`, undefined, { cookie: cookies[3], "x-reader-page-view": "1", "x-reader-internal": internal });
  assert.deepEqual(pageView.json(), state.json());
  const renewed = await getTimes();
  assert.ok(renewed.last_seen_at > age(MINUTE));
  assert.deepEqual(renewed.expires_at, initial.expires_at);
  assert.ok(renewed.expires_at.getTime() - initial.last_seen_at.getTime() >= 30 * DAY - 1);

  await sql`UPDATE reader_sessions SET last_seen_at = ${age(72 * HOUR)} WHERE id_hash = ${hash}`;
  await expectProtected(f.app, cookies[3], 401);
  await sql`UPDATE reader_sessions SET expires_at = ${age(1)}, last_seen_at = now() WHERE id_hash = ${tokenHash(sessionToken(cookies[1])!)}`;
  await expectProtected(f.app, cookies[1], 401);

  const logout = await f.call("POST", `${BASE}/logout`, undefined, { cookie: cookies[2] });
  assert.equal(logout.statusCode, 204);
  await expectProtected(f.app, cookies[2], 401);
  await sql`UPDATE reader_otps SET created_at = created_at - interval '70 seconds' WHERE email = ${reader.email}`;
  const { ticket } = await f.otp(reader.email);
  const signed = await f.call("POST", `${BASE}/login`, { email: reader.email, ticket });
  const live = readerSessionCookie(signed.headers["set-cookie"]);
  await expectProtected(f.app, live, 200);
  const admin = await adminHeaders();
  assert.equal((await f.call("POST", `${ADMIN_READERS}/${reader.id}/disable`, undefined, admin)).statusCode, 200);
  await expectProtected(f.app, live, 401);
  assert.equal((await f.call("POST", `${ADMIN_READERS}/${reader.id}/restore`, undefined, admin)).statusCode, 200);
  await expectProtected(f.app, live, 401);
});

// Isolation: per-file database copy, tagged emails and company, a dedicated IP, and a fake mailer.
test("verified applications deduplicate, expose coworkers, issue email-bound codes and tolerate mail failure", async t => {
  const f = await open(t);
  const company = `同事-${tag()}`;
  const coworker = await f.newReader({ company });
  const admin = await adminHeaders();
  async function apply(email: string, ip = f.ip) {
    const { code } = await issueOtp(f.policy, email, ip);
    const verified = await f.call("POST", `${BASE}/otp/verify`, { email, code });
    assert.equal(verified.statusCode, 200, verified.body);
    const payload = { ...profile, reason: "关注新能源品牌", email, company, ticket: verified.json().ticket };
    return f.call("POST", `${BASE}/applications`, payload);
  }
  const email = emailFor();
  const submitted = await apply(email);
  assert.equal(submitted.statusCode, 201, submitted.body);
  const id = submitted.json().id;
  const lookup = async () => f.call("GET", `${ADMIN_LOOKUPS}?${new URLSearchParams({
    reader_ids: [coworker.id, randomUUID()].join(","), application_ids: id,
  })}`, undefined, { cookie: admin.cookie });
  const pendingLookup = await lookup();
  const contacts = [{ id: coworker.id, name: profile.name, wechat: profile.wechat }];
  assert.equal(pendingLookup.statusCode, 200, pendingLookup.body);
  assert.equal(pendingLookup.headers["cache-control"], "private, no-store");
  assert.deepEqual(pendingLookup.json(), { readers: contacts, reissuable_application_ids: [] });
  const malformedLookup = await f.call("GET", `${ADMIN_LOOKUPS}?reader_ids=not-a-uuid`, undefined, { cookie: admin.cookie });
  assert.equal(malformedLookup.statusCode, 400, malformedLookup.body);
  await sql`UPDATE reader_otps SET created_at = created_at - interval '70 seconds' WHERE email = ${email}`;
  assert.equal((await apply(email)).json().code, "application_pending");
  const detail = await f.call("GET", `${ADMIN_APPLICATIONS}/${id}`, undefined, admin);
  assert.equal(detail.json().application.referrer, profile.referrer);
  assert.deepEqual(detail.json().coworkers.map((row: { id: string }) => row.id), [coworker.id]);
  assert.ok((await f.call("GET", `${ADMIN_APPLICATIONS}?status=pending`, undefined, admin)).json().applications
    .some((row: { id: string }) => row.id === id));

  const approved = await f.call("POST", `${ADMIN_APPLICATIONS}/${id}/approve`, undefined, admin);
  assert.equal(approved.statusCode, 200, approved.body);
  const body = approved.json();
  assert.equal(body.application_id, id);
  assert.equal(body.requires_approval, false);
  assert.equal(body.email_sent, true);
  assert.ok(body.invitation_text.includes(body.code));
  assert.equal(new URL(body.invitation_url).searchParams.get("code"), body.code);
  assert.deepEqual((await lookup()).json(), { readers: contacts, reissuable_application_ids: [id] });
  const mail = f.mailer.messages[0]!;
  assert.equal(mail.to, email);
  assert.ok(mail.text.includes(body.invitation_url));
  assert.ok(mail.html.includes(body.code));
  await sql`UPDATE reader_otps SET created_at = created_at - interval '70 seconds' WHERE email = ${email}`;
  const signup = await f.signup(body.code, email);
  assert.equal(signup.statusCode, 201, signup.body);
  assert.equal(signup.json().status, "active");
  assert.deepEqual((await lookup()).json(), { readers: contacts, reissuable_application_ids: [] });

  const batchEmail = emailFor();
  const batchId = (await apply(batchEmail)).json().id;
  f.mailer.fail = true;
  const batch = await f.call("POST", `${ADMIN_APPLICATIONS}/batch-approve`, { ids: [batchId, id, batchId] }, admin);
  assert.equal(batch.statusCode, 200, batch.body);
  const [issued, existing] = batch.json().results;
  assert.equal(issued.email_sent, false);
  assert.ok(issued.invitation_text.includes(issued.code));
  assert.equal(existing.error, "application_not_pending");
  assert.deepEqual((await f.call("GET", `${BASE}/invite/check?code=${issued.code}`)).json(), { valid: true, bound_email: true });

  const rejectId = (await apply(emailFor())).json().id;
  assert.deepEqual((await f.call("POST", `${ADMIN_APPLICATIONS}/${rejectId}/reject`, { reason: "暂缓", notify: false }, admin)).json(),
    { status: "rejected", email_sent: false });
  assert.equal((await f.call("GET", `${ADMIN_APPLICATIONS}/${rejectId}`, undefined, admin)).json().application.decision_reason, "暂缓");
  assert.equal((await apply(emailFor())).statusCode, 201);
  assert.equal((await apply(emailFor())).statusCode, 201);
  assert.equal((await apply(emailFor())).statusCode, 429);
});

// Isolation: per-file database copy, tagged applications, fake mailer and a temporary constraint on one test email.
test("batch approval preserves delivered results and codes after mail failure and a later database error", async t => {
  const f = await open(t);
  const admin = await adminHeaders();
  const failureEmail = "reader-batch-failure@example.test";
  await sql`ALTER TABLE reader_invites ADD CONSTRAINT reader_test_invite_failure CHECK (bound_email <> 'reader-batch-failure@example.test')`;
  t.after(async () => { await sql`ALTER TABLE reader_invites DROP CONSTRAINT reader_test_invite_failure`; });
  const emails = [emailFor(), failureEmail, emailFor()];
  const ids: string[] = [];
  for (const email of emails) {
    const [application] = await sql<{ id: string }[]>`INSERT INTO reader_applications (email, name, company, job_title, wechat, reason)
      VALUES (${email}, ${profile.name}, ${profile.company}, ${profile.job_title}, ${profile.wechat}, '测试申请') RETURNING id`;
    ids.push(application!.id);
  }
  // Let the first email fail after issuance. Delivery for a subsequent item still works.
  const send = f.mailer.send.bind(f.mailer);
  t.mock.method(f.mailer, "send", async (mail: Mail) => {
    if (mail.to === emails[0]) throw new Error("test delivery failed");
    await send(mail);
  });
  const batch = await f.call("POST", `${ADMIN_APPLICATIONS}/batch-approve`, { ids }, admin);
  assert.equal(batch.statusCode, 200, batch.body);
  const [first, failed, last] = batch.json().results;
  assert.equal(first.application_id, ids[0]);
  assert.equal(first.email_sent, false);
  assert.ok(first.code && first.invitation_text.includes(first.code));
  assert.deepEqual(failed, { application_id: ids[1], error: "reader_unavailable" });
  assert.equal(last.application_id, ids[2]);
  assert.equal(last.email_sent, true);
  assert.ok(last.code && f.mailer.messages[0]?.text.includes(last.code));
  assert.deepEqual((await f.call("GET", `${BASE}/invite/check?code=${first.code}`)).json(), { valid: true, bound_email: true });
  assert.equal((await f.call("GET", `${ADMIN_APPLICATIONS}/${ids[1]}`, undefined, admin)).json().application.status, "pending");
});

// Isolation: per-file database copy, one tagged application, and a lock held only on its old invite.
test("reissuing a lost approval code revokes it, admits only one concurrent replacement and refuses a used code", async t => {
  const f = await open(t);
  const admin = await adminHeaders();
  const email = emailFor();
  const { ticket } = await f.otp(email);
  const submitted = await f.call("POST", `${BASE}/applications`, { ...profile, email, ticket, reason: "测试申请" });
  assert.equal(submitted.statusCode, 201, submitted.body);
  const id = submitted.json().id as string;
  const url = `${ADMIN_APPLICATIONS}/${id}/reissue`;
  const reissue = () => f.call("POST", url, undefined, admin);
  assert.equal((await f.call("POST", url, undefined, { cookie: admin.cookie })).statusCode, 403);
  const pending = await reissue();
  assert.equal(pending.statusCode, 409, pending.body);
  assert.equal(pending.json().code, "application_not_approved");

  f.mailer.fail = true;
  const batch = await f.call("POST", `${ADMIN_APPLICATIONS}/batch-approve`, { ids: [id] }, admin);
  assert.equal(batch.statusCode, 200, batch.body);
  const [original] = batch.json().results;
  assert.equal(original.email_sent, false);

  const locked = gate();
  const unlock = gate();
  const holding = sql.begin(async tx => {
    await tx`SELECT id FROM reader_invites WHERE id = ${original.id} FOR UPDATE`;
    locked.open();
    await unlock.promise;
  });
  await Promise.race([locked.promise, holding]);
  const requests = [reissue(), reissue()];
  // Keep the first reissue transaction open while the competitor reaches the application row.
  const fallback = setTimeout(unlock.open, 10_000);
  const conflict = await Promise.race(requests).finally(() => {
    clearTimeout(fallback);
    unlock.open();
  });
  const responses = await Promise.all(requests);
  await holding;
  assert.equal(conflict.statusCode, 409, conflict.body);
  assert.equal(conflict.json().code, "application_reissue_in_progress");
  assert.deepEqual(responses.map(response => response.statusCode).sort(), [200, 409]);

  const replacement = responses.find(response => response.statusCode === 200)!.json();
  assert.deepEqual(Object.keys(replacement).sort(), Object.keys(original).sort());
  assert.equal(replacement.application_id, id);
  assert.equal(replacement.email_sent, false);
  assert.equal(replacement.requires_approval, false);
  assert.notEqual(replacement.code, original.code);
  assert.ok(replacement.invitation_text.includes(replacement.code));
  assert.equal(new URL(replacement.invitation_url).searchParams.get("code"), replacement.code);
  const invites = await sql`SELECT id, revoked_at FROM reader_invites WHERE bound_email = ${email}`;
  assert.deepEqual(invites.filter(row => row.revoked_at === null).map(row => row.id), [replacement.id]);
  assert.deepEqual(invites.filter(row => row.revoked_at !== null).map(row => row.id), [original.id]);
  const detail = await f.call("GET", `${ADMIN_APPLICATIONS}/${id}`, undefined, admin);
  assert.equal(detail.json().application.approved_invite_id, replacement.id);

  await sql`UPDATE reader_otps SET created_at = created_at - interval '70 seconds' WHERE email = ${email}`;
  const verified = await f.otp(email);
  const register = (code: string) => f.call("POST", `${BASE}/register`, { email, code, ticket: verified.ticket, ...profile, ...consent });
  assert.equal((await register(original.code)).json().code, "invalid_invite");
  const registered = await register(replacement.code);
  assert.equal(registered.statusCode, 201, registered.body);
  const used = await reissue();
  assert.equal(used.statusCode, 409, used.body);
  assert.equal(used.json().code, "invite_not_replaceable");
});

const privateFields = ["phone", "phone_verified_at", "wechat_openid", "wechat_unionid"];
const assertNoPhoneOrWechatIdentity = (body: object) => {
  for (const field of privateFields) assert.equal(Object.hasOwn(body, field), false, field);
};

// Isolation: per-file database copy, dedicated reader IDs, and explicit restoration of the synthetic aggregate.
test("tracking opt-out discards batches, export and clearing are scoped, deletion erases personal data", async t => {
  const f = await open(t);
  const reader = await f.newReader();
  const other = await f.newReader({ tracking_consent: true });
  const own = { cookie: reader.cookie };
  await sql`UPDATE reader_users SET phone = '15555550123', phone_verified_at = now(), wechat_openid = 'openid', wechat_unionid = 'unionid'
    WHERE id = ${reader.id}`;
  const me = await f.call("GET", `${BASE}/me`, undefined, own);
  assert.equal(me.statusCode, 200, me.body);
  assertNoPhoneOrWechatIdentity(me.json());
  const batch = { events: [{ kind: "view_item", target_id: "test-item", brand_slug: "test-brand", topic_slug: "test-topic" }] };
  assert.equal((await f.call("POST", `${BASE}/events`, batch, own)).statusCode, 204);
  assert.equal((await sql`SELECT id FROM reader_events WHERE user_id = ${reader.id}`).length, 0);

  const turnOn = await f.call("PATCH", `${BASE}/me`, { tracking_consent: true }, own);
  assert.equal(turnOn.statusCode, 200, turnOn.body);
  assert.equal(turnOn.json().tracking_consent, true);
  assertNoPhoneOrWechatIdentity(turnOn.json());
  const invalid = await f.call("POST", `${BASE}/events`, { events: [{ kind: "retargeting" }] }, own);
  assert.equal(invalid.statusCode, 400);
  assert.equal((await f.call("POST", `${BASE}/events`, batch, own)).statusCode, 204);
  assert.equal((await f.call("POST", `${BASE}/events`, batch, { cookie: other.cookie })).statusCode, 204);
  assert.equal((await f.call("GET", `${BASE}/me/events`, undefined, own)).json().events.length, 1);
  const exported = await f.call("GET", `${BASE}/me/export`, undefined, own);
  assert.equal(exported.statusCode, 200, exported.body);
  assert.match(exported.headers["content-disposition"] as string, /attachment/);
  assert.equal(exported.json().profile.email, reader.email);
  assertNoPhoneOrWechatIdentity(exported.json().profile);
  assert.equal(exported.json().events.length, 1);
  assert.equal(exported.json().truncated, false);
  assert.equal(exported.json().consents.length, 4);
  assert.equal(exported.json().logins[0].ip, f.ip);
  const admin = await adminHeaders();
  const traits = await f.call("GET", `${ADMIN_READERS}/${reader.id}`, undefined, admin);
  assertNoPhoneOrWechatIdentity(traits.json().reader);
  assert.equal(traits.json().interests.brands[0].brand_slug, "test-brand");
  const listings = await f.call("GET", `${ADMIN_READERS}?q=${reader.email}`, undefined, admin);
  assert.equal(listings.json().readers[0].active_days_7, 1);
  assert.equal(listings.json().readers[0].active_days_30, 1);

  assert.equal((await f.call("DELETE", `${BASE}/me/events`, undefined, own)).statusCode, 204);
  assert.equal((await f.call("GET", `${BASE}/me/events`, undefined, own)).json().events.length, 0);
  assert.equal((await f.call("POST", `${BASE}/events`, batch, own)).statusCode, 204);
  assert.equal((await f.call("PATCH", `${BASE}/me`, { tracking_consent: false }, own)).statusCode, 200);
  assert.equal((await f.call("POST", `${BASE}/events`, batch, own)).statusCode, 204);
  assert.equal((await f.call("GET", `${BASE}/me/events`, undefined, own)).json().events.length, 1);

  const [personalInvite] = await adminIssueInvites(f.policy, 1, { bound_email: reader.email });
  const stamp = "1910-01-03";
  await sql`INSERT INTO reader_event_daily (day, kind, event_count) VALUES (${stamp}, 'dwell', 2)`;
  t.after(async () => { await sql`DELETE FROM reader_event_daily WHERE day = ${stamp} AND kind = 'dwell'`; });
  assert.equal((await f.call("DELETE", `${BASE}/me`, undefined, own)).statusCode, 204);
  await expectProtected(f.app, reader.cookie, 401);
  const [remaining] = await sql`SELECT
    (SELECT count(*) FROM reader_users WHERE id = ${reader.id}) AS users,
    (SELECT count(*) FROM reader_events WHERE user_id = ${reader.id}) AS events,
    (SELECT count(*) FROM reader_consents WHERE user_id = ${reader.id}) AS consents,
    (SELECT count(*) FROM reader_auth_identities WHERE user_id = ${reader.id}) AS identities,
    (SELECT count(*) FROM reader_otps WHERE email = ${reader.email}) AS otps,
    (SELECT count(*) FROM reader_sessions WHERE user_id = ${reader.id}) AS sessions,
    (SELECT count(*) FROM reader_login_log WHERE user_id = ${reader.id}) AS logins,
    (SELECT count(*) FROM reader_activity_daily WHERE user_id = ${reader.id}) AS activity`;
  assert.ok(Object.values(remaining!).every(value => value === 0), JSON.stringify(remaining));
  const [scrubbed] = await sql`SELECT bound_email, revoked_at FROM reader_invites WHERE id = ${personalInvite!.id}`;
  assert.equal(scrubbed!.bound_email, null);
  assert.ok(scrubbed!.revoked_at);
  assert.equal((await sql`SELECT event_count FROM reader_event_daily WHERE day = ${stamp} AND kind = 'dwell'`)[0]!.event_count, 2);
  assert.equal((await sql`SELECT id FROM reader_events WHERE user_id = ${other.id}`).length, 1);
});

// Isolation: per-file database copy and dedicated reader IDs for both the capped account and its neighbor.
test("concurrent event batches keep the newest 20000 events and export only the newest 5000", async t => {
  const f = await open(t);
  const reader = await f.newReader({ tracking_consent: true });
  const other = await f.newReader({ tracking_consent: true });
  const own = { cookie: reader.cookie };
  const seedCount = 20_001;
  await sql`INSERT INTO reader_events (user_id, kind, query)
    SELECT ${reader.id}::uuid, 'search', n::text FROM (SELECT n FROM generate_series(1, ${seedCount}::int) AS series(n) ORDER BY n OFFSET 0) ordered`;
  await sql`INSERT INTO reader_events (user_id, kind, query) VALUES (${other.id}, 'search', 'other')`;
  const write = (queries: string[]) => f.call("POST", `${BASE}/events`, {
    events: queries.map(query => ({ kind: "search", query })),
  }, own);
  const results = await Promise.all([write(["new-a", "new-b"]), write(["new-c", "new-d", "new-e"])]);
  for (const response of results) assert.equal(response.statusCode, 204, response.body);
  const [counts] = await sql`SELECT count(*)::int AS total, min(query::int) FILTER (WHERE query NOT LIKE 'new-%') AS oldest
    FROM reader_events WHERE user_id = ${reader.id}`;
  assert.deepEqual({ ...counts }, { total: 20_000, oldest: 7 });
  assert.equal((await sql`SELECT query FROM reader_events WHERE user_id = ${other.id}`)[0]?.query, "other");
  const exported = await f.call("GET", `${BASE}/me/export`, undefined, own);
  assert.equal(exported.statusCode, 200, exported.body.slice(0, 200));
  const { events, truncated } = exported.json() as { events: Array<{ query: string }>; truncated: boolean };
  assert.equal(truncated, true);
  assert.equal(events.length, 5000);
  assert.deepEqual(events.slice(0, 5).map(event => event.query).sort(), ["new-a", "new-b", "new-c", "new-d", "new-e"]);
  assert.equal(events[5]?.query, String(seedCount));
  assert.equal(events.at(-1)?.query, String(seedCount - 4994));
});

// Isolation: per-file database copy and dedicated reader IDs.
test("switching tracking consent keeps only the latest 50 tracking records and preserves other consents", async t => {
  const f = await open(t);
  const reader = await f.newReader();
  const other = await f.newReader();
  let lastDroppedId = 0;
  for (let step = 1; step <= 60; step++) {
    const response = await f.call("PATCH", `${BASE}/me`, { tracking_consent: step % 2 === 1 }, { cookie: reader.cookie });
    assert.equal(response.statusCode, 200, response.body);
    if (step === 10) {
      const [last] = await sql<{ id: number }[]>`SELECT id FROM reader_consents WHERE user_id = ${reader.id}
        AND kind = 'tracking' ORDER BY id DESC LIMIT 1`;
      lastDroppedId = last!.id;
    }
  }
  const rows = await sql<{ id: number; kind: string; granted: boolean }[]>`
    SELECT id, kind, granted FROM reader_consents WHERE user_id = ${reader.id} ORDER BY id`;
  assert.deepEqual(rows.slice(0, 2).map(row => row.kind), ["terms", "privacy"]);
  const tracking = rows.slice(2);
  assert.equal(tracking.length, 50);
  assert.ok(tracking.every(row => row.kind === "tracking" && row.id > lastDroppedId));
  assert.deepEqual(tracking.map(row => row.granted), Array.from({ length: 50 }, (_, i) => i % 2 === 0));
  const [neighbor] = await sql`SELECT count(*) AS total FROM reader_consents WHERE user_id = ${other.id}`;
  assert.equal(neighbor?.total, 3);
});

// Isolation: per-file database copy and legacy consent rows scoped to a dedicated reader.
test("export includes only the latest 200 consents and reports when older records were omitted", async t => {
  const f = await open(t);
  const reader = await f.newReader();
  await sql`INSERT INTO reader_consents (user_id, kind, version, granted)
    SELECT ${reader.id}::uuid, 'tracking', 'legacy-' || n, true FROM generate_series(1, 197) AS series(n) ORDER BY n`;
  async function readExport() {
    const response = await f.call("GET", `${BASE}/me/export`, undefined, { cookie: reader.cookie });
    assert.equal(response.statusCode, 200, response.body.slice(0, 200));
    return response.json() as { consents: Array<{ kind: string; version: string }>; consents_truncated: boolean };
  }
  const full = await readExport();
  assert.equal(full.consents.length, 200);
  assert.equal(full.consents[0]?.kind, "terms");
  assert.equal(full.consents_truncated, false);

  await sql`INSERT INTO reader_consents (user_id, kind, version, granted) VALUES (${reader.id}, 'tracking', 'legacy-198', false)`;
  const limited = await readExport();
  assert.equal(limited.consents.length, 200);
  assert.equal(limited.consents_truncated, true);
  assert.equal(limited.consents[0]?.kind, "privacy");
  assert.equal(limited.consents.at(-1)?.version, "legacy-198");
});

// Isolation: per-file database copy, tagged readers and unique search text.
test("reader admin search matches literal percent, underscore and backslash", async t => {
  const f = await open(t);
  const admin = await adminHeaders();
  const marker = `reader-${tag()}`;
  const byName = await f.newReader({ name: marker + "%" });
  const byCompany = await f.newReader({ company: marker + "_" });
  const byEmail = await f.newReader();
  await sql`UPDATE reader_auth_identities SET subject = ${marker + "\\suffix@example.test"}
    WHERE user_id = ${byEmail.id} AND provider = 'email'`;
  await f.newReader({ name: marker + "x", company: marker + "suffix" });
  for (const [search, match] of [[marker + "%", byName], [marker + "_", byCompany], [marker + "\\", byEmail]] as const) {
    const response = await f.call("GET", `${ADMIN_READERS}?q=${encodeURIComponent(search)}`, undefined, admin);
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().readers.map((row: { id: string }) => row.id), [match.id], search);
  }
});

// Isolation: per-file database copy, tagged reader, distinct historical day and explicit aggregate cleanup.
test("retention anonymizes 180-day events exactly once and removes login IPs after 30 days", async t => {
  const f = await open(t);
  const r = await f.newReader({ tracking_consent: true });
  const stamp = "1910-02-03";
  t.after(async () => { await sql`DELETE FROM reader_event_daily WHERE day = ${stamp} AND kind = 'search'`; });
  await sql`INSERT INTO reader_events (user_id, kind, query, created_at)
    VALUES (${r.id}, 'search', 'old private search', ${new Date(`${stamp}T00:30:00Z`)}),
           (${r.id}, 'search', 'recent search', now())`;
  await sql`UPDATE reader_login_log SET created_at = ${age(31 * DAY)} WHERE user_id = ${r.id}`;
  const first = await retainReaderData(f.policy, new Date());
  const second = await retainReaderData(f.policy, new Date());
  assert.equal(first.readerAccounts.events, 1);
  assert.equal(second.readerAccounts.events, 0);
  assert.equal((await sql`SELECT event_count FROM reader_event_daily WHERE day = ${stamp} AND kind = 'search'`)[0]!.event_count, 1);
  assert.equal((await sql`SELECT id FROM reader_login_log WHERE user_id = ${r.id}`).length, 0);
  assert.deepEqual((await sql`SELECT query FROM reader_events WHERE user_id = ${r.id}`).map(row => row.query), ["recent search"]);
});

// Isolation: per-file database copy, six tagged applications and an invite issued just for the expired approval.
test("retention deletes all three application states at 90 days and leaves the issued invite", async t => {
  const f = await open(t);
  const approvedEmail = emailFor();
  const [invite] = await adminIssueInvites(f.policy, 1, { bound_email: approvedEmail });
  const now = new Date();
  const expiredAt = new Date(now.getTime() - 90 * DAY);
  const recentAt = new Date(expiredAt.getTime() + 1);
  const older = new Date(expiredAt.getTime() - DAY);
  const expired: string[] = [];
  const retained: string[] = [];
  for (const status of ["pending", "approved", "rejected"]) {
    for (const [at, ids] of [[expiredAt, expired], [recentAt, retained]] as const) {
      const associatedInvite = status === "approved" && ids === expired;
      const [application] = await sql<{ id: string }[]>`INSERT INTO reader_applications
        (email, name, company, job_title, wechat, reason, status, created_at, decided_at, approved_invite_id)
        VALUES (${associatedInvite ? approvedEmail : emailFor()}, ${profile.name}, ${profile.company}, ${profile.job_title},
          ${profile.wechat}, '测试申请', ${status}, ${status === "pending" ? at : older},
          ${status === "pending" ? null : at}, ${associatedInvite ? invite!.id : null}) RETURNING id`;
      ids.push(application!.id);
    }
  }
  const first = await retainReaderData(f.policy, now);
  assert.equal(first.readerAccounts.applications, 3);
  assert.equal((await retainReaderData(f.policy, now)).readerAccounts.applications, 0);
  const remaining = await sql<{ id: string }[]>`SELECT id FROM reader_applications WHERE id IN ${sql([...expired, ...retained])}`;
  assert.deepEqual(remaining.map(row => row.id).sort(), retained.sort());
  const [stored] = await sql`SELECT bound_email, revoked_at FROM reader_invites WHERE id = ${invite!.id}`;
  assert.equal(stored?.bound_email, approvedEmail);
  assert.equal(stored?.revoked_at, null);
});

// Isolation: per-file database copy and four dedicated invite IDs.
test("retention clears personal data only from unused expired or revoked invites and keeps the rows", async t => {
  const f = await open(t);
  const email = emailFor();
  const note = "测试备注";
  const invites = await adminIssueInvites(f.policy, 4, { bound_email: email, note });
  const ids = invites.map(invite => invite.id);
  const [expired, revoked, valid, used] = ids as [string, string, string, string];
  const now = new Date();
  await sql`UPDATE reader_invites SET expires_at = ${now} WHERE id = ${expired}`;
  await sql`UPDATE reader_invites SET revoked_at = ${now} WHERE id = ${revoked}`;
  await sql`UPDATE reader_invites SET expires_at = ${now}, used_at = ${now} WHERE id = ${used}`;
  const read = () => sql`SELECT id, bound_email, note FROM reader_invites WHERE id IN ${sql(ids)} ORDER BY id`;

  await retainReaderData(f.policy, now);
  const rows = await read();
  const details = new Map(rows.map(row => [row.id, [row.bound_email, row.note]]));
  assert.equal(details.size, 4);
  for (const id of [expired, revoked]) assert.deepEqual(details.get(id), [null, null]);
  for (const id of [valid, used]) assert.deepEqual(details.get(id), [email, note]);
  await retainReaderData(f.policy, now);
  assert.deepEqual([...(await read())], [...rows]);
});

// Isolation: per-file database copy and tagged publication fixture. Each app has its own Fastify instance.
test("the registered route inventory fails closed, the preview is narrow, and wall-off keeps established content exports", async t => {
  const f = await open(t);
  await assertAnonymousWall(f.app, f.routes);
  const admin = await adminHeaders();
  await expectProtected(f.app, admin.cookie, 200);
  const source = `reader-wall-${tag()}`;
  const now = new Date();
  const url = `https://example.test/${source}`;
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode) VALUES (${source}, '来源', 'rss', 'T1', 'editorial')`;
  const { articleId: id } = await upsertMaterial({ sourceId: source, url, title: "原始标题", bodyText: "保密正文",
    bodyStatus: "ok", via: "fetch", publishedAt: now });
  await sql`INSERT INTO publications (article_id, source_id, title, summary, url, discovered_at, timeline_at, sort_at, channel, eligible, selected, visible_after)
    VALUES (${id}, ${source}, '分享标题', '分享摘要', ${url}, ${now}, ${now}, ${now}, 'news', true, true, ${now})`;
  const preview = await f.call("GET", `${BASE}/preview/${id}`);
  assert.equal(preview.statusCode, 200, preview.body);
  assert.deepEqual(preview.json(), { title: "分享标题", summary: "分享摘要", source: "来源", published_at: now.toISOString(),
    application: { path: "/join", terms_version: "1", privacy_version: "1" } });
  assert.equal(preview.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(preview.headers["cache-control"], "private, no-store");
  assert.equal((await f.call("GET", `/items/${id}/markdown`)).statusCode, 401);
  const body = await f.call("GET", `/items/${id}/markdown`, undefined, { "x-reader-internal": internal });
  assert.equal(body.statusCode, 200, body.body);
  assert.match(body.body, /分享标题/);
  assert.equal(body.headers["cache-control"], "private, no-store");

  const storyTitle = "分享事件标题";
  const storyPublicId = randomUUID();
  const [story] = await sql`INSERT INTO stories (public_id, title, digest, first_report_at, latest_at)
    VALUES (${storyPublicId}, ${storyTitle}, '事件正文综述', ${now}, ${now}) RETURNING id`;
  const [fact] = await sql`INSERT INTO facts (public_id, story_id, title) VALUES (${source}, ${story!.id}, '事件进展') RETURNING id`;
  await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${fact!.id}, ${id}, 'report')`;
  const cards = [
    { path: `/og/items/${id}.png`, title: "分享标题", subtitle: "分享摘要" },
    { path: `/og/stories/${storyPublicId}.png`, title: storyTitle },
  ];
  for (const [kind, key, name] of [["daily", "2097-09-20", "日报"], ["weekly", "2097-W39", "周报"], ["monthly", "2097-09", "月报"]] as const) {
    const content = kind === "daily" ? { lead: { title: "报告头条", leadParagraph: "报告头条正文" } } : { overview: "报告总述正文" };
    await sql`INSERT INTO reports (kind, key, window_start, window_end, content, generated_at)
      VALUES (${kind}, ${key}, ${age(DAY)}, ${now}, ${sql.json(content)}, ${now})`;
    cards.push({ path: `/og/reports/${kind}/${key}.png`, title: `${withSubject(name)} · ${reportDateLabel(kind, key)}` });
  }
  for (const { path, title, subtitle } of cards) {
    const expected = `"og-${ogEtag({ kicker: "", title, subtitle })}"`;
    const response = await f.call("GET", path, undefined, { "if-none-match": expected });
    assert.equal(response.statusCode, 304, path);
    assert.equal(response.headers.etag, expected);
    assert.equal(response.headers["x-robots-tag"], "noindex, nofollow");
  }

  const off = await open(t, { READER_WALL_ENABLED: "false" });
  const unguarded = await off.call("GET", `/items/${id}/markdown`);
  assert.equal(unguarded.statusCode, 200, unguarded.body);
  assert.equal(unguarded.body, body.body);
  assert.match(unguarded.headers["cache-control"] as string, /public/);
  assert.equal((await off.call("GET", "/feed.xml")).statusCode, 200);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${id}`;
  assert.equal((await f.call("GET", `${BASE}/preview/${id}`)).statusCode, 404);
});

const inactivitySlot = {
  first: beijingAt("2025-02-03", "11:00"),
  final: beijingAt("2025-02-06", "09:00"),
  due: beijingAt("2025-02-06", "11:00"),
  deferred: beijingAt("2025-02-07", "11:00"),
};
const inactiveSince = new Date(inactivitySlot.first.getTime() - 30 * DAY);
const noNotices = { first: null, deadline: null, final: null };

function inactivityJobs(env: NodeJS.ProcessEnv = {}, mailer = new TestMailer()) {
  let now = inactivitySlot.first;
  const alerts: { title: string; lines: string[] }[] = [];
  const module = createReaderAccounts({
    policy: readerConfig({ READER_MAIL_ENABLED: "true", ...env }, secret), mailer, siteUrl: "https://reader.test/",
    now: () => now,
    async alert(title, lines) {
      alerts.push({ title, lines });
      return "sent";
    },
  });
  return {
    mailer, alerts,
    run(name: "notice" | "final-notice" | "digest", at: Date) {
      now = at;
      return module.schedules!.find(job => job.name === `reader-accounts.inactive-${name}`)!.run();
    },
  };
}

async function inactiveReader(t: TestContext, fields: {
  status?: "active" | "pending" | "disabled"; created?: Date; activated?: Date; last?: Date; name?: string;
  first?: Date; deadline?: Date; final?: Date; company?: string;
} = {}) {
  const email = emailFor();
  const id = await sql.begin(async tx => {
    const [reader] = await tx<{ id: string }[]>`INSERT INTO reader_users
      (name, company, job_title, wechat, tracking_consent, status, created_at, activated_at, last_active_at,
       inactivity_notified_at, inactivity_deadline_at, inactivity_final_notified_at)
      VALUES (${fields.name ?? profile.name}, ${fields.company ?? profile.company}, ${profile.job_title}, ${profile.wechat}, false,
       ${fields.status ?? "active"}, ${fields.created ?? inactiveSince}, ${fields.activated ?? null}, ${fields.last ?? null},
       ${fields.first ?? null}, ${fields.deadline ?? null}, ${fields.final ?? null}) RETURNING id`;
    await tx`INSERT INTO reader_auth_identities (provider, subject, user_id) VALUES ('email', ${email}, ${reader!.id})`;
    return reader!.id;
  });
  t.after(async () => { await sql`DELETE FROM reader_users WHERE id = ${id}`; });
  return { id, email };
}

async function noticesFor(id: string) {
  const [row] = await sql<{ first: Date | null; deadline: Date | null; final: Date | null }[]>`
    SELECT inactivity_notified_at AS first, inactivity_deadline_at AS deadline, inactivity_final_notified_at AS final
    FROM reader_users WHERE id = ${id}`;
  return row && { ...row };
}

// Isolation: per-file database copy, dedicated reader IDs cleaned after the test, fixed Beijing slots and a fake mailer.
test("first inactivity reminder uses the first 11:00 at or after 30 full days from the most recent activity", async t => {
  const f = inactivityJobs();
  const exactly = await inactiveReader(t);
  const legacy = await inactiveReader(t, { first: new Date(inactivitySlot.first.getTime() - DAY) });
  const recent = new Date(inactiveSince.getTime() + 1);
  const younger = await Promise.all([
    inactiveReader(t, { last: recent }), inactiveReader(t, { activated: recent }), inactiveReader(t, { created: recent }),
  ]);
  await f.run("notice", beijingAt("2025-02-03", "10:59"));
  assert.equal(f.mailer.messages.length, 0);
  const at = new Date(inactivitySlot.first.getTime() + 15_000);
  assert.deepEqual(await f.run("notice", at), { deleted: 0, deferred: 0, reminded: 2, failed: 0 });
  assert.deepEqual(new Set(f.mailer.messages.map(mail => mail.to)), new Set([exactly.email, legacy.email]));
  for (const { id } of [exactly, legacy]) {
    assert.deepEqual(await noticesFor(id), { first: at, deadline: inactivitySlot.due, final: null });
  }
  for (const { id } of younger) assert.deepEqual(await noticesFor(id), noNotices);
  const { text } = f.mailer.messages[0]!;
  for (const expected of ["3 天后", "2025-02-06 11:00", "资料和浏览记录", "https://reader.test/login", "自行注销"]) {
    assert.ok(text.includes(expected), expected);
  }
  await f.run("notice", beijingAt("2025-02-03", "11:01"));
  assert.equal(f.mailer.messages.length, 2);
  await f.run("notice", beijingAt("2025-02-04", "11:00"));
  assert.equal(f.mailer.messages.length, 5);
});

// Isolation: per-file database copy, dedicated reader IDs cleaned after the test, fake mailer's isolated failure switch.
test("failed inactivity mail rolls back its claim for both reminder stages", async t => {
  const f = inactivityJobs();
  const reader = await inactiveReader(t);
  f.mailer.fail = true;
  assert.deepEqual(await f.run("notice", inactivitySlot.first), { deleted: 0, deferred: 0, reminded: 0, failed: 1 });
  assert.deepEqual(await noticesFor(reader.id), noNotices);
  f.mailer.fail = false;
  await f.run("notice", inactivitySlot.first);
  f.mailer.fail = true;
  assert.deepEqual(await f.run("final-notice", beijingAt("2025-02-06", "10:30")), { reminded: 0, failed: 1 });
  assert.deepEqual(await noticesFor(reader.id), { first: inactivitySlot.first, deadline: inactivitySlot.due, final: null });
  assert.equal(f.mailer.messages.length, 1);
});

// Isolation: per-file database copy and dedicated reader IDs cleaned after the test. Disabled mail is per policy.
test("disabled mail prevents both reminder stages and automatic deletion", async t => {
  const f = inactivityJobs({ READER_MAIL_ENABLED: "1" });
  const unnotified = await inactiveReader(t);
  const due = { first: inactivitySlot.first, deadline: inactivitySlot.due, final: inactivitySlot.final };
  const ready = await inactiveReader(t, due);
  const waiting = await inactiveReader(t, { first: due.first, deadline: due.deadline });
  await f.run("notice", inactivitySlot.first);
  await f.run("final-notice", inactivitySlot.final);
  assert.deepEqual(await f.run("notice", inactivitySlot.due), { deleted: 0, deferred: 0, reminded: 0, failed: 0 });
  assert.deepEqual(await noticesFor(unnotified.id), noNotices);
  assert.deepEqual(await noticesFor(ready.id), due);
  assert.deepEqual(await noticesFor(waiting.id), { ...due, final: null });
  assert.equal(f.mailer.messages.length, 0);
});

// Isolation: per-file database copy, a dedicated reader ID cleaned after the test and a fake mailer.
test("second reminder is due at 09:00 and only sends once", async t => {
  const f = inactivityJobs();
  const reader = await inactiveReader(t, { first: inactivitySlot.first, deadline: inactivitySlot.due });
  await f.run("final-notice", beijingAt("2025-02-06", "08:59"));
  assert.equal(f.mailer.messages.length, 0);
  assert.deepEqual(await f.run("final-notice", inactivitySlot.final), { reminded: 1, failed: 0 });
  await f.run("final-notice", inactivitySlot.final);
  assert.equal(f.mailer.messages.length, 1);
  assert.match(f.mailer.messages[0]!.text, /今天 11:00.*自动删除/);
  assert.match(f.mailer.messages[0]!.text, /https:\/\/reader\.test\/login/);
  assert.deepEqual(await noticesFor(reader.id), { first: inactivitySlot.first, deadline: inactivitySlot.due, final: inactivitySlot.final });
});

// Isolation: per-file database copy, tagged emails and an injected Fastify instance, with dedicated reader cleanup.
test("real login and browsing renewal both cancel inactivity deletion immediately", async t => {
  const f = await open(t);
  const jobs = inactivityJobs();
  const login = await f.newReader();
  const browse = await f.newReader();
  const ids = [login.id, browse.id];
  t.after(async () => { await sql`DELETE FROM reader_users WHERE id IN ${sql(ids)}`; });
  await sql`UPDATE reader_users SET created_at = ${inactiveSince}, activated_at = ${inactiveSince}, last_active_at = ${inactiveSince}
    WHERE id IN ${sql(ids)}`;
  await sql`UPDATE reader_sessions SET last_seen_at = ${age(LIMITS.sessionRenewal + MINUTE)} WHERE user_id = ${browse.id}`;
  await jobs.run("notice", inactivitySlot.first);
  await jobs.run("final-notice", inactivitySlot.final);
  for (const id of ids) assert.ok((await noticesFor(id))?.final);

  await sql`UPDATE reader_otps SET created_at = ${age(HOUR)} WHERE email = ${login.email}`;
  const { ticket } = await f.otp(login.email);
  const res = await f.call("POST", `${BASE}/login`, { email: login.email, ticket });
  assert.equal(res.statusCode, 200, res.body);
  await expectProtected(f.app, browse.cookie, 200);
  for (const id of ids) assert.deepEqual(await noticesFor(id), noNotices);
  assert.deepEqual(await jobs.run("notice", inactivitySlot.due), { deleted: 0, deferred: 0, reminded: 0, failed: 0 });
  for (const id of ids) assert.deepEqual(await noticesFor(id), noNotices);
  await sql`UPDATE reader_users SET last_active_at = ${beijingAt("2025-02-04", "11:01")} WHERE id IN ${sql(ids)}`;
  assert.deepEqual(await jobs.run("notice", beijingAt("2025-03-06", "11:00")), { deleted: 0, deferred: 0, reminded: 0, failed: 0 });
  assert.deepEqual(await jobs.run("notice", beijingAt("2025-03-07", "11:00")), { deleted: 0, deferred: 0, reminded: 2, failed: 0 });
});

// Isolation: per-file database copy, tagged account, OTP and invite rows, plus cleanup of a dedicated anonymous aggregate day.
test("eligible inactivity deletion removes linked personal data and preserves anonymous totals", async t => {
  const f = await open(t);
  const jobs = inactivityJobs();
  const { id, email } = await f.newReader();
  t.after(async () => {
    await sql`DELETE FROM reader_users WHERE id = ${id}`;
    await sql`DELETE FROM reader_otps WHERE email = ${email}`;
    await sql`DELETE FROM reader_applications WHERE email = ${email}`;
  });
  const [invite] = await adminIssueInvites(f.policy, 1, { bound_email: email, note: "个人备注" });
  await sql`UPDATE reader_otps SET created_at = ${age(HOUR)} WHERE email = ${email}`;
  await issueOtp(f.policy, email, uniqueIp());
  await sql`INSERT INTO reader_applications (email, name, company, job_title, wechat, reason)
    VALUES (${email}, '测试', '公司', '职位', '微信', '申请理由')`;
  await sql`INSERT INTO reader_events (user_id, kind) VALUES (${id}, 'view_item')`;
  const day = "1910-02-06";
  await sql`INSERT INTO reader_event_daily (day, kind, event_count) VALUES (${day}, 'view_item', 1)`;
  t.after(async () => { await sql`DELETE FROM reader_event_daily WHERE day = ${day} AND kind = 'view_item'`; });
  await sql`UPDATE reader_users SET created_at = ${inactiveSince}, activated_at = ${inactiveSince}, last_active_at = ${inactiveSince},
    inactivity_notified_at = ${inactivitySlot.first}, inactivity_deadline_at = ${inactivitySlot.due},
    inactivity_final_notified_at = ${beijingAt("2025-02-06", "10:00")} WHERE id = ${id}`;

  await jobs.run("notice", beijingAt("2025-02-06", "10:59"));
  assert.ok(await noticesFor(id));
  assert.deepEqual(await jobs.run("notice", inactivitySlot.due), { deleted: 1, deferred: 0, reminded: 0, failed: 0 });
  assert.equal(await noticesFor(id), undefined);
  const [remaining] = await sql`SELECT
    (SELECT count(*) FROM reader_events WHERE user_id = ${id}) AS events,
    (SELECT count(*) FROM reader_consents WHERE user_id = ${id}) AS consents,
    (SELECT count(*) FROM reader_auth_identities WHERE user_id = ${id}) AS identities,
    (SELECT count(*) FROM reader_otps WHERE email = ${email}) AS otps,
    (SELECT count(*) FROM reader_applications WHERE email = ${email}) AS applications,
    (SELECT count(*) FROM reader_sessions WHERE user_id = ${id}) AS sessions,
    (SELECT count(*) FROM reader_login_log WHERE user_id = ${id}) AS logins,
    (SELECT count(*) FROM reader_activity_daily WHERE user_id = ${id}) AS activity`;
  assert.ok(Object.values(remaining!).every(value => value === 0), JSON.stringify(remaining));
  const [scrubbed] = await sql`SELECT bound_email, note, revoked_at FROM reader_invites WHERE id = ${invite!.id}`;
  assert.equal(scrubbed!.bound_email, null);
  assert.equal(scrubbed!.note, null);
  assert.ok(scrubbed!.revoked_at);
  assert.equal((await sql`SELECT event_count FROM reader_event_daily WHERE day = ${day} AND kind = 'view_item'`)[0]!.event_count, 1);
});

// Isolation: per-file database copy, three dedicated reader IDs cleaned after the test, fixed Beijing slots and a fake mailer.
test("missing, late and too-recent final notices defer deletion to the next 11:00", async t => {
  const f = inactivityJobs();
  const due = { first: inactivitySlot.first, deadline: inactivitySlot.due };
  const late = await inactiveReader(t, due);
  const lateAt = beijingAt("2025-02-06", "10:20");
  assert.deepEqual(await f.run("final-notice", lateAt), { reminded: 1, failed: 0 });
  assert.match(f.mailer.messages[0]!.text, /2025-02-07 11:00/);
  assert.deepEqual(await noticesFor(late.id), { first: due.first, deadline: inactivitySlot.deferred, final: lateAt });
  const missing = await inactiveReader(t, due);
  const tooRecent = await inactiveReader(t, { ...due, final: lateAt });
  assert.deepEqual(await f.run("notice", inactivitySlot.due), { deleted: 0, deferred: 2, reminded: 0, failed: 0 });
  assert.deepEqual(await noticesFor(missing.id), { first: due.first, deadline: inactivitySlot.deferred, final: null });
  assert.equal((await noticesFor(tooRecent.id))?.deadline?.getTime(), inactivitySlot.deferred.getTime());
  assert.deepEqual(await f.run("final-notice", beijingAt("2025-02-07", "09:00")), { reminded: 1, failed: 0 });
  assert.equal(f.mailer.messages[1]!.to, missing.email);
  assert.deepEqual(await f.run("notice", inactivitySlot.deferred), { deleted: 3, deferred: 0, reminded: 0, failed: 0 });
});

// Isolation: per-file database copy, tagged fixtures cleaned after the test and a fake mailer and alert sink.
test("pending and disabled readers are excluded from all inactivity jobs", async t => {
  const f = inactivityJobs();
  const due = { first: inactivitySlot.first, deadline: inactivitySlot.due, final: inactivitySlot.final };
  for (const status of ["pending", "disabled"] as const) {
    await inactiveReader(t, { status });
    await inactiveReader(t, { status, first: due.first, deadline: due.deadline });
    await inactiveReader(t, { status, ...due });
  }
  await f.run("notice", inactivitySlot.first);
  assert.deepEqual(await f.run("final-notice", inactivitySlot.final), { reminded: 0, failed: 0 });
  assert.deepEqual(await f.run("notice", inactivitySlot.due), { deleted: 0, deferred: 0, reminded: 0, failed: 0 });
  assert.deepEqual(await f.run("digest", inactivitySlot.first), { waiting: 0, sent: 0, failed: 0 });
  assert.equal(f.mailer.messages.length, 0);
  assert.equal(f.alerts.length, 0);
});

// Isolation: per-file database copy, tagged bulk rows explicitly removed, fake mail and alert, fixed Beijing slots.
test("all inactivity jobs cap work at 200 readers per run, including combined deletion and first reminders", async t => {
  const f = inactivityJobs();
  const name = tag();
  const { id: dueId } = await inactiveReader(t, { first: inactivitySlot.first, deadline: inactivitySlot.due, final: inactivitySlot.final });
  const rows = await sql<{ id: string }[]>`WITH cohort AS (
    INSERT INTO reader_users (name, company, job_title, wechat, tracking_consent, status, created_at)
    SELECT ${name}, '公司', '职位', '微信', false, 'active', ${inactiveSince}::timestamptz FROM generate_series(1, 201)
    RETURNING id
  ), identities AS (
    INSERT INTO reader_auth_identities (provider, subject, user_id) SELECT 'email', id::text || '@example.test', id FROM cohort
  ) SELECT id FROM cohort`;
  const ids = rows.map(row => row.id);
  t.after(async () => { await sql`DELETE FROM reader_users WHERE id IN ${sql(ids)}`; });
  assert.deepEqual(await f.run("notice", inactivitySlot.due), { deleted: 1, deferred: 0, reminded: 199, failed: 0 });
  assert.equal(await noticesFor(dueId), undefined);
  await sql`UPDATE reader_users SET inactivity_notified_at = ${inactivitySlot.first}, inactivity_deadline_at = ${inactivitySlot.due}
    WHERE id IN ${sql(ids)}`;
  assert.deepEqual(await f.run("final-notice", inactivitySlot.final), { reminded: 200, failed: 0 });
  assert.deepEqual(await f.run("digest", inactivitySlot.first), { waiting: 200, sent: 1, failed: 0 });
  assert.equal(f.alerts[0]!.lines.length, 201);
});

// Isolation: per-file database copy, one dedicated reader ID, two independent job instances and a barrier-controlled fake mailer.
test("concurrent workers skip in-flight first and second inactivity reminders without duplicate sends", async t => {
  const reader = await inactiveReader(t);
  for (const [job, at] of [["notice", inactivitySlot.first], ["final-notice", inactivitySlot.final]] as const) {
    const sending = gate();
    const finish = gate();
    class BlockingMailer extends TestMailer {
      override async send(mail: Mail) {
        sending.open();
        await finish.promise;
        await super.send(mail);
      }
    }
    const f = inactivityJobs({}, new BlockingMailer());
    const other = inactivityJobs();
    const first = f.run(job, at);
    try {
      assert.equal(await Promise.race([sending.promise.then(() => "sending"), first.then(() => "finished")]), "sending");
      await other.run(job, at);
      assert.equal(other.mailer.messages.length, 0);
    } finally {
      finish.open();
      await first;
    }
    assert.deepEqual(f.mailer.messages.map(mail => mail.to), [reader.email]);
  }
});

// Isolation: per-file database copy, unique named fixtures cleaned after the test and per-policy fake mail and alert sinks.
test("weekly digest includes only waiting readers and no email addresses, even with reader mail switched off", async t => {
  const off = inactivityJobs({ READER_MAIL_ENABLED: "false", READER_ADMIN_EMAIL: "owner@example.test" });
  assert.deepEqual(await off.run("digest", inactivitySlot.first), { waiting: 0, sent: 0, failed: 0 });
  assert.equal(off.alerts.length, 0);
  const waiting = { first: inactivitySlot.first, deadline: inactivitySlot.due };
  const reader = await inactiveReader(t, { name: "等待清理", company: "示例公司 <profile@example.test>", ...waiting });
  await inactiveReader(t, { name: "重新活跃", last: new Date(inactivitySlot.first.getTime() + MINUTE), ...waiting });
  await inactiveReader(t, { name: "未收到提醒" });
  const on = inactivityJobs({ READER_ADMIN_EMAIL: "owner@example.test" });
  assert.deepEqual(await off.run("digest", inactivitySlot.first), { waiting: 1, sent: 1, failed: 0 });
  assert.deepEqual(await on.run("digest", inactivitySlot.first), { waiting: 1, sent: 2, failed: 0 });
  assert.equal(off.mailer.messages.length, 0);
  assert.equal(on.mailer.messages[0]!.to, "owner@example.test");
  assert.deepEqual(on.alerts, off.alerts);
  const body = on.alerts[0]!.lines.join("\n");
  assert.equal(on.mailer.messages[0]!.text, body);
  assert.match(body, /等待清理.*示例公司.*产品经理.*2025-02-03 11:00.*2025-02-06 11:00/);
  assert.doesNotMatch(body, /重新活跃|未收到提醒|@/);
  assert.ok(!body.includes(reader.email));
});

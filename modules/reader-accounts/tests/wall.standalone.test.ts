import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import http, { type RequestOptions } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { Socket } from "node:net";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import type { RouteOptions } from "fastify";
import { CARDS } from "@aihot/site";
import { readerConfig } from "../backend/config.ts";
import { assertAnonymousWall } from "./wall-cases.ts";

// Isolation: this file has its own test process. Set the default policy before loading the engine config.
delete process.env.DEV_AUTH_ROLE;
process.env.READER_WALL_ENABLED = "false";
const { buildApp } = await import("@aihot/api/app");
const { clientIp } = await import("@aihot/api/http/respond");
const { ogEtag } = await import("@aihot/backend/media/og");
const { installModules } = await import("@aihot/backend/modules");
const { TOPICS } = await import("@aihot/backend/publication/topics");
const { SERVER_MODULES } = await import("@aihot/site/modules/server");
const { createReaderAccounts } = await import("../server.ts");
const modules = SERVER_MODULES.filter(m => m.name !== "reader-accounts");
const token = "wall-test-internal-token-32-characters";
const policy = readerConfig({ READER_WALL_ENABLED: "true", READER_INTERNAL_TOKEN: token }, "wall-test-secret");

test("all registered non-exempt API routes require login before handlers or redirects run", async t => {
  const answered: number[] = [];
  const served: string[] = [];
  const routes: RouteOptions[] = [];
  installModules([...modules, createReaderAccounts({ policy }), {
    name: "wall-test", http: app => { app.get("/future-publisher", () => ({ secret: "new content" })); },
    on: { requestAnswered: (_req, reply) => { answered.push(reply.statusCode); }, exitServed: exit => { served.push(exit); } },
  }]);
  const app = await buildApp({ onRoute: route => { routes.push(route); } });
  t.after(() => app.close());
  const checked = await assertAnonymousWall(app, routes);
  t.diagnostic(`已向 ${checked} 个受保护的已注册路由方法发出匿名请求`);
  assert.equal(answered.length, checked);
  assert.ok(answered.every(status => status === 401));
  assert.deepEqual(served, []);

  const robots = await app.inject("/robots.txt");
  assert.equal(robots.statusCode, 200);
  assert.match(robots.body, /^User-agent: \*\nDisallow: \/\n$/);
  assert.equal(robots.headers["x-robots-tag"], "noindex, nofollow");
  const ingest = await app.inject({ method: "POST", url: "/api/ingest/items", payload: {} });
  assert.equal(ingest.statusCode, 401);
  assert.equal(ingest.body, "Unauthorized");
  const anonymous = await app.inject("/api/reader/session");
  assert.equal(anonymous.statusCode, 200);
  assert.equal(anonymous.headers["cache-control"], "private, no-store");
  assert.equal(anonymous.json().loggedIn, false);
  for (const headers of [{}, { "x-reader-internal": "wrong" }]) {
    const samples = await app.inject({ url: "/api/reader/landing-samples", headers });
    assert.equal(samples.statusCode, 404);
    assert.equal(samples.headers["cache-control"], "private, no-store");
  }
  const deniedLookup = await app.inject("/api/admin/reader-lookups");
  assert.equal(deniedLookup.statusCode, 401, deniedLookup.body);
  assert.equal(deniedLookup.headers["cache-control"], "private, no-store");
  assert.equal(deniedLookup.json().code, "unauthorized");

  const wrong = await app.inject({ url: "/api/site/meta", headers: { "x-reader-internal": "wrong" } });
  assert.equal(wrong.statusCode, 401);
  const internal = await app.inject({ url: "/api/site/meta", headers: { "x-reader-internal": token } });
  assert.equal(internal.statusCode, 200);
  assert.equal(internal.headers["cache-control"], "private, no-store");
  assert.equal(internal.headers["x-accel-expires"], "0");
  assert.equal(internal.headers["x-robots-tag"], "noindex, nofollow");
  const unsafeWrite = await app.inject({ method: "POST", url: "/api/reader/logout", headers: { origin: "http://wrong.test" } });
  assert.equal(unsafeWrite.statusCode, 403);
  assert.equal(unsafeWrite.headers["cache-control"], "private, no-store");
});

test("startup refuses an enabled wall while the engine dev admin is active", () => {
  // Each subprocess loads its own engine config with an unreachable database.
  for (const [wall, environment, refusal] of [
    ["true", "reader-test", true], ["false", "reader-test", false], ["true", "production", false],
  ] as const) {
    const run = spawnSync(process.execPath, ["--import", "./tests/standalone.ts", "--input-type=module", "-e",
      'await import("@aihot/reader-accounts/server");'], {
      cwd: new URL("../../../", import.meta.url),
      env: { ...process.env, NODE_ENV: "development", AIHOT_ENVIRONMENT: environment, DEV_AUTH_ROLE: "admin",
        READER_WALL_ENABLED: wall, READER_INTERNAL_TOKEN: token },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(run.status, refusal ? 1 : 0, run.stderr || String(run.error ?? ""));
    if (refusal) assert.match(run.stderr, /开登录墙时必须关闭 DEV_AUTH_ROLE/);
  }
});

test("a site with no admin ignores old admin cookies on the wall and in reader admin", () => {
  // Isolation: a subprocess swaps only the site's ADMIN export and uses an unreachable database.
  const script = `
    import assert from "node:assert/strict";
    import { registerHooks } from "node:module";
    const site = import.meta.resolve("@aihot/site");
    const disabled = "data:text/javascript," + encodeURIComponent('export * from ' + JSON.stringify(site) + '; export const ADMIN = null;');
    registerHooks({ resolve: (specifier, context, next) => specifier === "@aihot/site"
      ? { shortCircuit: true, url: disabled } : next(specifier, context) });
    await import("./tests/standalone.ts");
    const { buildApp } = await import("@aihot/api/app");
    const { installModules } = await import("@aihot/backend/modules");
    const { default: reader } = await import("@aihot/reader-accounts/server");
    installModules([reader]);
    const app = await buildApp();
    try {
      for (const url of ["/api/site/meta", "/api/admin/readers", "/api/admin/reader-invites", "/api/admin/reader-applications"]) {
        const response = await app.inject({ url, headers: { cookie: "aihot_admin=stale-cookie" } });
        assert.equal(response.statusCode, 401, response.body);
      }
    } finally {
      await app.close();
    }
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: new URL("../../../", import.meta.url),
    env: { ...process.env, READER_WALL_ENABLED: "true", READER_INTERNAL_TOKEN: token },
    encoding: "utf8", timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr || String(run.error ?? ""));
});

test("the browser proxy strips the internal token before sending the upstream request", async t => {
  const { proxyToApi } = await import("../../../apps/web/app/lib/api-proxy.server.ts");
  // Isolation: stub only the outgoing request, then restore the built-in binding. No port is opened.
  let upstreamHeaders: RequestOptions["headers"];
  t.mock.method(http, "request", (options: RequestOptions) => {
    upstreamHeaders = options.headers;
    return new PassThrough();
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const req = new http.IncomingMessage(new Socket());
  req.method = "GET";
  req.url = "/api/site/meta";
  req.headers = { "x-reader-internal": token, accept: "application/json" };
  proxyToApi(req, new http.ServerResponse(req));
  req.push(null);
  assert.deepEqual(upstreamHeaders, { accept: "application/json" });
});

test("the API uses the trusted proxy address or the socket address when there are no forwarded headers", async t => {
  // Isolation: Fastify inject with a local test route. No port is opened.
  installModules([{ name: "reader-ip-test", http: app => { app.get("/reader-ip-test", req => ({ ip: clientIp(req) })); } }]);
  const app = await buildApp();
  t.after(() => app.close());
  const remoteAddress = "192.0.2.10";
  const visitor = "198.51.100.4";
  const client = async (headers?: Record<string, string>) =>
    (await app.inject({ url: "/reader-ip-test", remoteAddress, headers })).json().ip;
  assert.equal(await client(), remoteAddress);
  assert.equal(await client({ "x-forwarded-for": visitor }), visitor);
  for (const forwarded of ["203.0.113.6", "203.0.113.7"]) {
    assert.equal(await client({ "x-real-ip": visitor, "x-forwarded-for": forwarded }), visitor);
  }
});

test("the wall keeps static page descriptions and omits topic definitions from share cards", async t => {
  installModules([createReaderAccounts({ policy })]);
  const app = await buildApp();
  t.after(() => app.close());
  const page = CARDS.site!;
  const about = CARDS.about!;
  const topic = TOPICS.find(t => t.definition)!;
  for (const [url, card] of [
    ["/og/site.png", { kicker: "", title: page.title, subtitle: page.subtitle }],
    ["/og/pages/about.png", { kicker: "", title: about.title, subtitle: about.subtitle }],
    [`/og/topics/${topic.slug}.png`, { kicker: "", title: `${topic.name} 最新动态` }],
  ] as const) {
    const expected = `"og-${ogEtag(card)}"`;
    const response = await app.inject({ url, headers: { "if-none-match": expected } });
    assert.equal(response.statusCode, 304, url);
    assert.equal(response.headers.etag, expected);
  }
});

test("a disabled wall preserves existing status, payload and cache policy", async t => {
  installModules(modules);
  const baseline = await buildApp();
  installModules([...modules, createReaderAccounts({ policy: readerConfig({}, null) })]);
  const disabled = await buildApp();
  t.after(async () => { await Promise.all([baseline.close(), disabled.close()]); });
  for (const url of ["/api/site/meta", "/robots.txt", "/manifest.webmanifest", "/sitemap.xml-gone", "/openapi-v1.json"]) {
    const before = await baseline.inject(url);
    const after = await disabled.inject(url);
    assert.equal(after.statusCode, before.statusCode, url);
    assert.equal(after.body, before.body, url);
    assert.equal(after.headers["cache-control"], before.headers["cache-control"], url);
  }
  const feed = await disabled.inject({ method: "OPTIONS", url: "/feed.xml" });
  assert.equal(feed.statusCode, 204);
});

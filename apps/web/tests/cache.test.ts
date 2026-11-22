// Run after `npm run build -w @aihot/web`. Real production server/router, synthetic HTTP API only.
import assert from "node:assert/strict";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { Agent, get, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ADMIN } from "@aihot/site";
import { SIGN_IN_HOME } from "@aihot/contracts/admin";
import { isPrivatePage } from "@aihot/contracts/http-policy";
import { CATEGORY_KEYS } from "@aihot/contracts/taxonomy";
import { UNSAFE_decodeViaTurboStream } from "react-router";
import { fakeApi, itemDetail, startWebServer, type WebServer } from "./web-server.ts";

/** A health probe's no-store describes the probe itself, not the page data. */
const NO_UPSTREAM: Record<string, string> = {
  "agent.tsx": "/api/health returns no-store; forwarding it would reduce the page's 300 seconds to zero",
};

// Start just after the first comma. Ignore commas inside literals, objects, arrays and nested calls.
function hasUpstream(args: string): boolean {
  let depth = 0;
  let afterSecondArg = false;
  for (const [token] of args.matchAll(/\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`|\S/g)) {
    if (token.startsWith("//") || token.startsWith("/*")) continue;
    if (depth === 0 && token === ")") return false;
    if (afterSecondArg) return true;
    if (depth === 0 && token === ",") afterSecondArg = true;
    if (token === "(" || token === "{" || token === "[") depth++;
    if (token === ")" || token === "}" || token === "]") depth--;
  }
  return false;
}

test("route cache architecture forwards upstream headers for long-lived API pages", () => {
  const routes = new URL("../app/routes/", import.meta.url);
  const files = readdirSync(routes).filter((file) => file.endsWith(".tsx"));
  for (const file of Object.keys(NO_UPSTREAM)) assert.ok(files.includes(file), `${file}: remove the obsolete NO_UPSTREAM entry`);
  for (const file of files) {
    const source = readFileSync(new URL(file, routes), "utf8");
    const calls = [...source.matchAll(/\bcachedPage\s*\(\s*(\d+)\s*,/g)];
    const longLived = calls.filter((call) => Number(call[1]) > 60);
    const reason = NO_UPSTREAM[file];
    if (/\bcachedPage\s*\(/.test(source)) {
      assert.match(source, /export\s*\{\s*pageHeaders\s+as\s+headers\s*\}/, `${file}: export pageHeaders as headers`);
    }
    if (reason) {
      assert.ok(longLived.length, `${file}: remove the obsolete NO_UPSTREAM entry`);
      for (const call of calls) {
        assert.ok(!hasUpstream(source.slice(call.index + call[0].length)), `${file}: NO_UPSTREAM forbids the third argument (${reason})`);
      }
    } else if (longLived.length && /\b(?:apiGet|loadOr404)\s*[<(]/.test(source)) {
      for (const call of longLived) {
        assert.ok(hasUpstream(source.slice(call.index + call[0].length)), `${file}: cachedPage needs a third argument`);
      }
      assert.match(source, /\bresponseHeaders\s*:/, `${file}: collect upstream responseHeaders`);
    }
  }
});

let web: WebServer | undefined;
let origin: string;
let deadline: number;
let itemDeadline: number;
let itemFreshness = 60;
/** Root metadata answers only after the selected deadline has passed: a slow sibling loader. */
let metaAfterDeadline = false;
const apiCookies: Array<string | undefined> = [];
const api = fakeApi(async (url, res, req) => {
  apiCookies.push(req.headers.cookie);
  if (url.pathname === "/api/site/meta") {
    // Past the deadline on the wall clock the server reads: timers run on another clock, and a CI VM
    // stepping its wall clock back mid-wait would otherwise answer before the deadline.
    while (metaAfterDeadline && Date.now() < deadline * 1000 + 50) await new Promise((resolve) => setTimeout(resolve, deadline * 1000 + 50 - Date.now()));
    return { changelogVersion: "2026-09-28T12:00" };
  }
  if (url.pathname === "/api/site/timeline") {
    const filters = { channel: "all", category: url.searchParams.get("category"), tag: null };
    res.setHeader("X-Accel-Expires", `@${deadline}`);
    res.setHeader("Cache-Control", "public, max-age=30, s-maxage=30");
    return { filters, cards: [], nextCursor: null, dayCounts: [], hot: null };
  }
  if (url.pathname === "/api/site/hot") return { entries: [] };
  if (url.pathname === "/api/site/echo-client") return { forwarded: req.headers["x-forwarded-for"], real: req.headers["x-real-ip"] };
  if (url.pathname === "/api/site/download") {
    res.setHeader("Content-Type", "text/markdown; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="article.md"');
    return res.end("# Article");
  }
  if (url.pathname === "/api/site/items/freshness" || url.pathname === "/api/site/items/freshness/original") {
    itemDeadline = Math.floor(Date.now() / 1000) + itemFreshness;
    res.setHeader("X-Accel-Expires", `@${itemDeadline}`);
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    return itemDetail({ id: "freshness", title: "测试条目" });
  }
  if (url.pathname === "/api/site/contact") return { wechatQr: "/qr.png", feishuQr: "/qr.png" };
  if (url.pathname === "/api/site/stories/merged") {
    res.statusCode = 308;
    return { mergedInto: "surviving-story" };
  }
  if (url.pathname.startsWith("/api/admin/")) {
    res.statusCode = 401;
    return { code: "not_found" };
  }
});

function httpTest(name: string, body: () => Promise<void>) {
  test(name, async () => {
    if (!web) {
      deadline = Math.floor(Date.now() / 1000) + 20;
      web = await startWebServer(api);
      origin = web.origin;
    }
    await body();
  });
}
after(() => web?.stop());

httpTest("public route subsets produce the same complete navigation data; filters still differ", async () => {
  const answers = await Promise.all(["", "?_routes=root", "?_routes=routes%2Fhome", "?_routes=unknown"].map(async (query) => {
    const res = await fetch(`${origin}/_.data${query}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Cache-Control")!, /^public,/);
    assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
    assert.doesNotMatch(res.headers.get("Cache-Control")!, /stale/);
    const body = await res.text();
    assert.ok(body.includes("root") && body.includes("routes/home"));
    return body;
  }));
  assert.ok(answers.every((body) => body === answers[0]));
  const category = CATEGORY_KEYS.at(-1)!;
  const filtered = await fetch(`${origin}/_.data?category=${category}&_routes=root`);
  const body = await filtered.text();
  assert.ok(body.includes(category));
  assert.notEqual(body, answers[0]);
});

httpTest("navigation streams are plain text for download managers, including errors", async () => {
  for (const [pathname, status] of [["/_.data?_routes=root", 200], ["/items/missing.data", 404]] as const) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, status, pathname);
    assert.equal(res.headers.get("Content-Type"), "text/plain; charset=utf-8", pathname);
    assert.equal(res.headers.get("Content-Disposition"), null, pathname);
    assert.ok((await res.text()).length > 0, pathname);
  }
  const download = await fetch(origin + "/api/site/download");
  assert.equal(download.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(download.headers.get("Content-Disposition"), 'attachment; filename="article.md"');
  assert.equal(await download.text(), "# Article");
});

httpTest("HTML and navigation share freshness; cookies do not personalize public results", async () => {
  const html = await fetch(`${origin}/`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.match(await html.text(), /精选/);
  // The api's deadline also fixes the result's own expiry, so reads seconds apart compare byte for byte.
  const plain = await fetch(`${origin}/_.data`);
  const signedIn = await fetch(`${origin}/_.data?_routes=root`, { headers: { cookie: "admin_session=private; reader=returning" } });
  assert.match(plain.headers.get("Cache-Control")!, /^public,/);
  assert.equal(plain.headers.get("X-Accel-Expires"), `@${deadline}`);
  assert.equal(signedIn.headers.get("Set-Cookie"), null);
  assert.equal(await signedIn.text(), await plain.text());
  assert.ok(apiCookies.every((cookie) => !cookie));
});

httpTest("missing routes cannot be hidden by a root-only request; errors and redirects stay uncached", async () => {
  for (const pathname of ["/items/missing.data?_routes=root", "/does-not-exist.data?_routes=root", "/items/missing"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 404, pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.equal(res.headers.get("X-Accel-Expires"), "0");
    await res.text();
  }
  for (const [pathname, target] of [["/story/merged.data?_routes=root", "/story/surviving-story"], ["/_.data?q=search&_routes=root", "/all?q=search"]]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.status, 202);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    assert.match(await res.text(), new RegExp(target.replace("?", "\\?")));
  }
});

httpTest("admin data and actions never become public cache entries", async () => {
  if (ADMIN) {
    const admin = await fetch(`${origin}/admin/sources.data?_routes=admin-layout`);
    assert.equal(admin.status, 202);
    assert.equal(admin.headers.get("Cache-Control"), "private, no-store");
    assert.equal(admin.headers.get("X-Accel-Expires"), "0");
    assert.match(await admin.text(), /api\/auth\/login/);
  } else {
    const none = await fetch(`${origin}/admin/sources`);
    assert.equal(none.status, 404, "a site without admin pages has none");
    await none.text();
  }
  const action = await fetch(`${origin}/hot.data`, { method: "POST" });
  assert.equal(action.status, 405);
  assert.equal(action.headers.get("Cache-Control"), "private, no-store");
  assert.equal(action.headers.get("X-Accel-Expires"), "0");
  await action.text();
});

httpTest("gray pages are private like the admin's, whatever their route asks for", async () => {
  for (const pathname of ["/preview", "/preview/", "/preview/models", "/Preview/models", "/admin", "/admin/runs", "/admin/expiry"]) assert.equal(isPrivatePage(pathname), true, pathname);
  for (const pathname of ["/", "/previews", "/all", "/items/preview", "/administer"]) assert.equal(isPrivatePage(pathname), false, pathname);
  for (const pathname of ["/preview/missing", "/preview/missing.data", "/preview/missing.data?_routes=root"]) {
    const res = await fetch(origin + pathname);
    assert.equal(res.headers.get("Cache-Control"), "private, no-store", pathname);
    assert.equal(res.headers.get("X-Accel-Expires"), "0", pathname);
    await res.text();
  }
});

httpTest("browser freshness shares the selected deadline, including slow sibling loaders", async () => {
  const savedDeadline = deadline;
  try {
    deadline = Math.floor(Date.now() / 1000) + 20;
    for (const pathname of ["/", "/_.data?_routes=routes%2Fhome"]) {
      const res = await fetch(origin + pathname);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser === shared);
      assert.ok(Date.parse(res.headers.get("Date")!) / 1000 + browser <= deadline);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${deadline}`);
      assert.match(cc, /must-revalidate/);
      assert.doesNotMatch(cc, /stale/);
      await res.text();
    }
    // The selected loader initially grants a positive TTL (at least a whole second), but root metadata
    // finishes after it.
    deadline = Math.floor(Date.now() / 1000) + 2;
    metaAfterDeadline = true;
    await Promise.all(["/", "/_.data?_routes=routes%2Fhome"].map(async (pathname) => {
      const res = await fetch(origin + pathname);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("Cache-Control"), "no-cache");
      assert.equal(res.headers.get("X-Accel-Expires"), "0");
      await res.text();
    }));
  } finally {
    deadline = savedDeadline;
    metaAfterDeadline = false;
  }
});

httpTest("item and original pages share the upstream deadline, at most a minute", async () => {
  for (const seconds of [60, 20]) {
    itemFreshness = seconds;
    for (const path of ["/items/freshness.data", "/items/freshness/original.data"]) {
      const res = await fetch(origin + path);
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("X-Accel-Expires"), `@${itemDeadline}`, path);
      const cc = res.headers.get("Cache-Control")!;
      const browser = Number(cc.match(/(?:^|,)\s*max-age=(\d+)/)![1]);
      const shared = Number(cc.match(/(?:^|,)\s*s-maxage=(\d+)/)![1]);
      assert.ok(browser > 0 && browser <= seconds && shared === browser, path);
      await res.text();
    }
  }
});

// A tab opened before a page lost its loader still asks for that page's result, and its router rejects
// a missing one before React's release recovery can run.
httpTest("a page without a loader still answers navigation with an empty result", async () => {
  const res = await fetch(`${origin}/terms.data?_routes=routes%2Fterms`);
  assert.equal(res.status, 200);
  const { value } = await UNSAFE_decodeViaTurboStream(res.body!, globalThis);
  const result = value as Record<string, { data: unknown }>;
  assert.ok("routes/terms" in result, "an already open router must be able to unwrap its requested route");
  assert.equal(result["routes/terms"]!.data, null);
});

httpTest("browser caching preserves noindex and private sign-in responses", async () => {
  const feedback = await fetch(origin + "/feedback");
  assert.equal(feedback.status, 200);
  assert.match(await feedback.text(), /name="robots" content="noindex/);
  assert.equal(feedback.headers.get("Cache-Control"), "public, max-age=300, s-maxage=300, must-revalidate");
  const login = await fetch(origin + "/admin/login");
  assert.equal(login.status, ADMIN ? 200 : 404, "a site without admin pages has no admin sign-in either");
  assert.equal(login.headers.get("Cache-Control"), "private, no-store");
  if (ADMIN) assert.equal(login.headers.get("X-Robots-Tag"), "noindex, nofollow");
  await login.text();
});

test("a signed-in admin is sent past the sign-in page", { skip: !ADMIN && "this site has no admin pages" }, async () => {
  const api = fakeApi((url, res, req) => {
    if (url.pathname === "/api/admin/me") {
      if (req.headers.cookie?.includes("aihot_admin=fixture")) return { name: "Fixture admin", csrf: "fixture", dev: false };
      res.statusCode = 401;
      return { code: "unauthorized" };
    }
    if (url.pathname === "/api/auth/options") return { password: true };
  });
  const signedIn = await startWebServer(api);
  try {
    const res = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin%2Fcontent`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/admin/content");
    await res.text();
    for (const [target, location] of [["javascript:alert(1)", SIGN_IN_HOME], ["//evil.example/admin", SIGN_IN_HOME], ["/x/..//evil.example", SIGN_IN_HOME], ["https://evil.example/admin", "/admin"], ["/free-preview", "/free-preview"]]) {
      const away = await fetch(`${signedIn.origin}/admin/login?return=${encodeURIComponent(target!)}`, { headers: { cookie: "aihot_admin=fixture" }, redirect: "manual" });
      assert.equal(away.headers.get("location"), location, target);
      await away.text();
    }
    const anonymous = await fetch(`${signedIn.origin}/admin/login?return=%2Fadmin`, { redirect: "manual" });
    assert.equal(anonymous.status, 200, "without a session the page still offers the ways in");
    await anonymous.text();
  } finally {
    await signedIn.stop();
  }
});

httpTest("a visitor cannot name its own address to the api without a trusted proxy in front", async () => {
  const res = await fetch(`${origin}/api/site/echo-client`, { headers: { "X-Forwarded-For": "6.6.6.6", "X-Real-IP": "6.6.6.6" } });
  assert.deepEqual(await res.json(), { forwarded: "127.0.0.1", real: "127.0.0.1" });
});

// The real listener must own its ephemeral port; reserving and releasing one before spawn races
// another CI process. Canonical URLs still have to identify the listener's actual address.
test("a web server assigned port zero serves its own canonical address", async () => {
  const ephemeral = await startWebServer(fakeApi(), { WEB_PORT: "0", SITE_URL: "http://127.0.0.1:0" });
  try {
    const response = await fetch(`${ephemeral.origin}/about`);
    assert.equal(response.status, 200);
    assert.ok((await response.text()).includes(`rel="canonical" href="${ephemeral.origin}/about"`));
  } finally { await ephemeral.stop(); }
});

test("SSR keeps reaching an API that answers 503 and opens the circuit on transport failures", async () => {
  const path = "/items/circuit";
  let hits = 0;
  let unavailable = true;
  const upstream = fakeApi((url, res) => {
    if (url.pathname === `/api/site${path}`) hits++;
    if (unavailable) {
      res.statusCode = 503;
      return { code: "unavailable" };
    }
    if (url.pathname === `/api/site${path}`) return itemDetail({ id: "circuit", title: "测试条目" });
  });
  const server = await startWebServer(upstream);
  const port = (upstream.address() as AddressInfo).port;
  const read = async (status: number) => {
    const res = await fetch(server.origin + path, { signal: AbortSignal.timeout(1_000) });
    assert.equal(res.status, status);
    if (status === 503) assert.equal(res.headers.get("Cache-Control"), "private, no-store");
    await res.text();
  };
  try {
    for (let i = 1; i <= 4; i++) {
      await read(503);
      assert.equal(hits, i, "an HTTP 503 must not trip the circuit");
    }

    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    for (let i = 0; i < 4; i++) await read(503);

    // A refused connection is fast too. Restart behind the open circuit and check that it is bypassed.
    unavailable = false;
    upstream.listen(port, "127.0.0.1");
    await once(upstream, "listening");
    await read(503);
    assert.equal(hits, 4, "SSR must not contact the API while the circuit is open");
    assert.equal(server.logs().match(/"msg":"ssr api circuit open"/g)?.length, 1);

    await delay(5_000);
    await read(200);
    assert.equal(hits, 5);
  } finally {
    await server.stop();
  }
});

test("SIGTERM exits promptly with an idle keep-alive connection", async () => {
  const server = await startWebServer(fakeApi());
  const agent = new Agent({ keepAlive: true });
  try {
    const request = get(server.origin + "/about", { agent, signal: AbortSignal.timeout(2_000) });
    const [res] = (await once(request, "response")) as [IncomingMessage];
    assert.equal(res.statusCode, 200);
    const idle = once(agent, "free", { signal: AbortSignal.timeout(2_000) });
    res.resume();
    await idle;

    server.kill("SIGTERM");
    const code = await Promise.race([
      server.exited,
      delay(2_000, undefined, { ref: false }).then(() => assert.fail("web ignored SIGTERM")),
    ]);
    assert.equal(code, 0);
  } finally {
    agent.destroy();
    await server.stop();
  }
});

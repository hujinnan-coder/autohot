import assert from "node:assert/strict";
import { IncomingMessage, Server, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { test } from "node:test";
import { fakeApi, FIXTURE_AT, itemDetail, startWebServer } from "./web-server.ts";

const INTERNAL = "test-only-reader-internal-token-123456";
const ACTIVE = "theme=dark; reader_session=active-fixture";
const PENDING = "reader_session=pending-fixture";
const STALE = "reader_session=expired-fixture";
const PREVIEW = { title: "分享标题", summary: "分享摘要", source: "分享信源", published_at: FIXTURE_AT };
const PRIVATE = "正文机密标记";
const PRIVATE_HEADERS = "private, no-store";

function fixture(wall: boolean) {
  const calls: Array<{ path: string; cookie: string | null; token: string | null }> = [];
  function answer(url: URL, headers: Headers): Response {
    const path = url.pathname;
    const cookie = headers.get("cookie");
    const token = headers.get("x-reader-internal");
    calls.push({ path, cookie, token });
    if (path === "/api/reader/session") return Response.json({
      loggedIn: cookie === ACTIVE || cookie === PENDING,
      status: cookie === ACTIVE ? "active" : cookie === PENDING ? "pending" : null,
      terms_version: "fixture-terms", privacy_version: "fixture-privacy",
    });
    if (path === "/api/reader/landing-samples") {
      return token === INTERNAL ? Response.json({ samples: [
        { ...PREVIEW, title: "样例一", source: "不显示的样例信源", body: PRIVATE },
        { ...PREVIEW, title: "样例二" },
        { ...PREVIEW, title: "不显示的第三条样例" },
      ] }) : Response.json({}, { status: 404 });
    }
    if (path === "/api/reader/preview/a" || path === "/api/reader/preview/story/b") {
      return Response.json({ ...PREVIEW, body: PRIVATE, score: "评分机密标记" });
    }
    if (path === "/api/reader/me") return Response.json({
      id: "reader", status: cookie === PENDING ? "pending" : "active", name: "读者", company: "公司",
      job_title: "职位", wechat: "联系人", email: "reader@example.org", tracking_consent: false,
    });
    if (path === "/api/reader/me/invites") return Response.json({ quota: 0, invites: [] });
    if (path === "/api/site/meta") return Response.json({ changelogVersion: "reader-fixture" });
    if (path === "/api/site/timeline") {
      if (wall && token !== INTERNAL) return Response.json({}, { status: 401 });
      return Response.json({ filters: { channel: "all", category: null, tag: null }, cards: [], nextCursor: null, dayCounts: [], hot: null }, {
        headers: { "Cache-Control": "public, s-maxage=30", "X-Accel-Expires": `@${Math.floor(Date.now() / 1000) + 25}` },
      });
    }
    if (path === "/api/site/items/a") return Response.json(itemDetail({
      id: "a", title: "完整条目", body: { zh: `<p>${PRIVATE}</p>`, original: null, zhKind: "translation", complete: true },
    }));
    if (path === "/api/site/echo") return Response.json({ cookie, token });
    if (path === "/robots.txt") return new Response("User-agent: *\nDisallow: /\n");
    if (path === "/sitemap.xml") return new Response(null, { status: 401 });
    return Response.json({}, { status: 404 });
  }
  const api = fakeApi(async (url, res, req) => {
    const response = answer(url, new Headers(req.headers as Record<string, string>));
    res.statusCode = response.status;
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.end(await response.text());
  });
  return { answer, api, calls };
}

function privatePage(response: Response) {
  assert.equal(response.headers.get("Cache-Control"), PRIVATE_HEADERS);
  assert.equal(response.headers.get("X-Accel-Expires"), "0");
}

async function checkPreview(response: Response, path: string) {
  assert.equal(response.status, 200);
  privatePage(response);
  assert.equal(response.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const html = await response.text();
  for (const value of [PREVIEW.title, PREVIEW.summary, PREVIEW.source, "凭邀请码入座", "申请入座", encodeURIComponent(path)]) {
    assert.ok(html.includes(value), value);
  }
  assert.doesNotMatch(html, new RegExp(`${PRIVATE}|评分机密标记|完整条目|主导航`));
  assert.ok(!html.includes(INTERNAL));
}

type ReadPage = (path: string, cookie?: string) => Promise<Response>;
async function checkOpenWall(read: ReadPage, calls: ReturnType<typeof fixture>["calls"]) {
  const content = await read("/all?category=new-car");
  assert.equal(content.status, 302);
  assert.equal(content.headers.get("Location"), "/login?return=%2Fall%3Fcategory%3Dnew-car");
  privatePage(content);
  const alias = await read("/all/");
  assert.equal(alias.status, 302);
  assert.equal(alias.headers.get("Location"), "/login?return=%2Fall%2F");
  const data = await read("/_.data?_routes=root");
  assert.match(await data.text(), /\/login\?return=%2F/);
  privatePage(data);
  assert.equal(calls.filter(call => call.path.startsWith("/api/site/")).length, 0);

  for (const path of ["/join", "/apply", "/register?code=AB-CDEF-GHJK", "/login", "/terms", "/privacy"]) {
    const result = await read(path);
    assert.equal(result.status, 200, path);
    privatePage(result);
    const html = await result.text();
    if (path === "/join") {
      assert.match(html, /早上看去向，夜里听余声/);
      assert.match(html, /样例一.*样例二/);
      assert.doesNotMatch(html, /不显示的样例信源|不显示的第三条样例|正文机密标记/);
    }
    if (path.startsWith("/register")) assert.match(html, /AB-CDEF-GHJK/);
    if (path.startsWith("/join") || path.startsWith("/apply") || path.startsWith("/register") || path === "/login") {
      assert.equal(result.headers.get("X-Robots-Tag"), "noindex, nofollow");
    }
    assert.ok(!html.includes(INTERNAL));
  }
  await checkPreview(await read("/items/a?from=share"), "/items/a?from=share");
  await checkPreview(await read("/story/b"), "/story/b");
  assert.equal(calls.filter(call => call.path === "/api/site/items/a").length, 0);

  const beforeActive = calls.filter(call => call.path === "/api/reader/session").length;
  const signedIn = await read("/items/a", ACTIVE);
  assert.equal(signedIn.status, 200);
  privatePage(signedIn);
  const signedInHtml = await signedIn.text();
  assert.match(signedInHtml, /正文机密标记/);
  assert.ok(!signedInHtml.includes(INTERNAL));
  assert.match(await (await read("/more", ACTIVE)).text(), /href="\/account"[^>]*>.*?账户/);
  const activeSessionCalls = calls.filter(call => call.path === "/api/reader/session").slice(beforeActive);
  assert.deepEqual(activeSessionCalls, [{ path: "/api/reader/session", cookie: ACTIVE, token: INTERNAL }]);
  assert.equal(calls.find(call => call.path === "/api/site/items/a")?.token, INTERNAL);

  const pending = await read("/items/a", PENDING);
  assert.equal(pending.status, 302);
  assert.equal(pending.headers.get("Location"), "/account/pending");
  assert.match(await (await read("/account/pending", PENDING)).text(), /名片已收下，等待确认/);
  const account = await read("/account", PENDING);
  assert.equal(account.status, 200);
  privatePage(account);
  const html = await account.text();
  assert.match(html, /即将开放/);
  assert.doesNotMatch(html, /子邀请码|主导航/);

  for (let i = 0; i < 2; i++) {
    const expired = await read("/all", STALE);
    assert.equal(expired.headers.get("Location"), "/login?return=%2Fall&expired=1");
  }
  assert.equal(calls.filter(call => call.path === "/api/reader/session" && call.cookie === STALE).length, 2);
  assert.match(await (await read("/login?return=%2Fall&expired=1", STALE)).text(), /你有一阵没来了，为了账号安全，请重新登录。/);
}

// Run the production request handler using synthetic Node HTTP requests and a fake upstream.
// These mocks are confined to this node:test process and restored after the case.
test("reader wall SSR with an in-process API fixture", async t => {
  const { answer, calls } = fixture(true);
  t.mock.method(globalThis, "fetch", async (url: string, init?: RequestInit) => answer(new URL(url), new Headers(init?.headers)));
  let server: Server | undefined;
  t.mock.method(Server.prototype, "listen", function (this: Server) { server = this; return this; });
  const original = { wall: process.env.READER_WALL_ENABLED, token: process.env.READER_INTERNAL_TOKEN };
  process.env.READER_WALL_ENABLED = "true";
  process.env.READER_INTERNAL_TOKEN = INTERNAL;
  t.after(() => {
    if (original.wall === undefined) delete process.env.READER_WALL_ENABLED;
    else process.env.READER_WALL_ENABLED = original.wall;
    if (original.token === undefined) delete process.env.READER_INTERNAL_TOKEN;
    else process.env.READER_INTERNAL_TOKEN = original.token;
  });
  const events = ["unhandledRejection", "SIGINT", "SIGTERM"] as const;
  const listeners = events.map(event => process.listeners(event));
  t.after(() => events.forEach((event, i) => {
    for (const listener of process.listeners(event)) if (!listeners[i]!.includes(listener)) process.off(event, listener);
  }));
  await import("../server.ts");
  assert.ok(server);
  await checkOpenWall((path, cookie) => new Promise<Response>(resolve => {
    const req = new IncomingMessage(new Socket());
    req.url = path;
    req.method = "GET";
    req.httpVersionMajor = 1;
    req.httpVersionMinor = 1;
    req.headers = { host: "web.fixture", cookie };
    const res = new ServerResponse(req);
    const chunks: Uint8Array[] = [];
    res.write = (chunk: Uint8Array) => { chunks.push(chunk); return true; };
    res.end = ((body?: string) => {
      const headers = new Headers(res.getHeaders() as Record<string, string>);
      resolve(new Response(body ?? Buffer.concat(chunks).toString("utf8"), { status: res.statusCode, headers }));
      res.emit("finish");
      return res;
    }) as typeof res.end;
    server!.emit("request", req, res);
  }), calls);
});

// Uses the normal web harness, with a fresh child process and a private ephemeral API listener for each mode.
test("reader wall production HTTP and closed-wall cache behavior", async t => {
  const opened = fixture(true);
  const web = await startWebServer(opened.api, { READER_WALL_ENABLED: "true", READER_INTERNAL_TOKEN: INTERNAL });
  t.after(() => web.stop());
  await checkOpenWall((path, cookie) => fetch(web.origin + path, { headers: cookie ? { cookie } : {}, redirect: "manual" }), opened.calls);
  const forwarded = await fetch(web.origin + "/api/site/echo", { headers: { cookie: ACTIVE, "x-reader-internal": "browser-header" } });
  assert.deepEqual(await forwarded.json(), { cookie: ACTIVE, token: null });
  assert.match(await (await fetch(web.origin + "/robots.txt")).text(), /Disallow: \//);
  assert.equal((await fetch(web.origin + "/sitemap.xml")).status, 401);

  const closed = fixture(false);
  const publicWeb = await startWebServer(closed.api, { READER_WALL_ENABLED: "false", READER_INTERNAL_TOKEN: INTERNAL });
  t.after(() => publicWeb.stop());
  const homepage = await fetch(publicWeb.origin + "/", { headers: { cookie: ACTIVE } });
  assert.equal(homepage.status, 200);
  assert.match(homepage.headers.get("Cache-Control") ?? "", /^public, max-age=\d+, s-maxage=\d+, must-revalidate$/);
  assert.match(homepage.headers.get("X-Accel-Expires") ?? "", /^@\d+$/);
  assert.doesNotMatch(await homepage.text(), /href="\/account"/);
  const article = await fetch(publicWeb.origin + "/items/a");
  assert.match(await article.text(), /正文机密标记/);
  assert.ok(closed.calls.every(call => call.token === null && call.path !== "/api/reader/session"));
});

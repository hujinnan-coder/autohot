// Failure cases: an origin-form // path is read as a URL authority and throws a 500; an unknown
// double-slash path becomes a different host's root; HEAD or single-fetch data follows another rule.
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { request } from "node:http";
import { after, before, test } from "node:test";
import { fakeApi, startWebServer, type WebServer } from "./web-server.ts";

let web: WebServer;
const upstreamPaths: string[] = [];
const mediaCsp = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
const api = fakeApi((url, res, req) => {
  upstreamPaths.push(req.url ?? "");
  if (url.pathname === "/api/site/timeline") return { cards: [], nextCursor: null, dayCounts: {}, hot: [], filters: { category: null, channel: null, tag: null } };
  if (url.pathname === "/api/img-proxy") {
    res.setHeader("Content-Type", "image/svg+xml");
    res.setHeader("Content-Security-Policy", mediaCsp);
    return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>');
  }
});

before(async () => { web = await startWebServer(api); });
after(() => web?.stop());

function raw(path: string, method: "GET" | "HEAD") {
  return new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: web.port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("origin-form slashes keep the router's homepage and unknown-route semantics", async () => {
  for (const method of ["GET", "HEAD"] as const) {
    const home = await raw("/", method);
    assert.equal(home.status, 200, web.logs());
    for (const path of ["//", "////", "//?category=new-car"]) {
      const res = await raw(path, method);
      assert.equal(res.status, 200, `${method} ${path}: ${web.logs()}`);
      assert.equal(res.headers["content-type"], home.headers["content-type"]);
      assert.match(res.headers["cache-control"] ?? "", /^public, max-age=\d+, s-maxage=\d+, must-revalidate$/);
      if (method === "HEAD") assert.equal(res.body, "");
    }
    for (const path of ["/unknown-page", "//unknown-page", "//evil.invalid/unknown-page", "//unknown-page.data?token=private"]) {
      const res = await raw(path, method);
      assert.equal(res.status, 404, `${method} ${path}: ${web.logs()}`);
      assert.equal(res.headers["cache-control"], "private, no-store");
      if (method === "HEAD") assert.equal(res.body, "");
    }
  }
  assert.equal(web.logs(), "");
  assert.ok(upstreamPaths.every((path) => path.startsWith("/api/site/")));
});

test("pages, static files, redirects, errors and API responses all carry Caddy's security headers", async () => {
  const css = readdirSync(new URL("../build/client/assets/", import.meta.url)).find((file) => file.endsWith(".css"));
  assert.ok(css, "the built site has a stylesheet");
  // Origin-form // now serves the homepage. A malformed asset path still reaches the error handler.
  for (const [path, status] of [["/", 200], [`/assets/${css}`, 200], ["/about/", 301], ["/assets/%.css", 400], ["/api/health", 200]] as const) {
    const res = await raw(path, "GET");
    assert.equal(res.status, status, `${path}: ${web.logs()}`);
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN", path);
    assert.equal(res.headers["x-content-type-options"], "nosniff", path);
    assert.equal(res.headers["referrer-policy"], "strict-origin-when-cross-origin", path);
    assert.equal(res.headers["permissions-policy"], "camera=(), microphone=(), geolocation=()", path);
    assert.equal(res.headers["strict-transport-security"], undefined, path);
  }
});

test("the web proxy preserves the media response's CSP", async () => {
  const res = await raw("/api/img-proxy", "GET");
  assert.equal(res.status, 200, web.logs());
  assert.equal(res.headers["content-type"], "image/svg+xml");
  assert.equal(res.headers["content-security-policy"], mediaCsp);
});

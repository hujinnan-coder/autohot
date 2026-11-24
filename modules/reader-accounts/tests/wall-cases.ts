import assert from "node:assert/strict";
import type { FastifyInstance, InjectOptions, RouteOptions } from "fastify";
import { CONTACT_ALIASES } from "@aihot/contracts/http-policy";
import { SITE } from "@aihot/site";

const SAFE_GETS = new Set([
  "/api/health", "/api/auth/login", "/api/auth/options", "/robots.txt", "/manifest.webmanifest",
  "/openapi-v1.json", "/.well-known/security.txt", "/favicon.ico", "/icon.png", "/icon-192.png",
  "/apple-icon.png", "/logo.svg", "/contact/:file", "/og/site.png", "/og/pages/:file", "/og/items/:file",
  "/og/topics/:file", "/og/stories/:file", "/og/reports/:kind/:file",
  ...SITE.rootIcons.map(file => `/${file}`), ...CONTACT_ALIASES.map(({ file }) => `/${file}`),
]);
const SAFE_POSTS = new Set(["/api/ingest/items", "/api/auth/password", "/api/auth/logout"]);

export async function assertAnonymousWall(app: FastifyInstance, routes: readonly RouteOptions[]) {
  await app.ready();
  let checked = 0;
  for (const route of routes) {
    const template = route.url;
    if (template.startsWith("/api/reader/") || template.startsWith("/api/admin/")) continue;
    const url = template.replace(/:[\w]+\??|\*/g, "wall-probe");
    for (const method of [route.method].flat()) {
      if ((method === "GET" || method === "HEAD") && SAFE_GETS.has(template)) continue;
      if (method === "POST" && SAFE_POSTS.has(template)) continue;
      const reply = await app.inject({ method: method as InjectOptions["method"], url, headers: { "x-aihot-ssr": "1" } });
      assert.equal(reply.statusCode, 401, `${method} ${template} returned ${reply.statusCode}: ${reply.body.slice(0, 200)}`);
      assert.equal(reply.headers["cache-control"], "private, no-store", `${method} ${template}`);
      assert.match(reply.headers["content-type"] as string, /^application\/problem\+json/);
      if (method !== "HEAD") assert.equal(reply.json().code, "login_required", `${method} ${template}`);
      checked++;
    }
  }
  assert.ok(checked > 30, `On-route inventory covered only ${checked} methods`);
  return checked;
}

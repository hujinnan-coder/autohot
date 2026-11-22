import assert from "node:assert/strict";
import { test } from "node:test";
import { installModules } from "@aihot/backend/modules";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../apps/api/src/app.ts";

test("the public v1 GET routes and OpenAPI paths agree in both directions", async (t) => {
  const routes: Array<{ method: string; url: string }> = [];
  // onRoute gives full paths even for generated routes, where printRoutes compresses prefixes.
  // A site module that adds a v1 GET route must also document it in the spec.
  installModules(SERVER_MODULES);
  const app = await buildApp({ onRoute: (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) routes.push({ method, url: route.url });
  } });
  t.after(() => app.close());
  await app.ready();

  const norm = (url: string) => url.replace(/\{(\w+)\}/g, ":$1").replace(/\/$/, "");
  const INTERNAL = new Set(["/api/v1", "/api/v1/*", "/openapi-v1.json"]); // v1.ts readOnlyMethods
  const actual = new Set(routes
    .filter((route) => route.method === "GET" && route.url.startsWith("/api/v1/") && !route.url.includes("*") && !INTERNAL.has(route.url))
    .map((route) => norm(route.url)));
  const response = await app.inject("/openapi-v1.json");
  assert.equal(response.statusCode, 200);
  const spec = response.json();
  const documented = new Set(Object.keys(spec.paths).map(norm));

  assert.deepEqual([...documented].filter((url) => !actual.has(url)), [], "OpenAPI paths without GET routes");
  assert.deepEqual([...actual].filter((url) => !documented.has(url)), [], "GET routes missing from OpenAPI");
  assert.equal(documented.size, 25);
});

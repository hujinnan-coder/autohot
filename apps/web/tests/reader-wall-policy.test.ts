import assert from "node:assert/strict";
import { test } from "node:test";
import { hasReaderCookie, readerPageAccess, readerPageTarget, readerReturn, readerSessionKey } from "../app/lib/reader-wall.ts";

// Pure policy tests with synthetic paths and cookies. No service, environment or shared state.
test("the page allowlist, admin boundary and single-entry previews are distinct", () => {
  for (const path of ["/join", "/apply", "/register", "/LOGIN/", "/terms", "/privacy", "/admin/login", "/admin/readers"]) {
    assert.equal(readerPageAccess(path, null, false, "GET").redirect, undefined, path);
  }
  for (const path of ["/", "/more", "/login-help", "/items/1/original", "/admin-lookalike", "/admin/../all"]) {
    assert.equal(readerPageAccess(path, null, false, "GET").redirect, `/login?return=${encodeURIComponent(readerReturn(path))}`, path);
  }
  assert.equal(readerPageAccess("/items/a?via=share", null, false, "GET").share, "items");
  assert.equal(readerPageAccess("/story/a/", null, false, "HEAD").share, "story");
  assert.equal(readerPageAccess("/story/a", null, false, "POST").share, undefined);
  assert.equal(readerPageAccess("/account", "pending", false, "GET").redirect, undefined);
  assert.equal(readerPageAccess("/account/pending", "pending", false, "GET").redirect, undefined);
  assert.equal(readerPageAccess("/items/1", "pending", false, "GET").redirect, "/account/pending");
  assert.equal(readerPageAccess("/join", "pending", false, "GET").redirect, "/account/pending");
  assert.equal(readerPageAccess("/all", "active", false, "GET").redirect, undefined);
  assert.equal(readerPageAccess("/all", null, true, "GET").redirect, "/login?return=%2Fall&expired=1");
});

test("return URLs retain the site's path and query, excluding router transport parameters", () => {
  for (const target of [null, "https://elsewhere.test/all", "//elsewhere.test/all", "/\\elsewhere.test/all", "/..//elsewhere.test/all", "/login?return=/hot", "/%ZZ", "/" + "x".repeat(2001)]) {
    assert.equal(readerReturn(target), "/", target ?? "null");
  }
  assert.equal(readerReturn("/items/fixture?ref=%E5%BE%AE%E4%BF%A1#section"), "/items/fixture?ref=%E5%BE%AE%E4%BF%A1");
  assert.equal(readerPageTarget(new URL("http://local/_.data?_routes=root&category=new-car")), "/?category=new-car");
  assert.equal(readerPageTarget(new URL("http://local/story/abc.data?_routes=routes%2Fstory&q=x")), "/story/abc?q=x");
  assert.equal(readerPageTarget(new URL("http://local/items/abc_.data")), "/items/abc_");
  assert.equal(readerPageTarget(new URL("http://local/items/abc?_routes=kept")), "/items/abc?_routes=kept");
});

test("cache keys are deterministic cookie hashes and stale cookies can be recognized", () => {
  const cookie = "theme=dark; reader_session=a-fake-session";
  assert.match(readerSessionKey(cookie), /^[0-9a-f]{64}$/);
  assert.equal(readerSessionKey(cookie), readerSessionKey(cookie));
  assert.notEqual(readerSessionKey(cookie), readerSessionKey(cookie + "-changed"));
  assert.equal(hasReaderCookie(cookie), true);
  assert.equal(hasReaderCookie("old_reader_session=fixture; theme=dark"), false);
});

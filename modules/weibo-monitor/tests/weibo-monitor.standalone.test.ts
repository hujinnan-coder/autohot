import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { identityKeyForUrl } from "@aihot/backend/lib/url";
import { accounts, initialDueAccounts, nextDueAt, tickTime } from "../backend/accounts.ts";
import { parseTimeline, parseWeiboDate, parseWeiboDisplayDate, selectFirstScanItems, weiboUrlForIngest } from "../backend/timeline.ts";

const profile = readFileSync(new URL("../fixtures/sample-profile.html", import.meta.url), "utf8");
const renderedAt = new Date("2026-11-28T11:00:00+08:00");

test("Weibo timestamps use the supplied offset, including across a year boundary", () => {
  assert.equal(parseWeiboDate("Thu Nov 05 07:35:12 +0800 2026")?.toISOString(), "2026-11-04T23:35:12.000Z");
  assert.equal(parseWeiboDate("Fri Jan 01 00:15:00 +0800 2027")?.toISOString(), "2026-12-31T16:15:00.000Z");
  assert.equal(parseWeiboDate("Thu Dec 31 23:45:00 -0330 2026")?.toISOString(), "2027-01-01T03:15:00.000Z");
  assert.equal(parseWeiboDate("Fri Feb 30 07:35:12 +0800 2026"), null);
  assert.equal(parseWeiboDate("Thu Nov 05 07:35:12 2026"), null);
});

test("reads the posts, page author and signed avatar from a hydrated profile", () => {
  const { items, avatar } = parseTimeline(profile, { now: renderedAt });
  const statusPosts = items.filter(item => !item.url.includes("#"));
  const shortPosts = items.filter(item => item.url.includes("#"));
  assert.ok(items.length >= 9);
  assert.equal(statusPosts.length, 5);
  assert.equal(shortPosts.length, 6);
  for (const item of statusPosts) {
    assert.match(item.url, /^https:\/\/m\.weibo\.cn\/status\/\d+$/);
    assert.match(item.bodyText, /\.\.\.$/);
  }
  for (const item of shortPosts) {
    assert.match(item.url, /^https:\/\/m\.weibo\.cn\/u\/1749127163#[a-f0-9]{16}$/);
    assert.equal(new URL(item.url).hash.slice(1), createHash("sha1").update(item.bodyText).digest("hex").slice(0, 16));
  }
  for (const item of items) {
    assert.equal(item.author, "雷军");
    assert.ok(item.title.length <= 143);
    assert.doesNotMatch(item.bodyText, /置顶|展开全文|21分钟前|6万次播放/);
    assert.equal("retweeted_status" in item.raw, false);
  }
  assert.ok(items.some(item => item.bodyText.includes("关注和支持")));
  assert.equal(items.find(item => item.url.endsWith("/5369510837357649"))?.publishedAt, "2026-11-25T14:30:00.000Z");
  assert.ok(avatar);
  assert.ok(new URL(avatar).searchParams.get("ssig"));
  assert.equal(parseTimeline(profile.replaceAll("ssig=", "unsigned="), { now: renderedAt }).avatar, null);
});

test("reads relative dates from post headers and keeps a short post URL when its age changes", () => {
  const { items } = parseTimeline(profile, { now: renderedAt });
  const minutePost = items.find(item => item.bodyText.startsWith("这个雪季，你最期待的是什么？"));
  const hourPost = items.find(item => item.url.endsWith("/5370204134838420"));
  assert.ok(minutePost?.publishedAt);
  assert.ok(hourPost?.publishedAt);
  const minutes = (renderedAt.getTime() - Date.parse(minutePost.publishedAt)) / 60_000;
  const hours = (renderedAt.getTime() - Date.parse(hourPost.publishedAt)) / 3_600_000;
  assert.ok(minutes >= 21 && minutes < 22);
  assert.ok(hours >= 2 && hours < 3);
  assert.equal(parseTimeline(profile.replace(">21分钟前<", ">22分钟前<"), { now: renderedAt }).items
    .find(item => item.bodyText === minutePost.bodyText)?.url, minutePost.url);
});

test("short posts remain distinct after the ingest URL is normalized", () => {
  const { items } = parseTimeline(profile, { now: renderedAt });
  const identities = items.map(item => identityKeyForUrl(weiboUrlForIngest(item.url)));
  assert.equal(new Set(identities).size, items.length);
  assert.ok(identities.every(Boolean));
});

test("Weibo calendar dates use Beijing time and roll back a year only beyond one day", () => {
  const now = new Date("2026-12-31T16:30:00Z");
  for (const [label, expected] of [
    ["12-31 23:45", "2026-12-31T15:45:00.000Z"],
    ["12-31", "2026-12-30T16:00:00.000Z"],
    ["昨天 23:45", "2026-12-31T15:45:00.000Z"],
    ["00:15", "2026-12-31T16:15:00.000Z"],
    ["01-02 00:30", "2027-01-01T16:30:00.000Z"],
    ["01-02 00:31", "2026-01-01T16:31:00.000Z"],
  ] as const) {
    assert.equal(parseWeiboDisplayDate(label, now)?.toISOString(), expected, label);
  }
  for (const label of ["02-30", "25:00", "昨天 22:60", "未知"]) {
    assert.equal(parseWeiboDisplayDate(label, now), null, label);
  }
});

test("the first scan selects the five newest items even when an old post is pinned first", () => {
  const items = [1, 7, 6, 5, 4, 3, 2].map(day => ({ publishedAt: `2026-11-0${day}T00:00:00.000Z` }));
  const originalOrder = [...items];
  assert.deepEqual(selectFirstScanItems(items), items.slice(1, 6));
  assert.deepEqual(items, originalOrder);
});

test("the first scan keeps every item when there are fewer than five", () => {
  const older = { publishedAt: "2026-11-04T00:00:00.000Z" };
  const newer = { publishedAt: "2026-11-05T00:00:00.000Z" };
  assert.deepEqual(selectFirstScanItems([older, newer]), [newer, older]);
});

test("the first scan puts items without a publication date after dated items", () => {
  const dated = [5, 4, 3, 2].map(day => ({ publishedAt: `2026-11-0${day}T00:00:00.000Z` }));
  const undated = { publishedAt: null, id: "undated" };
  const otherUndated = { publishedAt: null, id: "other-undated" };
  assert.deepEqual(selectFirstScanItems([undated, ...dated, otherUndated]), [...dated, undated]);
});

test("fast, mid, and rest scans recur after 120, 240, and 720 minutes from the tick", () => {
  const tick = tickTime(new Date("2026-11-20T23:51:30Z"));
  assert.equal(tick.toISOString(), "2026-11-20T23:50:00.000Z");
  assert.equal(nextDueAt("fast", tick).toISOString(), "2026-11-21T01:50:00.000Z");
  assert.equal(nextDueAt("mid", tick).toISOString(), "2026-11-21T03:50:00.000Z");
  assert.equal(nextDueAt("rest", tick).toISOString(), "2026-11-21T11:50:00.000Z");
});

test("initial due times spread all configured accounts evenly across their tier intervals", () => {
  const now = new Date("2026-11-20T00:00:00Z");
  const due = initialDueAccounts(now);
  assert.equal(due.length, accounts.size);
  assert.equal(new Set(due.map(({ sourceId }) => sourceId)).size, accounts.size);
  for (const tier of ["fast", "mid", "rest"] as const) {
    const count = [...accounts.values()].filter(account => account.tier === tier).length;
    const minutes = due.filter(({ sourceId }) => accounts.get(sourceId)!.tier === tier)
      .map(({ nextDueAt }) => (nextDueAt.getTime() - now.getTime()) / 60_000)
      .sort((a, b) => a - b);
    assert.equal(minutes.length, count);
    if (count === 0) continue;
    const interval = (nextDueAt(tier, now).getTime() - now.getTime()) / 60_000;
    const spacing = interval / count;
    assert.equal(minutes[0], 0);
    for (const [index, minute] of minutes.entries()) {
      const gap = (minutes[index + 1] ?? interval) - minute;
      assert.ok(minute >= 0 && minute < interval);
      assert.ok(gap >= Math.floor(spacing) && gap <= Math.ceil(spacing));
    }
  }
  assert.deepEqual(accounts.get("weibopage-1243861097"), { uid: "1243861097", name: "李想", tier: "rest" });
});

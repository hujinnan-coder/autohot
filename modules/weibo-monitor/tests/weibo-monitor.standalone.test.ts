import assert from "node:assert/strict";
import { test } from "node:test";
import { accounts, initialDueAccounts, nextDueAt, tickTime } from "../backend/accounts.ts";
import { parseTimeline, parseWeiboDate, selectFirstScanItems } from "../backend/timeline.ts";

const post = {
  id: "5361796274981767",
  created_at: "Thu Nov 05 07:35:12 +0800 2026",
  text: '甲 &amp; 乙<br><a href="https://example.test/">链接</a> &lt;新款&gt; <img src="https://example.test/pic.jpg">',
  user: { screen_name: "雷军", verified_reason: "小米创办人" },
  pics: [{ url: "https://example.test/pic.jpg" }],
  page_info: { type: "video", url: "https://example.test/video.mp4" },
};
const avatar = "https://wx3.sinaimg.cn/orj480/6413b5d7ly8iipxn7561gj20u00u0acg.jpg";

function timeline(cards: unknown[]) {
  return JSON.stringify({ ok: 1, data: { cardlistInfo: { total: 22379 }, cards } });
}

test("Weibo timestamps use the supplied offset, including across a year boundary", () => {
  assert.equal(parseWeiboDate(post.created_at)?.toISOString(), "2026-11-04T23:35:12.000Z");
  assert.equal(parseWeiboDate("Fri Jan 01 00:15:00 +0800 2027")?.toISOString(), "2026-12-31T16:15:00.000Z");
  assert.equal(parseWeiboDate("Thu Dec 31 23:45:00 -0330 2026")?.toISOString(), "2027-01-01T03:15:00.000Z");
  assert.equal(parseWeiboDate("Fri Feb 30 07:35:12 +0800 2026"), null);
  assert.equal(parseWeiboDate("Thu Nov 05 07:35:12 2026"), null);
});

test("reads timeline JSON after the Jina headers and only imports text from post cards", () => {
  const json = timeline([
    { card_type: 11, mblog: post },
    { card_type: 9 },
    null,
    { card_type: 9, mblog: { ...post, text: '<img src="https://example.test/pic.jpg">' } },
    { card_type: 9, mblog: post },
  ]);
  const markdown = `Title: 微博\nURL Source: https://m.weibo.cn/api/container/getIndex\n\nMarkdown Content:\n${json}\n`;
  assert.deepEqual(parseTimeline(markdown).items, [{
    url: "https://m.weibo.cn/status/5361796274981767",
    title: "甲 & 乙 链接 <新款>",
    bodyText: "甲 & 乙 链接 <新款>",
    publishedAt: "2026-11-04T23:35:12.000Z",
    author: "雷军",
    raw: { verified_reason: "小米创办人" },
  }]);
  assert.deepEqual(parseTimeline(timeline([])), { items: [], avatar: null });
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

test("reads an author's avatar even when the post has no plain text to import", () => {
  const result = parseTimeline(timeline([{ card_type: 9, mblog: {
    ...post,
    text: '<img src="https://example.test/pic.jpg">',
    user: { ...post.user, avatar_hd: avatar },
  } }]));
  assert.deepEqual(result, { items: [], avatar });
});

test("ignores missing or invalid author avatars", () => {
  for (const avatar_hd of [undefined, "", "ftp://example.test/avatar.jpg", "https://", 123]) {
    const result = parseTimeline(timeline([{ card_type: 9, mblog: { ...post, user: { ...post.user, avatar_hd } } }]));
    assert.equal(result.avatar, null);
  }
});

test("a repost takes its avatar from the timeline account", () => {
  const repost = { ...post, retweeted_status: { user: { avatar_hd: "https://example.test/original.jpg" } } };
  const withoutAvatar = parseTimeline(timeline([{ card_type: 9, mblog: repost }]));
  assert.equal(withoutAvatar.avatar, null);
  const withAvatar = parseTimeline(timeline([{ card_type: 9, mblog: { ...repost, user: { ...post.user, avatar_hd: avatar } } }]));
  assert.equal(withAvatar.avatar, avatar);
});

test("rejects missing JSON, malformed JSON, and API errors", () => {
  assert.throws(() => parseTimeline("Title: 微博"), /no JSON/);
  assert.throws(() => parseTimeline('Title: 微博\n{"ok":1,'), /not valid JSON/);
  assert.throws(() => parseTimeline('{"ok":0,"msg":"error"}'), /ok != 1/);
  assert.throws(() => parseTimeline('{"ok":1,"data":{}}'), /no cards array/);
});

test("truncates the title at 140 characters and keeps the original post and full repost comment", () => {
  const text = "车".repeat(136) + "🚗" + "企".repeat(10);
  const { items: [item] } = parseTimeline(timeline([{ card_type: 9, mblog: {
    ...post,
    text,
    isLongText: true,
    retweeted_status: {
      id: "5361796274981766",
      created_at: "Thu Nov 05 07:30:00 +0800 2026",
      user: { screen_name: "原作者" },
      text: "<b>新车上市</b><br>售价 19.99 万元",
      pics: post.pics,
    },
  } }]));
  assert.equal(item.title, "车".repeat(136) + "🚗...");
  assert.equal(item.bodyText, `【原帖 @原作者】\n新车上市 售价 19.99 万元\n\n【转发评论 @雷军】\n${text}`);
  assert.equal(item.author, "雷军");
  assert.deepEqual(item.raw, {
    verified_reason: "小米创办人",
    retweeted_status: {
      id: "5361796274981766",
      created_at: "Thu Nov 05 07:30:00 +0800 2026",
      user: { screen_name: "原作者" },
    },
  });
  const { items: [short] } = parseTimeline(timeline([{ card_type: 9, mblog: { ...post, text: "车".repeat(140) } }]));
  assert.equal(short.title, "车".repeat(140));
});

test("imports a repost without a comment using the original text", () => {
  const { items } = parseTimeline(timeline([{ card_type: 9, mblog: {
    ...post,
    text: "",
    retweeted_status: { user: { screen_name: "原作者" }, text: "召回 200 辆" },
  } }]));
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "召回 200 辆");
  assert.equal(items[0].bodyText, "【原帖 @原作者】\n召回 200 辆");
});

test("marks a repost whose original text is missing", () => {
  const { items: [item] } = parseTimeline(timeline([{ card_type: 9, mblog: {
    ...post,
    text: "值得关注",
    retweeted_status: { user: { screen_name: "原作者" } },
  } }]));
  assert.equal(item.bodyText, "【转发 @原作者】（原帖正文缺失）\n值得关注");
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

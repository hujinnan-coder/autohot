// Topic pages: which articles a topic takes, and their counts.
// Written before the code, from the ways it can go wrong:
// - a company topic takes an article about another company that only mentions it (several subjects,
//   its name nowhere in the title), or drops one about it whose title names it in English, in another
//   case, next to Chinese text, or only by a product (it is the article's only subject);
// - a Latin name matches inside another word ("Smartphone" is not smart); a headline naming a company
//   that is not a subject of the article gets in;
// - a technical-direction topic stops taking its tags;
// - withdrawn or not yet released articles appear in a list or a count;
// - an article or story page names a topic its reports do not belong to;
// - an article page cannot tell which of its tags are a topic's own, so they link to filtered lists;
// - a topic without content has no page, or an unknown slug or a page past the end has one.
import { tag } from "./setup.ts";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { closeDb, sql } from "@aihot/backend/db";
import { upsertMaterial } from "@aihot/backend/content/materials";
import { stopBoss } from "@aihot/backend/jobs/queue";
import { installModules } from "@aihot/backend/modules";
import { publishArticle } from "@aihot/backend/publication/publish";
import { TOPICS, TOPIC_PAGE_SIZE, loadFollowingItems, loadTopicPage, listTopicSummaries, topicsOfStory } from "@aihot/backend/publication/topics";
import type { FollowingFeed } from "@aihot/following/feed";
import type { FeedItemSummary } from "@aihot/contracts/site";
import { SERVER_MODULES } from "@aihot/site/modules/server";
import { buildApp } from "../apps/api/src/app.ts";

const T = tag();
const OFFICIAL = `test-topics-official-${T}`;
const MEDIA = `test-topics-media-${T}`;
installModules(SERVER_MODULES);
const app = await buildApp();

before(async () => {
  await sql`INSERT INTO sources (id, name, kind, tier, participation_mode, next_fetch_at) VALUES
    (${OFFICIAL}, 'Official', 'rss', 'T1', 'editorial', '2100-01-01'),
    (${MEDIA}, 'Media', 'rss', 'T2', 'editorial', '2100-01-01')`;
});
after(async () => {
  await app.close();
  await stopBoss();
  await closeDb();
});

let n = 0;
interface Report {
  source?: string;
  at: Date;
  title: string;
  originalTitle?: string;
  subjects?: string[];
  tags?: string[];
  score?: number;
  selected?: boolean;
  fact?: number;
  category?: string;
}

/** A published report; `fact` links it to a fact before publishing, as grouping would. */
async function report(r: Report): Promise<string> {
  n += 1;
  const { articleId } = await upsertMaterial({
    sourceId: r.source ?? MEDIA, url: `https://example.com/topics-${T}-${n}`, title: r.originalTitle ?? r.title, bodyText: "body", bodyHtml: "<p>body</p>", bodyStatus: "ok", via: "fetch", publishedAt: r.at,
  });
  await sql`UPDATE articles SET discovered_at = ${r.at}, timeline_at = ${r.at}, grouped_at = now() WHERE id = ${articleId}`;
  await sql`INSERT INTO analyses (article_id, input_revision, origin, relevance, category, title_zh, summary_zh, score, selected, subjects, tags)
            VALUES (${articleId}, 1, 'rule', 'pass', ${r.category ?? "new-car"}, ${r.title}, ${`摘要 ${n}`}, ${r.score ?? 80}, ${r.selected ?? true}, ${r.subjects ?? []}, ${[r.category === "tech" ? "技术发布" : r.category === "paper" ? "财报/业绩" : r.category === "tip" ? "评测/体验" : r.category === "industry" ? "行业动态" : r.category === "opinion" ? "观点/访谈" : "新车上市", ...(r.tags ?? [])]})`;
  if (r.fact) await sql`INSERT INTO fact_articles (fact_id, article_id, role) VALUES (${r.fact}, ${articleId}, 'report')`;
  await publishArticle(articleId, { releasedAt: new Date(r.at.getTime() + 60_000) });
  return articleId;
}

async function story(title: string): Promise<{ id: number; publicId: string }> {
  const publicId = randomUUID();
  const [s] = await sql<{ id: number }[]>`INSERT INTO stories (public_id, title, first_report_at, latest_at) VALUES (${publicId}, ${title}, now(), now()) RETURNING id`;
  return { id: s!.id, publicId };
}

async function fact(storyId: number | null, title: string): Promise<number> {
  const [f] = await sql<{ id: number }[]>`INSERT INTO facts (public_id, story_id, title) VALUES (${`f-${T}-${randomUUID()}`}, ${storyId}, ${title}) RETURNING id`;
  return f!.id;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const ids = (items: Array<{ id: string }>) => items.map((i) => i.id);
const page = async (slug: string, p = 1) => {
  const data = await loadTopicPage(slug, p, new Date());
  assert.ok(data, `${slug} page ${p}`);
  return data;
};
/** Every article of a topic, over all its pages. */
async function members(slug: string): Promise<string[]> {
  const first = await page(slug);
  const out = ids(first.items);
  for (let p = 2; p <= first.pageCount; p++) out.push(...ids((await page(slug, p)).items));
  return out;
}

test("a company topic takes the articles about it, not the ones that only mention it", async () => {
  const about = await report({ at: hoursAgo(30), title: `FSD 推出新版本 ${T}`, subjects: ["tesla"] });
  const product = await report({ at: hoursAgo(31), title: `Model Y 新版上市 ${T}`, subjects: ["tesla"] });
  const english = await report({ at: hoursAgo(32), title: `新车上市 ${T}`, originalTitle: `Tesla launches a car ${T}`, subjects: ["tesla", "nio"] });
  const subpoena = await report({ at: hoursAgo(33), title: `加州检察长向 NIO 发出传票 ${T}`, subjects: ["nio", "tesla", "catl"] });
  const lowerCase = await report({ at: hoursAgo(34), title: `nio 公布新的安全框架 ${T}`, subjects: ["nio", "tesla"] });
  const pact = await report({ at: hoursAgo(35), title: `二十余家科技公司签署安全协议 ${T}`, subjects: ["nio", "tesla", "nissan"] });
  const metadata = await report({ at: hoursAgo(36), title: `Smartphone 标准发布，NIO 参与 ${T}`, subjects: ["smart", "nio"] });
  const adjacent = await report({ at: hoursAgo(37), title: `发布smart的新车 ${T}`, subjects: ["smart", "nio"] });
  const headline = await report({ at: hoursAgo(38), title: `Tesla 被一篇盘点提到 ${T}`, subjects: ["nissan"] });
  const agent = await report({ at: hoursAgo(39), title: `智能体框架发布 ${T}`, tags: ["智能驾驶"] });

  const tesla = await members("tesla");
  for (const id of [about, product, english]) assert.ok(tesla.includes(id), "about Tesla");
  for (const id of [subpoena, lowerCase, pact, headline]) assert.ok(!tesla.includes(id), "only mentions Tesla");
  const nio = await members("nio");
  for (const id of [subpoena, lowerCase, metadata]) assert.ok(nio.includes(id), "about NIO");
  for (const id of [english, pact]) assert.ok(!nio.includes(id), "only mentions NIO");
  const smart = await members("smart");
  assert.ok(smart.includes(adjacent), "smart next to Chinese text");
  assert.ok(!smart.includes(metadata), "Smartphone is not smart");
  assert.ok((await members("smart-driving")).includes(agent), "a technical direction takes its tag");

  // The article page names the topics it belongs to.
  const topicsOf = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
    return (JSON.parse(res.body) as { topics: Array<{ slug: string }> }).topics.map((t) => t.slug);
  };
  assert.deepEqual(await topicsOf(about), ["tesla", "launches"]);
  assert.deepEqual(await topicsOf(subpoena), ["nio", "launches"]);
  assert.deepEqual(await topicsOf(pact), ["launches"]);
  assert.deepEqual(await topicsOf(agent), ["smart-driving", "launches"]);
});

test("an article page says which of its tags are a topic's own", async () => {
  // A direction's or a form's tags, and the tag cards show for a company (its subject tag is never shown).
  const id = await report({ at: hoursAgo(3), title: `Tesla 开放智驾合作 ${T}`, subjects: ["tesla", "nio"], tags: ["智能驾驶", "合作/供应", "特斯拉", "蔚来", "框架"] });
  const res = await app.inject({ method: "GET", url: `/api/site/items/${id}` });
  const body = JSON.parse(res.body) as { tags: string[]; tagTopics: Record<string, string>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.tags, ["新车上市", "智能驾驶", "合作/供应", "特斯拉", "蔚来", "框架"]);
  assert.deepEqual(body.tagTopics, { "新车上市": "launches", "智能驾驶": "smart-driving", "合作/供应": "partnerships", "特斯拉": "tesla", "蔚来": "nio" });
  // The company its title does not name is a topic of the tag, not of the article.
  assert.deepEqual(body.topics.map((t) => t.slug), ["tesla", "smart-driving", "launches", "partnerships"]);
});

test("renaming a company topic keeps its old full name usable for search", async () => {
  const id = await report({at: hoursAgo(2), title: `欧萌达 新模型上线 ${T}`, subjects: ['omoda'], selected: false});
  for (const query of ['欧萌达 / 捷酷', '捷酷 / 欧萌达']) {
    const res = await app.inject({method: 'GET', url: `/api/site/pool?q=${encodeURIComponent(query)}`});
    assert.equal(res.statusCode, 200);
    assert.ok(ids(JSON.parse(res.body).items).includes(id), 'full company names must still find subject-tagged reports');
  }
});

test("a story page names the topics of its reports", async () => {
  const launch = await story(`智能体框架 V2 发布 ${T}`);
  await report({ source: OFFICIAL, at: hoursAgo(26), title: `智能体框架 V2 发布 ${T}`, tags: ["智能驾驶"], fact: await fact(launch.id, "发布 V2") });
  assert.deepEqual(await topicsOfStory(launch.id), [{ slug: "smart-driving", name: "智能驾驶" }, { slug: "launches", name: "新车上市" }]);
});

test("withdrawn articles stay out of lists and counts", async () => {
  const kept = await report({ at: hoursAgo(5), title: `欧萌达 发布新模型 ${T}`, subjects: ["omoda"] });
  const withdrawn = await report({ at: hoursAgo(4), title: `欧萌达 撤回的消息 ${T}`, subjects: ["omoda"] });
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${withdrawn}`;

  const data = await page("omoda");
  assert.deepEqual(ids(data.items), [kept]);
  assert.equal(data.topic.total, 1);
  const summary = (await listTopicSummaries()).topics.find((t) => t.slug === "omoda")!;
  assert.equal(summary.latest?.title, `欧萌达 发布新模型 ${T}`, "the index shows the newest public article");
});

test("every topic has a page; unknown topics and pages past the end have none", async () => {
  const empty = await page("maserati");
  assert.equal(empty.topic.indexable, false, "a topic without content is not indexed");
  assert.deepEqual(empty.items, []);
  assert.equal(await loadTopicPage("not-a-topic", 1, new Date()), null);
  assert.equal(await loadTopicPage("maserati", 2, new Date()), null);
  const index = await app.inject({ method: "GET", url: "/api/site/topics" });
  const body = JSON.parse(index.body) as { groups: Array<{ key: string }>; topics: Array<{ slug: string }> };
  assert.deepEqual(body.groups.map((g) => g.key), ["company", "field", "genre"]);
  assert.deepEqual(body.topics.map((t) => t.slug).sort(), TOPICS.map((t) => t.slug).sort(), "the index lists every topic");
});

const orderedFollowingIds: string[] = [];
let sharedFollowingId: string;
const pagedFollowingIds: string[] = [];
before(async () => {
  // The HTTP routes share a cached topic index. Publish these before any test loads it.
  for (const [i, brand] of ["bmw", "volvo", "bmw", "volvo"].entries()) {
    orderedFollowingIds.push(await report({ at: hoursAgo(2 + i), title: `${brand} 发布新车型 ${i} ${T}`, subjects: [brand] }));
  }
  sharedFollowingId = await report({ at: hoursAgo(2.5), title: `吉利和极氪发布联合公告 ${T}`, subjects: ["geely", "zeekr"] });
  for (let i = 0; i <= TOPIC_PAGE_SIZE; i++) {
    pagedFollowingIds.push(await report({ at: hoursAgo(2 + i), title: `比亚迪发布新车型 ${i} ${T}`, subjects: ["byd"] }));
  }
});

const followingFeed = (slugs: string[], pages = 1) => app.inject({
  url: `/api/site/following/feed?slugs=${encodeURIComponent(slugs.join(","))}&pages=${pages}`,
});

test("following combines two topics and orders their items by descending timeline time", async () => {
  const res = await followingFeed(["bmw", "volvo"]);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["cache-control"], "public, max-age=30, s-maxage=30");
  assert.equal(res.headers.etag, undefined);
  const body = res.json<FollowingFeed>();
  assert.deepEqual(ids(body.items), orderedFollowingIds);
  assert.equal(body.served, 2);
});

test("following returns one copy of a report from two topics", async () => {
  for (const slug of ["geely", "zeekr"]) assert.deepEqual(ids((await page(slug)).items), [sharedFollowingId]);
  const res = await followingFeed(["geely", "zeekr"]);
  assert.equal(res.statusCode, 200);
  const body = res.json<FollowingFeed>();
  assert.equal(body.served, 2);
  assert.deepEqual(ids(body.items), [sharedFollowingId]);
});

test("following paginates each topic and keeps topics with fewer pages", async () => {
  const first = await followingFeed(["byd", "bmw"]);
  assert.equal(first.statusCode, 200);
  assert.equal(first.json<FollowingFeed>().hasMore, true);
  assert.ok(!ids(first.json<FollowingFeed>().items).includes(pagedFollowingIds.at(-1)!));

  const second = await followingFeed(["byd", "bmw"], 2);
  assert.equal(second.statusCode, 200);
  const body = second.json<FollowingFeed>();
  assert.equal(body.hasMore, false);
  assert.equal(body.served, 2);
  assert.deepEqual(ids(body.items).sort(), [...pagedFollowingIds, ...orderedFollowingIds.filter((_, i) => i % 2 === 0)].sort());
});

test("following's batched read returns the same items as merging individual topic pages", async () => {
  const slugs = ["geely", "zeekr", "byd", "maserati"];
  const pages = 2;
  const now = new Date();
  const oldItems = new Map<string, FeedItemSummary>();
  for (const slug of slugs) {
    for (let p = 1; p <= pages; p++) {
      const topicPage = await loadTopicPage(slug, p, now);
      for (const item of topicPage?.items ?? []) oldItems.set(item.id, item);
    }
  }
  const expected = ids([...oldItems.values()].sort((a, b) => b.timelineAt.localeCompare(a.timelineAt)));
  assert.ok(expected.includes(sharedFollowingId) && expected.includes(pagedFollowingIds.at(-1)!));
  assert.deepEqual(ids((await loadFollowingItems(slugs, pages, now)).items), expected);
});

test("following accepts 30 topics and rejects 31", async () => {
  const slugs = TOPICS.slice(0, 31).map(topic => topic.slug);
  assert.equal(slugs.length, 31);
  assert.equal((await followingFeed(slugs)).statusCode, 400);
  const res = await followingFeed(slugs.slice(0, 30), 10);
  assert.equal(res.statusCode, 200);
  const body = res.json<FollowingFeed>();
  assert.equal(body.served, 30);
  assert.ok(body.items.length <= 30 * 10 * TOPIC_PAGE_SIZE);
});

test("following ignores unknown slugs and repeated topics", async () => {
  const res = await followingFeed(["geely", "not-a-topic", "geely"]);
  assert.equal(res.statusCode, 200);
  const body = res.json<FollowingFeed>();
  assert.equal(body.served, 1);
  assert.deepEqual(ids(body.items), [sharedFollowingId]);
});

test("following with no slug returns an empty feed", async () => {
  const res = await app.inject("/api/site/following/feed");
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json<FollowingFeed>(), { items: [], hasMore: false, served: 0 });
});

test("following filters a withdrawal while the cached topic still seats the item", async (t) => {
  // Start beyond any index reused by earlier tests and keep the next two reads within its TTL.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 61_000 });
  const slugs = ["geely"];
  assert.deepEqual(ids((await loadFollowingItems(slugs, 1)).items), [sharedFollowingId]);
  await sql`UPDATE publications SET visibility = 'withdrawn' WHERE article_id = ${sharedFollowingId}`;
  t.mock.timers.tick(1_000);
  const result = await loadFollowingItems(slugs, 1);
  assert.deepEqual(result.idsBySlug.get("geely"), [sharedFollowingId]);
  assert.deepEqual(ids(result.items), []);
});

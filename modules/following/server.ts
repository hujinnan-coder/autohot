import { looseQuery, sendProblem } from "@aihot/api/http/respond";
import { siteHandler } from "@aihot/api/routes/site";
import { defineServerModule } from "@aihot/backend/modules";
import { findTopic, loadTopicPage } from "@aihot/backend/publication/topics";
import type { FeedItemSummary } from "@aihot/contracts/site";
import type { FollowingFeed } from "./feed.ts";

const MAX_SLUGS = 30;
const MAX_PAGES = 10;

export default defineServerModule({
  name: "following",
  http(app) {
    app.get("/api/site/following/feed", siteHandler(async (req, reply) => {
      const q = looseQuery(req);
      const slugs = [...new Set((q.slugs ?? "").split(",").map(s => s.trim()).filter(Boolean))]
        .filter(slug => findTopic(slug) !== null);
      const pages = Math.min(Math.max(Math.trunc(Number(q.pages)) || 1, 1), MAX_PAGES);
      if (slugs.length > MAX_SLUGS) {
        return sendProblem(req, reply, { status: 400, code: "bad_request", detail: `slugs 最多 ${MAX_SLUGS} 个` });
      }

      const pagesOf = await Promise.all(slugs.map(slug =>
        Promise.all(Array.from({ length: pages }, (_, i) => loadTopicPage(slug, i + 1)))));
      const seen = new Map<string, FeedItemSummary>();
      let hasMore = false;
      let served = 0;
      for (const byPage of pagesOf) {
        const first = byPage[0];
        if (!first) continue;
        served++;
        if (first.pageCount > pages) hasMore = true;
        for (const page of byPage) {
          if (!page) continue;
          for (const item of page.items) if (!seen.has(item.id)) seen.set(item.id, item);
        }
      }
      const items = [...seen.values()].sort((a, b) => a.timelineAt < b.timelineAt ? 1 : a.timelineAt > b.timelineAt ? -1 : 0);
      return reply.header("Cache-Control", "public, max-age=30, s-maxage=30").send({ items, hasMore, served } satisfies FollowingFeed);
    }));
  },
});

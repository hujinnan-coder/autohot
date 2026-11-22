import { looseQuery, sendProblem } from "@aihot/api/http/respond";
import { siteHandler } from "@aihot/api/routes/site";
import { defineServerModule } from "@aihot/backend/modules";
import { findTopic, loadFollowingItems } from "@aihot/backend/publication/topics";
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

      const { idsBySlug, items: found, hasMore } = await loadFollowingItems(slugs, pages);
      const byId = new Map(found.map((item) => [item.id, item]));
      const seen = new Map<string, FeedItemSummary>();
      for (const ids of idsBySlug.values()) {
        for (const id of ids) {
          const item = byId.get(id);
          if (item && !seen.has(id)) seen.set(id, item);
        }
      }
      // A known topic's first page counts even when it has no items.
      const served = idsBySlug.size;
      const items = [...seen.values()].sort((a, b) => a.timelineAt < b.timelineAt ? 1 : a.timelineAt > b.timelineAt ? -1 : 0);
      return reply.header("Cache-Control", "public, max-age=30, s-maxage=30").send({ items, hasMore, served } satisfies FollowingFeed);
    }));
  },
});

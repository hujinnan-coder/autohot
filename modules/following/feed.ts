import type { FeedItemSummary } from "@aihot/contracts/site";

/** 每个关注主题取前几页，按条目 ID 去重后按时间倒序合并。 */
export interface FollowingFeed {
  items: FeedItemSummary[];
  /** 至少一个主题还有下一页。 */
  hasMore: boolean;
  /** 成功读取首页的已知主题数。 */
  served: number;
}

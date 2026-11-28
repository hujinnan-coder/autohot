import { config } from "../config.ts";

// Absolute links always use the configured address (SITE_URL), never the request Host: a CDN or proxy
// may send a different Host to the origin.
export const siteUrl = (path: string): string => `${config.siteUrl}${path}`;
export const itemUrl = (id: string): string => siteUrl(`/items/${id}`);
export const storyUrl = (publicId: string): string => siteUrl(`/story/${publicId}`);
export const dailyUrl = (date: string): string => siteUrl(`/daily/${date}`);
export const periodUrl = (kind: "weekly" | "monthly", key: string): string => siteUrl(`/${kind}/${key}`);

/** A story's v1 address as v1 links it (related stories' links.api). */
export const v1StoryApiUrl = (publicId: string): string => siteUrl(`/api/v1/stories/${publicId}`);

/**
 * 微博短帖常拿不到 mid，weibo-monitor 给这类帖子造 `u/<uid>?weibo_post=<正文哈希>` 的合成地址——
 * 那是入库去重的身份（ingest 会剥片段），读者打开只会落在博主主页。对外统一改写成干净的博主主页地址；
 * 有真链接的帖子（/status/<mid>）与其他站原样。
 */
export function readerWeiboLink(url: string): string {
  const profile = /^https:\/\/m\.weibo\.cn\/u\/(\d+)/.exec(url);
  return profile ? `https://m.weibo.cn/u/${profile[1]}` : url;
}

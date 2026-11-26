import { collapseWhitespace, stripTags, truncate } from "@aihot/backend/lib/text";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function parseWeiboDate(value: string): Date | null {
  const match = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2}) (\d{4})$/.exec(value);
  if (!match) return null;
  const [, month, day, time, offsetHours, offsetMinutes, year] = match;
  const monthNumber = MONTHS.indexOf(month) + 1;
  if (!monthNumber) return null;
  const local = `${year}-${String(monthNumber).padStart(2, "0")}-${day}T${time}`;
  const calendar = new Date(`${local}Z`);
  if (!Number.isFinite(calendar.getTime()) || !calendar.toISOString().startsWith(local)) return null;
  const date = new Date(`${local}${offsetHours}:${offsetMinutes}`);
  return Number.isFinite(date.getTime()) ? date : null;
}

interface User {
  screen_name?: string;
  verified_reason?: string;
  avatar_hd?: string;
  /** Signed image URL; the only form the CDN serves to a datacenter, valid for hours. */
  profile_image_url?: string;
}

interface RetweetedStatus {
  id?: string;
  text?: string;
  created_at?: string;
  user?: User;
}

interface Card {
  card_type?: number;
  mblog?: {
    id?: string;
    text?: string;
    created_at?: string;
    user?: User;
    retweeted_status?: RetweetedStatus;
  };
}

function authorName(user: User | undefined): string | null {
  return typeof user?.screen_name === "string" ? collapseWhitespace(user.screen_name) || null : null;
}

export function parseTimeline(markdown: string) {
  const at = markdown.indexOf('{"ok"');
  if (at === -1) throw new Error("Weibo timeline response has no JSON");
  let response: { ok?: unknown; data?: { cards?: Array<Card | null> } };
  try {
    response = JSON.parse(markdown.slice(at));
  } catch {
    throw new Error("Weibo timeline response is not valid JSON");
  }
  if (response.ok !== 1) throw new Error("Weibo timeline returned ok != 1");
  if (!Array.isArray(response.data?.cards)) throw new Error("Weibo timeline response has no cards array");

  let avatar: string | null = null;
  const items = response.data.cards.flatMap(card => {
    if (card?.card_type !== 9 || !card.mblog) return [];
    const post = card.mblog;
    // 带签名的 profile_image_url 是图床唯一放行的形态（avatar_hd 对数据中心直链 403）；签名约 9 小时
    // 有效，每次扫描都会用它刷新两个源，且 produceImage 成功后图进磁盘缓存，过期也不裂图。
    const url = post.user?.profile_image_url ?? post.user?.avatar_hd;
    if (avatar === null && typeof url === "string" && /^https?:\/\//i.test(url) && URL.canParse(url)) avatar = url;
    if (typeof post.id !== "string" || !/^\d+$/.test(post.id)) return [];
    const text = typeof post.text === "string" ? stripTags(post.text) : "";
    const original = post.retweeted_status;
    const originalText = typeof original?.text === "string" ? stripTags(original.text) : "";
    if (!text && !originalText) return [];
    const date = typeof post.created_at === "string" ? parseWeiboDate(post.created_at) : null;
    const author = authorName(post.user);
    const originalAuthor = authorName(original?.user);
    let bodyText = text;
    if (originalText) {
      bodyText = `【原帖 @${originalAuthor ?? "未知作者"}】\n${originalText}`;
      if (text) bodyText += `\n\n【转发评论 @${author ?? "未知作者"}】\n${text}`;
    } else if (original) {
      bodyText = `【转发 @${originalAuthor ?? "未知作者"}】（原帖正文缺失）\n${text}`;
    }
    const verifiedReason = post.user?.verified_reason;
    return [{
      url: `https://m.weibo.cn/status/${post.id}`,
      title: truncate(text || originalText, 140, "..."),
      bodyText,
      publishedAt: date?.toISOString() ?? null,
      author,
      raw: {
        ...(typeof verifiedReason === "string" ? { verified_reason: verifiedReason } : {}),
        ...(original && {
          retweeted_status: {
            id: typeof original.id === "string" ? original.id : undefined,
            created_at: typeof original.created_at === "string" ? original.created_at : undefined,
            user: { screen_name: originalAuthor },
          },
        }),
      },
    }];
  });
  return { items, avatar };
}

export function selectFirstScanItems<T extends { publishedAt: string | null }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => {
    if (a.publishedAt === null) return b.publishedAt === null ? 0 : 1;
    if (b.publishedAt === null) return -1;
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  }).slice(0, 5);
}

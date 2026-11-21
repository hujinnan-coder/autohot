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
}

interface Card {
  card_type?: number;
  mblog?: {
    id?: string;
    text?: string;
    created_at?: string;
    user?: User;
    retweeted_status?: { user?: User };
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
    const url = post.user?.avatar_hd;
    if (avatar === null && typeof url === "string" && /^https?:\/\//i.test(url) && URL.canParse(url)) avatar = url;
    if (typeof post.id !== "string" || !/^\d+$/.test(post.id) || typeof post.text !== "string") return [];
    const text = stripTags(post.text);
    if (!text) return [];
    const date = typeof post.created_at === "string" ? parseWeiboDate(post.created_at) : null;
    const originalAuthor = authorName(post.retweeted_status?.user) ?? "未知作者";
    return [{
      url: `https://m.weibo.cn/status/${post.id}`,
      title: truncate(text, 140, "..."),
      bodyText: post.retweeted_status ? `【转发 @${originalAuthor}】\n${text}` : text,
      publishedAt: date?.toISOString() ?? null,
      author: authorName(post.user),
      raw: typeof post.user?.verified_reason === "string" ? { verified_reason: post.user.verified_reason } : {},
    }];
  });
  return { items, avatar };
}

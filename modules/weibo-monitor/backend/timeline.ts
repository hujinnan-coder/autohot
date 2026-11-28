/// <reference lib="dom" />
/// <reference lib="dom.iterable" />

import { createHash } from "node:crypto";
import { contentDocument } from "@aihot/backend/lib/page-content";
import { collapseWhitespace, stripTags, truncate } from "@aihot/backend/lib/text";
import { parseLooseDate, readRelativeDate } from "@aihot/backend/sources/dates";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEIBO_ORIGIN = "https://m.weibo.cn";
const WEIBO_UTC_OFFSET = "+08:00";
const DAY_MS = 86_400_000;

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

export function parseWeiboDisplayDate(value: string, now = new Date()): Date | null {
  if (!Number.isFinite(now.getTime())) return null;
  const text = collapseWhitespace(value);
  const relative = readRelativeDate(text, now, WEIBO_UTC_OFFSET).publishedAt;
  if (relative) return relative;

  // 微博的时分和月日均以北京时间显示。
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  if (/^\d{1,2}:\d{2}$/.test(text)) return parseLooseDate(today + " " + text, WEIBO_UTC_OFFSET);
  if (!/^\d{2}-\d{2}(?: \d{1,2}:\d{2})?$/.test(text)) return null;
  const year = Number(today.slice(0, 4));
  const date = parseLooseDate(year + "-" + text, WEIBO_UTC_OFFSET);
  return date && date.getTime() - now.getTime() > DAY_MS
    ? parseLooseDate(year - 1 + "-" + text, WEIBO_UTC_OFFSET)
    : date;
}

function postHeader(article: Element): Element | null {
  const previous = article.previousElementSibling;
  return previous?.matches("header.weibo-top") ? previous : article.querySelector("header.weibo-top");
}

function postAvatar(article: Element | undefined): string | null {
  if (!article) return null;
  const header = postHeader(article);
  for (const img of [...(header?.querySelectorAll("img[src]") ?? []), ...article.querySelectorAll("img[src]")]) {
    const url = URL.parse(img.getAttribute("src") ?? "");
    if (url?.protocol === "https:" && /^(?:tvax|wx)[a-z0-9-]*\.sinaimg\.cn$/.test(url.hostname)
        && url.searchParams.get("Expires") && url.searchParams.get("ssig")) return url.href;
  }
  return null;
}

function postText(article: Element): string {
  for (const chrome of article.querySelectorAll("header, span.time, .tips-box, .weibo-media")) chrome.remove();
  for (const control of article.querySelectorAll("a, button")) {
    if (/^(?:展开全文|全文|关注|私信)$/.test(collapseWhitespace(control.textContent ?? ""))) control.remove();
  }
  return stripTags(article.innerHTML);
}

export function parseTimeline(html: string, { now = new Date(), uid }: { now?: Date; uid?: string } = {}) {
  const document = contentDocument(html);
  const articles = Array.from(document.querySelectorAll("article.weibo-main"));
  const author = collapseWhitespace(document.querySelector(".mod-fil-n")?.textContent ?? "") || null;
  const description = collapseWhitespace(document.querySelector(".mod-fil-desc")?.textContent ?? "");
  const verifiedReason = /^微博认证：\s*(.+)$/.exec(description)?.[1];
  if (!author && !articles.length) throw new Error("Weibo profile was not rendered");

  // pageConfig 里的 UID 是被访问的账号，另一个 uid 字段属于访客。
  const profileUid = uid ?? Array.from(document.querySelectorAll("script"), script =>
    /\bpageConfig:\s*\[\s*\{\s*"type"\s*:\s*"uid"\s*,\s*"value"\s*:\s*"(\d+)"\s*\}/.exec(script.textContent ?? "")?.[1],
  ).find(Boolean);
  const avatar = postAvatar(articles[0]);
  const items = articles.flatMap(article => {
    const status = Array.from(article.querySelectorAll('a[href^="/status/"]'), link => link.getAttribute("href"))
      .find(href => href && /^\/status\/\d+$/.test(href));
    const time = postHeader(article)?.querySelector("span.time") ?? article.querySelector("span.time:not(.weibo-media span)");
    const publishedAt = parseWeiboDisplayDate(time?.textContent ?? "", now)?.toISOString() ?? null;
    const bodyText = postText(article);
    if (!bodyText) return [];
    if (!status && !profileUid) throw new Error("Weibo profile has no account UID");
    const path = status ?? `/u/${profileUid}#${createHash("sha1").update(bodyText).digest("hex").slice(0, 16)}`;
    return [{
      url: WEIBO_ORIGIN + path,
      title: truncate(bodyText, 140, "..."),
      bodyText,
      publishedAt,
      author,
      // 先收录转发正文，等拿到真实转发样本再拆分 retweeted_status。
      raw: verifiedReason ? { verified_reason: verifiedReason } : {},
    }];
  });
  return { items, avatar };
}

/** 入库去重会去掉 URL 片段，短微博的哈希也放进查询参数。 */
export function weiboUrlForIngest(url: string): string {
  const link = new URL(url);
  if (link.hash) link.searchParams.set("weibo_post", link.hash.slice(1));
  return link.href;
}

export function selectFirstScanItems<T extends { publishedAt: string | null }>(items: readonly T[]): T[] {
  return items.toSorted((a, b) => {
    if (a.publishedAt === null) return b.publishedAt === null ? 0 : 1;
    if (b.publishedAt === null) return -1;
    return Date.parse(b.publishedAt) - Date.parse(a.publishedAt);
  }).slice(0, 5);
}

import { createHash } from "node:crypto";
import { safeReturn, SIGN_IN_HOME } from "@aihot/contracts/admin";
import { READER_COOKIE } from "@aihot/contracts/reader";

const WALL_PATHS = {
  entryPages: ["/join", "/apply", "/register", "/login"],
  legalPages: ["/terms", "/privacy"],
  accountPages: ["/account", "/account/pending"],
  admin: /^\/admin(?:\/|$)/,
  share: /^\/(items|story)\/[^/]+$/,
};

export type ReaderStatus = "active" | "pending" | null;
export type ReaderPageAccess = { status: ReaderStatus; isolated?: boolean; share?: "items" | "story"; redirect?: string };

export function readerPageTarget(url: URL): string {
  if (!url.pathname.endsWith(".data")) return url.pathname + url.search;
  const search = new URLSearchParams(url.search);
  search.delete("_routes");
  const query = search.toString();
  const pathname = url.pathname.replace(/\/_\.data$/, "/").replace(/\.data$/, "");
  return pathname + (query ? `?${query}` : "");
}

// Keep escaped separators in their original segment, like React Router's route matcher.
function pagePath(target: string): string {
  return decodeURI(new URL(`http://web.local${target}`).pathname).replace(/\/+$/, "").toLowerCase() || "/";
}

export function readerReturn(target: string | null): string {
  const path = safeReturn(target?.startsWith("/") ? target : "");
  if (path === SIGN_IN_HOME) return "/";
  try {
    return WALL_PATHS.entryPages.includes(pagePath(path)) ? "/" : path;
  } catch {
    return "/";
  }
}

export function readerLoginUrl(target: string, expired = false): string {
  const params = new URLSearchParams({ return: readerReturn(target) });
  if (expired) params.set("expired", "1");
  return `/login?${params}`;
}

export const hasReaderCookie = (cookie: string) => cookie.split(";").some(part => part.trimStart().startsWith(`${READER_COOKIE}=`));
export const readerSessionKey = (cookie: string) => createHash("sha256").update(cookie).digest("hex");
export const isReaderAdminPage = (target: string) => WALL_PATHS.admin.test(pagePath(target));

export function readerPageAccess(target: string, status: ReaderStatus, expired: boolean, method: string): ReaderPageAccess {
  const path = pagePath(target);
  if (WALL_PATHS.admin.test(path)) return { status };
  if (status === "pending" && !WALL_PATHS.accountPages.includes(path)) return { status, redirect: "/account/pending" };
  if (WALL_PATHS.entryPages.includes(path)) return { status, isolated: true };
  if (WALL_PATHS.legalPages.includes(path)) return { status, isolated: !status };
  if (status) return { status, isolated: status === "pending" || path === "/account/pending" };
  if (method === "GET" || method === "HEAD") {
    const match = WALL_PATHS.share.exec(path);
    if (match) return { status, isolated: true, share: match[1] === "story" ? "story" : "items" };
  }
  return { status, redirect: readerLoginUrl(target, expired) };
}

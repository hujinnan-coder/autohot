import { redirectDocument, type MiddlewareFunction, type RouterContextProvider } from "react-router";
import { READER_PAGE_HEADERS, READER_PRIVATE_HEADERS } from "@aihot/contracts/reader";
import { apiGet } from "./api.server.ts";
import { hasReaderCookie, isReaderAdminPage, readerPageAccess, readerPageTarget, readerSessionKey, type ReaderPageAccess, type ReaderStatus } from "./reader-wall.ts";

const SESSION_TTL = 4_000;
const MAX_SESSIONS = 1024;
const sessions = new Map<string, { status: NonNullable<ReaderStatus>; expires: number }>();

async function readerStatus(cookie: string): Promise<ReaderStatus> {
  const key = readerSessionKey(cookie);
  const cached = sessions.get(key);
  if (cached && cached.expires > performance.now()) return cached.status;
  sessions.delete(key);
  const { loggedIn, status } = await apiGet<{ loggedIn: boolean; status: ReaderStatus }>("/api/reader/session", {
    headers: { cookie, "x-reader-page-view": "1" }, signal: AbortSignal.timeout(3_000),
  });
  if (loggedIn !== true || (status !== "active" && status !== "pending")) return null;
  if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value!);
  sessions.set(key, { status, expires: performance.now() + SESSION_TTL });
  return status;
}

export async function checkReaderPage(url: URL, cookie: string, method: string): Promise<ReaderPageAccess> {
  const target = readerPageTarget(url);
  if (isReaderAdminPage(target)) return { status: null };
  const hasCookie = hasReaderCookie(cookie);
  const status = hasCookie ? await readerStatus(cookie) : null;
  return readerPageAccess(target, status, hasCookie && !status, method);
}

// The Node HTTP entry and the built route modules each load this file. A symbol shares the
// property name across both copies, and the provider belongs to just one request.
export const READER_ACCESS = Symbol.for("aihot.web.readerAccess");
type RequestContext = Readonly<RouterContextProvider> & { [READER_ACCESS]?: ReaderPageAccess };

export const checkedReaderPage = (context: RequestContext) => context[READER_ACCESS];

export const readerWallMiddleware: MiddlewareFunction<Response> = async ({ request, context }, next) => {
  // The development server does not use apps/web/server.ts.
  const access = checkedReaderPage(context) ?? await checkReaderPage(new URL(request.url), request.headers.get("cookie") ?? "", request.method);
  Object.assign(context, { [READER_ACCESS]: access });
  // Let React Router encode redirects for single-fetch navigations.
  if (access.redirect) throw redirectDocument(access.redirect, { headers: READER_PAGE_HEADERS });
  const response = await next();
  for (const [key, value] of Object.entries(READER_PRIVATE_HEADERS)) response.headers.set(key, value);
  response.headers.delete("Expires");
  return response;
};

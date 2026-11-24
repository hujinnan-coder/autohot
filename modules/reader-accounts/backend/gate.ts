import type { FastifyReply, FastifyRequest } from "fastify";
import { CONTACT_ALIASES } from "@aihot/contracts/http-policy";
import { ADMIN, SITE } from "@aihot/site";
import { SESSION_COOKIE as ADMIN_COOKIE, sessionPrincipal } from "@aihot/backend/admin/auth";
import { sendProblem } from "@aihot/api/http/respond";
import type { ReaderConfig } from "./config.ts";
import { publicWallPath } from "./gate-policy.ts";
import { equalSecret, NO_INDEX, PRIVATE_RESPONSE, sameOrigin } from "./rules.ts";
import { findSession } from "./sessions.ts";

export const pathOf = (req: FastifyRequest) => (req.raw.url ?? "/").split("?", 1)[0]!;
export const readerPath = (path: string) => path.startsWith("/api/reader/");
export const write = (req: FastifyRequest) => !["GET", "HEAD", "OPTIONS"].includes(req.method);

const extras = [...SITE.rootIcons, ...CONTACT_ALIASES.map(({ file }) => file)].map(file => `/${file}`);
const exempt = (req: FastifyRequest, path: string) => publicWallPath(path, req.method, req.routeOptions.url, extras);

const loginRequired = (req: FastifyRequest, reply: FastifyReply) => sendProblem(req, reply, {
  status: 401, code: "login_required", title: "Unauthorized", detail: "请先登录。", cacheControl: PRIVATE_RESPONSE,
});

export function writeOriginAllowed(req: FastifyRequest) {
  return !write(req) || sameOrigin(req.headers.origin, req.headers.host, req.protocol);
}

export function readerInternalAllowed(policy: ReaderConfig, req: FastifyRequest): boolean {
  const token = req.headers["x-reader-internal"];
  return typeof token === "string" && policy.internalToken !== null && equalSecret(token, policy.internalToken);
}

export function readerGate(policy: ReaderConfig) {
  return async (req: FastifyRequest, reply: FastifyReply, path: string) => {
    if (path === "/robots.txt" && (req.method === "GET" || req.method === "HEAD")) {
      reply.type("text/plain; charset=utf-8").send("User-agent: *\nDisallow: /\n");
      return;
    }
    if (exempt(req, path)) return;
    const cookie = req.headers.cookie;
    const internalAllowed = readerInternalAllowed(policy, req);
    const admin = ADMIN && !internalAllowed && cookie?.split(";").some(part => part.trim().startsWith(`${ADMIN_COOKIE}=`))
      ? await sessionPrincipal(cookie) : null;
    if (!internalAllowed && admin?.dev !== false && !await findSession(policy, cookie, { touch: writeOriginAllowed(req), activeOnly: true })) {
      loginRequired(req, reply);
      return;
    }
    if (!writeOriginAllowed(req)) {
      sendProblem(req, reply, { status: 403, code: "origin_not_allowed", detail: "写操作需要同源请求。", cacheControl: PRIVATE_RESPONSE });
    }
  };
}

export function applyReaderHeaders(policy: ReaderConfig, req: FastifyRequest, reply: FastifyReply) {
  const path = pathOf(req);
  if (readerPath(path) || (policy.wallEnabled && (!exempt(req, path) || path === "/robots.txt"))) {
    reply.header("Cache-Control", PRIVATE_RESPONSE).header("X-Accel-Expires", "0");
    reply.removeHeader("Expires");
    reply.header("X-Robots-Tag", NO_INDEX);
  } else if (policy.wallEnabled && path.startsWith("/og/")) {
    reply.header("X-Robots-Tag", NO_INDEX);
  }
}

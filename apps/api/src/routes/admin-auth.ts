// Admin sign-in and the /api/admin guard. Public routes never read the session.
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { safeReturn, SIGN_IN_HOME } from "@aihot/contracts/admin";
import { ADMIN } from "@aihot/site";
import { config } from "@aihot/backend/config";
import {
  cookie,
  endSession,
  LoginRejected,
  passwordLogin,
  SESSION_COOKIE,
  SESSION_DAYS,
  sessionPrincipal,
  type AdminPrincipal,
} from "@aihot/backend/admin/auth";
import { adminPagePrincipal, previewPrincipal } from "@aihot/backend/admin/preview";
import type { Previewer } from "@aihot/backend/modules";
import { clientIp, sendProblem } from "../http/respond.ts";

/**
 * A cookie is Secure when the request itself arrived over HTTPS: the browser judges it against the
 * page's origin, so a plain-HTTP entry (a LAN address, a published container port) drops a Secure
 * cookie at sign-in and the session never sticks. Behind a TLS-terminating proxy, trustProxy makes
 * `req.protocol` reflect X-Forwarded-Proto, so the public HTTPS entry keeps its Secure cookie.
 */
const secure = (req: FastifyRequest) => req.protocol === "https";

// Count failed passwords over 15 minutes. The global count flags distributed failures without locking out the admin.
const WINDOW_MS = 15 * 60_000;
const IP_LIMIT = 10;
const GLOBAL_LIMIT = 50;
const MAX_KEYS = 5000;
const attempts = new Map<string, number[]>();
let globalLoggedAt = -Infinity;

function peek(key: string, now: number): number[] {
  return (attempts.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
}

function recordFailure(key: string, log: FastifyRequest["log"]) {
  const now = Date.now();
  const recent = peek(key, now);
  attempts.delete(key);
  attempts.set(key, [...recent, now].slice(-IP_LIMIT));
  const global = peek("all", now);
  attempts.set("all", [...global, now].slice(-GLOBAL_LIMIT));
  if (global.length >= GLOBAL_LIMIT && now - globalLoggedAt >= WINDOW_MS) {
    globalLoggedAt = now;
    log.warn({ limit: GLOBAL_LIMIT, windowMs: WINDOW_MS }, "security.login_throttled");
  }
  if (attempts.size <= MAX_KEYS) return;
  for (const [id, failures] of attempts) {
    if (now - failures.at(-1)! >= WINDOW_MS) attempts.delete(id);
  }
  for (const id of attempts.keys()) {
    if (attempts.size <= MAX_KEYS) break;
    if (id !== "all") attempts.delete(id);
  }
}

export function resetLoginAttemptsForTest() {
  attempts.clear();
  globalLoggedAt = -Infinity;
}

const loginPage = (returnTo: string, error?: string) => `/admin/login?${new URLSearchParams({ return: safeReturn(returnTo), ...(error ? { error } : {}) })}`;

export type AdminHandler = (req: FastifyRequest, reply: FastifyReply, admin: AdminPrincipal) => Promise<unknown>;

/** Guard for /api/admin/*: a live session (or the development stand-in); writes need the CSRF token. */
export function adminHandler(fn: AdminHandler) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    const admin = await sessionPrincipal(req.headers.cookie);
    if (!admin) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Sign in to the admin first." });
    if (req.method !== "GET" && req.method !== "HEAD" && req.headers["x-csrf-token"] !== admin.csrf) {
      return sendProblem(req, reply, { status: 403, code: "forbidden", detail: "Missing or stale CSRF token." });
    }
    try {
      return await fn(req, reply, admin);
    } catch (error) {
      return handlerError(req, reply, error);
    }
  };
}

function handlerError(req: FastifyRequest, reply: FastifyReply, error: unknown) {
  if (error instanceof ZodError) {
    return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: error.issues.map((issue) => `${issue.path.join(".") || "请求"}: ${issue.message}`).join("; ").slice(0, 300) });
  }
  if ((error as { statusCode?: number }).statusCode === 400 || error instanceof SyntaxError) {
    return sendProblem(req, reply, { status: 400, code: "invalid_request", detail: String((error as Error).message).slice(0, 300) });
  }
  if ((error as { code?: string }).code === "conflict") return sendProblem(req, reply, { status: 409, code: "conflict", detail: (error as Error).message });
  req.log.error({ err: error, path: req.url.split("?")[0] }, "admin api error");
  return sendProblem(req, reply, { status: 500, code: "internal_error", detail: String((error as Error).message).slice(0, 300) });
}

/** Gray data is read-only, for engine admins or module-approved previewers. */
export function previewHandler(fn: (req: FastifyRequest, reply: FastifyReply, previewer: Previewer) => Promise<unknown>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") {
      reply.header("Allow", "GET, HEAD");
      return sendProblem(req, reply, { status: 405, code: "method_not_allowed", detail: "Preview data is read-only." });
    }
    const previewer = await previewPrincipal(req.headers.cookie);
    if (!previewer) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Preview access required." });
    try {
      return await fn(req, reply, previewer);
    } catch (error) {
      return handlerError(req, reply, error);
    }
  };
}

export function adminPageHandler(fn: (req: FastifyRequest, reply: FastifyReply, previewer: Previewer) => Promise<unknown>) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") {
      reply.header("Allow", "GET, HEAD");
      return sendProblem(req, reply, { status: 405, code: "method_not_allowed", detail: "Admin page data is read-only." });
    }
    const previewer = await adminPagePrincipal(req.headers.cookie);
    if (!previewer) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Admin page access required." });
    try {
      return await fn(req, reply, previewer);
    } catch (error) {
      return handlerError(req, reply, error);
    }
  };
}

export function registerAdminAuth(app: FastifyInstance) {
  app.get("/api/admin/preview", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const previewer = await previewPrincipal(req.headers.cookie);
    if (!previewer) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Preview access required.", cacheControl: "private, no-store" });
    return { name: previewer.name };
  });
  app.get("/api/admin/page-access", async (req, reply) => {
    reply.header("Cache-Control", "private, no-store");
    const admin = await adminPagePrincipal(req.headers.cookie);
    if (!admin) return sendProblem(req, reply, { status: 401, code: "unauthorized", detail: "Admin page access required.", cacheControl: "private, no-store" });
    return { name: admin.name };
  });
  if (!ADMIN) return;

  // The web admin sends a signed-out visitor here with ?return=.
  app.get("/api/auth/login", async (req, reply) => {
    const returnTo = String((req.query as Record<string, string>).return ?? SIGN_IN_HOME);
    // A live session does not need signing in again: go straight to where the visitor was headed.
    if (await sessionPrincipal(req.headers.cookie)) return reply.header("Cache-Control", "no-store").redirect(safeReturn(returnTo), 302);
    return reply.header("Cache-Control", "no-store").redirect(loginPage(returnTo), 302);
  });

  app.get("/api/auth/options", async (_req, reply) => reply.header("Cache-Control", "no-store").send({ password: !!config.adminPassword }));

  // The sign-in and sign-out forms post as plain HTML forms; only these routes read that format.
  app.register(async (form) => {
    form.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16 * 1024 }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(String(body))));
    });
    form.post("/api/auth/password", async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string>;
      const returnTo = String(b.return ?? SIGN_IN_HOME);
      reply.header("Cache-Control", "no-store");
      const key = `ip:${clientIp(req)}`;
      if (peek(key, Date.now()).length >= IP_LIMIT) return reply.redirect(loginPage(returnTo, "too-many"), 303);
      try {
        const { token, returnTo: target } = await passwordLogin(String(b.password ?? ""), returnTo, req.headers["user-agent"]);
        attempts.delete(key);
        reply.header("Set-Cookie", cookie(SESSION_COOKIE, token, SESSION_DAYS * 86400, secure(req)));
        return reply.redirect(target, 303);
      } catch (error) {
        const unset = error instanceof LoginRejected && /ADMIN_PASSWORD/.test(error.message);
        if (!(error instanceof LoginRejected)) req.log.error({ err: error }, "admin login failed");
        else if (!unset) recordFailure(key, req.log);
        return reply.redirect(loginPage(returnTo, unset ? "unset" : "wrong"), 303);
      }
    });
    // Signing out is a plain form too: outside this scope its empty urlencoded body would be a 415.
    form.post("/api/auth/logout", async (req, reply) => {
      await endSession(req.headers.cookie);
      reply.header("Set-Cookie", cookie(SESSION_COOKIE, "", 0, secure(req))).header("Cache-Control", "no-store");
      return reply.redirect("/", 303);
    });
  });
}

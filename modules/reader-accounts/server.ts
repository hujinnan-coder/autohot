import { isIP } from "node:net";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { adminHandler } from "@aihot/api/routes/admin-auth";
import { clientIp, sendProblem } from "@aihot/api/http/respond";
import { config, credential } from "@aihot/backend/config";
import { defineServerModule } from "@aihot/backend/modules";
import type { sendAlert } from "@aihot/backend/notify/feishu";
import { loadItemShare, loadLandingSamples } from "@aihot/backend/publication/og";
import { loadStoryShare, resolveStory } from "@aihot/backend/publication/stories";
import { ADMIN } from "@aihot/site";
import { approveReader, deleteReader, getReader, invitationChain, listReaders, loginReader, readerContacts, registerReader, setReaderDisabled, updateReader } from "./backend/accounts.ts";
import { applicationDetail, approveApplication, listApplications, rejectApplication, reissuableApplications, reissueApplicationInvite, submitApplication } from "./backend/applications.ts";
import { LIMITS, readerConfig, type ReaderConfig } from "./backend/config.ts";
import { notFound, ReaderError } from "./backend/errors.ts";
import { clearEvents, exportReader, readerEvents, readerInterests, recordEvents, retainReaderData } from "./backend/events.ts";
import { applyReaderHeaders, readerGate, readerInternalAllowed, writeOriginAllowed } from "./backend/gate.ts";
import { inactivitySchedules } from "./backend/inactivity.ts";
import * as input from "./backend/inputs.ts";
import { adminIssueInvites, checkInvite, childInvites, issueChildInvite, listInvites, revokeInvite, type IssuedInvite } from "./backend/invites.ts";
import { createSmtpMailer, NotConfigured, plainMail, SmtpSendError, type Mail, type Mailer } from "./backend/mailer.ts";
import { cancelOtp, issueOtp, verifyOtp } from "./backend/otp.ts";
import { PRIVATE_RESPONSE, readerCookie } from "./backend/rules.ts";
import { endReaderSession, findSession, validPrincipal, type ReaderUser } from "./backend/sessions.ts";
import type { AdminReaderLookups } from "./types.ts";

const BASE = "/api/reader";
const READERS = "/api/admin/readers";
const INVITES = "/api/admin/reader-invites";
const APPLICATIONS = "/api/admin/reader-applications";
const BODY = { bodyLimit: 16 * 1024 };

type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function handle(fn: Handler): Handler {
  return async (req, reply) => {
    try {
      if (!writeOriginAllowed(req)) throw new ReaderError(403, "origin_not_allowed", "写操作需要同源请求。");
      return await fn(req, reply);
    } catch (error) {
      if (error instanceof ReaderError) {
        return sendProblem(req, reply, { status: error.status, code: error.code, detail: error.message,
          retryAfter: error.retryAfter, cacheControl: PRIVATE_RESPONSE });
      }
      if (error instanceof ZodError) {
        const fields = [...new Set(error.issues.map(issue => issue.path.join(".")).filter(Boolean))].join(", ").slice(0, 160);
        return sendProblem(req, reply, { status: 400, code: "invalid_request",
          detail: fields ? `请检查请求字段：${fields}` : "请检查请求字段。", cacheControl: PRIVATE_RESPONSE });
      }
      req.log.error({ code: (error as { code?: string })?.code }, "reader account request failed");
      return sendProblem(req, reply, { status: 503, code: "reader_unavailable", detail: "读者账号服务暂不可用。", cacheControl: PRIVATE_RESPONSE });
    }
  };
}

function requestIp(req: FastifyRequest) {
  const raw = clientIp(req);
  if (raw.startsWith("::ffff:") && isIP(raw.slice(7)) === 4) return raw.slice(7);
  if (isIP(raw) === 6) return new URL(`http://[${raw}]`).hostname.slice(1, -1);
  return isIP(raw) === 4 ? raw : "0.0.0.0";
}

function withReader(policy: ReaderConfig, fn: (req: FastifyRequest, reply: FastifyReply, user: ReaderUser) => Promise<unknown>) {
  return handle(async (req, reply) => {
    const user = await findSession(policy, req.headers.cookie, { touch: true });
    if (!user) throw new ReaderError(401, "login_required", "请先登录。");
    return fn(req, reply, user);
  });
}

const idOf = (req: FastifyRequest) => input.idParams.parse(req.params).id;

export function createReaderAccounts(options: {
  policy?: ReaderConfig; mailer?: Mailer; siteUrl?: string; now?: () => Date; alert?: typeof sendAlert;
} = {}) {
  if ((options.policy?.wallEnabled ?? (process.env.READER_WALL_ENABLED === "true"))
    && config.devAdmin && config.environmentName !== "production") {
    throw new Error("开登录墙时必须关闭 DEV_AUTH_ROLE");
  }
  const policy = options.policy ?? readerConfig(process.env, credential("auth", "SESSION_SECRET"));
  const mailer = options.mailer ?? createSmtpMailer();
  const siteUrl = options.siteUrl ?? config.siteUrl;
  const consent = { terms_version: policy.termsVersion, privacy_version: policy.privacyVersion };

  function readerAdmin(fn: Handler): Handler {
    const guarded = adminHandler(async (req, reply, admin) => {
      if (policy.wallEnabled && admin.dev) {
        return sendProblem(req, reply, { status: 403, code: "forbidden",
          detail: "请使用管理员账号登录。", cacheControl: PRIVATE_RESPONSE });
      }
      return fn(req, reply);
    });
    return async (req, reply) => ADMIN ? guarded(req, reply) : sendProblem(req, reply, {
      status: 401, code: "unauthorized", detail: "请先登录后台。", cacheControl: PRIVATE_RESPONSE,
    });
  }

  async function deliver(log: Pick<FastifyRequest["log"], "warn"> | undefined, purpose: string, mail: Mail) {
    if (!policy.mailEnabled) return false;
    try {
      await mailer.send(mail);
      return true;
    } catch (error) {
      const failure = error instanceof NotConfigured ? "not_configured"
        : error instanceof SmtpSendError ? error.failure : "send_failed";
      if (log) log.warn({ purpose, failure }, "reader mail unavailable");
      else console.warn(JSON.stringify({ level: "warn", msg: "reader mail unavailable", purpose, failure }));
      return false;
    }
  }

  function signedIn(req: FastifyRequest, reply: FastifyReply, user: ReaderUser, token: string) {
    reply.header("Set-Cookie", readerCookie(token, policy.sessionLifetime / 1000, req.protocol === "https"));
    return validPrincipal(user);
  }

  async function applicationInvitation(req: FastifyRequest, id: string, { email, invite }: { email: string; invite: IssuedInvite }) {
    const link = new URL("/register", siteUrl);
    link.searchParams.set("code", invite.code);
    const invitationText = `你的加入申请已通过。请在 ${invite.expires_at.toISOString()} 前用申请邮箱打开 ${link.href} 注册。邀请码：${invite.code}`;
    const emailSent = await deliver(req.log, "application_approved", plainMail(email, "加入申请已通过", invitationText));
    return { application_id: id, ...invite, invitation_url: link.href, invitation_text: invitationText, email_sent: emailSent };
  }

  async function approveOne(req: FastifyRequest, id: string) {
    return applicationInvitation(req, id, await approveApplication(policy, id));
  }

  return defineServerModule({
    name: "reader-accounts",
    gate: policy.wallEnabled ? readerGate(policy) : undefined,
    retention: now => retainReaderData(policy, now),
    schedules: inactivitySchedules({ policy, siteUrl, now: options.now, alert: options.alert,
      deliver: mail => deliver(undefined, "inactivity", mail) }),
    http(app) {
      app.addHook("onSend", async (req, reply, payload) => {
        applyReaderHeaders(policy, req, reply);
        return payload;
      });

      app.post(`${BASE}/otp/send`, BODY, handle(async (req, reply) => {
        const { email } = input.emailInput.parse(req.body);
        if (!policy.mailEnabled && policy.production) throw new ReaderError(503, "mail_unavailable", "邮件服务尚未开启。");
        const issued = await issueOtp(policy, email, requestIp(req));
        const sent = await deliver(req.log, "otp", plainMail(email, "邮箱验证码", `验证码：${issued.code}。请在 10 分钟内使用。`));
        if (!sent && !policy.mailEnabled && !policy.production) {
          req.log.warn({ otp: issued.code, challengeId: issued.id }, "development reader OTP");
        } else if (!sent) {
          await cancelOtp(issued.id);
          throw new ReaderError(503, "mail_unavailable", "验证码邮件发送失败。");
        }
        return reply.code(204).send();
      }));
      app.post(`${BASE}/otp/verify`, BODY, handle(async req => {
        const { email, code } = input.verifyInput.parse(req.body);
        return verifyOtp(policy, email, code);
      }));
      app.post(`${BASE}/register`, BODY, handle(async (req, reply) => {
        const result = await registerReader(policy, input.registerInput.parse(req.body), requestIp(req));
        reply.code(201);
        return { ...signedIn(req, reply, result.user, result.token), child_invites: result.invites };
      }));
      app.post(`${BASE}/login`, BODY, handle(async (req, reply) => {
        const body = input.loginInput.parse(req.body);
        const ticket = "ticket" in body ? body.ticket : (await verifyOtp(policy, body.email, body.code)).ticket;
        const { user, token } = await loginReader(policy, body.email, ticket, requestIp(req));
        return signedIn(req, reply, user, token);
      }));
      app.post(`${BASE}/logout`, BODY, handle(async (req, reply) => {
        await endReaderSession(req.headers.cookie);
        return reply.header("Set-Cookie", readerCookie("", 0, req.protocol === "https")).code(204).send();
      }));
      app.get(`${BASE}/session`, handle(async req => {
        // SSR's content requests use an internal token, so its page check accounts for activity.
        const touch = policy.wallEnabled && req.headers["x-reader-page-view"] === "1" && readerInternalAllowed(policy, req);
        const user = await findSession(policy, req.headers.cookie, { touch });
        return { ...(user ? validPrincipal(user) : { loggedIn: false, status: null, nickname: null, needsProfile: false }), ...consent };
      }));
      app.post(`${BASE}/applications`, BODY, handle(async (req, reply) => {
        const result = await submitApplication(policy, input.applyInput.parse(req.body), requestIp(req));
        return reply.code(201).send(result);
      }));
      app.get(`${BASE}/invite/check`, handle(async req => checkInvite(policy, input.inviteQuery.parse(req.query).code)));
      app.get(`${BASE}/landing-samples`, handle(async req => {
        if (!policy.wallEnabled || !readerInternalAllowed(policy, req)) throw notFound();
        return { samples: await loadLandingSamples() };
      }));
      app.get<{ Params: { id: string } }>(`${BASE}/preview/:id`, handle(async req => {
        const item = await loadItemShare((req.params as { id: string }).id);
        if (!item) throw notFound();
        return { title: item.title, summary: item.summary, source: item.source.name, published_at: item.timelineAt,
          application: { path: "/join", ...consent } };
      }));
      app.get(`${BASE}/preview/story/:id`, handle(async (req, reply) => {
        const story = await resolveStory((req.params as { id: string }).id);
        if (story.kind === "merged") return reply.code(308).send({ mergedInto: story.target });
        if (story.kind === "not_found") throw notFound();
        const preview = await loadStoryShare(story.storyId);
        if (!preview) throw notFound();
        return preview;
      }));

      app.get(`${BASE}/me`, withReader(policy, async (_req, _reply, user) => getReader(user.id)));
      app.patch(`${BASE}/me`, BODY, withReader(policy, async (req, _reply, user) => updateReader(policy, user.id, input.profilePatch.parse(req.body))));
      app.post(`${BASE}/events`, { bodyLimit: LIMITS.eventBytes }, withReader(policy, async (req, reply, user) => {
        if (user.status === "active" && user.tracking_consent) await recordEvents(user.id, input.eventsInput.parse(req.body).events);
        return reply.code(204).send();
      }));
      app.get(`${BASE}/me/events`, withReader(policy, async (req, _reply, user) => readerEvents(user.id, input.pageInput.parse(req.query).offset)));
      app.get(`${BASE}/me/export`, withReader(policy, async (_req, reply, user) => {
        reply.header("Content-Disposition", 'attachment; filename="reader-data.json"');
        return exportReader(user.id);
      }));
      app.delete(`${BASE}/me/events`, BODY, withReader(policy, async (_req, reply, user) => {
        await clearEvents(user.id);
        return reply.code(204).send();
      }));
      app.delete(`${BASE}/me`, BODY, withReader(policy, async (req, reply, user) => {
        await deleteReader(user.id);
        return reply.header("Set-Cookie", readerCookie("", 0, req.protocol === "https")).code(204).send();
      }));
      app.get(`${BASE}/me/invites`, withReader(policy, async (_req, _reply, user) => childInvites(policy, user)));
      app.post(`${BASE}/me/invites`, BODY, withReader(policy, async (req, reply, user) => {
        const invite = await issueChildInvite(policy, user.id, input.childInviteInput.parse(req.body ?? {}));
        return reply.code(201).send(invite);
      }));

      // Admin writes keep the engine's own session and CSRF check.
      app.get("/api/admin/reader-lookups", {
        async onSend(_req, reply, payload) {
          reply.header("Cache-Control", PRIVATE_RESPONSE);
          return payload;
        },
      }, readerAdmin(handle(async (req): Promise<AdminReaderLookups> => {
        const { reader_ids, application_ids } = input.adminLookupsInput.parse(req.query);
        const [readers, reissuable_application_ids] = await Promise.all([
          readerContacts(reader_ids ?? []), reissuableApplications(application_ids ?? []),
        ]);
        return { readers, reissuable_application_ids };
      })));
      app.get(READERS, readerAdmin(handle(async req => {
        const q = input.readerListInput.parse(req.query);
        return listReaders(q.offset, q.status, q.q);
      })));
      app.get(`${READERS}/:id`, readerAdmin(handle(async req => {
        const id = idOf(req);
        const reader = await getReader(id);
        const [interests, chain] = await Promise.all([readerInterests(id), invitationChain(id)]);
        return { reader, interests, ...chain };
      })));
      app.post(`${READERS}/:id/disable`, BODY, readerAdmin(handle(async req => setReaderDisabled(idOf(req), true))));
      app.post(`${READERS}/:id/restore`, BODY, readerAdmin(handle(async req => setReaderDisabled(idOf(req), false))));
      app.post(`${READERS}/:id/approve`, BODY, readerAdmin(handle(async req => {
        const { user, email, invites } = await approveReader(policy, idOf(req));
        const emailSent = !!email && invites.length > 0 && await deliver(req.log, "reader_approved", plainMail(email,
          "你的读者账号已激活", `你的账号已激活。获赠的子邀请码：\n${invites.map(invite => invite.code).join("\n")}`));
        return { id: user.id, status: user.status, child_invites: invites, email_sent: emailSent };
      })));

      app.get(INVITES, readerAdmin(handle(async req => {
        const q = input.inviteListInput.parse(req.query);
        return listInvites(q.offset, q.batch_tag);
      })));
      app.post(INVITES, BODY, readerAdmin(handle(async (req, reply) => {
        const [invite] = await adminIssueInvites(policy, 1, input.inviteInput.parse(req.body ?? {}));
        return reply.code(201).send(invite);
      })));
      app.post(`${INVITES}/batch`, BODY, readerAdmin(handle(async (req, reply) => {
        const { count, ...data } = input.inviteBatchInput.parse(req.body);
        return reply.code(201).send({ invites: await adminIssueInvites(policy, count, data) });
      })));
      app.post(`${INVITES}/:id/revoke`, BODY, readerAdmin(handle(async (req, reply) => {
        await revokeInvite(idOf(req));
        return reply.code(204).send();
      })));

      app.get(APPLICATIONS, readerAdmin(handle(async req => {
        const q = input.applicationListInput.parse(req.query);
        return listApplications(q.offset, q.status);
      })));
      app.get(`${APPLICATIONS}/:id`, readerAdmin(handle(async req => applicationDetail(idOf(req)))));
      app.post(`${APPLICATIONS}/:id/approve`, BODY, readerAdmin(handle(async req => approveOne(req, idOf(req)))));
      app.post(`${APPLICATIONS}/:id/reissue`, BODY, readerAdmin(handle(async req => {
        const id = idOf(req);
        return applicationInvitation(req, id, await reissueApplicationInvite(policy, id));
      })));
      app.post(`${APPLICATIONS}/:id/reject`, BODY, readerAdmin(handle(async req => {
        const { reason, notify } = input.rejectInput.parse(req.body ?? {});
        const { email } = await rejectApplication(idOf(req), reason ?? null);
        const emailSent = notify && await deliver(req.log, "application_rejected", plainMail(email, "加入申请结果",
          reason ? `你的加入申请未通过。原因：${reason}` : "你的加入申请未通过。"));
        return { status: "rejected", email_sent: emailSent };
      })));
      app.post(`${APPLICATIONS}/batch-approve`, BODY, readerAdmin(handle(async req => {
        const { ids } = input.batchApproveInput.parse(req.body);
        const results = [];
        for (const id of new Set(ids)) {
          try {
            results.push(await approveOne(req, id));
          } catch (error) {
            if (!(error instanceof ReaderError) || error.status >= 500) {
              req.log.error({ applicationId: id, code: (error as { code?: string })?.code }, "reader application approval failed");
            }
            results.push({ application_id: id, error: error instanceof ReaderError ? error.code : "reader_unavailable" });
          }
        }
        return { results };
      })));
    },
  });
}

export default createReaderAccounts();

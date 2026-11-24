import { sql, type Tx } from "@aihot/backend/db";
import type { ReaderContact } from "../types.ts";
import { DAY, LIMITS, type ReaderConfig } from "./config.ts";
import { notFound, ReaderError } from "./errors.ts";
import type { ProfilePatch, RegisterInput } from "./inputs.ts";
import { lockInvite, useInvite, welcomeInvites } from "./invites.ts";
import { consumeTicket, lockKey, requireSecret } from "./otp.ts";
import { createSession, type ReaderUser } from "./sessions.ts";

type ReaderProfile = Omit<ReaderUser, "phone" | "phone_verified_at" | "wechat_openid" | "wechat_unionid">;
const profileFields = sql`u.id, u.status, u.name, u.company, u.job_title, u.wechat, u.business_card_url, u.referrer,
  u.tracking_consent, u.activated_at, u.last_active_at, u.created_at`;

export async function registerReader(policy: ReaderConfig, input: RegisterInput, ip: string) {
  if (input.terms_version !== policy.termsVersion || input.privacy_version !== policy.privacyVersion) {
    throw new ReaderError(409, "consent_version_changed", "请阅读并重新同意当前版条款与隐私说明。");
  }
  return sql.begin(async (tx) => {
    await lockKey(tx, "email", input.email);
    await consumeTicket(tx, input.email, input.ticket);
    const [existing] = await tx`SELECT 1 FROM reader_auth_identities WHERE provider = 'email' AND subject = ${input.email}`;
    if (existing) throw new ReaderError(409, "email_registered", "此邮箱已有账号。");
    const invite = await lockInvite(tx, policy, input.code, input.email);
    const status = invite.requires_approval ? "pending" : "active";
    const [user] = await tx<ReaderUser[]>`INSERT INTO reader_users
      (name, company, job_title, wechat, business_card_url, referrer, tracking_consent, status, activated_at)
      VALUES (${input.name}, ${input.company}, ${input.job_title}, ${input.wechat}, ${input.business_card_url ?? null},
        ${input.referrer ?? null}, ${input.tracking_consent}, ${status}, ${status === "active" ? new Date() : null})
      RETURNING *`;
    await tx`INSERT INTO reader_auth_identities (provider, subject, user_id) VALUES ('email', ${input.email}, ${user!.id})`;
    await tx`INSERT INTO reader_consents (user_id, kind, version, granted) VALUES
      (${user!.id}, 'terms', ${policy.termsVersion}, true),
      (${user!.id}, 'privacy', ${policy.privacyVersion}, true),
      (${user!.id}, 'tracking', ${policy.privacyVersion}, ${input.tracking_consent})`;
    await useInvite(tx, invite.id, user!.id);
    const invites = status === "active" ? await welcomeInvites(tx, policy, user!.id) : [];
    const token = await createSession(tx, policy, user!, ip);
    return { user: user!, token, invites };
  });
}

export async function loginReader(policy: ReaderConfig, email: string, ticket: string, ip: string) {
  requireSecret(policy);
  return sql.begin(async (tx) => {
    await lockKey(tx, "email", email);
    await consumeTicket(tx, email, ticket);
    const [user] = await tx<ReaderUser[]>`SELECT u.* FROM reader_users u
      JOIN reader_auth_identities i ON i.user_id = u.id WHERE i.provider = 'email' AND i.subject = ${email} FOR UPDATE OF u`;
    if (!user) throw new ReaderError(404, "reader_not_registered", "此邮箱尚未注册。");
    if (user.status === "disabled") throw new ReaderError(403, "reader_disabled", "账号已停用。");
    return { user, token: await createSession(tx, policy, user, ip) };
  });
}

export async function getReader(id: string) {
  const [user] = await sql<(ReaderProfile & { email: string | null; email_verified_at: Date | null })[]>`
    SELECT ${profileFields}, i.subject AS email, i.verified_at AS email_verified_at FROM reader_users u
    LEFT JOIN reader_auth_identities i ON i.user_id = u.id AND i.provider = 'email' WHERE u.id = ${id}`;
  if (!user) throw notFound();
  return user;
}

export async function updateReader(policy: ReaderConfig, id: string, patch: ProfilePatch) {
  await sql.begin(async (tx) => {
    const [user] = await tx<ReaderUser[]>`SELECT * FROM reader_users WHERE id = ${id} FOR UPDATE`;
    if (!user || user.status === "disabled") throw notFound();
    const columns = { name: patch.name, company: patch.company, job_title: patch.job_title, wechat: patch.wechat,
      business_card_url: patch.business_card_url, referrer: patch.referrer, tracking_consent: patch.tracking_consent };
    const changed = Object.entries(columns).filter(([key, value]) => value !== undefined && value !== user[key as keyof typeof columns]);
    if (!changed.length) return;
    await tx`UPDATE reader_users SET ${tx(Object.fromEntries(changed))} WHERE id = ${id}`;
    if (patch.tracking_consent !== undefined && patch.tracking_consent !== user.tracking_consent) {
      await tx`INSERT INTO reader_consents (user_id, kind, version, granted)
        VALUES (${id}, 'tracking', ${policy.privacyVersion}, ${patch.tracking_consent})`;
      await tx`DELETE FROM reader_consents WHERE user_id = ${id} AND kind = 'tracking' AND id <= (
        SELECT id FROM reader_consents WHERE user_id = ${id} AND kind = 'tracking'
        ORDER BY id DESC OFFSET ${LIMITS.trackingConsentsPerReader} LIMIT 1)`;
    }
  });
  return getReader(id);
}

export async function deleteReader(id: string) {
  await sql.begin(async (tx) => {
    const email = await lockReaderEmail(tx, id);
    const [user] = await tx`SELECT id FROM reader_users WHERE id = ${id} FOR UPDATE`;
    if (!user) throw notFound();
    await removeReaderData(tx, id, email);
  });
}

/** Acquire the email lock before locking the reader row, as login and registration do. */
export async function lockReaderEmail(tx: Tx, id: string) {
  const [identity] = await tx<{ subject: string }[]>`SELECT subject FROM reader_auth_identities WHERE user_id = ${id} AND provider = 'email'`;
  if (identity) await lockKey(tx, "email", identity.subject);
  return identity?.subject ?? null;
}

/** Shared by self-service and scheduled deletion. The caller holds both locks. */
export async function removeReaderData(tx: Tx, id: string, email: string | null) {
  if (email !== null) {
    await tx`DELETE FROM reader_otps WHERE email = ${email}`;
    await tx`DELETE FROM reader_applications WHERE email = ${email}`;
    await tx`UPDATE reader_invites SET bound_email = NULL, note = NULL,
      revoked_at = CASE WHEN used_at IS NULL THEN COALESCE(revoked_at, clock_timestamp()) ELSE revoked_at END
      WHERE bound_email = ${email} OR used_by = ${id}`;
  }
  await tx`UPDATE reader_invites SET bound_email = NULL, note = NULL,
    revoked_at = CASE WHEN used_at IS NULL THEN COALESCE(revoked_at, clock_timestamp()) ELSE revoked_at END
    WHERE issuer_reader_id = ${id}`;
  await tx`DELETE FROM reader_users WHERE id = ${id}`;
}

export async function approveReader(policy: ReaderConfig, id: string) {
  return sql.begin(async (tx) => {
    const [user] = await tx<ReaderUser[]>`UPDATE reader_users SET status = 'active', activated_at = clock_timestamp()
      WHERE id = ${id} AND status = 'pending' RETURNING *`;
    if (!user) throw new ReaderError(409, "reader_not_pending", "该账号不在待审状态。");
    const [identity] = await tx<{ subject: string }[]>`SELECT subject FROM reader_auth_identities WHERE user_id = ${id} AND provider = 'email'`;
    return { user, email: identity?.subject ?? null, invites: await welcomeInvites(tx, policy, id) };
  });
}

export async function setReaderDisabled(id: string, disabled: boolean) {
  return sql.begin(async (tx) => {
    const [user] = await tx<ReaderProfile[]>`UPDATE reader_users u
      SET status = CASE WHEN ${disabled} THEN 'disabled' WHEN activated_at IS NULL THEN 'pending' ELSE 'active' END
      WHERE id = ${id} RETURNING ${profileFields}`;
    if (!user) throw notFound();
    if (disabled) await tx`DELETE FROM reader_sessions WHERE user_id = ${id}`;
    return user;
  });
}

export async function listReaders(offset: number, status?: string, search?: string) {
  const q = search ? `%${search.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await sql`SELECT u.id, u.name, u.company, u.job_title, u.status, u.created_at, u.last_active_at, i.subject AS email,
      activity.active_days_7, activity.active_days_30
    FROM reader_users u LEFT JOIN reader_auth_identities i ON i.user_id = u.id AND i.provider = 'email'
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE day >= ${new Date(Date.now() - (LIMITS.activityWeekDays - 1) * DAY).toISOString().slice(0, 10)}) AS active_days_7,
        count(*) AS active_days_30
      FROM reader_activity_daily WHERE user_id = u.id AND day >= ${new Date(Date.now() - (LIMITS.activityMonthDays - 1) * DAY).toISOString().slice(0, 10)}
    ) activity ON true
    WHERE ${status ? sql`u.status = ${status}` : sql`true`}
      AND ${q ? sql`(u.name ILIKE ${q} ESCAPE '\\' OR u.company ILIKE ${q} ESCAPE '\\' OR i.subject ILIKE ${q} ESCAPE '\\')` : sql`true`}
    ORDER BY u.created_at DESC, u.id DESC OFFSET ${offset} LIMIT ${LIMITS.resultPage}`;
  return { readers: rows };
}

export async function readerContacts(ids: string[]): Promise<ReaderContact[]> {
  if (!ids.length) return [];
  return sql<ReaderContact[]>`SELECT id, name, wechat FROM reader_users WHERE id IN ${sql(ids)}`;
}

export async function invitationChain(id: string) {
  const [invitedBy] = await sql`SELECT i.issuer, r.id, r.name, i.used_at FROM reader_invites i
    LEFT JOIN reader_users r ON r.id = i.issuer_reader_id WHERE i.used_by = ${id}`;
  const invitedReaders = await sql`SELECT u.id, u.name, u.company, u.status, i.used_at FROM reader_invites i
    JOIN reader_users u ON u.id = i.used_by WHERE i.issuer_reader_id = ${id} ORDER BY i.used_at DESC`;
  return { invited_by: invitedBy ?? null, invited_readers: invitedReaders };
}


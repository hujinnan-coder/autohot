import { sql, type Tx } from "@aihot/backend/db";
import type { ReaderConfig } from "./config.ts";
import { tokenHash, randomToken, sessionTiming, sessionToken } from "./rules.ts";

export type Status = "active" | "pending" | "disabled";

export interface ReaderUser {
  id: string;
  status: Status;
  name: string;
  company: string;
  job_title: string;
  wechat: string;
  business_card_url: string | null;
  referrer: string | null;
  phone: string | null;
  phone_verified_at: Date | null;
  wechat_openid: string | null;
  wechat_unionid: string | null;
  tracking_consent: boolean;
  activated_at: Date | null;
  last_active_at: Date | null;
  created_at: Date;
}

export const validPrincipal = (user: ReaderUser) => ({
  loggedIn: true,
  status: user.status,
  nickname: user.name,
  needsProfile: ![user.name, user.company, user.job_title, user.wechat].every(Boolean),
});

async function markActivity(tx: Tx, userId: string, now: Date) {
  await tx`UPDATE reader_users SET last_active_at = ${now},
    inactivity_notified_at = CASE WHEN inactivity_notified_at < ${now} THEN NULL ELSE inactivity_notified_at END,
    inactivity_deadline_at = CASE WHEN inactivity_notified_at < ${now} THEN NULL ELSE inactivity_deadline_at END,
    inactivity_final_notified_at = CASE WHEN inactivity_notified_at < ${now} THEN NULL ELSE inactivity_final_notified_at END
    WHERE id = ${userId} AND (last_active_at IS NULL OR last_active_at < ${now})`;
  await tx`INSERT INTO reader_activity_daily (user_id, day) VALUES (${userId}, ${now.toISOString().slice(0, 10)}) ON CONFLICT DO NOTHING`;
}

/** The caller holds the reader row lock (or just created it) to serialize login and suspension. */
export async function createSession(tx: Tx, policy: ReaderConfig, user: ReaderUser, ip: string) {
  const now = new Date();
  const token = randomToken();
  await tx`DELETE FROM reader_sessions WHERE user_id = ${user.id}
    AND (expires_at <= ${now} OR last_seen_at <= ${new Date(now.getTime() - policy.idleLifetime)})`;
  await tx`INSERT INTO reader_sessions (id_hash, user_id, last_seen_at, expires_at)
    VALUES (${tokenHash(token)}, ${user.id}, ${now}, ${new Date(now.getTime() + policy.sessionLifetime)})`;
  await tx`DELETE FROM reader_sessions WHERE id_hash IN (
    SELECT id_hash FROM reader_sessions WHERE user_id = ${user.id}
    ORDER BY created_at DESC, id_hash DESC OFFSET ${policy.maxSessions})`;
  await tx`INSERT INTO reader_login_log (user_id, ip) VALUES (${user.id}, ${ip})`;
  await markActivity(tx, user.id, now);
  return token;
}

type SessionRow = ReaderUser & { last_seen_at: Date; expires_at: Date };

export async function findSession(
  policy: ReaderConfig, cookie: string | undefined, options: { touch?: boolean; activeOnly?: boolean } = {},
) {
  const token = sessionToken(cookie);
  if (!token) return null;
  const hash = tokenHash(token);
  const [user] = await sql<SessionRow[]>`SELECT u.*, s.last_seen_at, s.expires_at
    FROM reader_sessions s JOIN reader_users u ON u.id = s.user_id WHERE s.id_hash = ${hash}`;
  if (!user || user.status === "disabled" || (options.activeOnly && user.status !== "active")) return null;
  const now = new Date();
  const timing = sessionTiming(now, user.last_seen_at, user.expires_at, policy);
  if (!timing.valid) return null;
  if (!options.touch || !timing.renew) return user;
  // Use the same lock order as login and disable. Recheck after waiting, including logout or a newer renewal.
  return sql.begin(async (tx) => {
    const [current] = await tx<ReaderUser[]>`SELECT * FROM reader_users WHERE id = ${user.id} FOR UPDATE`;
    if (!current || current.status === "disabled" || (options.activeOnly && current.status !== "active")) return null;
    const [session] = await tx<Pick<SessionRow, "last_seen_at" | "expires_at">[]>`
      SELECT last_seen_at, expires_at FROM reader_sessions WHERE id_hash = ${hash} FOR UPDATE`;
    const at = new Date();
    if (!session) return null;
    const fresh = sessionTiming(at, session.last_seen_at, session.expires_at, policy);
    if (!fresh.valid) return null;
    if (fresh.renew) {
      await tx`UPDATE reader_sessions SET last_seen_at = ${at} WHERE id_hash = ${hash}`;
      await markActivity(tx, user.id, at);
    }
    return current;
  });
}

export async function endReaderSession(cookie: string | undefined) {
  const token = sessionToken(cookie);
  if (token) await sql`DELETE FROM reader_sessions WHERE id_hash = ${tokenHash(token)}`;
}

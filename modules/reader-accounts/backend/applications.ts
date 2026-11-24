import { sql } from "@aihot/backend/db";
import { HOUR, LIMITS, type ReaderConfig } from "./config.ts";
import { notFound, ReaderError } from "./errors.ts";
import type { ApplicationInput } from "./inputs.ts";
import { issueInvite } from "./invites.ts";
import { consumeTicket, lockKey, requireSecret } from "./otp.ts";
import { secretHash } from "./rules.ts";

export async function submitApplication(policy: ReaderConfig, input: ApplicationInput, ip: string) {
  const ipKey = secretHash(requireSecret(policy), "application-ip", ip);
  return sql.begin(async (tx) => {
    await lockKey(tx, "application-ip", ipKey);
    await lockKey(tx, "email", input.email);
    const now = new Date();
    const recent = await tx<{ created_at: Date }[]>`SELECT created_at FROM reader_applications WHERE ip_key = ${ipKey}
      AND created_at > ${new Date(now.getTime() - HOUR)} ORDER BY created_at DESC LIMIT ${LIMITS.applicationIpPerHour}`;
    const oldest = recent[LIMITS.applicationIpPerHour - 1];
    if (oldest) throw new ReaderError(429, "rate_limited", "申请过于频繁。", Math.ceil((oldest.created_at.getTime() + HOUR - now.getTime()) / 1000));
    await consumeTicket(tx, input.email, input.ticket);
    const [row] = await tx`INSERT INTO reader_applications (email, name, company, job_title, wechat, reason, referrer, ip_key)
      VALUES (${input.email}, ${input.name}, ${input.company}, ${input.job_title}, ${input.wechat}, ${input.reason}, ${input.referrer ?? null}, ${ipKey})
      ON CONFLICT (email) WHERE status = 'pending' DO NOTHING RETURNING id, status`;
    if (!row) throw new ReaderError(409, "application_pending", "该邮箱已有待审申请。");
    return row;
  });
}

const applicationFields = sql`id, email, name, company, job_title, wechat, reason, referrer, status,
  decision_reason, decided_at, approved_invite_id, created_at`;

export async function listApplications(offset: number, status?: string) {
  const where = status ? sql`WHERE status = ${status}` : sql``;
  const applications = await sql`SELECT ${applicationFields} FROM reader_applications ${where}
    ORDER BY created_at DESC, id DESC OFFSET ${offset} LIMIT ${LIMITS.resultPage}`;
  return { applications };
}

export async function applicationDetail(id: string) {
  const [application] = await sql<{ company: string }[]>`SELECT ${applicationFields} FROM reader_applications WHERE id = ${id}`;
  if (!application) throw notFound();
  const coworkers = await sql`SELECT id, name, company, job_title, status FROM reader_users
    WHERE lower(company) = lower(${application.company}) ORDER BY created_at DESC LIMIT ${LIMITS.resultPage}`;
  return { application, coworkers };
}

export async function reissuableApplications(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await sql<{ id: string }[]>`SELECT a.id FROM reader_applications a
    JOIN reader_invites i ON i.id = a.approved_invite_id
    WHERE a.id IN ${sql(ids)} AND a.status = 'approved' AND i.used_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM reader_auth_identities r WHERE r.provider = 'email' AND r.subject = a.email)`;
  return rows.map(row => row.id);
}

export async function approveApplication(policy: ReaderConfig, id: string) {
  return sql.begin(async (tx) => {
    const [row] = await tx<{ email: string }[]>`SELECT email FROM reader_applications WHERE id = ${id} AND status = 'pending' FOR UPDATE`;
    if (!row) throw new ReaderError(409, "application_not_pending", "该申请不在待审状态。");
    const invite = await issueInvite(tx, policy, { bound_email: row.email });
    await tx`UPDATE reader_applications SET status = 'approved', decided_at = clock_timestamp(),
      approved_invite_id = ${invite.id} WHERE id = ${id}`;
    return { email: row.email, invite };
  });
}

export async function reissueApplicationInvite(policy: ReaderConfig, id: string) {
  return sql.begin(async (tx) => {
    // A competing reissue must fail instead of waiting and revoking the code just issued.
    const [row] = await tx<{ email: string; approved_invite_id: string | null }[]>`
      SELECT email, approved_invite_id FROM reader_applications WHERE id = ${id} AND status = 'approved' FOR UPDATE NOWAIT`;
    if (!row) throw new ReaderError(409, "application_not_approved", "该申请尚未通过。");
    const changed = await tx`UPDATE reader_invites SET revoked_at = COALESCE(revoked_at, clock_timestamp())
      WHERE id = ${row.approved_invite_id} AND used_at IS NULL RETURNING id`;
    if (!changed.length) throw new ReaderError(409, "invite_not_replaceable", "该申请的邀请码不存在或已使用。");
    const invite = await issueInvite(tx, policy, { bound_email: row.email });
    await tx`UPDATE reader_applications SET approved_invite_id = ${invite.id} WHERE id = ${id}`;
    return { email: row.email, invite };
  }).catch((error: unknown) => {
    if ((error as { code?: string })?.code === "55P03") {
      throw new ReaderError(409, "application_reissue_in_progress", "该申请的邀请码正在重签。");
    }
    throw error;
  });
}

export async function rejectApplication(id: string, reason: string | null) {
  const [row] = await sql<{ email: string }[]>`UPDATE reader_applications SET status = 'rejected',
    decision_reason = ${reason}, decided_at = clock_timestamp() WHERE id = ${id} AND status = 'pending' RETURNING email`;
  if (!row) throw new ReaderError(409, "application_not_pending", "该申请不在待审状态。");
  return row;
}

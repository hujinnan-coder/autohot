import { randomUUID } from "node:crypto";
import { sql, type Db, type Tx } from "@aihot/backend/db";
import { HOUR, LIMITS, type ReaderConfig } from "./config.ts";
import { invalidOtp, invalidTicket, ReaderError } from "./errors.ts";
import { equalSecret, otpCode, otpRetryAfter, randomToken, secretHash, tokenHash } from "./rules.ts";

export function requireSecret(policy: ReaderConfig) {
  if (!policy.secret) throw new ReaderError(503, "reader_unavailable", "读者账号服务尚未配置。");
  return policy.secret;
}

// Serializes a check followed by a write across API processes, even when no row exists yet.
export async function lockKey(tx: Tx, name: string, key: string) {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`reader-accounts:${name}:${key}`}, 0))`;
}

const otpHash = (secret: string, id: string, code: string) => secretHash(secret, `otp:${id}`, code);

export async function issueOtp(policy: ReaderConfig, email: string, ip: string) {
  const secret = requireSecret(policy);
  const ipKey = secretHash(secret, "otp-ip", ip);
  return sql.begin(async (tx) => {
    await lockKey(tx, "otp-ip", ipKey);
    await lockKey(tx, "email", email);
    const now = new Date();
    const cutoff = new Date(now.getTime() - HOUR);
    const emailRows = await tx<{ created_at: Date }[]>`
      SELECT created_at FROM reader_otps WHERE email = ${email} AND created_at > ${cutoff}
      ORDER BY created_at DESC LIMIT ${LIMITS.otpEmailPerHour}`;
    const ipRows = await tx<{ created_at: Date }[]>`
      SELECT created_at FROM reader_otps WHERE ip_key = ${ipKey} AND created_at > ${cutoff}
      ORDER BY created_at DESC LIMIT ${LIMITS.otpIpPerHour}`;
    const retryAfter = otpRetryAfter(now, emailRows.map((r) => r.created_at), ipRows.map((r) => r.created_at));
    if (retryAfter > 0) throw new ReaderError(429, "rate_limited", "验证码发送过于频繁。", retryAfter);
    const id = randomUUID();
    const code = otpCode();
    await tx`UPDATE reader_otps SET code_hash = NULL WHERE email = ${email} AND code_hash IS NOT NULL`;
    await tx`INSERT INTO reader_otps (id, email, ip_key, code_hash, expires_at, created_at)
      VALUES (${id}, ${email}, ${ipKey}, ${otpHash(secret, id, code)}, ${new Date(now.getTime() + LIMITS.otpLifetime)}, ${now})`;
    return { id, code };
  });
}

export async function cancelOtp(id: string) {
  await sql`UPDATE reader_otps SET code_hash = NULL WHERE id = ${id}`;
}

export async function verifyOtp(policy: ReaderConfig, email: string, code: string) {
  const secret = requireSecret(policy);
  const result = await sql.begin(async (tx) => {
    await lockKey(tx, "email", email);
    const now = new Date();
    const [row] = await tx<{ id: string; code_hash: string | null; attempts: number; expires_at: Date }[]>`
      SELECT id, code_hash, attempts, expires_at FROM reader_otps WHERE email = ${email}
      ORDER BY created_at DESC LIMIT 1 FOR UPDATE`;
    if (!row?.code_hash || row.expires_at <= now || row.attempts >= LIMITS.otpAttempts) return null;
    if (!equalSecret(otpHash(secret, row.id, code), row.code_hash)) {
      const attempts = row.attempts + 1;
      await tx`UPDATE reader_otps SET attempts = ${attempts},
        code_hash = ${attempts < LIMITS.otpAttempts ? row.code_hash : null} WHERE id = ${row.id}`;
      return null;
    }
    const ticket = randomToken();
    const expiresAt = new Date(now.getTime() + LIMITS.ticketLifetime);
    await tx`UPDATE reader_otps SET code_hash = NULL, ticket_hash = ${tokenHash(ticket)}, ticket_expires_at = ${expiresAt}
      WHERE id = ${row.id}`;
    return { ticket, expiresAt };
  });
  if (!result) throw invalidOtp();
  return result;
}

export async function consumeTicket(db: Db, email: string, ticket: string) {
  const rows = await db`UPDATE reader_otps SET ticket_hash = NULL, ticket_expires_at = NULL
    WHERE email = ${email} AND ticket_hash = ${tokenHash(ticket)} AND ticket_expires_at > clock_timestamp() RETURNING id`;
  if (!rows.length) throw invalidTicket();
}

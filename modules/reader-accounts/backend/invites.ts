import { sql, type Db, type Tx } from "@aihot/backend/db";
import type { ReaderConfig } from "./config.ts";
import { LIMITS } from "./config.ts";
import { invalidInvite, ReaderError } from "./errors.ts";
import type { ChildInviteInput, InviteInput } from "./inputs.ts";
import { requireSecret } from "./otp.ts";
import { displayInvite, generateInvite, normalizeInvite, secretHash } from "./rules.ts";
import type { ReaderUser } from "./sessions.ts";

const inviteHash = (policy: ReaderConfig, code: string) => secretHash(requireSecret(policy), "invite", code);

function unused(db: Db) {
  return db`used_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()`;
}

export async function checkInvite(policy: ReaderConfig, input: string) {
  const code = normalizeInvite(input);
  const [row] = !code ? [] : await sql<{ bound: boolean }[]>`
    SELECT bound_email IS NOT NULL AS bound FROM reader_invites WHERE code_hash = ${inviteHash(policy, code)} AND ${unused(sql)}`;
  return { valid: !!row, bound_email: row?.bound ?? false };
}

export async function lockInvite(tx: Tx, policy: ReaderConfig, input: string, email: string) {
  const code = normalizeInvite(input);
  if (!code) throw invalidInvite();
  const [invite] = await tx<{ id: string; requires_approval: boolean }[]>`
    SELECT id, requires_approval FROM reader_invites WHERE code_hash = ${inviteHash(policy, code)}
      AND ${unused(tx)} AND (bound_email IS NULL OR bound_email = ${email}) FOR UPDATE`;
  if (!invite) throw invalidInvite();
  return invite;
}

export async function useInvite(tx: Tx, id: string, userId: string) {
  const used = await tx`UPDATE reader_invites SET used_by = ${userId}, used_at = clock_timestamp()
    WHERE id = ${id} AND ${unused(tx)} RETURNING id`;
  if (!used.length) throw invalidInvite();
}

export interface IssuedInvite {
  id: string;
  code: string;
  expires_at: Date;
  requires_approval: boolean;
}

export async function issueInvite(db: Db, policy: ReaderConfig, input: InviteInput, child?: { issuer: string; slot: number }): Promise<IssuedInvite> {
  const code = generateInvite();
  const expiresAt = new Date(Date.now() + policy.inviteLifetime);
  const [row] = await db<{ id: string }[]>`INSERT INTO reader_invites
    (code_hash, issuer, issuer_reader_id, child_slot, requires_approval, bound_email, batch_tag, note, expires_at)
    VALUES (${inviteHash(policy, code)}, ${child ? "reader" : "admin"}, ${child?.issuer ?? null}, ${child?.slot ?? null},
      ${Boolean(child)}, ${input.bound_email ?? null}, ${input.batch_tag ?? null}, ${input.note ?? null}, ${expiresAt})
    RETURNING id`;
  return { id: row!.id, code: displayInvite(code), expires_at: expiresAt, requires_approval: Boolean(child) };
}

/** Activation has already locked (or inserted) the user row. */
export async function welcomeInvites(tx: Tx, policy: ReaderConfig, userId: string) {
  const invites: IssuedInvite[] = [];
  if (policy.childEnabled) {
    for (let slot = 1; slot <= policy.childQuota; slot++) {
      invites.push(await issueInvite(tx, policy, {}, { issuer: userId, slot }));
    }
  }
  return invites;
}

export async function childInvites(policy: ReaderConfig, user: ReaderUser) {
  if (!policy.childEnabled || user.status !== "active") return { invites: [], quota: 0 };
  const invites = await sql`SELECT id, child_slot, bound_email, note, created_at, expires_at, used_at, revoked_at
    FROM reader_invites WHERE issuer_reader_id = ${user.id} AND revoked_at IS NULL ORDER BY child_slot`;
  return { invites, quota: policy.childQuota };
}

export async function issueChildInvite(policy: ReaderConfig, userId: string, input: ChildInviteInput) {
  if (!policy.childEnabled) throw new ReaderError(403, "child_invites_disabled", "子邀请码功能未开启。");
  return sql.begin(async (tx) => {
    const [user] = await tx<{ status: string }[]>`SELECT status FROM reader_users WHERE id = ${userId} FOR UPDATE`;
    if (user?.status !== "active") throw new ReaderError(403, "active_required", "账号激活后才能发出邀请。");
    const issued = await tx<{ id: string; child_slot: number; used_at: Date | null }[]>`
      SELECT id, child_slot, used_at FROM reader_invites WHERE issuer_reader_id = ${userId} AND revoked_at IS NULL`;
    const occupied = new Set(issued.map(i => i.child_slot));
    let slot = 1;
    if (input.replace_id) {
      const prior = issued.find(i => i.id === input.replace_id);
      if (!prior || prior.used_at || prior.child_slot > policy.childQuota) {
        throw new ReaderError(409, "invite_not_replaceable", "只能换发额度内尚未使用的子邀请码。");
      }
      const changed = await tx`UPDATE reader_invites SET revoked_at = clock_timestamp()
        WHERE id = ${prior.id} AND used_at IS NULL AND revoked_at IS NULL RETURNING id`;
      if (!changed.length) throw new ReaderError(409, "invite_not_replaceable", "该邀请码已使用或已撤销。");
      slot = prior.child_slot;
    } else {
      while (occupied.has(slot)) slot++;
      if (slot > policy.childQuota) throw new ReaderError(409, "child_invite_quota", "子邀请码额度已用完。");
    }
    return issueInvite(tx, policy, input, { issuer: userId, slot });
  });
}

export async function adminIssueInvites(policy: ReaderConfig, count: number, input: InviteInput) {
  return sql.begin(async (tx) => {
    const invites: IssuedInvite[] = [];
    for (let i = 0; i < count; i++) invites.push(await issueInvite(tx, policy, input));
    return invites;
  });
}

export async function listInvites(offset: number, batchTag?: string) {
  const filter = batchTag ? sql`WHERE batch_tag = ${batchTag}` : sql``;
  const invites = await sql`SELECT id, issuer, issuer_reader_id, child_slot, requires_approval, bound_email, batch_tag, note,
    created_at, expires_at, used_by, used_at, revoked_at FROM reader_invites ${filter}
    ORDER BY created_at DESC, id DESC OFFSET ${offset} LIMIT ${LIMITS.resultPage}`;
  const batches = await sql`SELECT batch_tag, count(*) AS total, count(used_at) AS used, count(revoked_at) AS revoked
    FROM reader_invites WHERE batch_tag IS NOT NULL GROUP BY batch_tag
    ORDER BY max(created_at) DESC, batch_tag LIMIT ${LIMITS.resultPage}`;
  return { invites, batches };
}

export async function revokeInvite(id: string) {
  const changed = await sql`UPDATE reader_invites SET revoked_at = clock_timestamp()
    WHERE id = ${id} AND used_at IS NULL AND revoked_at IS NULL RETURNING id`;
  if (!changed.length) throw new ReaderError(409, "invite_not_revocable", "该邀请码不存在、已使用或已撤销。");
}

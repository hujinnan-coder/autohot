import { sql } from "@aihot/backend/db";
import { DAY, HOUR, LIMITS, type ReaderConfig } from "./config.ts";
import { getReader } from "./accounts.ts";
import type { ReaderEvent } from "./inputs.ts";

const eventFields = sql`id, kind, target_id, topic_slug, brand_slug, query, dwell_bucket, created_at`;

export async function recordEvents(userId: string, events: readonly ReaderEvent[]) {
  await sql.begin(async (tx) => {
    // An opt-out and a concurrent event batch are ordered by the same reader row.
    const [user] = await tx<{ tracking_consent: boolean; status: string }[]>`
      SELECT tracking_consent, status FROM reader_users WHERE id = ${userId} FOR UPDATE`;
    if (!user?.tracking_consent || user.status === "disabled") return;
    const rows = events.map(e => ({
      user_id: userId, kind: e.kind, target_id: e.target_id ?? null, topic_slug: e.topic_slug ?? null,
      brand_slug: e.brand_slug ?? null, query: e.query ?? null, dwell_bucket: e.dwell_bucket ?? null,
    }));
    await tx`DELETE FROM reader_events WHERE user_id = ${userId} AND id <= (
      SELECT id FROM reader_events WHERE user_id = ${userId}
      ORDER BY id DESC OFFSET ${LIMITS.eventsPerReader - rows.length} LIMIT 1)`;
    await tx`INSERT INTO reader_events ${tx(rows)}`;
  });
}

export async function readerEvents(userId: string, offset: number) {
  const events = await sql`SELECT ${eventFields} FROM reader_events WHERE user_id = ${userId}
    ORDER BY id DESC OFFSET ${offset} LIMIT ${LIMITS.resultPage}`;
  return { events };
}

export async function exportReader(userId: string) {
  const [profile, events, consents, logins] = await Promise.all([
    getReader(userId),
    sql`SELECT ${eventFields} FROM reader_events WHERE user_id = ${userId}
      ORDER BY id DESC LIMIT ${LIMITS.exportEvents + 1}`,
    sql`SELECT kind, version, granted, created_at FROM reader_consents WHERE user_id = ${userId}
      ORDER BY id DESC LIMIT ${LIMITS.exportConsents + 1}`,
    sql`SELECT host(ip) AS ip, created_at FROM reader_login_log WHERE user_id = ${userId}
      AND created_at > ${new Date(Date.now() - LIMITS.loginIpDays * DAY)} ORDER BY created_at DESC`,
  ]);
  return { profile, events: events.slice(0, LIMITS.exportEvents), truncated: events.length > LIMITS.exportEvents,
    consents: consents.slice(0, LIMITS.exportConsents).reverse(), consents_truncated: consents.length > LIMITS.exportConsents, logins };
}

export async function clearEvents(userId: string) {
  await sql.begin(async (tx) => {
    await tx`SELECT id FROM reader_users WHERE id = ${userId} FOR UPDATE`;
    await tx`DELETE FROM reader_events WHERE user_id = ${userId}`;
  });
}

export async function readerInterests(userId: string) {
  const [brands, topics, content, recent] = await Promise.all([
    sql`SELECT brand_slug, count(*) AS visits FROM reader_events WHERE user_id = ${userId} AND brand_slug IS NOT NULL
      AND kind IN ('view_item', 'view_story', 'view_topic', 'view_report', 'report_open')
      GROUP BY brand_slug ORDER BY visits DESC, brand_slug LIMIT ${LIMITS.interestLimit}`,
    sql`SELECT topic_slug, count(*) AS visits FROM reader_events WHERE user_id = ${userId} AND topic_slug IS NOT NULL
      AND kind IN ('view_item', 'view_story', 'view_topic', 'view_report', 'report_open')
      GROUP BY topic_slug ORDER BY visits DESC, topic_slug LIMIT ${LIMITS.interestLimit}`,
    sql`SELECT kind, target_id, count(*) AS visits FROM reader_events WHERE user_id = ${userId} AND target_id IS NOT NULL
      AND kind IN ('view_item', 'view_story', 'view_topic', 'view_report', 'report_open')
      GROUP BY kind, target_id ORDER BY visits DESC, kind, target_id LIMIT ${LIMITS.interestLimit}`,
    sql`SELECT ${eventFields} FROM reader_events WHERE user_id = ${userId} ORDER BY id DESC LIMIT ${LIMITS.recentActions}`,
  ]);
  return { brands, topics, content, recent };
}

export async function retainReaderData(policy: ReaderConfig, now: Date) {
  const eventCutoff = new Date(now.getTime() - LIMITS.eventDays * DAY);
  // Delete and aggregate in one statement so overlapping retention runs count each event only once.
  const [events] = await sql<{ removed: number }[]>`
    WITH expired AS (
      DELETE FROM reader_events WHERE created_at <= ${eventCutoff} RETURNING kind, created_at
    ), totals AS (
      INSERT INTO reader_event_daily (day, kind, event_count)
      SELECT timezone('UTC', created_at)::date, kind, count(*) FROM expired GROUP BY 1, 2 ORDER BY 1, 2
      ON CONFLICT (day, kind) DO UPDATE SET event_count = reader_event_daily.event_count + EXCLUDED.event_count
    )
    SELECT count(*) AS removed FROM expired`;
  const expiredApplications = await sql`DELETE FROM reader_applications
    WHERE COALESCE(decided_at, created_at) <= ${new Date(now.getTime() - LIMITS.applicationDays * DAY)}`;
  const [logins, otps, sessions, activity, applicationRateKeys] = await Promise.all([
    sql`DELETE FROM reader_login_log WHERE created_at <= ${new Date(now.getTime() - LIMITS.loginIpDays * DAY)}`,
    sql`DELETE FROM reader_otps WHERE created_at <= ${new Date(now.getTime() - HOUR)}`,
    sql`DELETE FROM reader_sessions WHERE expires_at <= ${now} OR last_seen_at <= ${new Date(now.getTime() - policy.idleLifetime)}`,
    sql`DELETE FROM reader_activity_daily WHERE day < ${new Date(now.getTime() - (LIMITS.activityMonthDays - 1) * DAY).toISOString().slice(0, 10)}`,
    sql`UPDATE reader_applications SET ip_key = NULL WHERE ip_key IS NOT NULL AND created_at <= ${new Date(now.getTime() - HOUR)}`,
    sql`UPDATE reader_invites SET bound_email = NULL, note = NULL
      WHERE used_at IS NULL AND (revoked_at IS NOT NULL OR expires_at <= ${now})
        AND (bound_email IS NOT NULL OR note IS NOT NULL)`,
  ]);
  return { readerAccounts: { events: events!.removed, logins: logins.count, otps: otps.count,
    sessions: sessions.count, activeDays: activity.count, applications: expiredApplications.count, applicationRateKeys: applicationRateKeys.count } };
}

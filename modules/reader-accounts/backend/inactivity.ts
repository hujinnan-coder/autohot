import { sql } from "@aihot/backend/db";
import type { Scheduled } from "@aihot/backend/modules";
import { sendAlert } from "@aihot/backend/notify/feishu";
import { addDays, beijingAt, beijingDate, beijingTime } from "@aihot/contracts/time";
import { lockReaderEmail, removeReaderData } from "./accounts.ts";
import { DAY, HOUR, type ReaderConfig } from "./config.ts";
import { plainMail, type Mail } from "./mailer.ts";

const batchLimit = 200;
const recentActivity = sql`GREATEST(u.last_active_at, u.activated_at, u.created_at)`;
const waiting = sql`u.status = 'active' AND u.inactivity_deadline_at IS NOT NULL
  AND ${recentActivity} <= u.inactivity_notified_at`;
const readersWithEmail = sql`reader_users u JOIN reader_auth_identities i ON i.user_id = u.id AND i.provider = 'email'`;
const deadlineOn = (date: string) => beijingAt(date, "11:00");
const stamp = (at: Date) => `${beijingDate(at)} ${beijingTime(at)}`;

type Deliver = (mail: Mail) => Promise<boolean>;
type Clock = () => Date;

function safeFinalDeadline(deadline: Date, sentAt: Date) {
  const earliest = new Date(sentAt.getTime() + HOUR);
  if (deadline >= earliest) return deadline;
  const date = beijingDate(earliest);
  return deadlineOn(earliest <= deadlineOn(date) ? date : addDays(date, 1));
}

function noticeMail(email: string, login: string, deadline: Date, at: Date, firstGraceDays: number | null) {
  const when = beijingDate(deadline) === beijingDate(at) ? "今天 11:00（北京时间）" : `北京时间 ${stamp(deadline)}`;
  const lead = firstGraceDays === null
    ? `你的读者账号将在${when}自动删除`
    : `你的读者账号因长期未登录或浏览，将在 ${firstGraceDays} 天后（${when}）自动删除`;
  const subject = firstGraceDays === null ? "读者账号删除前的最后一次提醒" : "读者账号即将因不活跃被删除";
  return plainMail(email, subject, `若届时仍未登录或浏览，${lead}，含全部个人资料和浏览记录。\n登录一次即可保留账号。登录地址：${login}\n你也可以登录后在账号设置中自行注销。`);
}

async function sendNotices(policy: ReaderConfig, deliver: Deliver, login: string, now: Clock, batch: {
  first: boolean; cutoff: Date; deadline: Date; limit: number;
}) {
  const counts = { reminded: 0, failed: 0 };
  if (batch.limit === 0) return counts;
  const due = batch.first
    ? sql`u.status = 'active' AND ${recentActivity} <= ${batch.cutoff}
      AND (u.inactivity_notified_at IS NULL OR u.inactivity_deadline_at IS NULL OR ${recentActivity} > u.inactivity_notified_at)`
    : sql`${waiting} AND u.inactivity_final_notified_at IS NULL AND u.inactivity_deadline_at <= ${batch.cutoff}`;
  const priority = batch.first ? recentActivity : sql`u.inactivity_deadline_at`;
  const candidates = await sql<{ id: string }[]>`SELECT u.id FROM ${readersWithEmail} WHERE ${due}
    ORDER BY ${priority}, u.id LIMIT ${batch.limit}`;

  for (const { id } of candidates) {
    try {
      const sent = await sql.begin(async tx => {
        const [reader] = await tx<{ email: string }[]>`SELECT i.subject AS email FROM ${readersWithEmail}
          WHERE u.id = ${id} AND ${due} FOR UPDATE OF u SKIP LOCKED`;
        if (!reader) return false;
        // Keep the claim in the transaction so a failed or interrupted send cannot leave a saved notice.
        const at = now();
        const deadline = batch.first ? batch.deadline : safeFinalDeadline(batch.deadline, at);
        if (batch.first) {
          await tx`UPDATE reader_users SET inactivity_notified_at = ${at}, inactivity_deadline_at = ${deadline},
            inactivity_final_notified_at = NULL WHERE id = ${id}`;
        } else {
          await tx`UPDATE reader_users SET inactivity_final_notified_at = ${at}, inactivity_deadline_at = ${deadline} WHERE id = ${id}`;
        }
        if (!await deliver(noticeMail(reader.email, login, deadline, at, batch.first ? policy.inactiveGraceDays : null))) {
          throw new Error("reader inactivity notice failed");
        }
        const sentAt = now();
        if (batch.first) {
          await tx`UPDATE reader_users SET inactivity_notified_at = ${sentAt} WHERE id = ${id}`;
        } else {
          // A slow provider can finish after the last safe time for the date given at dispatch.
          const safeDeadline = safeFinalDeadline(deadline, sentAt);
          await tx`UPDATE reader_users SET inactivity_final_notified_at = ${sentAt}, inactivity_deadline_at = ${safeDeadline} WHERE id = ${id}`;
        }
        return true;
      });
      if (sent) counts.reminded++;
    } catch {
      counts.failed++;
    }
  }
  return counts;
}

async function processDeadline(slot: Date, tomorrow: Date) {
  const counts = { deleted: 0, deferred: 0, failed: 0 };
  const due = sql`${waiting} AND u.inactivity_deadline_at <= ${slot}`;
  const candidates = await sql<{ id: string }[]>`SELECT u.id FROM reader_users u WHERE ${due}
    ORDER BY u.inactivity_deadline_at, u.id LIMIT ${batchLimit}`;
  for (const { id } of candidates) {
    try {
      const result = await sql.begin(async tx => {
        const email = await lockReaderEmail(tx, id);
        const [reader] = await tx<{ inactivity_final_notified_at: Date | null }[]>`
          SELECT u.inactivity_final_notified_at FROM reader_users u WHERE u.id = ${id} AND ${due} FOR UPDATE SKIP LOCKED`;
        if (!reader) return null;
        const finalAt = reader.inactivity_final_notified_at;
        if (!finalAt || finalAt.getTime() > slot.getTime() - HOUR) {
          await tx`UPDATE reader_users SET inactivity_deadline_at = ${tomorrow} WHERE id = ${id}`;
          return "deferred";
        }
        await removeReaderData(tx, id, email);
        return "deleted";
      });
      if (result) counts[result]++;
    } catch {
      counts.failed++;
    }
  }
  return { counts, slotsLeft: batchLimit - candidates.length };
}

async function inactivityDigest(policy: ReaderConfig, deliver: Deliver, alert: typeof sendAlert) {
  const readers = await sql<{ name: string; company: string; job_title: string; inactivity_notified_at: Date; inactivity_deadline_at: Date }[]>`
    SELECT u.name, u.company, u.job_title, u.inactivity_notified_at, u.inactivity_deadline_at
    FROM reader_users u WHERE ${waiting} ORDER BY u.inactivity_deadline_at, u.inactivity_notified_at, u.id LIMIT ${batchLimit}`;
  const counts = { waiting: readers.length, sent: 0, failed: 0 };
  if (!readers.length) return counts;
  const title = "读者账号待删除周报（北京时间）";
  const lines = readers.map(reader => {
    const profile = [reader.name, reader.company, reader.job_title]
      .map(field => field.replace(/[^\s<>|]+@[^\s<>|]+\.[^\s<>|]+/g, "（邮箱已省略）").replace(/\s+/g, " "));
    return [...profile, stamp(reader.inactivity_notified_at), stamp(reader.inactivity_deadline_at)].join(" | ");
  });
  const body = ["姓名 | 公司 | 职位 | 第一次提醒时间 | 预定删除时间", ...lines];
  const results = await Promise.allSettled([
    alert(title, body),
    policy.mailEnabled && policy.adminEmail
      ? deliver(plainMail(policy.adminEmail, title, body.join("\n"))).then(sent => sent ? "sent" : "failed")
      : "disabled",
  ]);
  for (const result of results) {
    if (result.status === "rejected" || result.value === "pending" || result.value === "failed") counts.failed++;
    else if (result.value === "sent") counts.sent++;
  }
  return counts;
}

export function inactivitySchedules({ policy, siteUrl, deliver, now = () => new Date(), alert = sendAlert }: {
  policy: ReaderConfig; siteUrl: string; deliver: Deliver; now?: Clock; alert?: typeof sendAlert;
}): Scheduled[] {
  const login = `${siteUrl.replace(/\/+$/, "")}/login`;
  return [{
    name: "reader-accounts.inactive-notice",
    cron: "0 11 * * *",
    missed: "once",
    async run() {
      const at = now();
      // Cron workers poll within the scheduled minute. An off-slot catch-up waits for the next 11:00.
      if (!policy.mailEnabled || beijingTime(at) !== "11:00") return { reminded: 0, deleted: 0, deferred: 0, failed: 0 };
      const date = beijingDate(at);
      const slot = deadlineOn(date);
      const { counts, slotsLeft } = await processDeadline(slot, deadlineOn(addDays(date, 1)));
      const notices = await sendNotices(policy, deliver, login, now, {
        first: true, cutoff: new Date(slot.getTime() - policy.inactiveDays * DAY),
        deadline: deadlineOn(addDays(date, policy.inactiveGraceDays)), limit: slotsLeft,
      });
      return { ...counts, reminded: notices.reminded, failed: counts.failed + notices.failed };
    },
  }, {
    name: "reader-accounts.inactive-final-notice",
    cron: "0 9 * * *",
    missed: "once",
    async run() {
      if (!policy.mailEnabled) return { reminded: 0, failed: 0 };
      const at = now();
      const date = beijingDate(at);
      const deadline = deadlineOn(beijingTime(at) <= "09:00" ? date : addDays(date, 1));
      return sendNotices(policy, deliver, login, now, {
        first: false, cutoff: new Date(at.getTime() + 2 * HOUR), deadline, limit: batchLimit,
      });
    },
  }, {
    name: "reader-accounts.inactive-digest",
    cron: "0 11 * * 1",
    missed: "once",
    run: () => inactivityDigest(policy, deliver, alert),
  }];
}

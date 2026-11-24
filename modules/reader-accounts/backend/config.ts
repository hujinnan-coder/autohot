import { READER_INVITE_BATCH_LIMIT, READER_PAGE_SIZE } from "../types.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const LIMITS = {
  internalTokenMinLength: 32,
  otpLifetime: 10 * MINUTE,
  otpCooldown: MINUTE,
  otpEmailPerHour: 5,
  otpIpPerHour: 20,
  otpAttempts: 5,
  ticketLifetime: 10 * MINUTE,
  applicationIpPerHour: 5,
  sessionRenewal: 10 * MINUTE,
  loginIpDays: 30,
  applicationDays: 90,
  eventDays: 180,
  eventsPerReader: 20_000,
  exportEvents: 5_000,
  trackingConsentsPerReader: 50,
  exportConsents: 200,
  activityWeekDays: 7,
  activityMonthDays: 30,
  eventBatch: 50,
  eventBytes: 32 * 1024,
  issueBatch: READER_INVITE_BATCH_LIMIT,
  resultPage: READER_PAGE_SIZE,
  recentActions: 30,
  interestLimit: 10,
} as const;

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1, max = 3650) {
  const raw = env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return n;
}

export function readerConfig(env: NodeJS.ProcessEnv, secret: string | null) {
  const wallEnabled = env.READER_WALL_ENABLED === "true";
  const internalToken = env.READER_INTERNAL_TOKEN?.trim() || null;
  if (wallEnabled && (!secret?.trim() || !internalToken || internalToken.length < LIMITS.internalTokenMinLength)) {
    throw new Error(`READER_WALL_ENABLED=true requires SESSION_SECRET and READER_INTERNAL_TOKEN (at least ${LIMITS.internalTokenMinLength} characters)`);
  }
  return {
    secret,
    wallEnabled,
    internalToken,
    inviteLifetime: integer(env, "READER_INVITE_TTL_HOURS", 72) * HOUR,
    childEnabled: env.READER_CHILD_INVITES_ENABLED === "true",
    childQuota: integer(env, "READER_CHILD_INVITE_QUOTA", 2, 0, LIMITS.issueBatch),
    idleLifetime: integer(env, "READER_IDLE_HOURS", 72) * HOUR,
    sessionLifetime: integer(env, "READER_SESSION_DAYS", 30) * DAY,
    maxSessions: integer(env, "READER_MAX_SESSIONS", 3, 1, 100),
    mailEnabled: env.READER_MAIL_ENABLED === "true",
    inactiveDays: integer(env, "READER_INACTIVE_DAYS", 30),
    inactiveGraceDays: integer(env, "READER_INACTIVE_GRACE_DAYS", 3),
    adminEmail: env.READER_ADMIN_EMAIL?.trim() || null,
    production: env.NODE_ENV === "production",
    termsVersion: env.READER_TERMS_VERSION?.trim() || "1",
    privacyVersion: env.READER_PRIVACY_VERSION?.trim() || "1",
  };
}

export type ReaderConfig = ReturnType<typeof readerConfig>;


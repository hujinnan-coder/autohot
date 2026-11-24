import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { READER_COOKIE } from "@aihot/contracts/reader";
import { HOUR, LIMITS, type ReaderConfig } from "./config.ts";

const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const INVITE_SIZE = 10;
const READER_COOKIE_PATTERN = new RegExp(`(?:^|;\\s*)${READER_COOKIE}=([A-Za-z0-9_-]{43})(?=;|$)`);
export const PRIVATE_RESPONSE = "private, no-store";
export const NO_INDEX = "noindex, nofollow";

export const EVENT_KINDS = [
  "view_item", "view_story", "view_topic", "view_report", "search", "follow_change", "report_open", "dwell",
] as const;
export const DWELL_BUCKETS = ["under_10s", "10_29s", "30_59s", "60_179s", "180s_plus"] as const;

export const generateInvite = () => Array.from({ length: INVITE_SIZE }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join("");
export const displayInvite = (code: string) => `${code.slice(0, 2)}-${code.slice(2, 6)}-${code.slice(6)}`;

export function normalizeInvite(input: string) {
  const code = input.replace(/[-\s]/g, "").toUpperCase();
  return code.length === INVITE_SIZE && [...code].every((c) => INVITE_ALPHABET.includes(c)) ? code : null;
}

export const randomToken = () => randomBytes(32).toString("base64url");
export const otpCode = () => String(randomInt(1_000_000)).padStart(6, "0");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export function secretHash(secret: string, purpose: string, value: string) {
  return createHmac("sha256", secret).update(JSON.stringify(["reader-accounts", purpose, value])).digest("hex");
}

export function equalSecret(given: string, expected: string) {
  return timingSafeEqual(createHash("sha256").update(given).digest(), createHash("sha256").update(expected).digest());
}

export function sessionToken(header: string | undefined) {
  return header?.match(READER_COOKIE_PATTERN)?.[1] ?? null;
}

export function readerCookie(token: string, maxAge: number, secure: boolean) {
  return `${READER_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

export function sessionTiming(now: Date, lastSeen: Date, expires: Date, policy: Pick<ReaderConfig, "idleLifetime">) {
  const idle = now.getTime() - lastSeen.getTime();
  const valid = now < expires && idle < policy.idleLifetime;
  return { valid, renew: valid && idle >= LIMITS.sessionRenewal };
}

export function otpRetryAfter(now: Date, emailSends: readonly Date[], ipSends: readonly Date[]) {
  const waitFor = (sends: readonly Date[], capacity: number, period: number) =>
    sends.length < capacity ? 0 : sends[capacity - 1]!.getTime() + period - now.getTime();
  return Math.ceil(Math.max(
    waitFor(emailSends, 1, LIMITS.otpCooldown),
    waitFor(emailSends, LIMITS.otpEmailPerHour, HOUR),
    waitFor(ipSends, LIMITS.otpIpPerHour, HOUR),
  ) / 1000);
}

export function sameOrigin(origin: string | undefined, host: string | undefined, protocol: string) {
  if (!origin || !host || !/^https?$/.test(protocol) || !/^[a-z\d.:[\]-]+$/i.test(host)) return false;
  try {
    const supplied = new URL(origin);
    return origin === supplied.origin && supplied.origin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

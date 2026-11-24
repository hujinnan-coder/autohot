import { z } from "zod";
import { READER_MAX_OFFSET } from "../types.ts";
import { LIMITS } from "./config.ts";
import { EVENT_KINDS, DWELL_BUCKETS } from "./rules.ts";

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => text(max).nullable().optional();
export const email = z.string().trim().toLowerCase().max(254).email();
export const emailInput = z.object({ email });
const code = z.string().regex(/^\d{6}$/);
const ticket = z.string().regex(/^[a-zA-Z0-9_-]{43}$/);
const verified = emailInput.extend({ ticket });
export const verifyInput = emailInput.extend({ code });
export const loginInput = z.union([verified, verifyInput]);
export const id = z.uuid();
export const idParams = z.object({ id });
const invite = z.string().max(80);
export const inviteQuery = z.object({ code: invite });

const requiredProfile = {
  name: text(100),
  company: text(160),
  job_title: text(100),
  wechat: text(100),
  referrer: optionalText(160),
};
const profile = z.object({
  ...requiredProfile,
  business_card_url: z.url({ protocol: /^https?$/, hostname: /./ }).max(2048).nullable().optional(),
});
export const profilePatch = profile.partial().extend({ tracking_consent: z.boolean().optional() }).strict();
export const registerInput = verified.extend(profile.shape).extend({
  code: invite,
  tracking_consent: z.boolean().default(false),
  terms_accepted: z.literal(true),
  privacy_accepted: z.literal(true),
  terms_version: text(50),
  privacy_version: text(50),
});
export type RegisterInput = z.infer<typeof registerInput>;
export type ProfilePatch = z.infer<typeof profilePatch>;

export const applyInput = verified.extend({ ...requiredProfile, reason: text(2000) });
export type ApplicationInput = z.infer<typeof applyInput>;
export const rejectInput = z.object({ reason: optionalText(500), notify: z.boolean().default(false) });
export const batchApproveInput = z.object({ ids: z.array(id).min(1).max(LIMITS.issueBatch) });

export const inviteInput = z.object({ bound_email: email.nullable().optional(), note: optionalText(500), batch_tag: optionalText(100) });
export const inviteBatchInput = inviteInput.omit({ bound_email: true }).extend({
  batch_tag: text(100),
  count: z.number().int().min(1).max(LIMITS.issueBatch),
});
export const childInviteInput = inviteInput.omit({ batch_tag: true }).extend({ replace_id: id.optional() });
export type InviteInput = z.infer<typeof inviteInput>;
export type ChildInviteInput = z.infer<typeof childInviteInput>;
export const pageInput = z.object({ offset: z.coerce.number().int().min(0).max(READER_MAX_OFFSET).default(0) });
export const readerListInput = pageInput.extend({
  status: z.enum(["active", "pending", "disabled"]).optional(),
  q: text(160).optional(),
});
export const applicationListInput = pageInput.extend({ status: z.enum(["pending", "approved", "rejected"]).optional() });
export const inviteListInput = pageInput.extend({ batch_tag: text(100).optional() });
const lookupIds = (max: number) => z.string().max(37 * max).transform(value => value.split(","))
  .pipe(z.array(id).max(max)).optional();
export const adminLookupsInput = z.object({
  reader_ids: lookupIds(2 * LIMITS.resultPage),
  application_ids: lookupIds(LIMITS.resultPage),
});

const event = z.object({
  kind: z.enum(EVENT_KINDS),
  target_id: text(160).optional(),
  topic_slug: text(100).optional(),
  brand_slug: text(100).optional(),
  query: text(160).optional(),
  dwell_bucket: z.enum(DWELL_BUCKETS).optional(),
}).strict().refine(e => (e.kind === "dwell") === (e.dwell_bucket !== undefined)
  && (e.kind === "search" || e.query === undefined));
export const eventsInput = z.object({ events: z.array(event).min(1).max(LIMITS.eventBatch) }).strict();
export type ReaderEvent = z.infer<typeof event>;

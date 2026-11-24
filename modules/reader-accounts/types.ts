// JSON returned by the reader admin API. Timestamps are ISO strings.
export const READER_PAGE_SIZE = 50;
export const READER_MAX_OFFSET = 1_000_000;
export const READER_INVITE_BATCH_LIMIT = 100;

export type ReaderStatus = "active" | "pending" | "disabled";
export type ApplicationStatus = "pending" | "approved" | "rejected";
type InviteIssuer = "admin" | "reader";

export interface ReaderContact {
  id: string;
  name: string;
  wechat: string;
}

export interface AdminReaderLookups {
  readers: ReaderContact[];
  reissuable_application_ids: string[];
}

interface ReaderIdentity {
  id: string;
  name: string;
  company: string;
  job_title: string;
  email: string | null;
  created_at: string;
}

interface ReaderAccount extends ReaderIdentity {
  status: ReaderStatus;
  last_active_at: string | null;
}

export interface ReaderRow extends ReaderAccount {
  active_days_7: number;
  active_days_30: number;
}

interface ReaderProfile extends ReaderAccount {
  wechat: string;
  business_card_url: string | null;
  referrer: string | null;
  email_verified_at: string | null;
  tracking_consent: boolean;
  activated_at: string | null;
}

export type ReaderActionKind = "view_item" | "view_story" | "view_topic" | "view_report" | "search" | "follow_change" | "report_open" | "dwell";
type ReadKind = Extract<ReaderActionKind, "view_item" | "view_story" | "view_topic" | "view_report" | "report_open">;
type DwellBucket = "under_10s" | "10_29s" | "30_59s" | "60_179s" | "180s_plus";

export interface ReaderAction {
  id: number;
  kind: ReaderActionKind;
  target_id: string | null;
  topic_slug: string | null;
  brand_slug: string | null;
  query: string | null;
  dwell_bucket: DwellBucket | null;
  created_at: string;
}

export interface ReaderDetail {
  reader: ReaderProfile;
  interests: {
    brands: Array<{ brand_slug: string; visits: number }>;
    topics: Array<{ topic_slug: string; visits: number }>;
    content: Array<{ kind: ReadKind; target_id: string; visits: number }>;
    recent: ReaderAction[];
  };
  invited_by: { issuer: InviteIssuer; id: string | null; name: string | null; used_at: string } | null;
  invited_readers: Array<Pick<ReaderRow, "id" | "name" | "company" | "status"> & { used_at: string }>;
}

export interface ReaderApplication extends ReaderIdentity {
  email: string;
  wechat: string;
  reason: string;
  referrer: string | null;
  status: ApplicationStatus;
  decision_reason: string | null;
  decided_at: string | null;
  approved_invite_id: string | null;
}

export interface ReaderApplicationDetail {
  application: ReaderApplication;
  coworkers: Array<Pick<ReaderRow, "id" | "name" | "company" | "job_title" | "status">>;
}

export interface IssuedInvite {
  id: string;
  code: string;
  expires_at: string;
  requires_approval: boolean;
}

export interface ApplicationInvitation extends IssuedInvite {
  application_id: string;
  invitation_url: string;
  invitation_text: string;
  email_sent: boolean;
}

export type ApplicationApproval = ApplicationInvitation | { application_id: string; error: string };

export interface ReaderApproval {
  id: string;
  status: ReaderStatus;
  child_invites: IssuedInvite[];
  email_sent: boolean;
}

export interface ReaderInvite {
  id: string;
  issuer: InviteIssuer;
  issuer_reader_id: string | null;
  child_slot: number | null;
  requires_approval: boolean;
  bound_email: string | null;
  batch_tag: string | null;
  note: string | null;
  created_at: string;
  expires_at: string;
  used_by: string | null;
  used_at: string | null;
  revoked_at: string | null;
}

export interface ReaderInviteBatch {
  batch_tag: string;
  total: number;
  used: number;
  revoked: number;
}

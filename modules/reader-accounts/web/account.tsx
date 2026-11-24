import { useState, type FormEvent, type ReactNode } from "react";
import { data, redirectDocument, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { READER_PAGE_HEADERS } from "@aihot/contracts/reader";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import { ApiError, apiGet } from "@aihot/web/lib/api.server";
import { fullDateTime } from "@aihot/web/lib/format";
import { hasReaderCookie, readerLoginUrl } from "@aihot/web/lib/reader-wall";
import { READER_MAX_OFFSET, READER_PAGE_SIZE, type ReaderAction, type ReaderDetail, type ReaderInvite } from "../types.ts";
import { errorCode, Field, noteReaderSession, Notice, PENDING, ProfileFields, profileFrom, readerError, readerMeta, readerRequest, useReaderAction } from "./components.tsx";

export { headers } from "./components.tsx";
export const handle: Screen = { tab: "me", name: "账户" };
export const meta = () => readerMeta("账户");

type Profile = ReaderDetail["reader"];
type Invites = { quota: number; invites: ReaderInvite[] };
interface Records {
  offset: number;
  events: ReaderAction[];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const cookie = request.headers.get("cookie") ?? "";
  const options = { headers: { cookie }, signal: request.signal };
  const profile = await apiGet<Profile>("/api/reader/me", options).catch(error => {
    if (error instanceof ApiError && error.status === 401) {
      throw redirectDocument(readerLoginUrl("/account", hasReaderCookie(cookie)), { headers: READER_PAGE_HEADERS });
    }
    throw data({ message: "unavailable" }, { status: 503, headers: READER_PAGE_HEADERS });
  });
  const invitations = await apiGet<Invites>("/api/reader/me/invites", options).catch(error => {
    if (error instanceof ApiError && error.status === 401) {
      throw redirectDocument(readerLoginUrl("/account", true), { headers: READER_PAGE_HEADERS });
    }
    return null;
  });
  const invites = invitations?.quota && Array.isArray(invitations.invites)
    ? { quota: invitations.quota, invites: invitations.invites.map(({ id, expires_at, used_at, revoked_at }) => ({ id, expires_at, used_at, revoked_at })) }
    : null;
  return { profile, invites };
}

const eventLabels: Record<ReaderAction["kind"], string> = {
  view_item: "阅读条目", view_story: "浏览事件", view_topic: "浏览主题", view_report: "浏览报告",
  search: "搜索", follow_change: "更改关注", report_open: "打开报告", dwell: "停留",
};

function AccountCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="card space-y-4 p-5 lg:p-6">
      <h2 className="text-[16px] font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

export default function AccountPage() {
  const { profile, invites } = useLoaderData<typeof loader>();
  return <Account key={`${profile.id}:${profile.status}`} initial={profile} invites={invites} />;
}

function Account({ initial, invites }: { initial: Profile; invites: Awaited<ReturnType<typeof loader>>["invites"] }) {
  const [profile, setProfile] = useState(initial);
  const [records, setRecords] = useState<Records | null>(null);
  const [confirmation, setConfirmation] = useState<"clear" | "delete" | null>(null);
  const [status, setStatus] = useState("");
  const { busy, message, run } = useReaderAction();
  const pending = profile.status === "pending";

  function act(action: () => Promise<void>) {
    setStatus("");
    return run(action, error => {
      if (errorCode(error) === "login_required") {
        window.location.replace("/login?return=%2Faccount&expired=1");
        return "";
      }
      return readerError(error);
    });
  }
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const patch = profileFrom(new FormData(event.currentTarget));
    void act(async () => {
      setProfile(await readerRequest<Profile>("/me", "PATCH", patch));
      setStatus("资料已保存。");
    });
  }
  function toggleTracking() {
    void act(async () => {
      setProfile(await readerRequest<Profile>("/me", "PATCH", { tracking_consent: !profile.tracking_consent }));
      setStatus("浏览记录设置已保存。");
    });
  }
  function loadRecords(offset: number) {
    void act(async () => {
      const { events } = await readerRequest<{ events: ReaderAction[] }>(`/me/events?offset=${offset}`);
      setRecords({ events, offset });
    });
  }
  function confirm() {
    if (confirmation === "clear") {
      void act(async () => {
        await readerRequest("/me/events", "DELETE");
        setRecords({ offset: 0, events: [] });
        setConfirmation(null);
        setStatus("浏览记录已清空。");
      });
    } else if (confirmation === "delete") {
      void act(async () => {
        await readerRequest("/me", "DELETE");
        noteReaderSession(false);
        window.location.replace("/join");
      });
    }
  }

  return (
    <div className={`mx-auto max-w-[var(--page-max-reading)] pb-10 ${pending ? "px-[var(--gutter-l)] pt-5" : ""}`}>
      <PhoneBar title="账户" back={pending ? { to: "/account/pending", label: "等待确认" } : { to: "/more", label: "我的" }} />
      <header className="pb-5 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold text-ink">账户</h1>
        {pending && <p className="mt-2 text-[14px] text-ink-3">{PENDING}</p>}
      </header>
      <div className="space-y-4">
        <AccountCard title="资料">
          <form method="post" onSubmit={save} className="space-y-4">
            <Field label="邮箱" type="email" value={profile.email ?? ""} readOnly />
            <ProfileFields profile={profile} />
            <button type="submit" disabled={busy} className={buttonClass("primary")}>保存资料</button>
          </form>
        </AccountCard>
        <AccountCard title="隐私">
          <label className="flex items-center gap-2 text-[14px] text-ink-2">
            <input type="checkbox" checked={profile.tracking_consent} disabled={busy} onChange={toggleTracking} className="accent-accent" />
            浏览记录
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => records ? setRecords(null) : loadRecords(0)}>
              {records ? "收起记录" : "查看我的记录"}
            </button>
            <a className={buttonClass()} href="/api/reader/me/export">导出</a>
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => setConfirmation("clear")}>清空</button>
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => setConfirmation("delete")}>注销账号</button>
          </div>
          {confirmation && (
            <div className="space-y-3 rounded-control border border-line p-4">
              <p className="text-[14px] text-ink-2">{confirmation === "delete" ? "将删除全部资料和浏览记录" : "确认清空浏览记录？"}</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" disabled={busy} className={buttonClass()} onClick={() => setConfirmation(null)}>取消</button>
                <button type="button" disabled={busy} className={buttonClass("primary")} onClick={confirm}>{confirmation === "delete" ? "确认注销" : "确认清空"}</button>
              </div>
            </div>
          )}
          {records && (
            <div className="space-y-3 border-t border-line pt-3">
              {records.events.length === 0 ? <p className="text-[13px] text-ink-3">没有浏览记录。</p> : (
                <ul className="divide-y divide-line-soft">
                  {records.events.map(event => (
                    <li key={event.id} className="space-y-1 py-2 text-[13px] text-ink-2">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                        <span>{eventLabels[event.kind]}</span>
                        <time className="text-ink-3" dateTime={event.created_at}>{fullDateTime(event.created_at)}</time>
                      </div>
                      <p className="break-words text-ink-3">{event.query || event.target_id || event.topic_slug || event.brand_slug}</p>
                    </li>
                  ))}
                </ul>
              )}
              {(records.offset > 0 || records.events.length === READER_PAGE_SIZE) && (
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={busy || records.offset === 0} className={buttonClass()} onClick={() => loadRecords(records.offset - READER_PAGE_SIZE)}>上一页</button>
                  <button type="button" disabled={busy || records.events.length < READER_PAGE_SIZE || records.offset >= READER_MAX_OFFSET}
                    className={buttonClass()} onClick={() => loadRecords(records.offset + READER_PAGE_SIZE)}>下一页</button>
                </div>
              )}
            </div>
          )}
        </AccountCard>
        <AccountCard title="早晚报"><p className="text-[14px] text-ink-3">即将开放</p></AccountCard>
        {invites && (
          <AccountCard title="子邀请码">
            <p className="text-[14px] text-ink-3">额度 {invites.quota}</p>
            {invites.invites.length > 0 && (
              <ul className="divide-y divide-line-soft">
                {invites.invites.map(invite => (
                  <li key={invite.id} className="flex flex-wrap justify-between gap-x-3 py-2 text-[13px] text-ink-2">
                    <span>{invite.used_at ? "已使用" : invite.revoked_at ? "已撤销" : "有效期"}</span>
                    <time dateTime={invite.expires_at}>{fullDateTime(invite.expires_at)}</time>
                  </li>
                ))}
              </ul>
            )}
          </AccountCard>
        )}
        <Notice>{message}</Notice>
        {status && <p role="status" className="text-[13px] text-ink-2">{status}</p>}
        <button type="button" className={buttonClass()} disabled={busy} onClick={() => void act(async () => {
          await readerRequest("/logout", "POST");
          noteReaderSession(false);
          window.location.replace("/join");
        })}>退出登录</button>
      </div>
    </div>
  );
}

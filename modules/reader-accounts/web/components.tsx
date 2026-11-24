import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { Link } from "react-router";
import { READER_PAGE_HEADERS, type ReaderPreview } from "@aihot/contracts/reader";
import { SITE } from "@aihot/site";
import { Wordmark } from "@aihot/site/brand/Logo.tsx";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import { fullDateTime } from "@aihot/web/lib/format";
import { readRaw, writeRaw } from "@aihot/web/lib/local-state";

export const headers = () => READER_PAGE_HEADERS;
export const readerMeta = (title: string) => [{ title: `${title} · ${SITE.name}` }, { name: "robots", content: "noindex, nofollow" }];
export const EXPIRED = "你有一阵没来了，为了账号安全，请重新登录。";
export const PENDING = "名片已收下，等待确认";
export const inputClass = "mt-2 min-h-11 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-[16px] text-ink outline-none focus:border-accent lg:text-[14px]";
export const textLink = "font-medium text-accent-ink underline underline-offset-4 dark:text-accent";
export const withReturn = (path: string, returnTo: string) => `${path}?${new URLSearchParams({ return: returnTo })}`;

// The browser can discard an expired cookie before the server sees it. The tab only keeps
// enough information to show the relogin message, and never uses it to grant access.
const SESSION_SEEN = "reader-accounts:session-seen";
export const readerSessionSeen = () => readRaw(SESSION_SEEN, "session") === "1";
export const noteReaderSession = (signedIn: boolean) => writeRaw(SESSION_SEEN, signedIn ? "1" : null, "session");

export function ReaderPage({ title, lead, children, footer }: { title: string; lead?: string; children?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="mx-auto w-full max-w-lg px-[var(--gutter-l)] pb-16 pt-12 lg:pt-20">
      <Link to="/join" aria-label={SITE.name} className="inline-flex text-ink"><Wordmark size={26} /></Link>
      <header className="mb-6 mt-8">
        <h1 data-page-title="" className="text-[26px] font-semibold leading-tight text-ink">{title}</h1>
        {lead && <p className="mt-3 text-[14px] leading-relaxed text-ink-3">{lead}</p>}
      </header>
      {children}
      {footer && <div className="mt-6 text-[13px] leading-relaxed text-ink-3">{footer}</div>}
    </div>
  );
}

export function Field({ label, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block text-[13px] font-medium text-ink-2">
      {label}
      {hint && <span className="ml-2 font-normal text-ink-3">{hint}</span>}
      <input {...input} className={inputClass} />
    </label>
  );
}

type CardProfile = { name: string; company: string; job_title: string; wechat: string; business_card_url: string | null };

export function ProfileFields({ profile, application = false }: { profile?: CardProfile; application?: boolean }) {
  return (
    <>
      <Field label="姓名" name="name" autoComplete="name" maxLength={100} defaultValue={profile?.name} required />
      <Field label="公司/机构" name="company" autoComplete="organization" maxLength={160} defaultValue={profile?.company} required />
      <Field label="职位" name="job_title" autoComplete="organization-title" maxLength={100} defaultValue={profile?.job_title} required />
      <Field label="微信号" hint={application ? "用于和你联系，不对外展示" : undefined} name="wechat" maxLength={100} defaultValue={profile?.wechat} required />
      {!application && <Field label="名片照片链接" hint="选填" name="business_card_url" type="url" maxLength={2048} defaultValue={profile?.business_card_url ?? ""} />}
    </>
  );
}

export function ReferrerField() {
  return <Field label="介绍人" hint="选填，有人推荐你吗？写下 TA 的名字" name="referrer" maxLength={160} />;
}

export function profileFrom(form: FormData, application = false) {
  const read = (field: string) => String(form.get(field) ?? "").trim();
  return {
    name: read("name"), company: read("company"), job_title: read("job_title"), wechat: read("wechat"),
    ...(form.has("referrer") ? { referrer: read("referrer") || null } : {}),
    ...(!application ? { business_card_url: read("business_card_url") || null } : {}),
  };
}

export class ReaderRequestError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export async function readerRequest<T = void>(path: string, method = "GET", body?: object): Promise<T> {
  const response = await fetch(`/api/reader${path}`, {
    method,
    cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => null) as { code?: string; detail?: string } | null;
    throw new ReaderRequestError(problem?.code ?? "", response.status < 500 ? problem?.detail ?? "暂时无法完成，请重试。" : "暂时无法完成，请重试。");
  }
  return response.status === 204 ? undefined as T : response.json() as Promise<T>;
}

export const readerError = (error: unknown) => error instanceof ReaderRequestError ? error.message : "暂时无法完成，请重试。";
export const errorCode = (error: unknown) => error instanceof ReaderRequestError ? error.code : null;

export function Notice({ children }: { children: ReactNode }) {
  return children ? <p role="alert" className="text-[13px] leading-relaxed text-hot">{children}</p> : null;
}

export function useReaderAction() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<void>, onError: (error: unknown) => string = readerError) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(onError(error));
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, run };
}

export function EmailStep({ complete, bound = false, application = false, button = "验证邮箱", initialEmail = "", errorMessage = readerError }: {
  complete: (email: string, code: string) => Promise<void>;
  bound?: boolean;
  application?: boolean;
  button?: string;
  initialEmail?: string;
  errorMessage?: (error: unknown) => string;
}) {
  const [email, setEmail] = useState(initialEmail);
  const [challenge, setChallenge] = useState(0);
  const sent = challenge > 0;
  const { busy, message, run } = useReaderAction();
  function send() {
    return run(async () => {
      await readerRequest("/otp/send", "POST", { email });
      setChallenge(value => value + 1);
    });
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = new FormData(event.currentTarget).get("code");
    if (!sent) void send();
    else void run(() => complete(email, String(code)), errorMessage);
  }

  return (
    <form method="post" onSubmit={submit} className="card space-y-4 p-5 lg:p-6">
      <Field label="邮箱" hint={application ? "用来收验证码和回信" : undefined}
        name="email" type="email" autoComplete="email" autoCapitalize="none" maxLength={254}
        required value={email} onChange={event => setEmail(event.target.value)} readOnly={sent} />
      {bound && <p className="text-[13px] text-ink-3">此邀请码绑定了邮箱</p>}
      {sent && <Field key={challenge} label="验证码" name="code" type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />}
      <Notice>{message}</Notice>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass("primary", "lg")} disabled={busy}>{sent ? button : "发送验证码"}</button>
        {sent && (
          <>
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => void send()}>重新发送</button>
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => setChallenge(0)}>更换邮箱</button>
          </>
        )}
      </div>
    </form>
  );
}

export function SampleCard({ title, summary }: Pick<ReaderPreview, "title" | "summary">) {
  return (
    <article className="card p-5 lg:p-6">
      <h2 className="text-[16px] font-semibold leading-relaxed text-ink">{title}</h2>
      {summary && <p className="mt-2 text-[14px] leading-relaxed text-ink-3">{summary}</p>}
    </article>
  );
}

export function SharedPreview({ preview, returnTo }: { preview: ReaderPreview; returnTo: string }) {
  return (
    <ReaderPage title={preview.title}>
      <article className="card p-5 lg:p-6">
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-ink-3">
          <span>{preview.source}</span>
          <time dateTime={preview.published_at}>{fullDateTime(preview.published_at)}</time>
        </div>
        {preview.summary && <p className="mt-3 text-[15px] leading-relaxed text-ink-2">{preview.summary}</p>}
      </article>
      <p className="mt-6 text-[14px] leading-relaxed text-ink-3">这一条只给你看了标题和摘要，往下的部分，留给受邀的人。</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Link to={withReturn("/register", returnTo)} className={buttonClass("primary", "lg")}>凭邀请码入座</Link>
        <Link to={withReturn("/apply", returnTo)} className={buttonClass("secondary", "lg")}>申请入座</Link>
      </div>
    </ReaderPage>
  );
}

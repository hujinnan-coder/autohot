import { useState, type FormEvent } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import type { Screen } from "@aihot/web/components/shell/screens";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import { apiGet } from "@aihot/web/lib/api.server";
import { readerReturn } from "@aihot/web/lib/reader-wall";
import { EmailStep, errorCode, Field, noteReaderSession, Notice, ProfileFields, profileFrom, readerError, readerMeta, ReaderPage, readerRequest, ReferrerField, textLink, useReaderAction, withReturn } from "./components.tsx";

export { headers } from "./components.tsx";
export const handle: Screen = { name: "凭邀请码入座", standalone: true };
export const meta = () => readerMeta("凭邀请码入座");

interface ConsentVersions {
  terms_version: string;
  privacy_version: string;
}

const invalidInvite = "这枚邀请码已经失效，它只有三天有效期。向发码的人再要一枚，或者留一张名片。";

export async function loader({ request }: LoaderFunctionArgs) {
  const query = new URL(request.url).searchParams;
  const { terms_version, privacy_version } = await apiGet<ConsentVersions>("/api/reader/session", {
    headers: { cookie: request.headers.get("cookie") ?? "" }, signal: request.signal,
  });
  return {
    code: (query.get("code") ?? "").slice(0, 80),
    returnTo: readerReturn(query.get("return")),
    versions: { terms_version, privacy_version },
  };
}

export default function RegisterPage() {
  const { code, returnTo, versions } = useLoaderData<typeof loader>();
  return <Registration key={code} code={code} returnTo={returnTo} initialVersions={versions} />;
}

function Registration({ code, returnTo, initialVersions }: { code: string; returnTo: string; initialVersions: ConsentVersions }) {
  const [inviteCode, setInviteCode] = useState(code);
  const [invite, setInvite] = useState<{ valid: boolean; bound_email: boolean } | null>(null);
  const [verified, setVerified] = useState<{ email: string; ticket: string } | null>(null);
  const [email, setEmail] = useState("");
  const [versions, setVersions] = useState(initialVersions);
  const { busy, message, run } = useReaderAction();
  function check(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = inviteCode.trim();
    void run(async () => {
      const result = await readerRequest<{ valid: boolean; bound_email: boolean }>(`/invite/check?${new URLSearchParams({ code })}`);
      setInvite(result);
      if (result.valid) setInviteCode(code);
    });
  }
  function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      try {
        const { status } = await readerRequest<{ status: "active" | "pending" }>("/register", "POST", {
          code: inviteCode, ...verified, ...profileFrom(form), ...versions,
          terms_accepted: form.has("terms"), privacy_accepted: form.has("privacy"), tracking_consent: form.has("tracking"),
        });
        noteReaderSession(true);
        window.location.replace(status === "pending" ? "/account/pending" : returnTo);
      } catch (error) {
        if (errorCode(error) === "consent_version_changed") setVersions(await readerRequest<ConsentVersions>("/session"));
        throw error;
      }
    }, error => errorCode(error) === "invalid_invite" ? invalidInvite : readerError(error));
  }

  const footer = invite?.valid ? <button type="button" disabled={busy} className={textLink} onClick={() => { setInvite(null); setVerified(null); }}>更换邀请码</button> : undefined;
  return (
    <ReaderPage title={verified ? "落座之前，留一张名片" : "凭邀请码入座"}
      lead={verified ? "公司、职位和微信号不对外展示，是为了知道坐在对面的是谁，以后好联系。" : undefined} footer={footer}>
      {verified ? (
        <form method="post" onSubmit={register} className="card space-y-4 p-5 lg:p-6">
          <ProfileFields />
          <ReferrerField />
          <fieldset key={`${versions.terms_version}/${versions.privacy_version}`} className="space-y-3 border-t border-line pt-4 text-[13px] leading-relaxed text-ink-2">
            <label className="flex items-start gap-2"><input type="checkbox" name="terms" required className="mt-1 accent-accent" />
              <span>我已阅读并同意<Link to="/terms" target="_blank" rel="noopener noreferrer" className={textLink}>《服务条款》</Link></span>
            </label>
            <label className="flex items-start gap-2"><input type="checkbox" name="privacy" required className="mt-1 accent-accent" />
              <span>我已阅读并同意<Link to="/privacy" target="_blank" rel="noopener noreferrer" className={textLink}>《隐私说明》</Link></span>
            </label>
            <label className="flex items-start gap-2"><input type="checkbox" name="tracking" className="mt-1 accent-accent" />
              <span>允许记录我的浏览行为，用来定制早晚报，也让我们知道大家关心什么（随时可以在「我的」里关闭、导出或清空；不勾选也能正常使用）</span>
            </label>
          </fieldset>
          <Notice>{message}</Notice>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass("primary", "lg")} disabled={busy}>入座</button>
            <button type="button" className={buttonClass()} disabled={busy} onClick={() => setVerified(null)}>重新验证邮箱</button>
          </div>
        </form>
      ) : invite?.valid ? <EmailStep bound={invite.bound_email} initialEmail={email} complete={async (address, verificationCode) => {
        const { ticket } = await readerRequest<{ ticket: string }>("/otp/verify", "POST", { email: address, code: verificationCode });
        setEmail(address);
        setVerified({ email: address, ticket });
      }} /> : (
        <form method="post" onSubmit={check} className="card space-y-4 p-5 lg:p-6">
          <Field label="邀请码" name="code" value={inviteCode} onChange={event => { setInviteCode(event.target.value); setInvite(null); }}
            placeholder="把邀请码贴在这里，连字符有没有都行" autoComplete="off" autoCapitalize="characters" maxLength={80} required />
          <Notice>{message || (invite && !invite.valid && invalidInvite)}</Notice>
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={buttonClass("primary", "lg")} disabled={busy}>继续</button>
            {invite && !invite.valid && <Link to={withReturn("/apply", returnTo)} className={buttonClass()}>申请入座</Link>}
          </div>
        </form>
      )}
    </ReaderPage>
  );
}

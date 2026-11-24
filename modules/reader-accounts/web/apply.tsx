import { useState, type FormEvent } from "react";
import type { Screen } from "@aihot/web/components/shell/screens";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import { EmailStep, errorCode, inputClass, Notice, ProfileFields, profileFrom, readerError, readerMeta, ReaderPage, readerRequest, ReferrerField, useReaderAction } from "./components.tsx";

export { headers } from "./components.tsx";
export const handle: Screen = { name: "留一张名片", standalone: true };
export const meta = () => readerMeta("留一张名片");

// 开通邮件通道后改为 true。
const MAIL_LIVE = false;
const successCopy = MAIL_LIVE
  ? "名片收下了。我们看过之后回你，通常一到三个工作日，回信会到你留的邮箱，别忘了看看垃圾箱。想起什么想说的，直接回信就好。"
  : "名片收下了。我们看过之后回你，通常一到三个工作日，邮箱或微信都可能联系到你。";
const duplicateCopy = "这个邮箱的名片已经在案头了，不必再递一张。";

export default function ApplyPage() {
  const [verified, setVerified] = useState<{ email: string; ticket: string } | null>(null);
  const [done, setDone] = useState(false);
  const [email, setEmail] = useState("");
  const { busy, message, run } = useReaderAction();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run(async () => {
      await readerRequest("/applications", "POST", { ...verified, ...profileFrom(form, true), reason: String(form.get("reason")).trim() });
      setDone(true);
    }, error => errorCode(error) === "application_pending" ? duplicateCopy : readerError(error));
  }
  if (done) return <ReaderPage title="留一张名片"><p role="status" className="card p-5 text-[15px] leading-relaxed text-ink-2">{successCopy}</p></ReaderPage>;
  return (
    <ReaderPage title="留一张名片" lead="不必写得正式。说说你在汽车这一行做哪一块、平常盯什么，我们好知道这两份报该往哪里写得更合你用。">
      {verified ? (
        <form method="post" onSubmit={submit} className="card space-y-4 p-5 lg:p-6">
          <ProfileFields application />
          <label className="block text-[13px] font-medium text-ink-2">
            申请理由
            <textarea name="reason" rows={4} required maxLength={2000} className={inputClass} placeholder="比如：在主机厂做产品规划，常盯智能座舱和出海节奏。" />
          </label>
          <ReferrerField />
          <Notice>{message}</Notice>
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy} className={buttonClass("primary", "lg")}>提交名片</button>
            <button type="button" disabled={busy} className={buttonClass()} onClick={() => setVerified(null)}>重新验证邮箱</button>
          </div>
        </form>
      ) : <EmailStep application initialEmail={email} complete={async (address, code) => {
        const { ticket } = await readerRequest<{ ticket: string }>("/otp/verify", "POST", { email: address, code });
        setEmail(address);
        setVerified({ email: address, ticket });
      }} />}
    </ReaderPage>
  );
}

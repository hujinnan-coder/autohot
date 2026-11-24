import { useEffect, useState } from "react";
import { Link, redirectDocument, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { READER_PAGE_HEADERS } from "@aihot/contracts/reader";
import type { Screen } from "@aihot/web/components/shell/screens";
import { checkedReaderPage } from "@aihot/web/lib/reader-wall.server";
import { readerReturn } from "@aihot/web/lib/reader-wall";
import { EmailStep, errorCode, EXPIRED, noteReaderSession, readerError, readerMeta, ReaderPage, readerRequest, readerSessionSeen, textLink, withReturn } from "./components.tsx";

export { headers } from "./components.tsx";
export const handle: Screen = { name: "登录", standalone: true };
export const meta = () => readerMeta("欢迎回来");

export function loader({ request, context }: LoaderFunctionArgs) {
  const query = new URL(request.url).searchParams;
  const returnTo = readerReturn(query.get("return"));
  if (checkedReaderPage(context)?.status === "active") throw redirectDocument(returnTo, { headers: READER_PAGE_HEADERS });
  return { returnTo, returning: query.has("return"), expired: query.get("expired") === "1" };
}

export default function LoginPage() {
  const { returnTo, returning, expired } = useLoaderData<typeof loader>();
  const [seen, setSeen] = useState(false);
  useEffect(() => setSeen(returning && readerSessionSeen()), [returning]);
  return (
    <ReaderPage title="欢迎回来" lead="输入注册时的邮箱，我们发一个 6 位验证码给你。"
      footer={<>还没有邀请码？<Link to={withReturn("/apply", returnTo)} className={textLink}>申请入座</Link></>}>
      {(expired || seen) && <p className="mb-4 text-[14px] leading-relaxed text-ink-2" role="status">{EXPIRED}</p>}
      <EmailStep button="登录" complete={async (email, code) => {
        const { status } = await readerRequest<{ status: "active" | "pending" }>("/login", "POST", { email, code });
        noteReaderSession(true);
        window.location.replace(status === "pending" ? "/account/pending" : returnTo);
      }} errorMessage={error => errorCode(error) === "reader_not_registered"
        ? "这个邮箱还没有座位。有邀请码就去入座，没有的话留一张名片。" : readerError(error)} />
    </ReaderPage>
  );
}

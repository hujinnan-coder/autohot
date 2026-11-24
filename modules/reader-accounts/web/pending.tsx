import { Link, redirectDocument, type LoaderFunctionArgs } from "react-router";
import { READER_PAGE_HEADERS } from "@aihot/contracts/reader";
import type { Screen } from "@aihot/web/components/shell/screens";
import { buttonClass } from "@aihot/web/components/ui/Controls";
import { checkedReaderPage } from "@aihot/web/lib/reader-wall.server";
import { PENDING, readerMeta, ReaderPage } from "./components.tsx";

export { headers } from "./components.tsx";
export const handle: Screen = { tab: "me", name: "等待确认", standalone: true };
export const meta = () => readerMeta("等待确认");

export function loader({ context }: LoaderFunctionArgs) {
  if (checkedReaderPage(context)?.status === "active") throw redirectDocument("/", { headers: READER_PAGE_HEADERS });
  return null;
}

export default function PendingPage() {
  return <ReaderPage title={PENDING}><Link to="/account" className={buttonClass()}>账户</Link></ReaderPage>;
}

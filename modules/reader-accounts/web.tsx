import { useEffect } from "react";
import { Link, useRouteLoaderData } from "react-router";
import { IconChevronRight, IconUser } from "@aihot/web/components/icons";
import { defineWebModule, type AccountPlace } from "@aihot/web/modules";
import type { loader as rootLoader } from "@aihot/web/root";
import { noteReaderSession, SharedPreview } from "./web/components.tsx";

function AccountLink({ place }: { place: AccountPlace }) {
  const root = useRouteLoaderData<typeof rootLoader>("root");
  const signedIn = root?.reader?.signedIn;
  useEffect(() => {
    if (signedIn) noteReaderSession(true);
  }, [signedIn]);
  if (!signedIn) return null;
  if (place === "sidebar") {
    return (
      <Link to="/account" className="flex h-10 items-center gap-2.5 rounded-control px-2.5 text-[14px] font-medium text-ink-3 hover:bg-bg-sunk hover:text-ink">
        <IconUser size={17} />账户
      </Link>
    );
  }
  if (place !== "me") return null;
  return (
    <li>
      <Link to="/account" className="flex min-h-[52px] items-center gap-3 px-4 text-[16px] font-medium text-ink active:bg-bg-sunk lg:hover:bg-bg-sunk">
        <IconUser size={20} className="text-ink-3" />
        <span className="flex-1">账户</span>
        <IconChevronRight size={16} className="text-ink-4" />
      </Link>
    </li>
  );
}

export default defineWebModule({
  name: "reader-accounts",
  account: AccountLink,
  accountPlaces: ["sidebar", "me"],
  readerPreview: SharedPreview,
});

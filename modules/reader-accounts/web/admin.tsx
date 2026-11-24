import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useRevalidator } from "react-router";
import { SITE } from "@aihot/site";
import { bj } from "@aihot/web/features/admin/format";
import { toast, Toaster } from "@aihot/web/features/admin/toast";
import { AdminPage, Badge, Button, Card } from "@aihot/web/features/admin/ui";
import { copyText } from "@aihot/web/lib/clipboard";
import type { IssuedInvite, ReaderStatus } from "../types.ts";

export const detailLinkClass = "font-medium text-accent hover:underline";

export function ReaderAdminPage(props: React.ComponentProps<typeof AdminPage>) {
  return <><AdminPage {...props} /><Toaster /></>;
}

export function adminMeta(title: string) {
  return [{ title: `${title} · ${SITE.name} 后台` }, { name: "robots", content: "noindex, nofollow" }];
}

export function detailLink(params: URLSearchParams, id: string | null) {
  const next = new URLSearchParams(params);
  if (id) next.set("detail", id);
  else next.delete("detail");
  return { search: `?${next}`, hash: id ? "#reader-admin-detail" : "" };
}

export function readerLink(id: string) {
  return { pathname: "/admin/readers", ...detailLink(new URLSearchParams(), id) };
}

export function DetailCard({ title, params, children }: { title: string; params: URLSearchParams; children: ReactNode }) {
  return (
    <div id="reader-admin-detail" className="mb-4 scroll-mt-32">
      <Card title={title} right={<Link to={detailLink(params, null)} preventScrollReset className={detailLinkClass}>关闭详情</Link>}>
        {children}
      </Card>
    </div>
  );
}

export const readerStatuses = [
  { value: "active", label: "已激活", tone: "ok" },
  { value: "pending", label: "待审", tone: "warn" },
  { value: "disabled", label: "已停用", tone: "bad" },
] as const;

export function ReaderStatusBadge({ status }: { status: ReaderStatus }) {
  const item = readerStatuses.find(item => item.value === status);
  return <Badge tone={item?.tone}>{item?.label ?? status}</Badge>;
}

export function CopyButton({ value, children, label }: { value: string; children: ReactNode; label?: string }) {
  async function copy() {
    try {
      await copyText(value);
      toast("已复制", "ok");
    } catch {
      toast("复制失败，请手动复制", "error");
    }
  }
  return <Button size="sm" tone="ghost" aria-label={label} onClick={copy}>{children}</Button>;
}

export function CopyValue({ value, label }: { value: string | null | undefined; label: string }) {
  if (!value) return <span className="text-ink-4">—</span>;
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-x-1">
      <span className="min-w-0 break-all font-medium text-ink">{value}</span>
      <CopyButton value={value} label={`复制${label} ${value}`}>复制</CopyButton>
    </span>
  );
}

export function useReaderAdminAction(csrf: string) {
  const revalidator = useRevalidator();
  const [pending, setPending] = useState<string | null>(null);
  const running = useRef(false);

  async function run<T = unknown>(path: string, options: { body?: unknown; success?: string; onSuccess?: (result: T) => void } = {}) {
    if (running.current || revalidator.state === "loading") return false;
    running.current = true;
    setPending(path);
    const { body, success, onSuccess } = options;
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { "x-csrf-token": csrf, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (response.status === 401) {
        window.location.href = `/api/auth/login?${new URLSearchParams({ return: window.location.pathname + window.location.search })}`;
        return false;
      }
      if (!response.ok) {
        const problem = await response.json().catch(() => null) as { detail?: string } | null;
        toast(problem?.detail ?? `请求失败（${response.status}）`, "error");
        return false;
      }
      if (onSuccess) onSuccess(await response.json() as T);
      if (success) toast(success, "ok");
      void revalidator.revalidate();
      return true;
    } catch {
      toast("网络错误，请稍后再试", "error");
      return false;
    } finally {
      running.current = false;
      setPending(null);
    }
  }

  return { run, pending, busy: pending !== null || revalidator.state === "loading" };
}

export function useActionResults<T>() {
  const sequence = useRef(0);
  const [results, setResults] = useState<Array<{ id: number; value: T }>>([]);
  function show(value: T, updatePrevious?: (value: T) => T | null) {
    const id = ++sequence.current;
    setResults(current => {
      const previous = updatePrevious ? current.flatMap(result => {
        const next = updatePrevious(result.value);
        return next === null ? [] : [{ ...result, value: next }];
      }) : current;
      return [{ id, value }, ...previous];
    });
  }
  function dismiss(id: number) {
    setResults(current => current.filter(result => result.id !== id));
  }
  return { results, show, dismiss };
}

export function ResultCard({ title, dismiss, children }: { title: string; dismiss: () => void; children: ReactNode }) {
  const region = useRef<HTMLDivElement>(null);
  useEffect(() => { region.current?.focus(); }, []);
  return (
    <div ref={region} tabIndex={-1} role="region" aria-label={title} className="mb-4 scroll-mt-32">
      <Card title={title} right={<Button size="sm" tone="ghost" onClick={dismiss}>关闭结果</Button>}>
        {children}
      </Card>
    </div>
  );
}

export const copyNow = "明文邀请码仅在本次操作结果中显示，请先复制再关闭。";

export function InviteCodes({ invites }: { invites: IssuedInvite[] }) {
  return (
    <>
      <CopyButton value={invites.map(invite => invite.code).join("\n")}>全部复制</CopyButton>
      <ul className="mt-2 max-h-64 space-y-1 overflow-auto">
        {invites.map(invite => (
          <li key={invite.id} className="flex flex-wrap items-center gap-x-3 text-[13px]">
            <code className="font-semibold text-ink">{invite.code}</code>
            <span className="text-ink-3">{bj(invite.expires_at, true)} 到期</span>
          </li>
        ))}
      </ul>
    </>
  );
}

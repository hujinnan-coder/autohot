import type { FormEvent } from "react";
import { Form, Link } from "react-router";
import type { AdminMe } from "@aihot/contracts/admin";
import { bj } from "@aihot/web/features/admin/format";
import { Badge, Button, Card, DataTable, Field, Input, Pager, Textarea } from "@aihot/web/features/admin/ui";
import { adminPageGet, GRAY_HEADERS } from "@aihot/web/lib/admin.server";
import { READER_INVITE_BATCH_LIMIT, type IssuedInvite, type ReaderInvite, type ReaderInviteBatch } from "../types.ts";
import { adminMeta, copyNow, detailLinkClass, InviteCodes, ReaderAdminPage, readerLink, ResultCard, useActionResults, useReaderAdminAction } from "./admin.tsx";
import { listPage, loadLookups, mayHaveMore } from "./admin.server.ts";

const API = "/api/admin/reader-invites";
const statuses = {
  unused: { label: "未使用", tone: "ok" },
  used: { label: "已使用", tone: "info" },
  expired: { label: "已过期", tone: "warn" },
  revoked: { label: "已撤销", tone: "muted" },
} as const;

function inviteStatus(invite: ReaderInvite, now: number): keyof typeof statuses {
  if (invite.used_at) return "used";
  if (invite.revoked_at) return "revoked";
  return new Date(invite.expires_at).getTime() <= now ? "expired" : "unused";
}

export const headers = () => ({ ...GRAY_HEADERS, "X-Robots-Tag": "noindex, nofollow" });
export const meta = () => adminMeta("邀请码");

interface LoaderData {
  csrf: string;
  invites: Array<ReaderInvite & { status: keyof typeof statuses }>;
  batches: ReaderInviteBatch[];
  names: Record<string, string>;
  batchTag: string;
  page: number;
  hasMore: boolean;
}

export async function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const { page, offset } = listPage(params);
  const batchTag = params.get("batch_tag")?.trim().slice(0, 100) ?? "";
  const query = new URLSearchParams({ offset });
  if (batchTag) query.set("batch_tag", batchTag);
  const [{ csrf }, { invites, batches }] = await Promise.all([
    adminPageGet<AdminMe>(request, "/api/admin/me"),
    adminPageGet<{ invites: ReaderInvite[]; batches: ReaderInviteBatch[] }>(request, `${API}?${query}`),
  ]);
  const ids = invites.flatMap(invite => [invite.issuer_reader_id, invite.used_by]).filter(id => id !== null);
  const contacts = (await loadLookups(request, "reader_ids", ids)).readers;
  const now = Date.now();
  const result: LoaderData = {
    csrf, invites: invites.map(invite => ({ ...invite, status: inviteStatus(invite, now) })), batches, batchTag,
    names: Object.fromEntries(contacts.map(reader => [reader.id, reader.name])),
    page, hasMore: mayHaveMore(page, invites.length),
  };
  return Response.json(result, { headers: headers() });
}

function IssueForm({ batch = false, busy, submitting, onSubmit }: {
  batch?: boolean; busy: boolean; submitting: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <Card title={batch ? "批量生成" : "生成单个"}>
      <form className="grid gap-3" onSubmit={onSubmit}>
        {batch ? (
          <Field label={`数量（最多 ${READER_INVITE_BATCH_LIMIT}）`}>
            <Input aria-label="数量" name="count" type="number" min={1} max={READER_INVITE_BATCH_LIMIT} step={1} defaultValue={1} required />
          </Field>
        ) : (
          <Field label="绑定邮箱（选填）">
            <Input aria-label="绑定邮箱" name="bound_email" type="email" maxLength={254} />
          </Field>
        )}
        <Field label={batch ? "渠道标签" : "渠道标签（选填）"}>
          <Input aria-label="渠道标签" name="batch_tag" maxLength={100} required={batch} />
        </Field>
        <Field label="备注（选填）">
          <Textarea aria-label="备注" name="note" maxLength={500} rows={2} />
        </Field>
        <div className="flex justify-end">
          <Button type="submit" tone="primary" busy={submitting} disabled={busy}>{batch ? "批量生成" : "生成邀请码"}</Button>
        </div>
      </form>
    </Card>
  );
}

export default function ReaderInvites({ loaderData }: { loaderData: LoaderData }) {
  const { csrf, invites, batches, names, batchTag, page, hasMore } = loaderData;
  const action = useReaderAdminAction(csrf);
  const results = useActionResults<IssuedInvite[]>();

  function issue(event: FormEvent<HTMLFormElement>, batch: boolean) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const batch_tag = String(form.get("batch_tag") ?? "").trim();
    const note = String(form.get("note") ?? "").trim() || null;
    if (batch) {
      if (!batch_tag) {
        const tag = event.currentTarget.elements.namedItem("batch_tag") as HTMLInputElement;
        tag.value = "";
        tag.reportValidity();
        return;
      }
      void action.run<{ invites: IssuedInvite[] }>(`${API}/batch`, {
        body: { count: Number(form.get("count")), batch_tag, note }, onSuccess: result => results.show(result.invites),
      });
    } else {
      void action.run<IssuedInvite>(API, {
        body: { bound_email: String(form.get("bound_email") ?? "").trim() || null, batch_tag: batch_tag || null, note },
        onSuccess: invite => results.show([invite]),
      });
    }
  }

  function readerName(id: string | null) {
    return id && names[id] ? <Link to={readerLink(id)} className={detailLinkClass}>{names[id]}</Link> : "读者（资料已清除）";
  }

  return (
    <ReaderAdminPage title="邀请码">
      {results.results.map(({ id, value }) => (
        <ResultCard key={id} title={`已生成 ${value.length} 个邀请码`} dismiss={() => results.dismiss(id)}>
          <p className="mb-2 text-[13px] font-medium text-ink">{copyNow}</p>
          <InviteCodes invites={value} />
        </ResultCard>
      ))}
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        <IssueForm busy={action.busy} submitting={action.pending === API} onSubmit={event => issue(event, false)} />
        <IssueForm batch busy={action.busy} submitting={action.pending === `${API}/batch`} onSubmit={event => issue(event, true)} />
      </div>
      <Card title="渠道汇总" className="mb-4" pad={false} scrollable>
        <DataTable rows={batches} rowKey={row => row.batch_tag} empty="暂无渠道统计" dense columns={[
          { key: "tag", label: "渠道标签", render: row => <Link to={`?${new URLSearchParams({ batch_tag: row.batch_tag })}`} className={detailLinkClass}>{row.batch_tag}</Link> },
          { key: "total", label: "总数", align: "right", render: row => row.total },
          { key: "used", label: "已用", align: "right", render: row => row.used },
          { key: "revoked", label: "已撤销", align: "right", render: row => row.revoked },
        ]} />
      </Card>
      <Form key={batchTag} method="get" className="mb-4 flex max-w-md flex-wrap items-center gap-2">
        <Input className="min-w-36 flex-1" name="batch_tag" defaultValue={batchTag} maxLength={100} placeholder="筛选渠道标签" aria-label="筛选渠道标签" />
        <Button type="submit">筛选</Button>
        {batchTag && <Link to="?" className={detailLinkClass}>清除筛选</Link>}
      </Form>
      <Card title="邀请码列表" pad={false}>
        <DataTable rows={invites} rowKey={row => row.id} empty="当前筛选下没有邀请码" columns={[
          { key: "status", label: "状态", render: row => <Badge tone={statuses[row.status].tone}>{statuses[row.status].label}</Badge> },
          { key: "issuer", label: "签发人", className: "min-w-20", render: row => row.issuer === "admin" ? "站长" : readerName(row.issuer_reader_id) },
          { key: "tag", label: "渠道标签", className: "min-w-20", render: row => row.batch_tag ?? "—" },
          { key: "note", label: "备注", className: "min-w-24 break-words", render: row => row.note ?? "—" },
          { key: "email", label: "绑定邮箱", className: "min-w-28 break-all", render: row => row.bound_email ?? "—" },
          { key: "created", label: "创建时间", className: "num whitespace-nowrap", render: row => bj(row.created_at, true) },
          { key: "expires", label: "过期时间", className: "num whitespace-nowrap", render: row => bj(row.expires_at, true) },
          { key: "used_at", label: "使用时间", className: "num whitespace-nowrap", render: row => bj(row.used_at, true) },
          { key: "used_by", label: "使用人", className: "min-w-20", render: row => row.used_at ? readerName(row.used_by) : "—" },
          { key: "action", label: "操作", render: row => row.status === "unused" ? (
            <Button size="sm" tone="ghost" busy={action.pending === `${API}/${row.id}/revoke`} disabled={action.busy}
              onClick={() => action.run(`${API}/${row.id}/revoke`, { success: "已撤销邀请码" })}>撤销</Button>
          ) : "—" },
        ]} />
      </Card>
      <Pager page={page} hasMore={hasMore} />
    </ReaderAdminPage>
  );
}

import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AdminMe } from "@aihot/contracts/admin";
import { bj } from "@aihot/web/features/admin/format";
import { toast } from "@aihot/web/features/admin/toast";
import { Badge, Button, Card, DataTable, Field, FilterChips, KV, Pager, ReasonDialog, Textarea } from "@aihot/web/features/admin/ui";
import { adminPageGet, GRAY_HEADERS } from "@aihot/web/lib/admin.server";
import type { ApplicationApproval, ApplicationInvitation, ReaderApplication, ReaderApplicationDetail } from "../types.ts";
import {
  adminMeta, CopyButton, copyNow, CopyValue, DetailCard, detailLink, detailLinkClass, ReaderAdminPage,
  readerLink, ReaderStatusBadge, ResultCard, useActionResults, useReaderAdminAction,
} from "./admin.tsx";
import { detailId, listPage, loadLookups, mayHaveMore } from "./admin.server.ts";

const API = "/api/admin/reader-applications";
const statuses = {
  pending: { label: "待审", tone: "warn" },
  approved: { label: "已通过", tone: "ok" },
  rejected: { label: "已拒绝", tone: "muted" },
} as const;

export const headers = () => ({ ...GRAY_HEADERS, "X-Robots-Tag": "noindex, nofollow" });
export const meta = () => adminMeta("申请审批");

interface LoaderData {
  csrf: string;
  applications: ReaderApplication[];
  detail: ReaderApplicationDetail | null;
  canReissue: boolean;
  isPendingView: boolean;
  page: number;
  hasMore: boolean;
}

export async function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const { page, offset } = listPage(params);
  const filter = params.get("status");
  const status = filter === "approved" || filter === "rejected" ? filter : "pending";
  const query = new URLSearchParams({ offset, status });
  const id = detailId(params);
  const [{ csrf }, { applications }, detail] = await Promise.all([
    adminPageGet<AdminMe>(request, "/api/admin/me"),
    adminPageGet<{ applications: ReaderApplication[] }>(request, `${API}?${query}`),
    id ? adminPageGet<ReaderApplicationDetail>(request, `${API}/${id}`) : null,
  ]);
  const canReissue = detail?.application.status === "approved" && !!detail.application.approved_invite_id
    && (await loadLookups(request, "application_ids", [detail.application.id])).reissuable_application_ids.includes(detail.application.id);
  const result: LoaderData = { csrf, applications, detail, canReissue, isPendingView: status === "pending", page, hasMore: mayHaveMore(page, applications.length) };
  return Response.json(result, { headers: headers() });
}

function ApplicationStatusBadge({ status }: { status: ReaderApplication["status"] }) {
  return <Badge tone={statuses[status].tone}>{statuses[status].label}</Badge>;
}

function ApplicationDetail({ detail }: { detail: ReaderApplicationDetail }) {
  const { application: row, coworkers } = detail;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="space-y-4">
        <KV items={[
          ["审批状态", <ApplicationStatusBadge status={row.status} />],
          ["公司", <CopyValue value={row.company} label="公司" />],
          ["职位", <CopyValue value={row.job_title} label="职位" />],
          ["微信号", <CopyValue value={row.wechat} label="微信号" />],
          ["邮箱", <CopyValue value={row.email} label="邮箱" />],
          ["介绍人", row.referrer],
          ["申请时间", bj(row.created_at, true)],
          ["审批时间", row.decided_at ? bj(row.decided_at, true) : null],
          ["拒绝理由", row.decision_reason],
        ]} />
        <section>
          <h3 className="text-[13px] font-medium text-ink">申请理由</h3>
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-ink-2">{row.reason}</p>
        </section>
      </div>
      <section>
        <h3 className="text-[13px] font-medium text-ink">同公司已有读者</h3>
        {coworkers.length === 0 ? <p className="mt-2 text-[13px] text-ink-3">暂无同公司读者</p> : (
          <ul className="mt-2 max-h-64 divide-y divide-line overflow-auto">
            {coworkers.map(reader => (
              <li key={reader.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-[13px]">
                <Link to={readerLink(reader.id)} className={detailLinkClass}>{reader.name}</Link>
                <span className="text-ink-2">{reader.job_title}</span>
                <ReaderStatusBadge status={reader.status} />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

interface ApprovalResults {
  title: string;
  rows: ApplicationApproval[];
  names: Record<string, string>;
}

function InvitationResult({ row }: { row: ApplicationInvitation }) {
  return (
    <div className="mt-2 space-y-2">
      <KV items={[
        ["邀请码", <CopyValue value={row.code} label="邀请码" />],
        ["邀请链接", <CopyValue value={row.invitation_url} label="邀请链接" />],
        ["有效至", bj(row.expires_at, true)],
      ]} />
      <p className={`text-[13px] ${row.email_sent ? "text-ink-3" : "text-hot"}`}>
        {row.email_sent ? "邀请邮件已发送" : "邀请邮件未发出，请复制邀请文案后手动转发。"}
      </p>
      <CopyButton value={row.invitation_text}>复制邀请文案</CopyButton>
    </div>
  );
}

export default function ReaderApplications({ loaderData }: { loaderData: LoaderData }) {
  const { csrf, applications, detail, canReissue, isPendingView, page, hasMore } = loaderData;
  const [params] = useSearchParams();
  const [selected, setSelected] = useState(new Set<string>());
  const [rejection, setRejection] = useState<ReaderApplication | null>(null);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(false);
  const action = useReaderAdminAction(csrf);
  const results = useActionResults<ApprovalResults>();
  const ids = isPendingView ? applications.filter(row => selected.has(row.id)).map(row => row.id) : [];
  const current = detail?.application;

  function issue(row: ReaderApplication, mode: "approve" | "reissue") {
    return action.run<ApplicationInvitation>(`${API}/${row.id}/${mode}`, {
      onSuccess: result => {
        const title = mode === "approve" ? "申请已通过" : "邀请码已重新签发";
        results.show({ title, rows: [result], names: { [row.id]: row.name } }, mode === "reissue" ? previous => {
          const rows = previous.rows.filter(entry => "error" in entry || entry.application_id !== row.id);
          return rows.length ? { ...previous, rows } : null;
        } : undefined);
      },
    });
  }

  function approveBatch() {
    const names = Object.fromEntries(applications.map(row => [row.id, row.name]));
    return action.run<{ results: ApplicationApproval[] }>(`${API}/batch-approve`, {
      body: { ids },
      onSuccess: response => {
        results.show({ title: "批量审批结果", rows: response.results, names });
        setSelected(current => {
          const next = new Set(current);
          for (const row of response.results) if (!("error" in row)) next.delete(row.application_id);
          return next;
        });
      },
    });
  }

  function startRejection(row: ReaderApplication) {
    setReason("");
    setNotify(false);
    setRejection(row);
  }

  return (
    <ReaderAdminPage title="申请审批">
      {results.results.map(({ id, value }) => (
        <ResultCard key={id} title={value.title} dismiss={() => results.dismiss(id)}>
          {value.rows.some(row => !("error" in row)) && <p className="mb-3 text-[13px] font-medium text-ink">{copyNow}</p>}
          <ul className="max-h-120 divide-y divide-line overflow-auto" tabIndex={value.rows.length > 3 ? 0 : undefined}>
            {value.rows.map(row => (
              <li key={row.application_id} className="py-3 first:pt-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2 text-[13px]">
                  <strong className="text-ink">{value.names[row.application_id] ?? row.application_id}</strong>
                  {"error" in row ? <Badge tone="bad">失败</Badge> : <Badge tone="ok">成功</Badge>}
                </div>
                {"error" in row ? <p className="mt-1 break-all text-[13px] text-hot">{row.error}</p> : <InvitationResult row={row} />}
              </li>
            ))}
          </ul>
        </ResultCard>
      ))}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <FilterChips param="status" resets={["detail"]} options={[
          { value: "", label: statuses.pending.label },
          { value: "approved", label: statuses.approved.label },
          { value: "rejected", label: statuses.rejected.label },
        ]} />
        {isPendingView && <Button busy={action.pending === `${API}/batch-approve`} disabled={action.busy || !ids.length} onClick={approveBatch}>
          批量通过{ids.length > 0 && `（${ids.length}）`}
        </Button>}
      </div>
      {detail && current && (
        <DetailCard title={current.name} params={params}>
          <ApplicationDetail detail={detail} />
          <div className="mt-4 flex flex-wrap gap-2">
            {current.status === "pending" && <>
              <Button tone="primary" busy={action.pending === `${API}/${current.id}/approve`} disabled={action.busy} onClick={() => issue(current, "approve")}>通过</Button>
              <Button tone="danger" disabled={action.busy} onClick={() => startRejection(current)}>拒绝</Button>
            </>}
            {canReissue && <Button busy={action.pending === `${API}/${current.id}/reissue`} disabled={action.busy} title="重新签发后旧码失效" onClick={() => issue(current, "reissue")}>重新签发邀请码</Button>}
          </div>
        </DetailCard>
      )}
      <Card pad={false}>
        <DataTable rows={applications} rowKey={row => row.id} empty={isPendingView ? "没有待审申请" : "当前状态下没有申请"} columns={[
          ...(isPendingView ? [{ key: "select", label: <span className="sr-only">选择</span>, render: (row: ReaderApplication) => (
            <input type="checkbox" aria-label={`选择 ${row.name}`} checked={selected.has(row.id)} disabled={action.busy} onChange={event => {
              const checked = event.currentTarget.checked;
              setSelected(current => {
                const next = new Set(current);
                if (checked) next.add(row.id);
                else next.delete(row.id);
                return next;
              });
            }} />
          ) }] : []),
          { key: "name", label: "姓名", className: "min-w-20", render: row => <Link to={detailLink(params, row.id)} className={detailLinkClass}>{row.name}</Link> },
          { key: "company", label: "公司", className: "min-w-28", render: row => <CopyValue value={row.company} label="公司" /> },
          { key: "job_title", label: "职位", className: "min-w-24", render: row => <CopyValue value={row.job_title} label="职位" /> },
          { key: "wechat", label: "微信号", className: "min-w-28", render: row => <CopyValue value={row.wechat} label="微信号" /> },
          { key: "created_at", label: "申请时间", className: "num whitespace-nowrap", render: row => bj(row.created_at, true) },
          { key: "referrer", label: "介绍人", className: "min-w-20", render: row => row.referrer ?? "—" },
          { key: "reason", label: "申请理由", className: "min-w-32", render: row => <span className="line-clamp-2 break-words">{row.reason}</span> },
        ]} />
      </Card>
      <Pager page={page} hasMore={hasMore} />
      <ReasonDialog open={rejection !== null} title={`拒绝 ${rejection?.name ?? ""} 的申请`} confirmLabel="拒绝申请" danger requireReason={false}
        busy={!!rejection && action.pending === `${API}/${rejection.id}/reject`} onClose={() => setRejection(null)}
        onSubmit={() => rejection ? action.run<{ email_sent: boolean }>(`${API}/${rejection.id}/reject`, {
          body: { reason: reason.trim() || null, notify },
          onSuccess: result => {
            toast("已拒绝申请", "ok");
            if (notify && !result.email_sent) toast("通知邮件未发出", "error");
          },
        }) : false}>
        <Field label="理由（选填）">
          <Textarea aria-label="拒绝理由" maxLength={500} value={reason} onChange={event => setReason(event.target.value)} />
        </Field>
        <label className="flex items-center gap-2 text-[13px] text-ink-2">
          <input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} />通知申请人
        </label>
      </ReasonDialog>
    </ReaderAdminPage>
  );
}

import { Form, Link, useSearchParams } from "react-router";
import type { AdminMe } from "@aihot/contracts/admin";
import { bj } from "@aihot/web/features/admin/format";
import { Button, Card, DataTable, FilterChips, Input, KV, Pager, Time } from "@aihot/web/features/admin/ui";
import { adminPageGet, GRAY_HEADERS } from "@aihot/web/lib/admin.server";
import type { ReaderAction, ReaderActionKind, ReaderApproval, ReaderDetail, ReaderRow } from "../types.ts";
import {
  adminMeta, copyNow, CopyValue, DetailCard, detailLink, detailLinkClass, InviteCodes, ReaderAdminPage, readerLink,
  ReaderStatusBadge, readerStatuses, ResultCard, useActionResults, useReaderAdminAction,
} from "./admin.tsx";
import { detailId, listPage, loadLookups, mayHaveMore } from "./admin.server.ts";

const API = "/api/admin/readers";
const kinds: Record<ReaderActionKind, string> = {
  view_item: "浏览文章", view_story: "浏览事件", view_topic: "浏览主题", view_report: "浏览报告",
  search: "搜索", follow_change: "调整关注", report_open: "打开报告", dwell: "阅读停留",
};
const dwellTimes: Record<NonNullable<ReaderAction["dwell_bucket"]>, string> = {
  under_10s: "不到 10 秒", "10_29s": "10–29 秒", "30_59s": "30–59 秒", "60_179s": "60–179 秒", "180s_plus": "3 分钟及以上",
};

export const headers = () => ({ ...GRAY_HEADERS, "X-Robots-Tag": "noindex, nofollow" });
export const meta = () => adminMeta("读者名单");

interface LoaderData {
  csrf: string;
  readers: Array<ReaderRow & { wechat: string | null }>;
  detail: ReaderDetail | null;
  page: number;
  hasMore: boolean;
  q: string;
  status: string;
}

export async function loader({ request }: { request: Request }) {
  const params = new URL(request.url).searchParams;
  const { page, offset } = listPage(params);
  const status = readerStatuses.find(item => item.value === params.get("status"))?.value ?? "";
  const q = params.get("q")?.trim().slice(0, 160) ?? "";
  const query = new URLSearchParams({ offset });
  if (q) query.set("q", q);
  if (status) query.set("status", status);
  const id = detailId(params);
  const [{ csrf }, { readers }, detail] = await Promise.all([
    adminPageGet<AdminMe>(request, "/api/admin/me"),
    adminPageGet<{ readers: ReaderRow[] }>(request, `${API}?${query}`),
    id ? adminPageGet<ReaderDetail>(request, `${API}/${id}`) : null,
  ]);
  const contacts = (await loadLookups(request, "reader_ids", readers.map(reader => reader.id))).readers;
  const wechat = new Map(contacts.map(contact => [contact.id, contact.wechat]));
  const result: LoaderData = {
    csrf, readers: readers.map(reader => ({ ...reader, wechat: wechat.get(reader.id) ?? null })), detail, q, status,
    page, hasMore: mayHaveMore(page, readers.length),
  };
  return Response.json(result, { headers: headers() });
}

function InterestList({ title, rows }: { title: string; rows: Array<{ label: string; visits: number }> }) {
  return (
    <section>
      <h4 className="text-[13px] font-medium text-ink">{title}</h4>
      {rows.length === 0 ? <p className="mt-1 text-[13px] text-ink-3">暂无记录</p> : (
        <ol className="mt-1 divide-y divide-line">
          {rows.map(({ label, visits }) => (
            <li key={label} className="flex items-baseline justify-between gap-3 py-1.5 text-[13px] text-ink-2">
              <span className="min-w-0 break-all">{label}</span>
              <span className="num shrink-0 text-ink-3">{visits} 次</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function InvitationChain({ detail }: { detail: ReaderDetail }) {
  const { invited_by: inviter, invited_readers: invited } = detail;
  return (
    <section>
      <h3 className="mb-2 text-[14px] font-semibold text-ink">邀请链</h3>
      <KV items={[
        ["邀请人", inviter && <>
          {inviter.id ? <Link to={readerLink(inviter.id)} className={detailLinkClass}>{inviter.name ?? "读者"}</Link>
            : inviter.issuer === "admin" ? "站长" : "读者（资料已清除）"}
          <span className="ml-2 text-ink-3">{bj(inviter.used_at, true)}</span>
        </>],
        ["邀请的读者", invited.length === 0 ? "暂无" : (
          <ul className="space-y-1">
            {invited.map(reader => (
              <li key={reader.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Link to={readerLink(reader.id)} className={detailLinkClass}>{reader.name}</Link>
                <span>{reader.company}</span>
                <ReaderStatusBadge status={reader.status} />
                <span className="text-ink-3">{bj(reader.used_at, true)}</span>
              </li>
            ))}
          </ul>
        )],
      ]} />
    </section>
  );
}

function ReaderDetails({ detail, children }: { detail: ReaderDetail; children: React.ReactNode }) {
  const { reader, interests } = detail;
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-4">
          <KV items={[
            ["状态", <ReaderStatusBadge status={reader.status} />],
            ["公司", <CopyValue value={reader.company} label="公司" />],
            ["职位", <CopyValue value={reader.job_title} label="职位" />],
            ["微信号", <CopyValue value={reader.wechat} label="微信号" />],
            ["邮箱", <CopyValue value={reader.email} label="邮箱" />],
            ["名片", reader.business_card_url && <a className={detailLinkClass} href={reader.business_card_url} target="_blank" rel="noreferrer">查看名片</a>],
            ["介绍人", reader.referrer],
            ["注册时间", bj(reader.created_at, true)],
            ["激活时间", bj(reader.activated_at, true)],
            ["最近活跃", bj(reader.last_active_at, true)],
            ["浏览记录", reader.tracking_consent ? "已同意记录" : "未同意记录"],
          ]} />
          {children}
        </div>
        <InvitationChain detail={detail} />
      </div>
      <section className="border-t border-line pt-4">
        <h3 className="mb-3 text-[14px] font-semibold text-ink">兴趣画像（各前 10）</h3>
        <div className="grid gap-4 sm:grid-cols-3">
          <InterestList title="常看品牌" rows={interests.brands.map(row => ({ label: row.brand_slug, visits: row.visits }))} />
          <InterestList title="常看主题" rows={interests.topics.map(row => ({ label: row.topic_slug, visits: row.visits }))} />
          <InterestList title="常看内容" rows={interests.content.map(row => ({ label: `${kinds[row.kind]} · ${row.target_id}`, visits: row.visits }))} />
        </div>
      </section>
      <Card title="最近 30 条动作" pad={false} scrollable>
        <DataTable rows={interests.recent} rowKey={row => row.id} empty="暂无动作记录" dense columns={[
          { key: "at", label: "时间", className: "num whitespace-nowrap", render: row => bj(row.created_at, true) },
          { key: "kind", label: "动作", className: "whitespace-nowrap", render: row => kinds[row.kind] },
          { key: "target", label: "内容 / 搜索词", render: row => <span className="break-all">{row.query ?? row.target_id ?? "—"}</span> },
          { key: "topic", label: "主题", render: row => row.topic_slug ?? "—" },
          { key: "brand", label: "品牌", render: row => row.brand_slug ?? "—" },
          { key: "dwell", label: "停留", render: row => row.dwell_bucket ? dwellTimes[row.dwell_bucket] : "—" },
        ]} />
      </Card>
    </div>
  );
}

export default function Readers({ loaderData }: { loaderData: LoaderData }) {
  const { csrf, readers, detail, page, hasMore, status, q } = loaderData;
  const [params] = useSearchParams();
  const action = useReaderAdminAction(csrf);
  const results = useActionResults<{ name: string; approval: ReaderApproval }>();
  const reader = detail?.reader;
  const stateAction = reader?.status === "disabled" ? "restore" : "disable";

  function approve() {
    if (!reader) return;
    return action.run<ReaderApproval>(`${API}/${reader.id}/approve`, {
      success: "已批准读者",
      onSuccess: approval => { if (approval.child_invites.length) results.show({ name: reader.name, approval }); },
    });
  }

  return (
    <ReaderAdminPage title="读者名单">
      {results.results.map(({ id, value }) => (
        <ResultCard key={id} title={`${value.name} 获赠的子邀请码`} dismiss={() => results.dismiss(id)}>
          <p className="text-[13px] font-medium text-ink">{copyNow}</p>
          <p className={`mb-2 text-[13px] ${value.approval.email_sent ? "text-ink-3" : "text-hot"}`}>
            {value.approval.email_sent ? "子邀请码已通过邮件发送" : "子邀请码邮件未发出，请手动转发。"}
          </p>
          <InviteCodes invites={value.approval.child_invites} />
        </ResultCard>
      ))}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <Form key={q} method="get" className="flex w-full max-w-sm items-center gap-2">
          {status && <input type="hidden" name="status" value={status} />}
          <Input type="search" name="q" defaultValue={q} maxLength={160} placeholder="搜索姓名、公司或邮箱" aria-label="搜索姓名、公司或邮箱" />
          <Button type="submit">搜索</Button>
        </Form>
        <FilterChips param="status" resets={["detail"]} options={[{ value: "", label: "全部状态" }, ...readerStatuses]} />
      </div>
      {detail && reader && (
        <DetailCard title={reader.name} params={params}>
          <ReaderDetails detail={detail}>
            <div className="flex flex-wrap gap-2">
              {reader.status === "pending" && <Button tone="primary" busy={action.pending === `${API}/${reader.id}/approve`} disabled={action.busy} onClick={approve}>批准</Button>}
              <Button tone={stateAction === "disable" ? "danger" : "secondary"} busy={action.pending === `${API}/${reader.id}/${stateAction}`} disabled={action.busy}
                onClick={() => action.run(`${API}/${reader.id}/${stateAction}`, { success: stateAction === "disable" ? "已停用读者" : "已恢复读者" })}>
                {stateAction === "disable" ? "停用" : "恢复"}
              </Button>
            </div>
          </ReaderDetails>
        </DetailCard>
      )}
      <Card pad={false}>
        <DataTable rows={readers} rowKey={row => row.id} empty="当前筛选下没有读者" columns={[
          { key: "name", label: "姓名", className: "min-w-20", render: row => <Link to={detailLink(params, row.id)} className={detailLinkClass}>{row.name}</Link> },
          { key: "company", label: "公司", className: "min-w-28", render: row => <CopyValue value={row.company} label="公司" /> },
          { key: "job_title", label: "职位", className: "min-w-24", render: row => <CopyValue value={row.job_title} label="职位" /> },
          { key: "wechat", label: "微信号", className: "min-w-28", render: row => <CopyValue value={row.wechat} label="微信号" /> },
          { key: "status", label: "状态", render: row => <ReaderStatusBadge status={row.status} /> },
          { key: "last_active_at", label: "最近活跃", render: row => <Time at={row.last_active_at} /> },
          { key: "active_days", label: "7 天 / 30 天活跃", align: "right", render: row => `${row.active_days_7} / ${row.active_days_30} 天` },
        ]} />
      </Card>
      <Pager page={page} hasMore={hasMore} />
    </ReaderAdminPage>
  );
}

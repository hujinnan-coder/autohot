// 标注：逐条标“该选 / 不该选 / 两可”，攒成精选评测的金标集。待标的按离门槛远近排，最难判断的在前；
// 标注前不显示模型的分数，免得被它带着走，标完再给出来对照。
import { useState } from "react";
import { useRevalidator, useSearchParams } from "react-router";
import { SITE } from "@aihot/site";
import { CATEGORIES } from "@aihot/industry/taxonomy";
import { adminPageGet, GRAY_HEADERS } from "@aihot/web/lib/admin.server";
import { bj } from "@aihot/web/features/admin/format";
import { AdminPage, Badge, Button, Card, Empty, FilterChips, Input, Pager } from "@aihot/web/features/admin/ui";
import type { LabelingItem, LabelingPage } from "../types.ts";

export async function loader({ request }: { request: Request }) {
  const page = await adminPageGet<LabelingPage>(request, `/api/admin/labeling${new URL(request.url).search}`);
  return Response.json(page, { headers: GRAY_HEADERS });
}

export const headers = () => GRAY_HEADERS;

export const meta = () => [{ title: `标注 · ${SITE.name} 后台` }];

const DECISION = { select: "该选", reject: "不该选", either: "两可" } as const;
const DECISION_TONE = { select: "ok", reject: "bad", either: "muted" } as const;
const VALUE = { decision: "决策价值", topic: "话题价值", both: "两者都有" } as const;
const CATEGORY: Record<string, string> = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));
const TIER: Record<string, string> = { T1: "官方一手", T1_5: "官方账号", T2: "媒体" };

type Value = keyof typeof VALUE;

function LabelCard({ item, csrf }: { item: LabelingItem; csrf: string }) {
  const revalidator = useRevalidator();
  const [value, setValue] = useState<Value | null>(item.mark?.value ?? null);
  const [note, setNote] = useState(item.mark?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(method: "PUT" | "DELETE", body?: unknown) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/labeling/${encodeURIComponent(item.articleId)}`, {
        method,
        credentials: "same-origin",
        headers: { ...(body ? { "content-type": "application/json" } : {}), "x-csrf-token": csrf },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { detail?: string } | null)?.detail ?? `请求失败（${res.status}）`);
      revalidator.revalidate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "网络错误，请稍后再试");
    } finally {
      setBusy(false);
    }
  }

  const mark = (decision: keyof typeof DECISION) => send("PUT", { decision, value, note: note.trim() || null });
  const toggle = (v: "decision" | "topic") => {
    const has = { decision: value === "decision" || value === "both", topic: value === "topic" || value === "both" };
    has[v] = !has[v];
    setValue(has.decision && has.topic ? "both" : has.decision ? "decision" : has.topic ? "topic" : null);
  };
  const on = (v: "decision" | "topic") => value === v || value === "both";

  return (
    <article className="rounded-panel bg-surface p-4 ring-1 ring-line">
      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-ink-3">
        <span className="font-medium text-ink-2">{item.sourceName}</span>
        <Badge tone="muted">{TIER[item.tier] ?? item.tier}</Badge>
        {item.category && <Badge tone="info">{CATEGORY[item.category] ?? item.category}</Badge>}
        {item.publishedAt && <span className="num">{bj(item.publishedAt)}</span>}
        {item.mark && <Badge tone={DECISION_TONE[item.mark.decision]}>{DECISION[item.mark.decision]}</Badge>}
        {item.mark?.value && <Badge tone="accent">{VALUE[item.mark.value]}</Badge>}
        {item.score !== null && (
          <span className="num" title="两次评分的平均；门槛是这条信源当时的入选线">
            模型 {item.score} 分{item.threshold !== null && ` · 门槛 ${item.threshold}`}
            {item.mark && item.mark.decision !== "either" && item.threshold !== null && (item.score >= item.threshold) !== (item.mark.decision === "select") && (
              <span className="ml-1 font-medium text-hot">与你不同</span>
            )}
          </span>
        )}
      </div>
      <h2 className="mt-2 text-[15.5px] font-semibold leading-snug text-ink">
        <a href={item.url} target="_blank" rel="noreferrer" className="hover:text-accent">{item.title}</a>
      </h2>
      {item.originalTitle && <p className="mt-0.5 text-[12.5px] text-ink-4">{item.originalTitle}</p>}
      {item.summary && <p className="mt-2 text-[13.5px] leading-relaxed text-ink-2">{item.summary}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button tone="primary" busy={busy} onClick={() => mark("select")}>该选</Button>
        <Button tone="danger" disabled={busy} onClick={() => mark("reject")}>不该选</Button>
        <Button disabled={busy} onClick={() => mark("either")}>两可</Button>
        <span className="mx-1 hidden h-5 w-px bg-line sm:inline-block" />
        {(["decision", "topic"] as const).map((v) => (
          <button key={v} type="button" onClick={() => toggle(v)} aria-pressed={on(v)}
            className={`rounded-full px-3 py-1 text-[12.5px] ring-1 transition-colors ${on(v) ? "bg-accent/10 text-accent ring-accent" : "text-ink-3 ring-line hover:bg-bg-sunk"}`}>
            {VALUE[v]}
          </button>
        ))}
        {item.mark && <Button tone="ghost" size="sm" disabled={busy} onClick={() => send("DELETE")}>撤销标注</Button>}
      </div>
      <Input className="mt-2" placeholder="备注（选填）：为什么该选或不该选" value={note} onChange={(e) => setNote(e.target.value)} />
      {error && <p className="mt-2 text-[12.5px] text-hot">{error}</p>}
    </article>
  );
}

export default function Labeling({ loaderData }: { loaderData: LabelingPage }) {
  const { counts, items, csrf, view, sources, sourceCounts } = loaderData;
  const [sp] = useSearchParams();
  return (
    <AdminPage
      title="标注"
      subtitle="逐条判断这条该不该进精选。标满 100–200 条后，用它们校准评分标准和门槛（docs/selection.md）。待标的离门槛近的在前，标注前不显示模型分数。“决策价值 / 话题价值”选填，留给早报晚报用。"
    >
      <div className="mb-4 grid grid-cols-4 gap-2 sm:gap-3">
        {([["已标", counts.done], ["该选", counts.select], ["不该选", counts.reject], ["两可", counts.either]] as const).map(([label, n]) => (
          <Card key={label}><div className="text-[12.5px] text-ink-3">{label}</div><div className="num mt-0.5 text-[18px] font-semibold text-ink sm:text-[22px]">{n}</div></Card>
        ))}
      </div>
      <div className="mb-4 flex flex-col gap-2">
        <FilterChips param="view" resets={["band"]} options={[{ value: "", label: "待标", count: counts.todo }, { value: "done", label: "已标", count: counts.done }]} />
        <FilterChips param="band" options={[
          { value: "", label: "全部分数" },
          { value: "high", label: "模型高分（70+）", count: counts.bands.high },
          { value: "mid", label: "中间（50–69）", count: counts.bands.mid },
          { value: "low", label: "低分（50 以下）", count: counts.bands.low },
        ]} />
        <FilterChips param="source" resets={[]} options={[
          { value: "", label: "全部信源", count: counts[view] },
          ...sources.map((name) => ({
            value: name,
            label: <span className="min-w-0 max-w-[12rem] truncate" title={name}>{name}</span>,
            count: sourceCounts[name],
          })),
        ]} />
      </div>
      {items.length === 0 ? (
        <Empty>{sp.get("source") ? "当前筛选下没有资料" : view === "todo" ? (sp.get("band") ? "这一档没有待标的了" : "没有待标的资料，等新资料评完分再来") : "还没有标注"}</Empty>
      ) : (
        <div className="grid gap-3">
          {items.map((item) => <LabelCard key={`${item.articleId}:${item.mark?.labeledAt ?? ""}`} item={item} csrf={csrf} />)}
        </div>
      )}
      <Pager page={loaderData.page} hasMore={loaderData.hasMore} />
    </AdminPage>
  );
}

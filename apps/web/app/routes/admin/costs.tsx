import type { Route } from "./+types/costs";
import type { AdminCosts } from "@aihot/contracts/admin";
import { addDays, beijingDate } from "@aihot/contracts/time";
import { SITE } from "@aihot/site";
import { adminGet } from "../../lib/admin.server";
import { useAdminAction } from "../../features/admin/action";
import { bj, money, num } from "../../features/admin/format";
import { AdminPage, Badge, Button, Card, DataTable, Empty, FilterChips, Input, Stat } from "../../features/admin/ui";
import { useEffect, useState } from "react";

export async function loader({ request }: Route.LoaderArgs) {
  const days = new URL(request.url).searchParams.get("days") ?? "7";
  return adminGet<AdminCosts>(request, `/api/admin/costs?days=${encodeURIComponent(days)}`);
}

export const meta: Route.MetaFunction = () => [{ title: `成本 · ${SITE.name} 后台` }];

// Currencies keep a stable order (¥ before $) in the combined Stat values.
const moneyTotals = (totals: Record<string, number>, prefix = "") =>
  Object.entries(totals)
    .sort(([a], [b]) => (a === "CNY" ? -1 : b === "CNY" ? 1 : a.localeCompare(b)))
    .map(([c, v]) => `${prefix}${money(v, c)}`)
    .join(" + ") || "—";

// Recorded estimates and price-derived estimates are separate sources of the same guess: they add up.
const sumMoney = (...parts: Array<Record<string, number>>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const part of parts) for (const [cur, v] of Object.entries(part)) out[cur] = (out[cur] ?? 0) + v;
  return out;
};

// The spend that decides the reading order: yuan dominates, other currencies follow, calls come last.
const spendRank = (totals: Record<string, number>, calls: number) => totals["CNY"] || totals["USD"] || calls / 1e9;

/** A call whose tokens no price covers and the provider reported no cost. */
function Unpriced() {
  return <span className="whitespace-nowrap text-ink-4" title="没有服务商返回的费用，service_prices 里也没有覆盖它的单价">未定价</span>;
}

// One line per (service, model): purpose rows of the API summed back to the model.
interface ModelCost {
  service: string;
  model: string | null;
  calls: number;
  retried: number;
  tokensIn: number;
  tokensOut: number;
  actual: Record<string, number>;
  recorded: Record<string, number>;
  estimate: Record<string, number>;
  waste: number;
  failed: number;
}

const collect = (rows: AdminCosts["rows"], keyOf: (r: AdminCosts["rows"][number]) => string): Map<string, ModelCost> => {
  const by = new Map<string, ModelCost>();
  for (const r of rows) {
    const t = by.get(keyOf(r)) ?? { service: r.service, model: r.model, calls: 0, retried: 0, tokensIn: 0, tokensOut: 0, actual: {}, recorded: {}, estimate: {}, waste: 0, failed: 0 };
    t.calls += r.calls;
    t.retried += r.retried;
    t.tokensIn += r.tokensIn;
    t.tokensOut += r.tokensOut;
    t.waste += r.wasteCost ?? 0;
    t.failed += r.failedCost ?? 0;
    if (r.actualCost !== null) t.actual[r.currency ?? "CNY"] = (t.actual[r.currency ?? "CNY"] ?? 0) + r.actualCost;
    if (r.recordedCost !== null) t.recorded[r.currency ?? "CNY"] = (t.recorded[r.currency ?? "CNY"] ?? 0) + r.recordedCost;
    if (r.estimate) t.estimate[r.estimate.currency] = (t.estimate[r.estimate.currency] ?? 0) + r.estimate.amount;
    by.set(keyOf(r), t);
  }
  return by;
};

// Cost per call only makes sense in one currency; mixed-currency rows stay silent instead of guessing a rate.
const perCall = (t: ModelCost) => {
  const totals = sumMoney(t.actual, t.recorded, t.estimate);
  const entries = Object.entries(totals);
  return t.calls > 0 && entries.length === 1 ? { amount: entries[0]![1] / t.calls, currency: entries[0]![0] } : null;
};

const toneOfDays = (daysLeft: number) => (daysLeft <= 3 ? "bad" : daysLeft <= 7 ? "warn" : "ok") as "bad" | "warn" | "ok";

// The monthly budget editor: inline like the settings page's quota rows, saved through the audited PUT.
function BudgetEditor({ initial }: { initial: AdminCosts["budget"] }) {
  const { run, pending } = useAdminAction();
  const [v, setV] = useState({
    monthlyCNY: initial.monthlyCNY?.toString() ?? "",
    monthlyUSD: initial.monthlyUSD?.toString() ?? "",
    alertBalance: initial.alertBalance?.toString() ?? "",
  });
  useEffect(() => {
    setV({
      monthlyCNY: initial.monthlyCNY?.toString() ?? "",
      monthlyUSD: initial.monthlyUSD?.toString() ?? "",
      alertBalance: initial.alertBalance?.toString() ?? "",
    });
  }, [initial]);
  const changed = v.monthlyCNY !== (initial.monthlyCNY?.toString() ?? "") || v.monthlyUSD !== (initial.monthlyUSD?.toString() ?? "") || v.alertBalance !== (initial.alertBalance?.toString() ?? "");
  const save = async () => {
    const amount = (s: string) => (s.trim() === "" ? null : Number(s));
    await run("PUT", "/api/admin/costs/budget", { monthlyCNY: amount(v.monthlyCNY), monthlyUSD: amount(v.monthlyUSD), alertBalance: amount(v.alertBalance) }, { label: "budget", success: "预算已保存" });
  };
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="text-[12px] text-ink-3">
        月预算 ¥
        <Input className="mt-1 w-28" inputMode="decimal" value={v.monthlyCNY} onChange={(e) => setV({ ...v, monthlyCNY: e.target.value })} placeholder="不设" />
      </label>
      <label className="text-[12px] text-ink-3">
        月预算 $
        <Input className="mt-1 w-28" inputMode="decimal" value={v.monthlyUSD} onChange={(e) => setV({ ...v, monthlyUSD: e.target.value })} placeholder="不设" />
      </label>
      <label className="text-[12px] text-ink-3">
        余额告警阈值
        <Input className="mt-1 w-28" inputMode="decimal" value={v.alertBalance} onChange={(e) => setV({ ...v, alertBalance: e.target.value })} placeholder="不告警" />
      </label>
      <Button size="sm" busy={pending === "budget"} disabled={!changed} onClick={save}>保存</Button>
    </div>
  );
}

// One editable service_prices row: prices the estimates rely on, editable without touching SQL.
function PriceRow({ p }: { p: AdminCosts["prices"][number] }) {
  const { run, pending } = useAdminAction();
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState({
    inputPerMtok: p.inputPerMtok?.toString() ?? "",
    cachedPerMtok: p.cachedPerMtok?.toString() ?? "",
    outputPerMtok: p.outputPerMtok?.toString() ?? "",
  });
  const save = async () => {
    const rate = (s: string) => (s.trim() === "" ? null : Number(s));
    if ((await run("PUT", "/api/admin/costs/prices", { service: p.service, model: p.model, currency: p.currency, inputPerMtok: rate(v.inputPerMtok), cachedPerMtok: rate(v.cachedPerMtok), outputPerMtok: rate(v.outputPerMtok) }, { label: `price-${p.service}-${p.model}`, success: "单价已更新，新的估算立即生效" })) !== null) setEditing(false);
  };
  if (!editing) {
    return (
      <tr className="border-b border-line/70 last:border-0">
        <td className="px-3 py-2 font-mono text-[12px]">{p.service}</td>
        <td className="px-3 py-2 font-mono text-[12px]">{p.model || "（全服务通用价）"}</td>
        <td className="px-3 py-2 text-right">{p.currency}</td>
        <td className="px-3 py-2 text-right font-mono text-[12px]">{p.inputPerMtok ?? "—"}</td>
        <td className="px-3 py-2 text-right font-mono text-[12px]">{p.cachedPerMtok ?? "—"}</td>
        <td className="px-3 py-2 text-right font-mono text-[12px]">{p.outputPerMtok ?? "—"}</td>
        <td className="px-3 py-2 text-right"><Button size="sm" onClick={() => setEditing(true)}>改价</Button></td>
      </tr>
    );
  }
  return (
    <tr className="border-b border-line/70 last:border-0 bg-bg-sunk">
      <td className="px-3 py-2 font-mono text-[12px]">{p.service}</td>
      <td className="px-3 py-2 font-mono text-[12px]">{p.model || "（全服务通用价）"}</td>
      <td className="px-3 py-2 text-right">{p.currency}</td>
      {(["inputPerMtok", "cachedPerMtok", "outputPerMtok"] as const).map((k) => (
        <td key={k} className="px-2 py-2 text-right"><Input className="w-24" inputMode="decimal" value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} /></td>
      ))}
      <td className="px-3 py-2 text-right">
        <span className="inline-flex gap-1.5">
          <Button size="sm" busy={pending === `price-${p.service}-${p.model}`} onClick={save}>保存</Button>
          <Button size="sm" onClick={() => setEditing(false)}>取消</Button>
        </span>
      </td>
    </tr>
  );
}

export default function CostsAdmin({ loaderData: c }: Route.ComponentProps) {
  const isLocal = (service: string) => c.localServices.includes(service);
  const byModel = [...collect(c.rows, (r) => `${r.service}|${r.model ?? ""}`).values()]
    .map((t) => ({ ...t, totals: sumMoney(t.actual, t.recorded, t.estimate) }))
    .sort((a, b) => spendRank(b.totals, b.calls) - spendRank(a.totals, a.calls));
  // Purposes first, then the models inside one purpose by spend: same-task models sit side by side.
  const byPurpose = [...c.rows]
    .map((r) => ({
      ...r,
      totals: sumMoney(r.actualCost !== null ? { [r.currency ?? "CNY"]: r.actualCost } : {}, r.recordedCost !== null ? { [r.currency ?? "CNY"]: r.recordedCost } : {}, r.estimate ? { [r.estimate.currency]: r.estimate.amount } : {}),
      cell: {
        actual: r.actualCost !== null ? { [r.currency ?? "CNY"]: r.actualCost } : {},
        recorded: r.recordedCost !== null ? { [r.currency ?? "CNY"]: r.recordedCost } : {},
        estimate: r.estimate ? { [r.estimate.currency]: r.estimate.amount } : {},
      },
    }))
    .sort((a, b) => a.purpose.localeCompare(b.purpose) || spendRank(b.totals, b.calls) - spendRank(a.totals, a.calls));
  const totals = byModel.reduce(
    (a, t) => ({
      calls: a.calls + t.calls,
      retried: a.retried + t.retried,
      tokensIn: a.tokensIn + t.tokensIn,
      tokensOut: a.tokensOut + t.tokensOut,
      waste: a.waste + t.waste,
      failed: a.failed + t.failed,
      actual: Object.entries(t.actual).reduce((s, [cur, v]) => ({ ...s, [cur]: (s[cur] ?? 0) + v }), a.actual),
      recorded: Object.entries(t.recorded).reduce((s, [cur, v]) => ({ ...s, [cur]: (s[cur] ?? 0) + v }), a.recorded),
      estimate: Object.entries(t.estimate).reduce((s, [cur, v]) => ({ ...s, [cur]: (s[cur] ?? 0) + v }), a.estimate),
    }),
    { calls: 0, retried: 0, tokensIn: 0, tokensOut: 0, waste: 0, failed: 0, actual: {} as Record<string, number>, recorded: {} as Record<string, number>, estimate: {} as Record<string, number> },
  );
  const spent = sumMoney(totals.actual, totals.recorded, totals.estimate);
  // Tokens were spent but neither the provider nor a price line says what they cost; local engines are free by design.
  const unpriced = c.rows.filter((r) => !isLocal(r.service) && r.actualCost === null && r.recordedCost === null && !r.estimate && (r.tokensIn > 0 || r.tokensOut > 0));
  const costCell = (t: { service?: string; actual: Record<string, number>; recorded: Record<string, number>; estimate: Record<string, number> }) => {
    if (t.service && isLocal(t.service)) return <Badge tone="ok">本地 · 免费</Badge>;
    const guessed = sumMoney(t.recorded, t.estimate);
    return (
      <>
        <div>{moneyTotals(t.actual)}</div>
        {Object.keys(guessed).length ? (
          <div className="text-ink-3" title="调用方记录的估算费用，加上没有费用记录的用量按 service_prices 单价的推算">{moneyTotals(guessed, "≈ ")}</div>
        ) : (
          <Unpriced />
        )}
      </>
    );
  };
  const wasteCell = (waste: number, failed: number) => {
    if (waste <= 0 && failed <= 0) return <span className="text-ink-4">0</span>;
    return (
      <span className={waste / Math.max(1e-9, sumMoney(spent)["CNY"] ?? 1) > 0.05 || failed > 0 ? "text-hot" : ""} title={`重试浪费 ≈${money(waste)}；失败与结果未知的尝试 ≈${money(failed)}（可能计费但没有产出）`}>
        {`≈ ${money(waste + failed)}`}
      </span>
    );
  };

  // Runway rows merge accounts that resolve to the same key; platform rows fill in sampling detail.
  const platformRows = [
    ...c.runway.map((r) => {
      const details = c.platform.filter((p) => r.accounts.includes(p.account));
      const fetchedAt = details.map((p) => p.fetchedAt).sort().at(-1) ?? null;
      const balanceSpend = details.reduce((a, p) => (p.spendWindow ? { ...a, [p.currency]: (a[p.currency] ?? 0) + p.spendWindow.amount } : a), {} as Record<string, number>);
      return { runway: r, detail: details[0] ?? null, fetchedAt, samples: details.reduce((a, p) => Math.max(a, p.samples), 0), balanceSpend };
    }),
    ...c.platform.filter((p) => !c.runway.some((r) => r.accounts.includes(p.account))).map((p) => ({
      runway: null, detail: p, fetchedAt: p.fetchedAt, samples: p.samples,
      balanceSpend: p.spendWindow ? { [p.currency]: p.spendWindow.amount } : {},
    })),
  ];

  const windowDays: string[] = Array.from({ length: c.days }, (_, i) => addDays(beijingDate(Date.now()), -(c.days - 1 - i)));
  const daySpend = new Map(c.daily.map((d) => [d.day, d]));
  const maxDaySpend = Math.max(...c.daily.map((d) => d.spend.find((s) => s.currency === "CNY")?.amount ?? 0), 0.01);
  const activeDays = c.daily.length;
  const dailyAverage = sumMoney(...c.daily.flatMap((d) => d.spend.map((s) => ({ [s.currency]: s.amount }))));
  for (const [cur, v] of Object.entries(dailyAverage)) dailyAverage[cur] = v / Math.max(1, activeDays);
  const labelEvery = (day: string, i: number) => (c.days > 31 ? day.endsWith("-01") || i === windowDays.length - 1 : true);
  const staleHours = (at: string | null) => (at ? Math.floor((Date.now() - new Date(at).getTime()) / 3600_000) : null);
  const csvHref = (kind: string) => `/api/admin/costs/export?kind=${kind}&days=${c.days}`;

  // The month budget progress: spent of budget, and where the current pace lands at month end.
  const monthSpendCNY = c.budget.monthSpend["CNY"] ?? 0;
  const budgetCNY = c.budget.monthlyCNY;
  const forecastCNY = c.budget.forecast["CNY"] ?? 0;
  const overBudget = budgetCNY != null && forecastCNY > budgetCNY;
  const perSelected = c.outputs.selectedArticles > 0 ? sumMoney(...Object.entries(c.outputs.pipelineCost).map(([cur, amount]) => ({ [cur]: amount }))) : null;

  return (
    <AdminPage
      title="成本"
      subtitle="回答四个问题：钱还够用多久（余额跑道，15 分钟采样）、有没有超预算（月度金额预算与月底预测）、每天烧多快、花在哪一步值不值（次均成本、重试浪费、按内容归因）。估算按高峰价推算，空闲时段（周末全天、工作日夜间与午间、法定节假日）自动折半，调休上班日按工作日计；MiMo 按列表价估算（Token Plan 的夜间 0.8 倍折扣不计入）。"
      actions={
        <FilterChips
          param="days"
          options={[
            { value: "1", label: "24 小时" },
            { value: "", label: "7 天" },
            { value: "30", label: "30 天" },
            { value: "90", label: "90 天" },
          ]}
        />
      }
    >
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="付费调用" value={num(totals.calls)} hint={`输入 ${num(totals.tokensIn)} / 输出 ${num(totals.tokensOut)} token · 重试 ${num(totals.retried)}`} />
        <Stat
          label={`窗口花费（${c.days} 天）`}
          value={moneyTotals(spent, "≈ ")}
          hint={Object.keys(totals.actual).length ? `账单 ${moneyTotals(totals.actual)}，其余为记录的估算与单价推算` : "服务商未返回账单金额，全部为记录的估算与单价推算"}
        />
        <Stat label="日均消耗" value={moneyTotals(dailyAverage, "≈ ")} hint={`${activeDays} 个有调用的日子平均（全服务）`} />
        <Stat
          label="重试与失败浪费"
          value={moneyTotals({ CNY: totals.waste + totals.failed, USD: 0 }, "≈ ").replace(/ \+ \$0/, "")}
          tone={totals.waste + totals.failed > 0 ? "warn" : "ok"}
          hint={`重试 ≈${money(totals.waste)} · 失败/未知 ≈${money(totals.failed)}（可能计费但没有产出）`}
        />
      </div>

      <div className="mt-5 grid grid-cols-1 gap-5">
        <Card title="月度预算" right={<BudgetEditor initial={c.budget} />}>
          {budgetCNY != null || c.budget.monthlyUSD != null ? (
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              {(["CNY", "USD"] as const).filter((cur) => (cur === "CNY" ? budgetCNY != null : c.budget.monthlyUSD != null)).map((cur) => {
                const budget = cur === "CNY" ? budgetCNY : c.budget.monthlyUSD;
                const spentMonth = c.budget.monthSpend[cur] ?? 0;
                const forecast = c.budget.forecast[cur] ?? 0;
                const pct = budget ? Math.min(100, Math.round((spentMonth / budget) * 100)) : 0;
                return (
                  <div key={cur}>
                    <div className="flex items-baseline justify-between text-[13px]">
                      <span>{cur === "CNY" ? "人民币" : "美元"}：本月已花 <span className="num font-semibold">{money(spentMonth, cur)}</span> / 预算 {money(budget ?? 0, cur)}</span>
                      <span className={`num ${overBudget ? "text-hot" : "text-ink-3"}`}>{`预计月底 ${money(forecast, cur)}（${overBudget ? "超" : "未超"}）`}</span>
                    </div>
                    <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface ring-1 ring-line">
                      <span className={`block h-full ${overBudget ? "bg-hot" : "bg-accent"}`} style={{ width: `${budget ? Math.min(100, Math.round((forecast / budget) * 100)) : 0}%` }} />
                    </div>
                    <div className="mt-1 text-[11px] text-ink-4">浅色进度条按月底预测画（本月日均 × 当月天数）；花费占比 {pct}%。</div>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty>还没有设置金额预算：右上角填一个月预算（按币种），保存后这里跟踪本月花费与月底预测，超过预算时告警会走通知通道。</Empty>
          )}
          <div className="mt-4 border-t border-line/70 pt-3 text-[12.5px] text-ink-3">
            产出对照：窗口内精选 <span className="num font-semibold">{num(c.outputs.selectedArticles)}</span> 篇、日报 <span className="num font-semibold">{num(c.outputs.reports)}</span> 份；文章流水线（预筛/评分/理解/摘要/结构化）花费 {moneyTotals(perSelected ?? {})}
            {c.outputs.selectedArticles > 0 && perSelected && Object.keys(perSelected).length === 1 ? <>，每篇入选 ≈ <span className="num font-semibold">{money(Object.values(perSelected)[0]! / c.outputs.selectedArticles, Object.keys(perSelected)[0]!)}</span></> : null}。
          </div>
        </Card>

        <Card title="平台侧余额与跑道" pad={false}>
          {platformRows.length ? (
            <DataTable
              dense
              rows={platformRows}
              rowKey={(row) => `${row.runway?.accounts.join("+") ?? row.detail?.account}`}
              columns={[
                {
                  key: "a",
                  label: "平台 / 账户",
                  render: (row) => (
                    <>
                      <div className="whitespace-nowrap font-mono text-[12px]">{row.runway ? row.runway.accounts[0]!.replace(/_API_KEY$/, "") : row.detail?.service}</div>
                      <div className="whitespace-nowrap font-mono text-[11px] text-ink-4" title={row.runway ? row.runway.accounts.join(" + ") : row.detail?.account ?? ""}>
                        {row.runway ? (row.runway.accounts.length > 1 ? `${row.runway.accounts.length} 把密钥` : row.runway.accounts[0]) : row.detail?.account}
                      </div>
                    </>
                  ),
                },
                {
                  key: "b",
                  label: "余额",
                  align: "right",
                  render: (row) => (
                    <span className="whitespace-nowrap" title={row.detail?.granted ? `其中赠金 ${money(row.detail.granted, row.detail.currency)}` : undefined}>
                      {row.runway ? money(row.runway.balance, row.runway.currency) : money(row.detail!.balance, row.detail!.currency)}
                      {row.detail && !row.detail.isAvailable && <Badge tone="bad">不可用</Badge>}
                    </span>
                  ),
                },
                {
                  key: "w",
                  label: "近窗消耗（余额差）",
                  align: "right",
                  render: (row) =>
                    Object.keys(row.balanceSpend).length ? (
                      <span className="whitespace-nowrap" title="由相邻快照的余额差推算，充值与赠金发放不计入">{moneyTotals(row.balanceSpend, "≈ ")}</span>
                    ) : (
                      <span className="text-ink-4" title="窗口内快照不足两个，还推算不出消耗">—</span>
                    ),
                },
                {
                  key: "r",
                  label: "日均消耗（回执口径）",
                  align: "right",
                  render: (row) =>
                    row.runway?.dailySpend != null ? (
                      <span className="whitespace-nowrap" title="窗口内有调用的日子（北京日）的平均消耗，按回执费用与单价估算">≈ {money(row.runway.dailySpend, row.runway.currency)} / 天</span>
                    ) : (
                      <span className="text-ink-4" title="窗口内没有可折算的消耗，或消耗币种与余额不同">—</span>
                    ),
                },
                {
                  key: "d",
                  label: "预计还能用",
                  align: "right",
                  render: (row) =>
                    row.runway?.daysLeft != null ? (
                      <Badge tone={toneOfDays(row.runway.daysLeft)} title="余额 ÷ 日均消耗（向下取整）。低于 7 天该留意，低于 3 天该充值了">{`≈ ${row.runway.daysLeft} 天`}</Badge>
                    ) : (
                      <span className="text-ink-4">—</span>
                    ),
                },
                {
                  key: "t",
                  label: "采样",
                  render: (row) => {
                    const stale = staleHours(row.fetchedAt);
                    return (
                      <span className="num whitespace-nowrap text-ink-3">
                        {bj(row.fetchedAt)} · {row.samples} 次
                        {stale !== null && stale >= 2 && <Badge tone="warn" title="余额采样落后：worker 可能停了，跑道数字不再是当前余额">{`采样落后 ${stale} 小时`}</Badge>}
                      </span>
                    );
                  },
                },
              ]}
            />
          ) : (
            <Empty>
              还没有平台余额快照：在 .env 设 PROVIDER_BALANCE_ENABLED=true 后，worker 每 15 分钟采集一次。DeepSeek、MiMo 提供官方余额接口；
              Jina、SocialData 没有，以回执里记录的估算为准。
            </Empty>
          )}
        </Card>

        <Card title="每日消耗（北京日）" right={<span className="num text-[12.5px] text-ink-3">{`${moneyTotals(spent, "合计 ≈")} · ${moneyTotals(dailyAverage, "日均 ≈")} · `}<a className="text-accent" href={csvHref("daily")}>导出 CSV</a></span>} pad={false}>
          {activeDays ? (
            <div className="px-4 py-4">
              <div className="flex h-28 items-end gap-1">
                {windowDays.map((day) => {
                  const row = daySpend.get(day);
                  const cny = row?.spend.find((s) => s.currency === "CNY")?.amount ?? 0;
                  return (
                    <div
                      key={day}
                      className="flex h-full min-w-0 flex-1 flex-col justify-end"
                      title={`${day}：${row ? `${moneyTotals(sumMoney(...row.spend.map((s) => ({ [s.currency]: s.amount }))))} · ${num(row.calls)} 次` : "没有调用"}`}
                    >
                      <div
                        className={`rounded-t-mark ${row ? "bg-accent/80 hover:bg-accent" : "bg-ink/10"}`}
                        style={{ height: `${row ? Math.max(2, Math.round((cny / maxDaySpend) * 100)) : 4}%` }}
                      />
                    </div>
                  );
                })}
              </div>
              <div className="mt-1.5 flex gap-1 text-[10px] text-ink-4">
                {windowDays.map((day, i) => (
                  <div key={day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
                    {labelEvery(day, i) ? day.slice(5) : ""}
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[12px] text-ink-4">柱高按当日人民币消耗归一（含单价推算，空闲时段折半、法定节假日按放假计）；灰柱是没有调用的日子。悬停看各币种金额。</div>
            </div>
          ) : (
            <Empty>这个窗口内没有按日消耗可画</Empty>
          )}
        </Card>

        <Card title="按模型汇总" right={<a className="text-accent" href={csvHref("models")}>导出 CSV</a>} pad={false}>
          {byModel.length ? (
            <DataTable
              dense
              rows={byModel}
              rowKey={(t) => `${t.service}|${t.model ?? ""}`}
              columns={[
                { key: "s", label: "服务", render: (t) => <span className="whitespace-nowrap font-mono text-[12px]">{t.service}</span> },
                { key: "m", label: "模型", render: (t) => <span className="whitespace-nowrap font-mono text-[12px]">{t.model ?? "—"}</span> },
                { key: "c", label: "调用", align: "right", render: (t) => num(t.calls) },
                { key: "rt", label: "重试", align: "right", render: (t) => (t.retried === 0 ? <span className="text-ink-4">0</span> : <span className={t.retried / Math.max(1, t.calls) > 0.1 ? "text-hot" : ""}>{`${num(t.retried)}（${Math.round((t.retried / Math.max(1, t.calls)) * 100)}%）`}</span>) },
                { key: "t", label: "输入 / 输出 token", align: "right", render: (t) => <span className="whitespace-nowrap">{`${num(t.tokensIn)} / ${num(t.tokensOut)}`}</span> },
                { key: "$", label: "实际 / 估算费用", align: "right", render: (t) => costCell({ service: t.service, actual: t.actual, recorded: t.recorded, estimate: t.estimate }) },
                {
                  key: "pc",
                  label: "次均",
                  align: "right",
                  render: (t) => {
                    const pc = perCall(t);
                    return pc ? <span className="whitespace-nowrap" title="窗口内该模型全部费用 ÷ 调用次数">≈ {money(pc.amount, pc.currency)}</span> : <span className="text-ink-4" title="费用跨多种货币，不折算">—</span>;
                  },
                },
                { key: "w", label: "浪费（重试+失败）", align: "right", render: (t) => wasteCell(t.waste, t.failed) },
              ]}
            />
          ) : (
            <Empty>{c.days} 天内没有付费调用</Empty>
          )}
        </Card>

        <Card title="按用途拆分（同用途的模型相邻，按花费排序）" right={<a className="text-accent" href={csvHref("purposes")}>导出 CSV</a>} pad={false}>
          {byPurpose.length ? (
            <DataTable
              dense
              rows={byPurpose}
              rowKey={(r) => `${r.service}|${r.model ?? ""}|${r.purpose}`}
              columns={[
                { key: "p", label: "用途", render: (r) => <span className="whitespace-nowrap font-mono text-[11.5px] text-ink-3">{r.purpose}</span> },
                { key: "s", label: "服务", render: (r) => <span className="whitespace-nowrap font-mono text-[12px]">{r.service}</span> },
                { key: "m", label: "模型", render: (r) => <span className="whitespace-nowrap font-mono text-[12px]">{r.model ?? "—"}</span> },
                { key: "c", label: "调用", align: "right", render: (r) => num(r.calls) },
                { key: "$", label: "实际 / 估算费用", align: "right", render: (r) => costCell(r.cell) },
                {
                  key: "pc",
                  label: "次均",
                  align: "right",
                  render: (r) => {
                    const entries = Object.entries(r.totals);
                    return r.calls > 0 && entries.length === 1 ? <span className="whitespace-nowrap" title="窗口内该用途全部费用 ÷ 调用次数">≈ {money(entries[0]![1] / r.calls, entries[0]![0])}</span> : <span className="text-ink-4">—</span>;
                  },
                },
                { key: "w", label: "浪费（重试+失败）", align: "right", render: (r) => wasteCell(r.wasteCost ?? 0, r.failedCost ?? 0) },
              ]}
            />
          ) : (
            <Empty>{c.days} 天内没有付费调用</Empty>
          )}
        </Card>

        <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
          <Card title="最贵的内容 Top 10" right={<a className="text-accent" href={csvHref("subjects")}>导出 CSV</a>} pad={false}>
            {c.topSubjects.length ? (
              <DataTable
                dense
                rows={c.topSubjects}
                rowKey={(s) => s.subject}
                columns={[
                  { key: "s", label: "内容", render: (s) => <span className="block max-w-56 truncate font-mono text-[11.5px]" title={s.subject}>{s.subject}</span> },
                  { key: "c", label: "调用", align: "right", render: (s) => num(s.calls) },
                  { key: "$", label: "花费", align: "right", render: (s) => (s.cost !== null ? <span className="num">{money(s.cost, s.currency ?? "CNY")}</span> : <span className="text-ink-4">—</span>) },
                ]}
              />
            ) : (
              <Empty>窗口内没有按内容归因的调用</Empty>
            )}
          </Card>

          <Card title="按月汇总（近 6 个北京月）" pad={false}>
            {c.monthly.length ? (
              <DataTable
                dense
                rows={[...c.monthly].reverse()}
                rowKey={(m) => m.month}
                columns={[
                  { key: "m", label: "月份", render: (m) => <span className="num">{m.month}</span> },
                  { key: "$", label: "花费", align: "right", render: (m) => <span className="num">{moneyTotals(sumMoney(...m.spend.map((s) => ({ [s.currency]: s.amount }))))}</span> },
                ]}
              />
            ) : (
              <Empty>还没有跨月的消耗记录</Empty>
            )}
          </Card>
        </div>

        <Card title="单价表（估算的依据，改价立即生效且记入审计）" pad={false}>
          {c.prices.length ? (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[12px] text-ink-3">
                  <th className="px-3 py-2 font-medium">服务</th>
                  <th className="px-3 py-2 font-medium">模型</th>
                  <th className="px-3 py-2 text-right font-medium">币种</th>
                  <th className="px-3 py-2 text-right font-medium">输入 ¥/Mtok</th>
                  <th className="px-3 py-2 text-right font-medium">缓存 ¥/Mtok</th>
                  <th className="px-3 py-2 text-right font-medium">输出 ¥/Mtok</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {c.prices.map((p) => <PriceRow key={`${p.service}|${p.model}`} p={p} />)}
              </tbody>
            </table>
          ) : (
            <Empty>service_prices 表为空：没有单价的服务显示"未定价"。DeepSeek 与 MiMo 的官方价可从各自价格页抄入。</Empty>
          )}
          <div className="px-4 py-3 text-[12px] text-ink-4">改价只影响之后的估算，历史数据不按新价重算；DeepSeek 空闲时段半价与节假日由系统自动折算，无需在此体现。</div>
        </Card>
      </div>
    </AdminPage>
  );
}

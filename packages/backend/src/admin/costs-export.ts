import type { AdminCosts } from "@aihot/contracts/admin";

const kinds = ["daily", "models", "purposes", "subjects"] as const;
type CostExportKind = typeof kinds[number];
type Cell = string | number | null;
type Spend = { amount: number; currency: string };

export function isCostExportKind(value: string | undefined): value is CostExportKind {
  return kinds.some((kind) => kind === value);
}

function csvCell(value: Cell): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  // Excel can interpret text from a provider as a formula even in a quoted cell.
  const literal = /^[\t\r\n]|^\s*[=+\-@]/.test(value) ? "'" + value : value;
  return /[",\r\n]/.test(literal) ? '"' + literal.replaceAll('"', '""') + '"' : literal;
}

const formatSpend = (spend: Spend[]) => spend.map(({ amount, currency }) => currency ? `${currency} ${amount}` : String(amount)).join(" / ");

function usageRows(rows: AdminCosts["rows"], byPurpose: boolean): Cell[][] {
  const groups = new Map<string, AdminCosts["rows"]>();
  for (const row of rows) {
    const key = JSON.stringify([row.service, row.model, byPurpose ? row.purpose : null]);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const { service, model, purpose } = group[0]!;
    const counts = { calls: 0, retried: 0, tokensIn: 0, tokensOut: 0 };
    const amounts = Array.from({ length: 5 }, () => new Map<string, number>());
    for (const row of group) {
      counts.calls += row.calls;
      counts.retried += row.retried;
      counts.tokensIn += row.tokensIn;
      counts.tokensOut += row.tokensOut;
      const currency = row.currency ?? "";
      const wasteCurrency = row.currency ?? row.estimate?.currency ?? "";
      const spend = [
        { amount: row.actualCost, currency },
        { amount: row.recordedCost, currency },
        row.estimate,
        { amount: row.wasteCost, currency: wasteCurrency },
        { amount: row.failedCost, currency: wasteCurrency },
      ];
      spend.forEach((entry, index) => {
        if (!entry || entry.amount === null) return;
        const totals = amounts[index]!;
        totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + entry.amount);
      });
    }
    return [
      service, model, ...(byPurpose ? [purpose] : []),
      counts.calls, counts.retried, counts.tokensIn, counts.tokensOut,
      ...amounts.map((totals) => formatSpend([...totals].map(([currency, amount]) => ({ currency, amount })))),
    ];
  });
}

export function costsCsv(kind: CostExportKind, data: Pick<AdminCosts, "daily" | "rows" | "topSubjects">): string {
  let rows: Cell[][];
  switch (kind) {
    case "daily":
      rows = [["日期", "调用次数", "花费"], ...data.daily.map((row) => [row.day, row.calls, formatSpend(row.spend)])];
      break;
    case "subjects":
      rows = [
        ["内容", "调用次数", "花费", "币种", "单价估算"],
        ...data.topSubjects.map((row) => [row.subject, row.calls, row.cost, row.currency, row.estimate?.amount ?? null]),
      ];
      break;
    case "models":
    case "purposes": {
      const byPurpose = kind === "purposes";
      rows = [
        ["服务", "模型", ...(byPurpose ? ["用途"] : []), "调用次数", "重试次数", "输入 Token", "输出 Token",
          "实际费用", "已记录估算", "单价估算", "重试花费", "失败花费"],
        ...usageRows(data.rows, byPurpose),
      ];
      break;
    }
  }
  return "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

import { sql, type Db } from "@aihot/backend/db";
import { IngestError, ingestItems, MAX_ITEMS } from "@aihot/backend/ingest/items";
import { runOwner } from "@aihot/backend/jobs/runs";
import { shutdownSignal } from "@aihot/backend/lib/shutdown";
import { jinaRead } from "@aihot/backend/providers/jina";
import { produceImage } from "@aihot/backend/media/images";
import { BudgetExceededError, completeReceipt } from "@aihot/backend/providers/receipts";
import { accounts, nextDueAt, tickTime } from "./accounts.ts";
import { parseTimeline } from "./timeline.ts";

const MAX_ACCOUNTS_PER_TICK = 4;

interface DueAccount {
  source_id: string;
  next_due_at: Date;
}

interface Outcome {
  found: number;
  created: number;
  error: string | null;
}

const errorMessage = (error: unknown) => String(error instanceof Error ? error.message : error).slice(0, 1000);

async function finishRun(db: Db, runId: number, status: "ok" | "failed" | "skipped", outcome: Outcome) {
  return db`UPDATE fetch_runs SET status = ${status}, finished_at = now(),
    found_count = ${outcome.found}, new_count = ${outcome.created}, error = ${outcome.error}
    WHERE id = ${runId} AND status = 'running'`;
}

async function recordResult(db: Db, runId: number, sourceId: string, dueAt: Date, outcome: Outcome, receiptId?: number) {
  const ok = outcome.error === null;
  const changed = await finishRun(db, runId, ok ? "ok" : "failed", outcome);
  if (!changed.count) return false;
  await db`UPDATE sources SET last_fetch_at = now(), last_ok_at = CASE WHEN ${ok} THEN now() ELSE last_ok_at END,
    last_error = ${outcome.error}, fail_count = CASE WHEN ${ok} THEN 0 ELSE fail_count + 1 END,
    health = CASE WHEN NOT enabled THEN 'paused' WHEN ${ok} THEN 'ok' WHEN fail_count + 1 >= 5 THEN 'failing' ELSE 'degraded' END,
    updated_at = now() WHERE id = ${sourceId} AND kind = 'external'`;
  await db`UPDATE weibo_monitor_due SET next_due_at = ${dueAt} WHERE source_id = ${sourceId}`;
  // The run keeps the result and the articles keep the text. Drop the original timeline from the receipt.
  if (receiptId !== undefined) await completeReceipt(db, receiptId, "text");
  return true;
}

/** The image proxy must actually be able to serve the avatar before it goes near the database. */
async function canShow(avatar: string): Promise<boolean> {
  try {
    await produceImage(avatar, "avatar");
    return true;
  } catch {
    return false;
  }
}

async function scanAccount(row: DueAccount, tick: Date): Promise<"ok" | "failed" | "budget" | "skipped"> {
  const sourceId = row.source_id;
  const account = accounts.get(sourceId);
  if (!account) return "skipped";
  const [run] = await sql<{ id: number }[]>`
    INSERT INTO fetch_runs (source_id, detail)
    SELECT id, ${sql.json({ owner: await runOwner() })} FROM sources
    WHERE id = ${sourceId} AND enabled AND kind = 'external' RETURNING id`;
  if (!run) return "skipped";

  const dueAt = nextDueAt(account.tier, tick);
  const uid = account.uid;
  let receiptId: number | undefined;
  let timeline: ReturnType<typeof parseTimeline>;
  try {
    const url = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${uid}&containerid=107603${uid}`;
    const page = await jinaRead(url, {
      purpose: "source_listing",
      subject: `weibo:${uid}`,
      round: row.next_due_at.toISOString(),
    });
    receiptId = page.receiptId;
    timeline = parseTimeline(page.markdown);
  } catch (error) {
    const budget = error instanceof BudgetExceededError;
    const outcome = { found: 0, created: 0, error: errorMessage(error) };
    if (budget || shutdownSignal.signal.aborted) {
      await finishRun(sql, run.id, "skipped", outcome);
      return budget ? "budget" : "skipped";
    }
    await sql.begin(tx => recordResult(tx, run.id, sourceId, dueAt, outcome, receiptId));
    return "failed";
  }

  const { items, avatar } = timeline;
  try {
    await sql.begin(async tx => {
      let created = 0;
      for (let i = 0; i < items.length; i += MAX_ITEMS) {
        created += (await ingestItems({ sourceId, items: items.slice(i, i + MAX_ITEMS) }, { collectorTx: tx })).created;
      }
      const recorded = await recordResult(tx, run.id, sourceId, dueAt, { found: items.length, created, error: null }, receiptId);
      // 微博图床对无 cookie 的抓取返回 403：头像写库前必须经图片代理验证真的出图，
      // 否则页面上就是裂图（11-21 深夜的教训——75 个源被写成抓不到的 wx*.sinaimg.cn 直链）。
      if (!recorded || avatar === null || !(await canShow(avatar))) return;
      await tx.savepoint(sp => sp`
        UPDATE sources SET icon_url = ${avatar}
        WHERE id IN (${`weibopage-${uid}`}, ${`weibo-${uid}`}) AND icon_url IS DISTINCT FROM ${avatar}
      `).catch(error => {
        console.warn(`Weibo avatar update failed for ${uid}: ${errorMessage(error)}`);
      });
    });
    return "ok";
  } catch (error) {
    const skipped = error instanceof IngestError && error.status === 409;
    await finishRun(sql, run.id, skipped ? "skipped" : "failed", { found: items.length, created: 0, error: errorMessage(error) });
    if (skipped) return "skipped";
    throw error;
  }
}

export async function scanDueAccounts() {
  const tick = tickTime(new Date());
  // The worker's singleton schedule serializes these ticks across worker processes.
  const due = await sql<DueAccount[]>`
    SELECT d.source_id, d.next_due_at FROM weibo_monitor_due d JOIN sources s ON s.id = d.source_id
    WHERE d.next_due_at <= ${tick} AND s.enabled AND s.kind = 'external' AND d.source_id = ANY(${[...accounts.keys()]}::text[])
    ORDER BY d.next_due_at, d.source_id LIMIT ${MAX_ACCOUNTS_PER_TICK}`;
  const result = { checked: 0, failed: 0, budgetStopped: false };
  for (const row of due) {
    if (shutdownSignal.signal.aborted) break;
    const status = await scanAccount(row, tick);
    if (status === "budget") {
      result.budgetStopped = true;
      break;
    }
    if (status === "ok" || status === "failed") result.checked += 1;
    if (status === "failed") result.failed += 1;
  }
  return result;
}

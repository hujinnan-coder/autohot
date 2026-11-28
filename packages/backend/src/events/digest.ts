// Story digest: rewritten incrementally as reports arrive; contradictions with earlier reporting are
// stated explicitly. Latest progress is bound to a current public report, not generated independently.
import { z } from "zod";
import { modelFor } from "../editorial/models.ts";
import { beijingDate, beijingTime } from "@aihot/contracts/time";
import { sql } from "../db.ts";
import { editorialPolicy } from "../modules.ts";
import { chatJson } from "../providers/llm.ts";
import { completeReceipt } from "../providers/receipts.ts";
import { digestFactEvidence, digestInputsHash, digestReportHash, digestReports, type DigestReport } from "../publication/story-evidence.ts";
import { promptText, promptVersion } from "../editorial/prompts.ts";

export const DIGEST_PROMPT_VERSION = promptVersion("story-digest");

export const DIGEST_SYSTEM = promptText("story-digest");

export const DigestSchema = z.object({
  title: z.string().max(120).catch(""),
  digest: z.string().min(10).max(2000),
  productKey: z.string().max(60).nullable().catch(null),
  majorNode: z.boolean().nullable().catch(null),
});

/** Sampling of every digest request. */
export const DIGEST_SAMPLING = { temperature: 0.3, maxTokens: 1200 };

/** Oldest first; reports from the same moment keep the order digestReports returned them in. */
export const byReportTime = (a: { at: Date }, b: { at: Date }) => a.at.getTime() - b.at.getTime();

/** Keep the latest reports, the newest report of each fact and every first-party report, in time order. */
const RECENT_REPORTS = 40;
export function digestSelection<T extends Omit<DigestReport, "story_id">>(reports: T[]): T[] {
  const byFact = new Map(reports.map(r => [r.fact_id, r.id]));
  const picked = new Set([...reports.slice(-RECENT_REPORTS).map(r => r.id), ...byFact.values()]);
  for (const r of reports) if (r.first_party) picked.add(r.id);
  return reports.filter(r => picked.has(r.id));
}

/**
 * The digest request's input, from one story's reports in byReportTime order. The evaluation
 * (scripts/eval-story-digests.ts) sends this, the system prompt and the sampling above as they are.
 */
export function buildStoryDigestInput(story: { title: string; digest: string | null }, reports: Omit<DigestReport, "story_id">[], opts: { corrected: boolean; knownArticleIds?: string[]; changedIds?: string[] }) {
  const known = new Set(opts.knownArticleIds ?? []);
  const changed = new Set(opts.changedIds ?? []);
  const recentIds = new Set(reports.slice(-RECENT_REPORTS).map(r => r.id));
  const lines = digestSelection(reports).map((r) => {
    const label = `${changed.has(r.id) ? "【已更正】" : ""}${recentIds.has(r.id) ? "" : "【早期】"}${opts.corrected ? (r.first_party ? "【一手】" : "") : (known.has(r.id) ? "" : "【新】")}`;
    return `${label}报道 ${r.id}｜事实 ${r.fact_id}｜${beijingDate(r.at)} ${beijingTime(r.at)}｜${r.source_name}${!opts.corrected && r.first_party ? "（一手）" : ""}｜${r.title}｜${r.summary ?? ""}\n事实条件与来源证据：${JSON.stringify(digestFactEvidence(r))}`;
  });
  return opts.corrected
    ? `事件当前标题：${story.title}\n\n标【已更正】的报道，其当前内容与此前综述所依据的不同；请以它们现在的内容为准，不要沿用以前版本的说法。其余报道用于补足背景。\n报道（按时间）：\n${lines.join("\n")}`
    : `事件当前标题：${story.title}\n${story.digest ? `上一版综述：${story.digest}\n` : ""}\n报道（按时间，标【新】的是上一版之后的新报道）：\n${lines.join("\n")}`;
}

/**
 * A story's digest from its current reports. `rewrite` (rewriteStoryDigest) writes it again from the reports
 * as they are now with the current prompt, as after a correction: a new wording otherwise reaches a story
 * only when its reports change.
 */
export async function composeStoryDigest(storyId: number, opts: { rewrite?: boolean } = {}): Promise<{ updated: boolean; version?: number }> {
  const [story] = await sql<{ id: number; title: string; digest: string | null; version: number; origin: string }[]>`
    SELECT id, title, digest, version, origin FROM stories WHERE id = ${storyId} AND merged_into IS NULL`;
  if (!story) return { updated: false };
  const reports = await digestReports(sql, [storyId]);
  if (reports.length === 0) {
    const cleared = await sql`UPDATE stories SET digest = NULL, digest_updated_at = NULL, updated_at = now()
      WHERE id = ${storyId} AND version = ${story.version} AND merged_into IS NULL AND digest IS NOT NULL`;
    return { updated: cleared.count > 0 };
  }
  reports.sort(byReportTime);
  const selection = digestSelection(reports);
  const ids = selection.map((r) => r.id).sort();
  // What this version is written from: the reports and what they currently say (corrections included).
  const inputsHash = digestInputsHash(selection);
  const [last] = await sql<{ article_ids: string[]; inputs_hash: string | null; digest: string; receipt_id: number | null; report_hashes: Record<string, string> | null }[]>`
    SELECT article_ids, inputs_hash, digest, receipt_id, report_hashes FROM story_digests WHERE story_id = ${storyId} ORDER BY version DESC LIMIT 1`;
  // Legacy versions of stories over 40 reports are rewritten once to establish their actual inputs,
  // including when the new selection happens to contain all the reports.
  const legacyLongStory = !!last && !last.report_hashes && reports.length > RECENT_REPORTS;
  const reportHashes = Object.fromEntries(selection.map(r => [r.id, digestReportHash(r)]));
  const lastHashes = last?.report_hashes;
  const changedIds = lastHashes ? ids.filter(id => Object.hasOwn(lastHashes, id) && lastHashes[id] !== reportHashes[id]) : [];
  const sameReports = !!last && JSON.stringify([...last.article_ids].sort()) === JSON.stringify(ids);
  if (!opts.rewrite && !legacyLongStory && story.digest !== null && sameReports && last!.inputs_hash === inputsHash) return { updated: false };
  // Same reports, different content: an editor corrected one. A report gone from the story (withdrawn,
  // or regrouped elsewhere) likewise. Rewrite from the reports as they are now, without the previous
  // digest, so a corrected or withdrawn fact does not survive as "earlier reports said".
  const dropped = !!last && last.article_ids.some((id) => !ids.includes(id));
  const corrected = opts.rewrite === true || legacyLongStory || changedIds.length > 0 || sameReports || dropped;
  const user = buildStoryDigestInput(story, reports, { corrected, knownArticleIds: last?.article_ids, changedIds });
  const latest = reports[reports.length - 1]!.title;
  const fallbackDigest = reports
    .slice(-5)
    .map((r) => r.summary?.trim() || r.title.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 2000) || latest;
  // A withdrawal clears the public projection but retains its history. Restoring exactly the same
  // evidence reuses that digest through the normal version/input checks, without another model call.
  const res = !opts.rewrite && !legacyLongStory && last?.inputs_hash === inputsHash ? { data: { title: "", digest: last.digest }, receiptId: last.receipt_id } : await chatJson({
    model: await modelFor("digest"), purpose: "story_digest", subject: `story:${storyId}@${ids.length}`, promptVersion: DIGEST_PROMPT_VERSION,
    system: DIGEST_SYSTEM, user, schema: DigestSchema, ...DIGEST_SAMPLING,
  });
  const reviewed = editorialPolicy().reviewStoryDigest
    ? await editorialPolicy().reviewStoryDigest!({
        storyId,
        title: res.data.title || story.title,
        digest: res.data.digest,
        fallbackTitle: latest,
        fallbackDigest,
      })
    : null;
  const nextTitle = reviewed ? (res.data.title ? reviewed.title : (reviewed.title !== story.title ? reviewed.title : "")) : res.data.title;
  const nextDigest = reviewed ? reviewed.digest : res.data.digest;
  const allReceipts = [
    ...(res.receiptId !== null ? [res.receiptId] : []),
    ...(reviewed?.receiptIds ?? []),
  ];
  const version = story.version + 1;
  const updated = await sql.begin(async (tx) => {
    const [current] = await tx<{ version: number; merged_into: number | null }[]>`
      SELECT version, merged_into FROM stories WHERE id = ${storyId} FOR UPDATE`;
    // Report corrections, withdrawals and membership changes do not necessarily bump the story
    // version. Compare the same input identity again after the model returns.
    if (!current || current.version !== story.version || current.merged_into !== null
        || digestInputsHash(digestSelection((await digestReports(tx, [storyId])).sort(byReportTime))) !== inputsHash) {
      // A paid response remains reusable even when an editor or another digest won the race.
      for (const rid of new Set(allReceipts)) await completeReceipt(tx, rid);
      return false;
    }
    await tx`INSERT INTO story_digests (story_id, version, digest, receipt_id, article_ids, inputs_hash, report_hashes)
             VALUES (${storyId}, ${version}, ${nextDigest}, ${res.receiptId}, ${ids}, ${inputsHash}, ${tx.json(reportHashes)})`;
    // 模型对车型拿不准时给 null：保留已有的车型与节点判定，不让重写抹掉回填的结果。
    const product = "productKey" in res.data
      ? tx`product_key = coalesce(${res.data.productKey}, product_key), major_node = coalesce(${res.data.majorNode}, major_node),`
      : tx``;
    await tx`UPDATE stories SET digest = ${nextDigest}, digest_updated_at = now(),
               title = CASE WHEN origin = 'manual' OR ${nextTitle} = '' THEN title ELSE ${nextTitle} END,
               ${product} version = ${version}, updated_at = now()
             WHERE id = ${storyId}`;
    for (const rid of new Set(allReceipts)) await completeReceipt(tx, rid);
    return true;
  });
  return updated ? { updated: true, version } : { updated: false };
}

// The labeling queue and the owner's labels. The queue is every article the score model judged (its latest
// analysis, past the prefilter), the ones closest to their threshold first: the hard cases calibration needs.
// The model's score stays out of the queue so it does not lead the label; a labeled item shows it beside.
import { z } from "zod";
import { sql } from "@aihot/backend/db";
import { BANDS, DECISIONS, VALUES, type Band, type Decision, type LabelingItem, type LabelingPage, type Value } from "../types.ts";

const PAGE = 20;
/** How far back the queue reaches. */
const QUEUE_DAYS = 60;

interface Row {
  article_id: string;
  score: string | null;
  threshold: number | null;
  category: string | null;
  title_zh: string | null;
  summary_zh: string | null;
  title: string;
  url: string;
  excerpt: string | null;
  published_at: Date | null;
  source_name: string;
  tier: string;
  decision: Decision | null;
  value: Value | null;
  note: string | null;
  labeled_at: Date | null;
}

/** The latest analysis of each scored article in the queue's reach, with its label if it has one. */
function scored() {
  return sql<Row[]>`
    WITH latest AS (
      SELECT DISTINCT ON (an.article_id) an.article_id, an.score, an.relevance, an.category, an.title_zh, an.summary_zh,
             (an.output->>'threshold')::int AS threshold
        FROM analyses an
        JOIN articles ar ON ar.id = an.article_id
       WHERE ar.discovered_at > now() - make_interval(days => ${QUEUE_DAYS})
       ORDER BY an.article_id, an.id DESC)
    SELECT l.article_id, l.score, l.threshold, coalesce(m.category, l.category) AS category, l.title_zh, l.summary_zh,
           ar.title, ar.url, ar.excerpt, ar.published_at, s.name AS source_name, s.tier,
           m.decision, m.value, m.note, m.labeled_at
      FROM latest l
      JOIN articles ar ON ar.id = l.article_id
      JOIN sources s ON s.id = ar.source_id
      LEFT JOIN labeling_marks m ON m.article_id = l.article_id
     WHERE l.relevance <> 'block' AND l.score IS NOT NULL`;
}

const bandOf = (score: number): Band => (score >= BANDS.high[0] ? "high" : score >= BANDS.mid[0] ? "mid" : "low");

function item(r: Row): LabelingItem {
  const labeled = r.decision !== null;
  return {
    articleId: r.article_id,
    title: r.title_zh || r.title,
    originalTitle: r.title_zh && r.title_zh !== r.title ? r.title : null,
    summary: r.summary_zh || r.excerpt?.slice(0, 300) || null,
    url: r.url,
    sourceName: r.source_name,
    tier: r.tier,
    category: r.category,
    publishedAt: r.published_at?.toISOString() ?? null,
    score: labeled ? Number(r.score) : null,
    threshold: labeled ? r.threshold : null,
    mark: labeled ? { decision: r.decision!, value: r.value, note: r.note, labeledAt: r.labeled_at!.toISOString() } : null,
  };
}

export async function labelingPage(query: { view?: string; band?: string; source?: string; page?: string }, csrf: string): Promise<LabelingPage> {
  const view = query.view === "done" ? "done" : "todo";
  const band = query.band && Object.hasOwn(BANDS, query.band) ? (query.band as Band) : null;
  const requestedPage = Math.max(1, Number(query.page) || 1);
  const rows = await scored();
  const todo = rows.filter((r) => r.decision === null);
  const done = rows.filter((r) => r.decision !== null);
  const bands = { high: 0, mid: 0, low: 0 };
  const queue = view === "todo" ? todo : done;
  const sourceCounts = Object.create(null) as Record<string, number>;
  for (const r of queue) {
    bands[bandOf(Number(r.score))]++;
    sourceCounts[r.source_name] = (sourceCounts[r.source_name] ?? 0) + 1;
  }
  const sources = Object.keys(sourceCounts).sort((a, b) => sourceCounts[b] - sourceCounts[a] || a.localeCompare(b));
  const list = queue.filter((r) => (!band || bandOf(Number(r.score)) === band) && (!query.source || r.source_name === query.source));
  if (view === "todo") list.sort((a, b) => distance(a) - distance(b) || a.article_id.localeCompare(b.article_id));
  else list.sort((a, b) => b.labeled_at!.getTime() - a.labeled_at!.getTime());
  const counts = {
    todo: todo.length,
    done: done.length,
    select: done.filter((r) => r.decision === "select").length,
    reject: done.filter((r) => r.decision === "reject").length,
    either: done.filter((r) => r.decision === "either").length,
    bands,
  };
  const page = query.source ? Math.min(requestedPage, Math.max(1, Math.ceil(list.length / PAGE))) : requestedPage;
  const slice = list.slice((page - 1) * PAGE, page * PAGE);
  return { csrf, view, band, counts, sources, sourceCounts, items: slice.map(item), page, hasMore: list.length > page * PAGE };
}

/** Distance of the score from its source's threshold at the time; sources without one go last. */
function distance(r: Row): number {
  return r.threshold === null ? 1000 : Math.abs(Number(r.score) - r.threshold);
}

const MarkInput = z.object({
  decision: z.enum(DECISIONS),
  value: z.enum(VALUES).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});

/** Labels an article (or relabels it), keeping its material as it is now. False when it is not a scored article. */
export async function markArticle(articleId: string, input: unknown, actor: string): Promise<boolean> {
  const mark = MarkInput.parse(input);
  const [a] = await sql<{ title: string; language: string | null; published_at: Date | null; body_text: string | null; excerpt: string | null; source_name: string; kind: string; tier: string; category: string | null }[]>`
    SELECT ar.title, ar.language, ar.published_at, ar.body_text, ar.excerpt, s.name AS source_name, s.kind, s.tier,
           (SELECT category FROM analyses WHERE article_id = ar.id ORDER BY id DESC LIMIT 1) AS category
      FROM articles ar JOIN sources s ON s.id = ar.source_id
     WHERE ar.id = ${articleId}`;
  if (!a) return false;
  // The eval's material (scripts/eval-selection-core.ts GoldRow): the original text, as the score model reads it.
  const material = {
    title: a.title,
    originalTitle: null,
    publishedAt: a.published_at?.toISOString() ?? null,
    sourceName: a.source_name,
    bodyZh: null,
    bodyOriginal: a.body_text || a.excerpt || null,
  };
  // Online only T1 is first party (docs/selection.md).
  const sourceFacts = { sourceKind: a.kind, sourceTier: a.tier, firstParty: a.tier === "T1", language: a.language };
  await sql`
    INSERT INTO labeling_marks (article_id, decision, value, note, category, material, source_facts, labeled_by)
    VALUES (${articleId}, ${mark.decision}, ${mark.value ?? null}, ${mark.note || null}, ${a.category}, ${sql.json(material)}, ${sql.json(sourceFacts)}, ${actor})
    ON CONFLICT (article_id) DO UPDATE SET decision = EXCLUDED.decision, value = EXCLUDED.value, note = EXCLUDED.note,
      labeled_by = EXCLUDED.labeled_by, labeled_at = now()`;
  return true;
}

export async function unmarkArticle(articleId: string): Promise<boolean> {
  const rows = await sql`DELETE FROM labeling_marks WHERE article_id = ${articleId} RETURNING article_id`;
  return rows.length > 0;
}

/** Every label as a line of the eval's gold set; one in five goes to the holdout, by article id. */
export async function goldLines(): Promise<string[]> {
  const rows = await sql<{ article_id: string; decision: string; value: string | null; category: string | null; material: unknown; source_facts: unknown }[]>`
    SELECT article_id, decision, value, category, material, source_facts FROM labeling_marks ORDER BY labeled_at, article_id`;
  return rows.map((r) => JSON.stringify({
    caseId: r.article_id,
    material: r.material,
    sourceFacts: r.source_facts,
    samplingContext: { benchmarkSplit: holdout(r.article_id) ? "holdout" : "development", samplingStratum: r.category ?? "unknown" },
    // `value` (决策价值 / 话题价值) is for the morning and evening editions; the selection eval reads only the decision.
    gold: { decision: r.decision, ...(r.value ? { value: r.value } : {}) },
  }));
}

function holdout(id: string): boolean {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 5 === 0;
}

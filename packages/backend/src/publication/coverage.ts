// How widely a fact was reported: the editorial sources whose listed reports are evidence of it, by a
// cutoff, as the daily's "另外 N 家也报道了" counts it.
import { sql } from "../db.ts";
import { evidenceCondition, listedCondition } from "./scope.ts";

/** Count live arrivals by discovery and archived reports by their source date for the edition cutoff. */
export async function factSources(factIds: number[], end: Date): Promise<Map<number, string[]>> {
  if (factIds.length === 0) return new Map();
  const rows = await sql<{ fact_id: number; sources: string[] }[]>`
    SELECT fa.fact_id, array_agg(DISTINCT p.source_id) AS sources
    FROM fact_articles fa JOIN publications p ON p.article_id = fa.article_id JOIN sources s ON s.id = p.source_id
    WHERE fa.fact_id = ANY(${factIds}::bigint[]) AND ${evidenceCondition()} AND ${listedCondition(end)}
      AND s.participation_mode = 'editorial' AND (CASE WHEN p.backfill THEN p.timeline_at ELSE p.discovered_at END) < ${end}
    GROUP BY fa.fact_id`;
  return new Map(rows.map((r) => [r.fact_id, r.sources]));
}

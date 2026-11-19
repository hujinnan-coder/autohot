// What the labeling page reads from the api (server.ts), shared by both sides.
export const DECISIONS = ["select", "reject", "either"] as const;
export const VALUES = ["decision", "topic", "both"] as const;
export type Decision = (typeof DECISIONS)[number];
export type Value = (typeof VALUES)[number];
/** The model's mean score by band: [from, below). */
export const BANDS = { high: [70, 101], mid: [50, 70], low: [0, 50] } as const;
export type Band = keyof typeof BANDS;

export interface LabelingItem {
  articleId: string;
  title: string;
  originalTitle: string | null;
  summary: string | null;
  url: string;
  sourceName: string;
  tier: string;
  category: string | null;
  publishedAt: string | null;
  /** Only once labeled. */
  score: number | null;
  threshold: number | null;
  mark: { decision: Decision; value: Value | null; note: string | null; labeledAt: string } | null;
}

export interface LabelingPage {
  csrf: string;
  view: "todo" | "done";
  band: Band | null;
  counts: { todo: number; done: number; select: number; reject: number; either: number; bands: Record<Band, number> };
  items: LabelingItem[];
  page: number;
  hasMore: boolean;
}

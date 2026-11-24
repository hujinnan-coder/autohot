export const READER_COOKIE = "reader_session";
export const READER_PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store",
  "X-Accel-Expires": "0",
};
export const READER_PAGE_HEADERS = { ...READER_PRIVATE_HEADERS, "X-Robots-Tag": "noindex, nofollow" };

export interface ReaderPreview {
  title: string;
  summary: string | null;
  source: string;
  published_at: string;
}

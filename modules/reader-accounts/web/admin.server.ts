import { adminPageGet } from "@aihot/web/lib/admin.server";
import { READER_MAX_OFFSET, READER_PAGE_SIZE, type AdminReaderLookups } from "../types.ts";

const LAST_PAGE = READER_MAX_OFFSET / READER_PAGE_SIZE + 1;

export function listPage(params: URLSearchParams) {
  const requested = Number(params.get("page"));
  const page = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested, LAST_PAGE) : 1;
  return { page, offset: String((page - 1) * READER_PAGE_SIZE) };
}

export function mayHaveMore(page: number, length: number) {
  return page < LAST_PAGE && length === READER_PAGE_SIZE;
}

export function detailId(params: URLSearchParams) {
  const id = params.get("detail");
  return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ? id.toLowerCase() : null;
}

export function loadLookups(request: Request, field: "reader_ids" | "application_ids", ids: string[]): Promise<AdminReaderLookups> {
  if (!ids.length) return Promise.resolve({ readers: [], reissuable_application_ids: [] });
  const query = new URLSearchParams({ [field]: [...new Set(ids)].join(",") });
  return adminPageGet(request, `/api/admin/reader-lookups?${query}`);
}

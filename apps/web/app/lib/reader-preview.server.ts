import { data, type RouterContextProvider } from "react-router";
import { READER_PAGE_HEADERS, type ReaderPreview } from "@aihot/contracts/reader";
import { loadOr404 } from "./api.server.ts";
import { checkedReaderPage } from "./reader-wall.server.ts";
import { readerPageTarget } from "./reader-wall.ts";

export async function loadReaderPreview(context: Readonly<RouterContextProvider>, request: Request, kind: "items" | "story", id: string) {
  if (checkedReaderPage(context)?.share !== kind) return null;
  const returnTo = readerPageTarget(new URL(request.url));
  const endpoint = `/api/reader/preview/${kind === "story" ? "story/" : ""}${encodeURIComponent(id)}`;
  const item = await loadOr404<ReaderPreview>(endpoint, { signal: request.signal, merged: (target) => `/story/${encodeURIComponent(target)}` });
  const { title, summary, source, published_at } = item;
  return data({ readerPreview: { title, summary, source, published_at }, returnTo }, { headers: READER_PAGE_HEADERS });
}

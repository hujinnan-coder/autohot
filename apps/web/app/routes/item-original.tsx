import type { Route } from "./+types/item-original";
import type { SiteItemDetail } from "@aihot/contracts/site";
import { cachedPage, loadOr404 } from "../lib/api.server";
import { loadFollowups } from "../features/item/followups.server";
import { pageReuse } from "../lib/page-reuse";
export { default, handle, headers, meta } from "./item";

export const { clientLoader, shouldRevalidate } = pageReuse<typeof loader>();
export async function loader({ params, request }: Route.LoaderArgs) {
  const upstream = new Headers();
  const item = await loadOr404<SiteItemDetail>(`/api/site/items/${encodeURIComponent(params.id)}/original`, { responseHeaders: upstream, signal: request.signal });
  return cachedPage(60, { item, followups: await loadFollowups(item, request.signal) }, upstream);
}

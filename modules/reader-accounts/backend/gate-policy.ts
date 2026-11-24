/** Only these existing paths bypass the wall. Namespace exceptions own their own authorization. */
export const WALL_EXEMPT = {
  namespaces: ["/api/reader/", "/api/admin/"],
  exact: [
    "/api/health", "/api/auth/login", "/api/auth/options",
    "/robots.txt", "/manifest.webmanifest", "/openapi-v1.json", "/.well-known/security.txt",
    "/favicon.ico", "/icon.png", "/icon-192.png", "/apple-icon.png", "/logo.svg",
    "/og/site.png",
  ],
  routes: ["/contact/:file", "/og/pages/:file", "/og/items/:file", "/og/topics/:file", "/og/stories/:file", "/og/reports/:kind/:file"],
  posts: ["/api/ingest/items", "/api/auth/password", "/api/auth/logout"],
} as const;

/** /api/site, v1 (including agent), feed/RSS, MCP, Markdown, sitemap, llms.txt, media and new paths default to protected. */
export function publicWallPath(path: string, method: string, route?: string, extraStatic: readonly string[] = []) {
  if (WALL_EXEMPT.namespaces.some(prefix => path.startsWith(prefix))) return true;
  if (method === "POST") return WALL_EXEMPT.posts.some(entry => entry === path);
  if (method !== "GET" && method !== "HEAD") return false;
  return WALL_EXEMPT.exact.some(exact => exact === path) || extraStatic.includes(path)
    || WALL_EXEMPT.routes.some(template => template === route);
}

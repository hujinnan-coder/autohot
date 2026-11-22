// 我的关注：一次读取关注品牌的合并动态，沿用品牌页的归属规则。
// 第一版不登录，关注的品牌存在这个浏览器里（store.ts）；有了账号以后再同步。
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { TopicsResponse, TopicSummary } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import { IconClose, IconHeart } from "@aihot/web/components/icons";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { DayList } from "@aihot/web/features/feed/DayList";
import { pageMeta } from "@aihot/web/lib/seo";
import type { FollowingFeed } from "../feed.ts";
import { FOLLOW_LIMIT, toggleFollow, useFollowing } from "./store.ts";

export const handle: Screen = { tab: "me", name: "我的关注" };

export function meta() {
  return pageMeta({ title: "我的关注", description: `关注几个品牌，把它们在 ${SITE.name} 上的最新动态合成一条信息流。`, path: "/following", noindex: true });
}

const chip = "inline-flex min-h-8 items-center gap-1 rounded-full px-3 py-1 text-[12.5px] ring-1 transition-colors";
/** 搜索为空时先给读者看的备选个数。 */
const SUGGEST = 24;
/** 聚合接口每个主题最多读取 10 页。 */
const MAX_FEED_PAGES = 10;

export default function FollowingPage() {
  const following = useFollowing();
  const [mounted, setMounted] = useState(false);
  const [topics, setTopics] = useState<TopicSummary[] | null>(null);
  const [topicsFailed, setTopicsFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [full, setFull] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    const ctrl = new AbortController();
    setTopicsFailed(false);
    fetch("/api/site/topics", { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<TopicsResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((d) => setTopics(d.topics.filter((t) => t.group === "company")))
      .catch(() => {
        if (!ctrl.signal.aborted) setTopicsFailed(true);
      });
    return () => ctrl.abort();
  }, []);

  const bySlug = useMemo(() => new Map((topics ?? []).map((t) => [t.slug, t])), [topics]);
  // 品牌页没有了（改名或下线）的关注项不再请求；名单还没读到时先都当作有。
  const followed = useMemo(() => (topics ? following.filter((s) => bySlug.has(s)) : [...following]), [following, bySlug, topics]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    const taken = new Set(following);
    const pool = (topics ?? []).filter((t) => !taken.has(t.slug));
    if (!q) return [...pool].sort((a, b) => b.recent - a.recent || a.name.localeCompare(b.name, "zh-CN")).slice(0, SUGGEST);
    return pool.filter((t) => t.name.toLowerCase().includes(q) || t.slug.includes(q)).slice(0, SUGGEST);
  }, [topics, following, query]);

  const onToggle = (slug: string) => {
    const ok = toggleFollow(slug);
    setFull(!ok && !following.includes(slug) && following.length >= FOLLOW_LIMIT);
  };

  return (
    <div className="pb-12">
      <PhoneBar back={{ to: "/more", label: "我的" }} title="我的关注" />
      <header className="pb-4 pt-3 lg:pt-1">
        <h1 data-page-title="" className="text-[24px] font-semibold leading-[1.3] text-ink">我的关注</h1>
        <p className="mt-1.5 text-[13px] text-ink-3">选几个你关心的品牌，把它们的最新动态合成一条信息流。不用登录，关注的品牌只存在这个浏览器里。</p>
      </header>

      {mounted && (
        <section aria-label="已关注的品牌" className="rounded-card border border-line bg-surface px-4 py-3.5">
          <h2 className="text-[13px] font-semibold text-ink-2">
            已关注 <span className="num font-normal text-ink-4">{followed.length}/{FOLLOW_LIMIT}</span>
          </h2>
          {followed.length === 0 ? (
            <p className="mt-2 text-[13px] text-ink-4">还没有关注的品牌，从下面选几个。</p>
          ) : (
            <ul className="mt-2.5 flex flex-wrap gap-2">
              {followed.map((slug) => (
                <li key={slug}>
                  <button type="button" onClick={() => onToggle(slug)} aria-label={`取消关注${bySlug.get(slug)?.name ?? slug}`} className={`${chip} bg-accent-soft text-accent-ink ring-accent/30 hover:ring-accent dark:text-accent`}>
                    {bySlug.get(slug)?.name ?? slug}
                    <IconClose size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-4 border-t border-line-soft pt-3.5">
            <label className="block">
              <span className="sr-only">搜索品牌</span>
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜品牌或公司，如 比亚迪、宁德时代"
                className="w-full rounded-control bg-bg-sunk px-3 py-2 text-[14px] text-ink outline-none ring-1 ring-line placeholder:text-ink-4 focus:ring-2 focus:ring-accent"
              />
            </label>
            {full && <p role="status" className="mt-2 text-[12.5px] text-hot">最多关注 {FOLLOW_LIMIT} 个，先取消几个再添加。</p>}
            {topicsFailed ? (
              <p className="mt-3 text-[13px] text-ink-3">品牌名单暂时没读到，刷新页面再试。</p>
            ) : !topics ? (
              <p className="mt-3 text-[13px] text-ink-4">加载品牌名单…</p>
            ) : candidates.length === 0 ? (
              <p className="mt-3 text-[13px] text-ink-4">{query.trim() ? "没有找到这个品牌。" : "没有更多可选的品牌了。"}</p>
            ) : (
              <ul className="mt-3 flex flex-wrap gap-2">
                {candidates.map((t) => (
                  <li key={t.slug}>
                    <button type="button" onClick={() => onToggle(t.slug)} aria-label={`关注${t.name}`} className={`${chip} text-ink-2 ring-line hover:bg-bg-sunk hover:ring-line-strong`}>
                      <span aria-hidden="true">+</span> {t.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {mounted && <Feed slugs={followed} ready={topics !== null} />}
    </div>
  );
}

function Feed({ slugs, ready }: { slugs: string[]; ready: boolean }) {
  const cache = useRef<{ key: string; pages: number; items: FollowingFeed["items"]; hasMore: boolean } | null>(null);
  const [request, setRequest] = useState({ pages: 1 });
  const [{ busy, requestFailed }, setStatus] = useState({ busy: false, requestFailed: false });
  const key = slugs.join(",");
  const { pages } = request;

  useEffect(() => {
    if (!ready) return;
    const { pages } = request;
    if (!key) cache.current = null;
    if (!key || (cache.current?.key === key && cache.current.pages === pages)) {
      setStatus({ busy: false, requestFailed: false });
      return;
    }
    const ctrl = new AbortController();
    setStatus({ busy: true, requestFailed: false });
    fetch(`/api/site/following/feed?slugs=${encodeURIComponent(key)}&pages=${pages}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? (r.json() as Promise<FollowingFeed>) : Promise.reject(new Error(String(r.status)))))
      .then(({ items, hasMore }) => {
        if (ctrl.signal.aborted) return;
        cache.current = { key, pages, items, hasMore };
        setStatus({ busy: false, requestFailed: false });
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setStatus({ busy: false, requestFailed: true });
      });
    return () => ctrl.abort();
  }, [key, request, ready]);

  const items = cache.current?.items ?? [];
  const failed = requestFailed ? slugs.length : 0;
  const hasMore = cache.current?.hasMore && (pages < MAX_FEED_PAGES || requestFailed || busy);

  if (slugs.length === 0) {
    return (
      <div className="mt-4 flex flex-col items-center rounded-card border border-dashed border-line-strong px-6 py-12 text-center">
        <IconHeart size={20} className="text-ink-4" />
        <p className="mt-3 text-[13px] text-ink-3">关注几个品牌后，它们的最新动态会出现在这里。</p>
        <Link to="/topics" className="mt-4 text-[12.5px] font-medium text-accent hover:text-accent-ink">浏览全部品牌与主题 →</Link>
      </div>
    );
  }
  if (busy && items.length === 0) return <p className="mt-6 text-center text-[13px] text-ink-4">加载关注的动态…</p>;
  if (items.length === 0) {
    return (
      <div className="mt-4 lg:card">
        <EmptyState title={failed === slugs.length ? "动态暂时没读到" : "关注的品牌暂时还没有精选动态"}>
          {failed === slugs.length ? "刷新页面再试一次。" : "它们有了精选内容就会出现在这里，也可以再多关注几个品牌。"}
        </EmptyState>
      </div>
    );
  }
  return (
    <div className="mt-5">
      <DayList items={items} />
      {failed > 0 && <p className="mt-3 text-center text-[12.5px] text-ink-4">有 {failed} 个品牌的动态暂时没读到。</p>}
      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button type="button" disabled={busy} onClick={() => setRequest({ pages: requestFailed ? pages : pages + 1 })} className="rounded-full px-5 py-2 text-[13px] font-medium text-ink-2 ring-1 ring-line hover:bg-bg-sunk disabled:opacity-50">
            {busy ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </div>
  );
}

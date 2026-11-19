// 我的关注：关注的品牌各读一次它的品牌页（和品牌页同一套归属规则），合并成一条按时间排的动态流。
// 第一版不登录，关注的品牌存在这个浏览器里（store.ts）；有了账号以后再同步。
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { FeedItemSummary, TopicPage, TopicsResponse, TopicSummary } from "@aihot/contracts/site";
import { SITE } from "@aihot/site";
import { IconClose, IconHeart } from "@aihot/web/components/icons";
import { PhoneBar } from "@aihot/web/components/shell/PhoneBar";
import type { Screen } from "@aihot/web/components/shell/screens";
import { EmptyState } from "@aihot/web/components/ui/Page";
import { DayList } from "@aihot/web/features/feed/DayList";
import { pageMeta } from "@aihot/web/lib/seo";
import { FOLLOW_LIMIT, toggleFollow, useFollowing } from "./store.ts";

export const handle: Screen = { tab: "me", name: "我的关注" };

export function meta() {
  return pageMeta({ title: "我的关注", description: `关注几个品牌，把它们在 ${SITE.name} 上的最新动态合成一条信息流。`, path: "/following", noindex: true });
}

const chip = "inline-flex min-h-8 items-center gap-1 rounded-full px-3 py-1 text-[12.5px] ring-1 transition-colors";
/** 搜索为空时先给读者看的备选个数。 */
const SUGGEST = 24;

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
  // `${slug}:${page}` → 那一页；读失败记为 "fail"，不再重复请求。
  const cache = useRef(new Map<string, TopicPage | "fail">());
  const [version, setVersion] = useState(0);
  const [pages, setPages] = useState(1);
  const [busy, setBusy] = useState(false);
  const key = slugs.join(",");

  useEffect(() => {
    if (!ready) return;
    const ctrl = new AbortController();
    const jobs: Promise<unknown>[] = [];
    for (const slug of slugs) {
      for (let p = 1; p <= pages; p++) {
        const at = `${slug}:${p}`;
        if (cache.current.has(at)) continue;
        // 第 2 页起要等第 1 页回来，才知道有没有这一页。
        const first = cache.current.get(`${slug}:1`);
        if (p > 1 && (!first || first === "fail" || first.pageCount < p)) continue;
        jobs.push(
          fetch(`/api/site/topics/${encodeURIComponent(slug)}${p > 1 ? `?page=${p}` : ""}`, { signal: ctrl.signal })
            .then((r) => (r.ok ? (r.json() as Promise<TopicPage>) : Promise.reject(new Error(String(r.status)))))
            .then((d) => void cache.current.set(at, d))
            .catch(() => {
              if (!ctrl.signal.aborted) cache.current.set(at, "fail");
            }),
        );
      }
    }
    if (!jobs.length) {
      setBusy(false);
      return;
    }
    setBusy(true);
    Promise.all(jobs).then(() => {
      if (!ctrl.signal.aborted) setVersion((v) => v + 1);
    });
    return () => ctrl.abort();
  }, [key, pages, version, ready]);

  const { items, hasMore, failed } = useMemo(() => {
    const seen = new Map<string, FeedItemSummary>();
    let more = false;
    let bad = 0;
    for (const slug of slugs) {
      const first = cache.current.get(`${slug}:1`);
      if (first === "fail") bad++;
      if (first && first !== "fail" && first.pageCount > pages) more = true;
      for (let p = 1; p <= pages; p++) {
        const page = cache.current.get(`${slug}:${p}`);
        if (page && page !== "fail") for (const it of page.items) if (!seen.has(it.id)) seen.set(it.id, it);
      }
    }
    const list = [...seen.values()].sort((a, b) => (a.timelineAt < b.timelineAt ? 1 : a.timelineAt > b.timelineAt ? -1 : 0));
    return { items: list, hasMore: more, failed: bad };
    // version 变了说明 cache 里有新页。
  }, [key, pages, version]);

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
          <button type="button" disabled={busy} onClick={() => setPages((p) => p + 1)} className="rounded-full px-5 py-2 text-[13px] font-medium text-ink-2 ring-1 ring-line hover:bg-bg-sunk disabled:opacity-50">
            {busy ? "加载中…" : "加载更多"}
          </button>
        </div>
      )}
    </div>
  );
}
